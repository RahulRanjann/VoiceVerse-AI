import type { ConfigService } from '@nestjs/config';
import { MalwareScanStatus, MediaSecurityStatus } from '@voiceverse/database';
import type { Job } from 'bullmq';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import type { DatabaseService } from '../../../infrastructure/database/database.service';
import type { ObjectStoragePort } from '../../media-ingest/domain/object-storage.port';
import type { MalwareScannerPort } from '../domain/malware-scanner.port';
import { SCAN_VIDEO_JOB } from '../infrastructure/media-security.queue';
import { MediaScanWorkerService } from './media-scan-worker.service';

const userId = '01900000-0000-7000-8000-000000000001';
const organizationId = '01900000-0000-7000-8000-000000000002';
const videoId = '01900000-0000-7000-8000-000000000020';
const attemptId = '01900000-0000-7000-8000-000000000040';

function createHarness() {
  const video = {
    id: videoId,
    organizationId,
    securityStatus: MediaSecurityStatus.PENDING,
    storageBucket: 'voiceverse-test',
    storageKey: `tenants/${organizationId}/source.mp4`,
    userId,
  };
  const client = {
    $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    malwareScanAttempt: {
      update: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({ id: attemptId }),
    },
    video: {
      findFirst: vi.fn().mockResolvedValue(video),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const getObjectStream = vi
    .fn<ObjectStoragePort['getObjectStream']>()
    .mockResolvedValue(Readable.from([Buffer.from('movie')]));
  const storage = {
    abortMultipartUpload: vi.fn(),
    completeMultipartUpload: vi.fn(),
    createMultipartUpload: vi.fn(),
    getObjectStream,
    headObject: vi.fn(),
    ping: vi.fn(),
    signUploadPart: vi.fn(),
  } as unknown as ObjectStoragePort;
  const scan = vi.fn<MalwareScannerPort['scan']>().mockResolvedValue({ verdict: 'clean' });
  const scanner = {
    ping: vi.fn(),
    scan,
  };
  const config = {
    get: vi.fn((key: keyof Environment) => (key === 'REDIS_URL' ? 'redis://localhost:6379/0' : 2)),
  } as unknown as ConfigService<Environment, true>;
  const service = new MediaScanWorkerService(
    { client } as unknown as DatabaseService,
    config,
    storage,
    scanner,
  );
  const job = {
    attemptsMade: 0,
    data: {
      attemptId,
      bucket: video.storageBucket,
      key: video.storageKey,
      organizationId,
      videoId,
    },
    name: SCAN_VIDEO_JOB,
  } as Job;
  return { client, getObjectStream, job, scan, service, storage, video };
}

describe('MediaScanWorkerService', () => {
  it('streams an object through the scanner and commits a clean verdict before acknowledging', async () => {
    const harness = createHarness();

    await harness.service.processJob(harness.job);

    expect(harness.getObjectStream).toHaveBeenCalledWith({
      bucket: harness.video.storageBucket,
      key: harness.video.storageKey,
    });
    expect(harness.scan).toHaveBeenCalled();
    expect(harness.client.malwareScanAttempt.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: MalwareScanStatus.CLEAN }),
      }),
    );
    expect(harness.client.video.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { securityStatus: MediaSecurityStatus.CLEAN } }),
    );
  });

  it('quarantines an infected object and records the signature', async () => {
    const harness = createHarness();
    harness.scan.mockResolvedValue({
      findingName: 'Eicar-Test-Signature',
      verdict: 'infected',
    });

    await harness.service.processJob(harness.job);

    expect(harness.client.malwareScanAttempt.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          findingName: 'Eicar-Test-Signature',
          status: MalwareScanStatus.INFECTED,
        }),
      }),
    );
    expect(harness.client.video.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { securityStatus: MediaSecurityStatus.INFECTED } }),
    );
  });

  it('records a stable error state and rethrows so BullMQ can retry', async () => {
    const harness = createHarness();
    const scanError = new Error('scanner unavailable');
    scanError.name = 'ClamdScanError';
    harness.scan.mockRejectedValue(scanError);

    await expect(harness.service.processJob(harness.job)).rejects.toBe(scanError);
    expect(harness.client.malwareScanAttempt.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          errorCode: 'ClamdScanError',
          status: MalwareScanStatus.ERROR,
        }),
      }),
    );
    expect(harness.client.video.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { securityStatus: MediaSecurityStatus.ERROR } }),
    );
  });

  it('creates a distinct persisted attempt for a BullMQ retry', async () => {
    const harness = createHarness();
    const retryJob = { ...harness.job, attemptsMade: 1 } as Job;

    await harness.service.processJob(retryJob);

    expect(harness.client.malwareScanAttempt.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          attemptNumber: 2,
          id: expect.not.stringMatching(attemptId),
        }),
      }),
    );
  });

  it('is idempotent for terminal video verdicts', async () => {
    const harness = createHarness();
    harness.client.video.findFirst.mockResolvedValue({
      ...harness.video,
      securityStatus: MediaSecurityStatus.CLEAN,
    });

    await harness.service.processJob(harness.job);
    expect(harness.scan).not.toHaveBeenCalled();
  });

  it('rejects unsupported, malformed, or orphaned jobs', async () => {
    const unsupported = createHarness();
    await expect(
      unsupported.service.processJob({ ...unsupported.job, name: 'unknown' } as Job),
    ).rejects.toThrow(/UnsupportedMediaSecurityJob/);

    const malformed = createHarness();
    await expect(
      malformed.service.processJob({ ...malformed.job, data: {} } as Job),
    ).rejects.toThrow();

    const orphaned = createHarness();
    orphaned.client.video.findFirst.mockResolvedValue(null);
    await expect(orphaned.service.processJob(orphaned.job)).rejects.toThrow(
      /MediaScanVideoNotFound/,
    );
  });

  it('shuts down safely before the BullMQ worker has started', async () => {
    await expect(createHarness().service.onApplicationShutdown()).resolves.toBeUndefined();
  });
});
