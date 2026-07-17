import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  MediaSecurityStatus,
  MultipartUploadStatus,
  OrganizationRole,
  ProjectStatus,
  VideoIngestStatus,
} from '@voiceverse/database';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import type { DatabaseService } from '../../../infrastructure/database/database.service';
import type { AccessContext } from '../../identity/domain/access-context';
import {
  OBJECT_STORAGE_UNAVAILABLE_CODE,
  OBJECT_STORAGE_UNAVAILABLE_MESSAGE,
  ObjectStorageUnavailableError,
} from '../domain/object-storage.error';
import { MediaIngestService } from './media-ingest.service';

const mebibytes = 1_048_576;
const partSize = 5 * mebibytes;
const totalBytes = partSize + 1_024;
const userId = '01900000-0000-7000-8000-000000000001';
const organizationId = '01900000-0000-7000-8000-000000000002';
const projectId = '01900000-0000-7000-8000-000000000010';
const videoId = '01900000-0000-7000-8000-000000000020';
const uploadId = '01900000-0000-7000-8000-000000000030';

const context: AccessContext = {
  organizationId,
  role: OrganizationRole.EDITOR,
  sessionId: '01900000-0000-7000-8000-000000000003',
  userId,
};

function createHarness(overrides: Partial<Record<keyof Environment, unknown>> = {}) {
  const values: Partial<Record<keyof Environment, unknown>> = {
    S3_BUCKET: 'voiceverse-test',
    S3_MULTIPART_EXPIRY_HOURS: 24,
    S3_PART_SIZE_BYTES: partSize,
    S3_SIGNED_URL_TTL_SECONDS: 900,
    UPLOAD_MAX_BYTES: 20 * 1_024 * 1_024 * 1_024,
    ...overrides,
  };
  const config = {
    get: vi.fn((key: keyof Environment) => values[key]),
  } as unknown as ConfigService<Environment, true>;

  const video = {
    byteSize: BigInt(totalBytes),
    createdByUserId: userId,
    id: videoId,
    ingestStatus: VideoIngestStatus.UPLOADING,
    mediaType: 'video/mp4',
    organizationId,
    originalFilename: 'feature.mp4',
    projectId,
    securityStatus: MediaSecurityStatus.PENDING,
    sha256: null,
    storageBucket: 'voiceverse-test',
    storageKey: `tenants/${organizationId}/projects/${projectId}/source/${videoId}/original.mp4`,
  };
  const upload = {
    abortedAt: null,
    completedAt: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    id: uploadId,
    idempotencyKey: 'upload-key-0001',
    organizationId,
    partSize,
    providerUploadId: 'provider-upload-id',
    status: MultipartUploadStatus.INITIATED,
    totalParts: 2,
    video,
    videoId,
  };
  const completedVideo = {
    ...video,
    ingestStatus: VideoIngestStatus.UPLOADED,
    securityStatus: MediaSecurityStatus.PENDING,
    storageEtag: 'stored-etag',
    uploadedAt: new Date(),
  };
  const completedUpload = {
    ...upload,
    completedAt: new Date(),
    status: MultipartUploadStatus.COMPLETED,
  };

  const transactionClient = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    malwareScanAttempt: {
      upsert: vi.fn().mockResolvedValue({
        id: '01900000-0000-7000-8000-000000000040',
      }),
    },
    multipartUpload: {
      create: vi.fn().mockResolvedValue(upload),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ ...upload, parts: [] }),
      update: vi.fn().mockResolvedValue(completedUpload),
    },
    multipartUploadPart: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
    outboxEvent: { upsert: vi.fn().mockResolvedValue({}) },
    project: { update: vi.fn().mockResolvedValue({}) },
    video: {
      create: vi.fn().mockResolvedValue(video),
      update: vi.fn().mockResolvedValue(completedVideo),
    },
  };
  const client = {
    $transaction: vi.fn(async (operation: unknown) => {
      if (typeof operation === 'function') {
        return (operation as (client: typeof transactionClient) => Promise<unknown>)(
          transactionClient,
        );
      }
      return Promise.all(operation as Promise<unknown>[]);
    }),
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    multipartUpload: {
      findFirst: vi.fn().mockResolvedValue(upload),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    project: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: projectId, status: ProjectStatus.DRAFT, videos: [] }),
      update: vi.fn().mockResolvedValue({}),
    },
    video: { update: vi.fn().mockResolvedValue({}) },
  };
  const storage = {
    abortMultipartUpload: vi.fn().mockResolvedValue(undefined),
    completeMultipartUpload: vi.fn().mockResolvedValue({ etag: 'stored-etag' }),
    createMultipartUpload: vi.fn().mockResolvedValue('provider-upload-id'),
    getObjectStream: vi.fn(),
    headObject: vi.fn().mockResolvedValue({ byteSize: totalBytes, etag: 'head-etag' }),
    ping: vi.fn().mockResolvedValue(undefined),
    putImmutableObject: vi.fn().mockResolvedValue(undefined),
    signUploadPart: vi
      .fn()
      .mockImplementation((input: { partNumber: number }) =>
        Promise.resolve(`https://storage.test/part/${input.partNumber}`),
      ),
  };
  const service = new MediaIngestService({ client } as unknown as DatabaseService, config, storage);
  return {
    client,
    completedUpload,
    completedVideo,
    service,
    storage,
    transactionClient,
    upload,
    video,
  };
}

const createInput = {
  byteSize: totalBytes,
  filename: ' feature.mp4 ',
  mediaType: 'video/mp4',
};

describe('MediaIngestService', () => {
  it('creates an immutable tenant-scoped multipart upload atomically', async () => {
    const harness = createHarness();

    const result = await harness.service.create(context, projectId, 'upload-key-0001', createInput);

    expect(result).toMatchObject({
      partSize,
      status: MultipartUploadStatus.INITIATED,
      totalParts: 2,
      video: { byteSize: String(totalBytes), id: videoId },
    });
    expect(harness.storage.createMultipartUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expect.stringMatching(
          new RegExp(`^tenants/${organizationId}/projects/${projectId}/source/.+/original\\.mp4$`),
        ),
        metadata: expect.objectContaining({ 'organization-id': organizationId }),
      }),
    );
    expect(harness.transactionClient.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'media.multipart_upload.created' }),
      }),
    );
  });

  it('replays an identical idempotent request without creating storage work', async () => {
    const harness = createHarness();
    harness.client.multipartUpload.findUnique.mockResolvedValue(harness.upload);

    await expect(
      harness.service.create(context, projectId, 'upload-key-0001', {
        ...createInput,
        filename: 'feature.mp4',
      }),
    ).resolves.toMatchObject({ id: uploadId });
    expect(harness.storage.createMultipartUpload).not.toHaveBeenCalled();

    await expect(
      harness.service.create(context, projectId, 'upload-key-0001', {
        ...createInput,
        filename: 'different.mp4',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects unauthorized or malformed upload intents before touching storage', async () => {
    const viewer = { ...context, role: OrganizationRole.VIEWER };
    await expect(
      createHarness().service.create(viewer, projectId, 'upload-key-0001', createInput),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      createHarness().service.create(context, 'not-a-uuid', 'upload-key-0001', createInput),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      createHarness().service.create(context, projectId, 'short', createInput),
    ).rejects.toThrow(/Idempotency-Key/);
    await expect(
      createHarness().service.create(context, projectId, 'upload-key-0001', {
        ...createInput,
        filename: '../feature.mp4',
      }),
    ).rejects.toThrow(/filename/);
    await expect(
      createHarness().service.create(context, projectId, 'upload-key-0001', {
        ...createInput,
        filename: 'feature\u0007.mp4',
      }),
    ).rejects.toThrow(/filename/);
    await expect(
      createHarness().service.create(context, projectId, 'upload-key-0001', {
        ...createInput,
        mediaType: 'video/quicktime',
      }),
    ).rejects.toThrow(/MP4/);
    await expect(
      createHarness({ UPLOAD_MAX_BYTES: totalBytes - 1 }).service.create(
        context,
        projectId,
        'upload-key-0001',
        createInput,
      ),
    ).rejects.toThrow(/upload limit/);
  });

  it('rejects missing and archived projects', async () => {
    const missing = createHarness();
    missing.client.project.findFirst.mockResolvedValue(null);
    await expect(
      missing.service.create(context, projectId, 'upload-key-0001', createInput),
    ).rejects.toBeInstanceOf(NotFoundException);

    const archived = createHarness();
    archived.client.project.findFirst.mockResolvedValue({
      id: projectId,
      status: ProjectStatus.ARCHIVED,
      videos: [],
    });
    await expect(
      archived.service.create(context, projectId, 'upload-key-0001', createInput),
    ).rejects.toThrow(/Archived projects/);
  });

  it('enforces one immutable source video per project before creating storage state', async () => {
    const harness = createHarness();
    harness.client.project.findFirst.mockResolvedValue({
      id: projectId,
      status: ProjectStatus.INGESTING,
      videos: [{ id: videoId }],
    });

    await expect(
      harness.service.create(context, projectId, 'upload-key-0002', createInput),
    ).rejects.toThrow(/already has a source video/);

    expect(harness.storage.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('returns a sanitized retryable response when storage cannot create the upload', async () => {
    const harness = createHarness();
    const sensitiveCause =
      'connect ECONNREFUSED http://private-storage.internal/tenant/source/original.mp4';
    harness.storage.createMultipartUpload.mockRejectedValue(
      new ObjectStorageUnavailableError(
        'create-multipart-upload',
        new AggregateError([new Error(sensitiveCause)], sensitiveCause),
      ),
    );
    const warning = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const caught = await harness.service
      .create(context, projectId, 'upload-key-0001', createInput)
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    if (!(caught instanceof ServiceUnavailableException)) {
      throw new Error('Expected a service unavailable exception.');
    }
    expect(caught.getStatus()).toBe(503);
    expect(caught.getResponse()).toEqual({
      code: OBJECT_STORAGE_UNAVAILABLE_CODE,
      message: OBJECT_STORAGE_UNAVAILABLE_MESSAGE,
      statusCode: 503,
    });
    expect(JSON.stringify(caught.getResponse())).not.toContain(sensitiveCause);
    expect(harness.client.$transaction).not.toHaveBeenCalled();
    expect(harness.storage.abortMultipartUpload).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      {
        dependency: 'object-storage',
        errorCode: OBJECT_STORAGE_UNAVAILABLE_CODE,
        errorName: 'AggregateError',
        operation: 'create-multipart-upload',
      },
      'Object storage operation unavailable',
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain(sensitiveCause);
  });

  it('aborts the provider upload when the database transaction loses', async () => {
    const harness = createHarness();
    harness.client.$transaction.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(
      harness.service.create(context, projectId, 'upload-key-0001', createInput),
    ).rejects.toThrow(/database unavailable/);
    expect(harness.storage.abortMultipartUpload).toHaveBeenCalled();
  });

  it('signs only valid parts with their exact expected content lengths', async () => {
    const harness = createHarness();

    const result = await harness.service.signParts(context, uploadId, { partNumbers: [1, 2] });

    expect(result).toEqual({
      expiresInSeconds: 900,
      parts: [
        { contentLength: partSize, partNumber: 1, url: 'https://storage.test/part/1' },
        { contentLength: 1_024, partNumber: 2, url: 'https://storage.test/part/2' },
      ],
    });
    await expect(
      harness.service.signParts(context, uploadId, { partNumbers: [3] }),
    ).rejects.toThrow(/part count/);
  });

  it('rejects signing against expired or non-writable uploads', async () => {
    const expired = createHarness();
    expired.client.multipartUpload.findFirst.mockResolvedValue({
      ...expired.upload,
      expiresAt: new Date(Date.now() - 1_000),
    });
    await expect(
      expired.service.signParts(context, uploadId, { partNumbers: [1] }),
    ).rejects.toThrow(/expired/);

    const completed = createHarness();
    completed.client.multipartUpload.findFirst.mockResolvedValue(completed.completedUpload);
    await expect(
      completed.service.signParts(context, uploadId, { partNumbers: [1] }),
    ).rejects.toThrow(/no longer writable/);
  });

  it('persists a completion manifest before finalizing storage and enqueues one scan', async () => {
    const harness = createHarness();
    const result = await harness.service.complete(context, uploadId, {
      parts: [
        { byteSize: partSize, etag: 'etag-1', partNumber: 1 },
        { byteSize: 1_024, etag: 'etag-2', partNumber: 2 },
      ],
    });

    expect(result).toMatchObject({
      status: MultipartUploadStatus.COMPLETED,
      video: { ingestStatus: VideoIngestStatus.UPLOADED },
    });
    expect(harness.transactionClient.multipartUploadPart.createMany).toHaveBeenCalled();
    expect(harness.storage.completeMultipartUpload).toHaveBeenCalled();
    expect(harness.transactionClient.outboxEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          deduplicationKey: `media.scan.requested:${videoId}:1`,
        }),
      }),
    );
  });

  it('reconciles an ambiguous provider completion response with object HEAD', async () => {
    const harness = createHarness();
    harness.storage.completeMultipartUpload.mockRejectedValue(new Error('connection reset'));

    await expect(
      harness.service.complete(context, uploadId, {
        parts: [
          { etag: 'etag-1', partNumber: 1 },
          { etag: 'etag-2', partNumber: 2 },
        ],
      }),
    ).resolves.toMatchObject({ status: MultipartUploadStatus.COMPLETED });
    expect(harness.storage.headObject).toHaveBeenCalled();
  });

  it('fails safely when storage cannot finalize or returns the wrong object size', async () => {
    const unavailable = createHarness();
    unavailable.storage.completeMultipartUpload.mockRejectedValue(new Error('timeout'));
    unavailable.storage.headObject.mockRejectedValue(new Error('not found'));
    await expect(
      unavailable.service.complete(context, uploadId, {
        parts: [
          { etag: 'etag-1', partNumber: 1 },
          { etag: 'etag-2', partNumber: 2 },
        ],
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    const wrongSize = createHarness();
    wrongSize.storage.headObject.mockResolvedValue({ byteSize: totalBytes - 1 });
    await expect(
      wrongSize.service.complete(context, uploadId, {
        parts: [
          { etag: 'etag-1', partNumber: 1 },
          { etag: 'etag-2', partNumber: 2 },
        ],
      }),
    ).rejects.toThrow(/size does not match/);
    expect(wrongSize.client.multipartUpload.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: MultipartUploadStatus.FAILED } }),
    );
  });

  it('validates a complete, contiguous, size-consistent manifest', async () => {
    const harness = createHarness();
    await expect(
      harness.service.complete(context, uploadId, {
        parts: [{ etag: 'etag-1', partNumber: 1 }],
      }),
    ).rejects.toThrow(/Every multipart part/);
    await expect(
      harness.service.complete(context, uploadId, {
        parts: [
          { etag: 'etag-1', partNumber: 1 },
          { etag: 'etag-3', partNumber: 3 },
        ],
      }),
    ).rejects.toThrow(/unique and contiguous/);
    await expect(
      harness.service.complete(context, uploadId, {
        parts: [
          { byteSize: 1, etag: 'etag-1', partNumber: 1 },
          { etag: 'etag-2', partNumber: 2 },
        ],
      }),
    ).rejects.toThrow(/unexpected byte size/);
  });

  it('returns status and handles abort idempotently', async () => {
    const harness = createHarness();
    await expect(harness.service.status(context, uploadId)).resolves.toMatchObject({
      id: uploadId,
    });
    await expect(harness.service.abort(context, uploadId)).resolves.toBeUndefined();
    expect(harness.storage.abortMultipartUpload).toHaveBeenCalled();

    harness.client.multipartUpload.findFirst.mockResolvedValue({
      ...harness.upload,
      status: MultipartUploadStatus.ABORTED,
    });
    harness.storage.abortMultipartUpload.mockClear();
    await harness.service.abort(context, uploadId);
    expect(harness.storage.abortMultipartUpload).not.toHaveBeenCalled();

    harness.client.multipartUpload.findFirst.mockResolvedValue(harness.completedUpload);
    await expect(harness.service.abort(context, uploadId)).rejects.toThrow(/cannot be aborted/);
  });

  it('does not disclose uploads from another tenant', async () => {
    const harness = createHarness();
    harness.client.multipartUpload.findFirst.mockResolvedValue(null);

    await expect(harness.service.status(context, uploadId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
