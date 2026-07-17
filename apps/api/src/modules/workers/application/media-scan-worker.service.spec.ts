import type { ConfigService } from '@nestjs/config';
import { MalwareScanStatus, MediaSecurityStatus } from '@voiceverse/database';
import type { Job } from 'bullmq';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import type { DatabaseService } from '../../../infrastructure/database/database.service';
import type { ObjectStoragePort } from '../../media-ingest/domain/object-storage.port';
import type { SourcePreparationInitializerService } from '../../workflow/application/source-preparation-initializer.service';
import type { MalwareScannerPort } from '../domain/malware-scanner.port';
import { SCAN_VIDEO_JOB } from '../infrastructure/media-security.queue';
import { MediaScanWorkerService } from './media-scan-worker.service';

const userId = '01900000-0000-7000-8000-000000000001';
const organizationId = '01900000-0000-7000-8000-000000000002';
const videoId = '01900000-0000-7000-8000-000000000020';
const attemptId = '01900000-0000-7000-8000-000000000040';

function createHarness() {
  const video = {
    createdByUserId: userId,
    id: videoId,
    organizationId,
    projectId: '01900000-0000-7000-8000-000000000003',
    securityStatus: MediaSecurityStatus.PENDING,
    sha256: null,
    storageBucket: 'voiceverse-test',
    storageKey: `tenants/${organizationId}/source.mp4`,
    userId,
  };
  const client = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    malwareScanAttempt: {
      findFirst: vi.fn().mockResolvedValue({
        id: attemptId,
        leaseToken: null,
        leasedUntil: null,
        recoveryCount: 0,
        startedAt: null,
        status: MalwareScanStatus.QUEUED,
      }),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    video: {
      findFirst: vi.fn().mockResolvedValue(video),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const transaction = vi.fn((input: unknown) => {
    if (typeof input === 'function') {
      return (input as (value: typeof client) => Promise<unknown>)(client);
    }
    return Promise.all(input as Promise<unknown>[]);
  });
  Object.assign(client, { $transaction: transaction });
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
  const scan = vi.fn<MalwareScannerPort['scan']>().mockImplementation(async (stream) => {
    for await (const _chunk of stream) void _chunk;
    return { verdict: 'clean' };
  });
  const scanner = {
    ping: vi.fn(),
    scan,
  };
  const values: Partial<Environment> = {
    MEDIA_SCAN_LEASE_SECONDS: 300,
    OUTBOX_LEASE_SECONDS: 30,
    REDIS_URL: 'redis://localhost:6379/0',
    WORKER_CONCURRENCY: 2,
  };
  const config = {
    get: vi.fn((key: keyof Environment) => values[key]),
  } as unknown as ConfigService<Environment, true>;
  const sourcePreparation = {
    initialize: vi.fn().mockResolvedValue({ attemptId, jobId: videoId, stageId: videoId }),
  } as unknown as SourcePreparationInitializerService;
  const service = new MediaScanWorkerService(
    { client } as unknown as DatabaseService,
    config,
    storage,
    scanner,
    sourcePreparation,
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
  return { client, getObjectStream, job, scan, service, sourcePreparation, storage, video };
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
    expect(harness.client.malwareScanAttempt.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: MalwareScanStatus.CLEAN }),
      }),
    );
    expect(harness.client.video.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ securityStatus: MediaSecurityStatus.CLEAN }),
      }),
    );
    expect(harness.sourcePreparation.initialize).toHaveBeenCalled();
  });

  it('quarantines an infected object and records the signature', async () => {
    const harness = createHarness();
    harness.scan.mockResolvedValue({
      findingName: 'Eicar-Test-Signature',
      verdict: 'infected',
    });

    await harness.service.processJob(harness.job);

    expect(harness.client.malwareScanAttempt.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          findingName: 'Eicar-Test-Signature',
          status: MalwareScanStatus.INFECTED,
        }),
      }),
    );
    expect(harness.client.video.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ securityStatus: MediaSecurityStatus.INFECTED }),
      }),
    );
    expect(harness.sourcePreparation.initialize).not.toHaveBeenCalled();
  });

  it('records a stable error state and rethrows so BullMQ can retry', async () => {
    const harness = createHarness();
    const scanError = new Error('scanner unavailable');
    scanError.name = 'ClamdScanError';
    harness.scan.mockRejectedValue(scanError);

    await expect(harness.service.processJob(harness.job)).rejects.toBe(scanError);
    expect(harness.client.malwareScanAttempt.updateMany).toHaveBeenLastCalledWith(
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

  it('keeps transport retries on the authoritative scan attempt', async () => {
    const harness = createHarness();
    const scanError = new Error('scanner unavailable');
    scanError.name = 'ClamdScanError';
    harness.scan.mockRejectedValue(scanError);
    const retryJob = { ...harness.job, attemptsMade: 1, opts: { attempts: 5 } } as Job;

    await expect(harness.service.processJob(retryJob)).rejects.toBe(scanError);
    expect(harness.client.malwareScanAttempt.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: MalwareScanStatus.QUEUED }),
      }),
    );
  });

  it('acknowledges a permanent checksum mismatch without BullMQ retries', async () => {
    const harness = createHarness();
    harness.client.video.findFirst.mockResolvedValue({
      ...harness.video,
      sha256: 'a'.repeat(64),
    });
    const retryableTransportJob = { ...harness.job, opts: { attempts: 5 } } as Job;

    await expect(harness.service.processJob(retryableTransportJob)).resolves.toBeUndefined();

    expect(harness.client.malwareScanAttempt.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          errorCode: 'SourceChecksumMismatch',
          status: MalwareScanStatus.ERROR,
        }),
      }),
    );
    expect(harness.client.video.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { securityStatus: MediaSecurityStatus.ERROR } }),
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

  it('does not reclaim a terminal error attempt on duplicate delivery', async () => {
    const harness = createHarness();
    harness.client.video.findFirst.mockResolvedValue({
      ...harness.video,
      securityStatus: MediaSecurityStatus.ERROR,
    });
    harness.client.malwareScanAttempt.findFirst.mockResolvedValue({
      completedAt: new Date(),
      errorCode: 'SourceChecksumMismatch',
      id: attemptId,
      leaseToken: null,
      leasedUntil: null,
      recoveryCount: 0,
      startedAt: new Date(),
      status: MalwareScanStatus.ERROR,
    });

    await harness.service.processJob(harness.job);

    expect(harness.client.malwareScanAttempt.updateMany).not.toHaveBeenCalled();
    expect(harness.getObjectStream).not.toHaveBeenCalled();
    expect(harness.scan).not.toHaveBeenCalled();
  });

  it('re-publishes a stale scan command after Redis delivery loss', async () => {
    const harness = createHarness();
    const queryRaw = harness.client.$queryRaw as ReturnType<typeof vi.fn>;
    queryRaw.mockResolvedValue([{ id: attemptId }]);

    await expect(harness.service.recoverExpiredAttempts()).resolves.toBe(1);

    const query = queryRaw.mock.calls[0]?.[0] as TemplateStringsArray;
    expect(query.join(' ')).toContain("event.event_type = 'media.scan.requested'");
    expect(query.join(' ')).toContain('event.published_at');
  });

  it('reclaims an expired scan lease with a compare-and-set cutoff', async () => {
    const harness = createHarness();
    const oldLeaseToken = '01900000-0000-7000-8000-000000000099';
    harness.client.malwareScanAttempt.findFirst.mockResolvedValue({
      id: attemptId,
      leaseToken: oldLeaseToken,
      leasedUntil: new Date(Date.now() - 30_000),
      recoveryCount: 0,
      startedAt: new Date(Date.now() - 60_000),
      status: MalwareScanStatus.RUNNING,
    });
    harness.client.video.findFirst.mockResolvedValue({
      ...harness.video,
      securityStatus: MediaSecurityStatus.SCANNING,
    });

    await harness.service.processJob(harness.job);

    expect(harness.client.malwareScanAttempt.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          leaseToken: oldLeaseToken,
          leasedUntil: expect.objectContaining({ lt: expect.any(Date) }),
          recoveryCount: { lt: 1 },
        }),
      }),
    );
    expect(harness.scan).toHaveBeenCalledTimes(1);
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
