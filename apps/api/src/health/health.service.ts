import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../config/environment';
import { DatabaseService } from '../infrastructure/database/database.service';
import { RedisService } from '../infrastructure/redis/redis.service';
import {
  OBJECT_STORAGE,
  type ObjectStoragePort,
} from '../modules/media-ingest/domain/object-storage.port';
import type { HealthResponseDto, ReadinessCheckDto, ReadinessResponseDto } from './health.dto';

const DEPENDENCY_TIMEOUT_MS = 2_000;

async function checkDependency(check: () => Promise<void>): Promise<ReadinessCheckDto> {
  const startedAt = performance.now();
  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      check(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Dependency health check timed out.')),
          DEPENDENCY_TIMEOUT_MS,
        );
        timer.unref();
      }),
    ]);
    return { status: 'up', latencyMs: Math.round(performance.now() - startedAt) };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly bucket: string;

  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    config: ConfigService<Environment, true>,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStoragePort,
  ) {
    this.bucket = config.get('S3_BUCKET', { infer: true });
  }

  liveness(): HealthResponseDto {
    return {
      service: 'voiceverse-api',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  async readiness(): Promise<ReadinessResponseDto> {
    const [databaseResult, redisResult, storageResult] = await Promise.allSettled([
      checkDependency(() => this.database.ping()),
      checkDependency(() => this.redis.ping()),
      checkDependency(() => this.storage.ping(this.bucket)),
    ]);

    const checks: Record<string, ReadinessCheckDto> = {
      database:
        databaseResult.status === 'fulfilled'
          ? databaseResult.value
          : { status: 'down', latencyMs: DEPENDENCY_TIMEOUT_MS },
      redis:
        redisResult.status === 'fulfilled'
          ? redisResult.value
          : { status: 'down', latencyMs: DEPENDENCY_TIMEOUT_MS },
      storage:
        storageResult.status === 'fulfilled'
          ? storageResult.value
          : { status: 'down', latencyMs: DEPENDENCY_TIMEOUT_MS },
    };

    if (
      databaseResult.status === 'rejected' ||
      redisResult.status === 'rejected' ||
      storageResult.status === 'rejected'
    ) {
      this.logger.warn('Readiness check failed for one or more dependencies.');
      throw new ServiceUnavailableException({
        service: 'voiceverse-api',
        status: 'error',
        timestamp: new Date().toISOString(),
        checks,
      } satisfies ReadinessResponseDto);
    }

    return {
      service: 'voiceverse-api',
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks,
    };
  }
}
