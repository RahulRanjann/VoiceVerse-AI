import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService } from '../infrastructure/database/database.service';
import type { RedisService } from '../infrastructure/redis/redis.service';
import type { Environment } from '../config/environment';
import type { ObjectStoragePort } from '../modules/media-ingest/domain/object-storage.port';
import { HealthService } from './health.service';

function createService(options?: {
  databaseFails?: boolean;
  redisFails?: boolean;
  storageFails?: boolean;
}) {
  const database = {
    ping: options?.databaseFails
      ? vi.fn().mockRejectedValue(new Error('database unavailable'))
      : vi.fn().mockResolvedValue(undefined),
  } as unknown as DatabaseService;
  const redis = {
    ping: options?.redisFails
      ? vi.fn().mockRejectedValue(new Error('redis unavailable'))
      : vi.fn().mockResolvedValue(undefined),
  } as unknown as RedisService;
  const storage = {
    ping: options?.storageFails
      ? vi.fn().mockRejectedValue(new Error('storage unavailable'))
      : vi.fn().mockResolvedValue(undefined),
  } as unknown as ObjectStoragePort;
  const config = {
    get: vi.fn().mockReturnValue('voiceverse-test'),
  } as unknown as ConfigService<Environment, true>;

  return new HealthService(database, redis, config, storage);
}

describe('HealthService', () => {
  it('keeps liveness independent from infrastructure', () => {
    expect(
      createService({ databaseFails: true, redisFails: true, storageFails: true }).liveness(),
    ).toMatchObject({
      service: 'voiceverse-api',
      status: 'ok',
    });
  });

  it('returns readiness only when every dependency is healthy', async () => {
    await expect(createService().readiness()).resolves.toMatchObject({
      status: 'ok',
      checks: {
        database: { status: 'up' },
        redis: { status: 'up' },
        storage: { status: 'up' },
      },
    });
  });

  it('returns a sanitized failure when a dependency is unavailable', async () => {
    await expect(createService({ databaseFails: true }).readiness()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    try {
      await createService({ databaseFails: true }).readiness();
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('database unavailable');
    }
  });

  it('fails readiness when the private object bucket is unavailable', async () => {
    await expect(createService({ storageFails: true }).readiness()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
