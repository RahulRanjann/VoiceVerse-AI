import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import type { Environment } from '../../config/environment';

@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly client: Redis;
  private readonly logger = new Logger(RedisService.name);
  private connectPromise?: Promise<void>;

  constructor(config: ConfigService<Environment, true>) {
    this.client = new Redis(config.get('REDIS_URL', { infer: true }), {
      connectTimeout: 1_500,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => Math.min(attempt * 100, 1_000),
    });

    this.client.on('error', (error: Error) => {
      // Never log the Redis URL because it can carry credentials.
      this.logger.warn(`Redis client error: ${error.name}`);
    });
  }

  async ping(): Promise<void> {
    if (this.client.status === 'wait') {
      this.connectPromise ??= this.client.connect();
      try {
        await this.connectPromise;
      } finally {
        this.connectPromise = undefined;
      }
    }

    const response = await this.client.ping();
    if (response !== 'PONG') {
      throw new Error('Redis returned an unexpected ping response.');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client.status === 'ready') {
      await this.client.quit();
      return;
    }

    this.client.disconnect(false);
  }
}
