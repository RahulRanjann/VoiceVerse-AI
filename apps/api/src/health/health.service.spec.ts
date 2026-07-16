import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService } from '../infrastructure/database/database.service';
import type { RedisService } from '../infrastructure/redis/redis.service';
import { HealthService } from './health.service';

function createService(options?: { databaseFails?: boolean; redisFails?: boolean }) {
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

  return new HealthService(database, redis);
}

describe('HealthService', () => {
  it('keeps liveness independent from infrastructure', () => {
    expect(createService({ databaseFails: true, redisFails: true }).liveness()).toMatchObject({
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
});
