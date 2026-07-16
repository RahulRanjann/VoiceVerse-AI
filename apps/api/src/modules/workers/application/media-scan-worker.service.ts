import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MalwareScanStatus, MediaSecurityStatus } from '@voiceverse/database';
import { Job, Worker } from 'bullmq';
import Redis from 'ioredis';
import { z } from 'zod';

import type { Environment } from '../../../config/environment';
import { DatabaseService } from '../../../infrastructure/database/database.service';
import { uuidv7 } from '../../../shared/uuid';
import {
  OBJECT_STORAGE,
  type ObjectStoragePort,
} from '../../media-ingest/domain/object-storage.port';
import { MALWARE_SCANNER, type MalwareScannerPort } from '../domain/malware-scanner.port';
import { MEDIA_SECURITY_QUEUE, SCAN_VIDEO_JOB } from '../infrastructure/media-security.queue';

const jobDataSchema = z.object({
  attemptId: z.string().uuid(),
  bucket: z.string().min(1),
  key: z.string().min(1),
  organizationId: z.string().uuid(),
  videoId: z.string().uuid(),
});

@Injectable()
export class MediaScanWorkerService implements OnApplicationShutdown {
  private readonly logger = new Logger(MediaScanWorkerService.name);
  private readonly redisUrl: string;
  private readonly concurrency: number;
  private connection?: Redis;
  private worker?: Worker;

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStoragePort,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScannerPort,
  ) {
    this.redisUrl = config.get('REDIS_URL', { infer: true });
    this.concurrency = config.get('WORKER_CONCURRENCY', { infer: true });
  }

  start(): void {
    if (this.worker) return;
    this.connection = new Redis(this.redisUrl, {
      maxRetriesPerRequest: null,
    });
    this.worker = new Worker(MEDIA_SECURITY_QUEUE, (job) => this.processJob(job), {
      concurrency: this.concurrency,
      connection: this.connection,
    });
    this.worker.on('failed', (job, error) => {
      this.logger.warn({ errorCode: error.name, jobId: job?.id }, 'Media security scan job failed');
    });
    this.worker.on('error', (error) => {
      this.logger.error({ errorCode: error.name }, 'Media security worker error');
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    if (this.connection && this.connection.status !== 'end') await this.connection.quit();
  }

  async processJob(job: Job): Promise<void> {
    if (job.name !== SCAN_VIDEO_JOB) throw new Error('UnsupportedMediaSecurityJob');
    const data = jobDataSchema.parse(job.data);
    const video = await this.database.client.video.findFirst({
      where: {
        id: data.videoId,
        organizationId: data.organizationId,
        storageBucket: data.bucket,
        storageKey: data.key,
      },
    });
    if (!video) throw new Error('MediaScanVideoNotFound');
    if (
      video.securityStatus === MediaSecurityStatus.CLEAN ||
      video.securityStatus === MediaSecurityStatus.INFECTED
    ) {
      return;
    }

    const attemptNumber = job.attemptsMade + 1;
    const attempt = await this.database.client.malwareScanAttempt.upsert({
      create: {
        attemptNumber,
        engine: 'clamav',
        id: attemptNumber === 1 ? data.attemptId : uuidv7(),
        status: MalwareScanStatus.QUEUED,
        videoId: video.id,
      },
      update: {},
      where: { videoId_attemptNumber: { attemptNumber, videoId: video.id } },
    });
    const startedAt = new Date();
    await this.database.client.$transaction([
      this.database.client.malwareScanAttempt.update({
        data: { startedAt, status: MalwareScanStatus.RUNNING },
        where: { id: attempt.id },
      }),
      this.database.client.video.update({
        data: { securityStatus: MediaSecurityStatus.SCANNING },
        where: { id: video.id },
      }),
    ]);

    try {
      const stream = await this.storage.getObjectStream({
        bucket: video.storageBucket,
        key: video.storageKey,
      });
      const result = await this.scanner.scan(stream);
      const completedAt = new Date();
      const infected = result.verdict === 'infected';
      await this.database.client.$transaction([
        this.database.client.malwareScanAttempt.update({
          data: {
            completedAt,
            engineVersion: result.engineVersion,
            findingName: infected ? result.findingName : null,
            signatureVersion: result.signatureVersion,
            status: infected ? MalwareScanStatus.INFECTED : MalwareScanStatus.CLEAN,
          },
          where: { id: attempt.id },
        }),
        this.database.client.video.update({
          data: {
            securityStatus: infected ? MediaSecurityStatus.INFECTED : MediaSecurityStatus.CLEAN,
          },
          where: { id: video.id },
        }),
        this.database.client.auditLog.create({
          data: {
            action: infected ? 'media.scan.infected' : 'media.scan.clean',
            id: uuidv7(),
            organizationId: video.organizationId,
            resourceId: video.id,
            resourceType: 'video',
          },
        }),
      ]);
    } catch (error) {
      const errorCode = error instanceof Error ? error.name : 'UnknownError';
      await this.database.client.$transaction([
        this.database.client.malwareScanAttempt.update({
          data: {
            completedAt: new Date(),
            errorCode: errorCode.slice(0, 100),
            status: MalwareScanStatus.ERROR,
          },
          where: { id: attempt.id },
        }),
        this.database.client.video.update({
          data: { securityStatus: MediaSecurityStatus.ERROR },
          where: { id: video.id },
        }),
      ]);
      throw error;
    }
  }
}
