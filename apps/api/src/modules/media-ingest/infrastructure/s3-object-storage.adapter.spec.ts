import type { S3Client } from '@aws-sdk/client-s3';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import {
  OBJECT_STORAGE_UNAVAILABLE_CODE,
  OBJECT_STORAGE_UNAVAILABLE_MESSAGE,
  ObjectStorageUnavailableError,
} from '../domain/object-storage.error';
import { S3ObjectStorageAdapter } from './s3-object-storage.adapter';

function createAdapter(): S3ObjectStorageAdapter {
  const values: Partial<Record<keyof Environment, unknown>> = {
    S3_ACCESS_KEY: 'test-access-key',
    S3_ENDPOINT: 'http://storage.internal',
    S3_FORCE_PATH_STYLE: true,
    S3_KMS_KEY_ID: undefined,
    S3_PUBLIC_ENDPOINT: 'https://uploads.test',
    S3_REGION: 'us-east-1',
    S3_SECRET_KEY: 'test-secret-key',
    S3_SIGNED_URL_TTL_SECONDS: 900,
    S3_SSE_ALGORITHM: 'none',
  };
  const config = {
    get: vi.fn((key: keyof Environment) => values[key]),
  } as unknown as ConfigService<Environment, true>;
  return new S3ObjectStorageAdapter(config);
}

describe('S3ObjectStorageAdapter', () => {
  it('returns normalized content and immutable artifact metadata from HEAD', async () => {
    const adapter = createAdapter();
    const internalClient = Reflect.get(adapter, 'internalClient') as S3Client;
    vi.spyOn(internalClient, 'send').mockResolvedValue({
      ContentLength: 123,
      ContentType: 'audio/flac',
      ETag: 'etag',
      Metadata: { sha256: 'a'.repeat(64) },
    } as never);

    await expect(
      adapter.headObject({ bucket: 'private-bucket', key: 'artifacts/audio.flac' }),
    ).resolves.toEqual({
      byteSize: 123,
      etag: 'etag',
      mediaType: 'audio/flac',
      metadata: { sha256: 'a'.repeat(64) },
    });
  });

  it('normalizes provider transport errors without exposing provider details', async () => {
    const adapter = createAdapter();
    const sensitiveCause = new AggregateError(
      [new Error('connect ECONNREFUSED http://storage.internal/private-object')],
      'provider request failed for http://storage.internal/private-object',
    );
    const internalClient = Reflect.get(adapter, 'internalClient') as S3Client;
    vi.spyOn(internalClient, 'send').mockRejectedValue(sensitiveCause);

    const caught = await adapter
      .createMultipartUpload({
        bucket: 'private-bucket',
        key: 'tenant/private-object',
        mediaType: 'video/mp4',
        metadata: { 'organization-id': 'organization-id' },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(caught).toBeInstanceOf(ObjectStorageUnavailableError);
    expect(caught).toMatchObject({
      code: OBJECT_STORAGE_UNAVAILABLE_CODE,
      message: OBJECT_STORAGE_UNAVAILABLE_MESSAGE,
      operation: 'create-multipart-upload',
    });
    expect(caught).toHaveProperty('cause', sensitiveCause);
    expect(caught).not.toHaveProperty('bucket');
    expect(caught).not.toHaveProperty('key');
    expect(caught instanceof Error ? caught.message : '').not.toContain('storage.internal');
  });

  it('writes small immutable server artifacts with integrity metadata', async () => {
    const adapter = createAdapter();
    const internalClient = Reflect.get(adapter, 'internalClient') as S3Client;
    const send = vi.spyOn(internalClient, 'send').mockResolvedValue({} as never);
    const body = Buffer.from('{"schemaVersion":"test"}\n');

    await adapter.putImmutableObject({
      body,
      bucket: 'private-bucket',
      key: 'artifacts/manifest.json',
      mediaType: 'application/json',
      metadata: { producer: 'voiceverse-api' },
      sha256: 'a'.repeat(64),
    });

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      Bucket: 'private-bucket',
      ContentLength: body.byteLength,
      IfNoneMatch: '*',
      Key: 'artifacts/manifest.json',
      Metadata: { producer: 'voiceverse-api', sha256: 'a'.repeat(64) },
    });
  });
});
