import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

import { DatabaseService } from '../infrastructure/database/database.service';
import { RedisService } from '../infrastructure/redis/redis.service';
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

  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  liveness(): HealthResponseDto {
    return {
      service: 'voiceverse-api',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  async readiness(): Promise<ReadinessResponseDto> {
    const [databaseResult, redisResult] = await Promise.allSettled([
      checkDependency(() => this.database.ping()),
      checkDependency(() => this.redis.ping()),
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
    };

    if (databaseResult.status === 'rejected' || redisResult.status === 'rejected') {
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
