import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { z } from 'zod';

import type { Environment } from '../../../config/environment';
import { MEDIA_SECURITY_QUEUE, SCAN_VIDEO_JOB } from './media-security.queue';

const scanRequestSchema = z.object({
  attemptId: z.string().uuid(),
  bucket: z.string().min(1),
  key: z.string().min(1),
  organizationId: z.string().uuid(),
  videoId: z.string().uuid(),
});

@Injectable()
export class QueuePublisherService implements OnApplicationShutdown {
  private readonly connection: Redis;
  private readonly queue: Queue;

  constructor(config: ConfigService<Environment, true>) {
    this.connection = new Redis(config.get('REDIS_URL', { infer: true }), {
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
    this.queue = new Queue(MEDIA_SECURITY_QUEUE, { connection: this.connection });
  }

  async ping(): Promise<void> {
    if (this.connection.status === 'wait') await this.connection.connect();
    const response = await this.connection.ping();
    if (response !== 'PONG') throw new Error('RedisUnexpectedPingResponse');
  }

  async publish(event: {
    eventType: string;
    deduplicationKey: string;
    payload: unknown;
  }): Promise<void> {
    if (event.eventType !== 'media.scan.requested') {
      throw new Error('UnsupportedOutboxEvent');
    }
    const payload = scanRequestSchema.parse(event.payload);
    const jobId = `outbox-${createHash('sha256').update(event.deduplicationKey).digest('hex')}`;
    await this.queue.add(SCAN_VIDEO_JOB, payload, {
      attempts: 5,
      backoff: { delay: 5_000, type: 'exponential' },
      jobId,
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: { age: 604_800, count: 5_000 },
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
    if (this.connection.status !== 'end') await this.connection.quit();
  }
}
