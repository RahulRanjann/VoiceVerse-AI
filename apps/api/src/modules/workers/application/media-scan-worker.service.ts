import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MalwareScanStatus, MediaSecurityStatus } from '@voiceverse/database';
import { Job, Worker } from 'bullmq';
import { createHash, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import Redis from 'ioredis';
import { z } from 'zod';

import type { Environment } from '../../../config/environment';
import { DatabaseService } from '../../../infrastructure/database/database.service';
import { uuidv7 } from '../../../shared/uuid';
import {
  OBJECT_STORAGE,
  type ObjectStoragePort,
} from '../../media-ingest/domain/object-storage.port';
import { SourcePreparationInitializerService } from '../../workflow/application/source-preparation-initializer.service';
import { MALWARE_SCANNER, type MalwareScannerPort } from '../domain/malware-scanner.port';
import { MEDIA_SECURITY_QUEUE, SCAN_VIDEO_JOB } from '../infrastructure/media-security.queue';

const jobDataSchema = z.object({
  attemptId: z.string().uuid(),
  bucket: z.string().min(1),
  key: z.string().min(1),
  organizationId: z.string().uuid(),
  videoId: z.string().uuid(),
});
const MAX_SCAN_LEASE_RECOVERIES = 1;

@Injectable()
export class MediaScanWorkerService implements OnApplicationShutdown {
  private readonly logger = new Logger(MediaScanWorkerService.name);
  private readonly redisUrl: string;
  private readonly concurrency: number;
  private readonly deliveryRecoverySeconds: number;
  private readonly leaseSeconds: number;
  private readonly workerId = `${hostname()}:${process.pid}:${uuidv7()}`;
  private connection?: Redis;
  private worker?: Worker;

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStoragePort,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScannerPort,
    private readonly sourcePreparation: SourcePreparationInitializerService,
  ) {
    this.redisUrl = config.get('REDIS_URL', { infer: true });
    this.concurrency = config.get('WORKER_CONCURRENCY', { infer: true });
    this.leaseSeconds = config.get('MEDIA_SCAN_LEASE_SECONDS', { infer: true });
    this.deliveryRecoverySeconds = Math.max(
      60,
      config.get('OUTBOX_LEASE_SECONDS', { infer: true }) * 2,
    );
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

    const attempt = await this.database.client.malwareScanAttempt.findFirst({
      where: { id: data.attemptId, videoId: video.id },
    });
    if (!attempt) throw new Error('MediaScanAttemptNotFound');
    if (
      attempt.status === MalwareScanStatus.CLEAN ||
      attempt.status === MalwareScanStatus.INFECTED
    ) {
      return;
    }
    const startedAt = new Date();
    const recoveringExpiredLease =
      attempt.status === MalwareScanStatus.RUNNING &&
      attempt.leaseToken !== null &&
      attempt.leasedUntil !== null &&
      attempt.leasedUntil < startedAt &&
      attempt.recoveryCount < MAX_SCAN_LEASE_RECOVERIES;
    if (!recoveringExpiredLease && attempt.status !== MalwareScanStatus.QUEUED) {
      return;
    }
    const leaseToken = uuidv7();
    const leasedUntil = new Date(startedAt.getTime() + this.leaseSeconds * 1_000);
    const claimed = await this.database.client.$transaction(async (transaction) => {
      const result = await transaction.malwareScanAttempt.updateMany({
        data: {
          completedAt: null,
          errorCode: null,
          heartbeatAt: startedAt,
          leaseToken,
          leasedUntil,
          ...(recoveringExpiredLease ? { recoveryCount: { increment: 1 } } : {}),
          startedAt: attempt.startedAt ?? startedAt,
          status: MalwareScanStatus.RUNNING,
          workerId: this.workerId,
        },
        where: recoveringExpiredLease
          ? {
              id: attempt.id,
              leaseToken: attempt.leaseToken,
              leasedUntil: { lt: startedAt },
              recoveryCount: { lt: MAX_SCAN_LEASE_RECOVERIES },
              status: MalwareScanStatus.RUNNING,
            }
          : {
              id: attempt.id,
              status: MalwareScanStatus.QUEUED,
            },
      });
      if (result.count !== 1) return false;
      await transaction.video.update({
        data: { securityStatus: MediaSecurityStatus.SCANNING },
        where: { id: video.id },
      });
      return true;
    });
    // A second at-least-once delivery must not scan concurrently with the owner.
    if (!claimed) return;

    const heartbeat = this.startHeartbeat(attempt.id, leaseToken);
    try {
      const source = await this.storage.getObjectStream({
        bucket: video.storageBucket,
        key: video.storageKey,
      });
      const hash = createHash('sha256');
      const result = await this.scanner.scan(this.hashingStream(source, hash));
      const computedSha256 = hash.digest('hex');
      if (video.sha256 && !this.checksumsMatch(video.sha256, computedSha256)) {
        const mismatch = new Error('The source object checksum does not match its ingest record.');
        mismatch.name = 'SourceChecksumMismatch';
        throw mismatch;
      }
      const completedAt = new Date();
      const infected = result.verdict === 'infected';
      await this.database.client.$transaction(async (transaction) => {
        const won = await transaction.malwareScanAttempt.updateMany({
          data: {
            completedAt,
            engineVersion: result.engineVersion,
            findingName: infected ? result.findingName : null,
            heartbeatAt: completedAt,
            leaseToken: null,
            leasedUntil: null,
            signatureVersion: result.signatureVersion,
            status: infected ? MalwareScanStatus.INFECTED : MalwareScanStatus.CLEAN,
          },
          where: {
            id: attempt.id,
            leaseToken,
            status: MalwareScanStatus.RUNNING,
          },
        });
        if (won.count !== 1) throw new Error('MediaScanLeaseLost');
        await transaction.video.update({
          data: {
            sha256: computedSha256,
            securityStatus: infected ? MediaSecurityStatus.INFECTED : MediaSecurityStatus.CLEAN,
          },
          where: { id: video.id },
        });
        await transaction.auditLog.create({
          data: {
            action: infected ? 'media.scan.infected' : 'media.scan.clean',
            id: uuidv7(),
            organizationId: video.organizationId,
            resourceId: video.id,
            resourceType: 'video',
          },
        });
        if (!infected) await this.sourcePreparation.initialize(transaction, video);
      });
    } catch (error) {
      const errorCode = error instanceof Error ? error.name : 'UnknownError';
      const configuredAttempts = typeof job.opts?.attempts === 'number' ? job.opts.attempts : 1;
      const permanentError = new Set(['ClamdStreamLimitExceeded', 'SourceChecksumMismatch']).has(
        errorCode,
      );
      const willRetry = !permanentError && job.attemptsMade + 1 < configuredAttempts;
      const persisted = await this.database.client.$transaction(async (transaction) => {
        const won = await transaction.malwareScanAttempt.updateMany({
          data: {
            completedAt: willRetry ? null : new Date(),
            errorCode: errorCode.slice(0, 100),
            heartbeatAt: new Date(),
            leaseToken: null,
            leasedUntil: null,
            status: willRetry ? MalwareScanStatus.QUEUED : MalwareScanStatus.ERROR,
          },
          where: { id: attempt.id, leaseToken, status: MalwareScanStatus.RUNNING },
        });
        if (won.count !== 1) return false;
        await transaction.video.update({
          data: {
            securityStatus: willRetry ? MediaSecurityStatus.PENDING : MediaSecurityStatus.ERROR,
          },
          where: { id: video.id },
        });
        return true;
      });
      if (!persisted) return;
      // Permanent content/policy failures are authoritative terminal outcomes;
      // acknowledging the transport delivery prevents BullMQ from downloading
      // and scanning the same feature-length object repeatedly.
      if (permanentError) return;
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Replays lost scan commands and terminally closes exhausted scan leases. */
  async recoverExpiredAttempts(limit = 25): Promise<number> {
    const now = new Date();
    const stalePublishedBefore = new Date(now.getTime() - this.deliveryRecoverySeconds * 1_000);
    const replayed = await this.database.client.$queryRaw<Array<{ id: string }>>`
      WITH candidates AS (
        SELECT event.id
        FROM outbox_events AS event
        INNER JOIN malware_scan_attempts AS attempt
          ON event.payload ->> 'attemptId' = attempt.id::text
        INNER JOIN videos AS video ON video.id = attempt.video_id
        WHERE event.status = 'published'
          AND event.event_type = 'media.scan.requested'
          AND event.published_at < ${stalePublishedBefore}
          AND video.ingest_status = 'uploaded'
          AND (
            (
              attempt.status = 'queued'
              AND video.security_status = 'pending'
            )
            OR
            (
              attempt.status = 'running'
              AND attempt.leased_until < ${now}
              AND attempt.recovery_count < ${MAX_SCAN_LEASE_RECOVERIES}
              AND video.security_status = 'scanning'
            )
          )
        ORDER BY event.published_at, event.id
        LIMIT ${limit}
        FOR UPDATE OF event SKIP LOCKED
      )
      UPDATE outbox_events AS event
      SET status = 'pending',
          available_at = ${now},
          last_error = NULL,
          lease_id = NULL,
          leased_until = NULL,
          published_at = NULL
      FROM candidates
      WHERE event.id = candidates.id
      RETURNING event.id
    `;

    const exhausted = await this.database.client.malwareScanAttempt.findMany({
      orderBy: [{ leasedUntil: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        leaseToken: true,
        video: { select: { organizationId: true } },
        videoId: true,
      },
      take: limit,
      where: {
        leasedUntil: { lt: now },
        recoveryCount: { gte: MAX_SCAN_LEASE_RECOVERIES },
        status: MalwareScanStatus.RUNNING,
        video: {
          ingestStatus: 'UPLOADED',
          securityStatus: MediaSecurityStatus.SCANNING,
        },
      },
    });
    let timedOut = 0;
    for (const attempt of exhausted) {
      if (!attempt.leaseToken) continue;
      const won = await this.database.client.$transaction(async (transaction) => {
        const completedAt = new Date();
        const updated = await transaction.malwareScanAttempt.updateMany({
          data: {
            completedAt,
            errorCode: 'MEDIA_SCAN_LEASE_EXPIRED',
            heartbeatAt: completedAt,
            leaseToken: null,
            leasedUntil: null,
            status: MalwareScanStatus.ERROR,
          },
          where: {
            id: attempt.id,
            leaseToken: attempt.leaseToken,
            leasedUntil: { lt: now },
            status: MalwareScanStatus.RUNNING,
          },
        });
        if (updated.count !== 1) return false;
        await transaction.video.updateMany({
          data: { securityStatus: MediaSecurityStatus.ERROR },
          where: { id: attempt.videoId, securityStatus: MediaSecurityStatus.SCANNING },
        });
        await transaction.auditLog.create({
          data: {
            action: 'media.scan.failed',
            id: uuidv7(),
            metadata: { errorCode: 'MEDIA_SCAN_LEASE_EXPIRED' },
            organizationId: attempt.video.organizationId,
            resourceId: attempt.videoId,
            resourceType: 'video',
          },
        });
        return true;
      });
      if (won) timedOut += 1;
    }
    return replayed.length + timedOut;
  }

  private startHeartbeat(attemptId: string, leaseToken: string): ReturnType<typeof setInterval> {
    const interval = Math.max(10_000, Math.floor((this.leaseSeconds * 1_000) / 3));
    return setInterval(() => {
      const now = new Date();
      void this.database.client.malwareScanAttempt
        .updateMany({
          data: {
            heartbeatAt: now,
            leasedUntil: new Date(now.getTime() + this.leaseSeconds * 1_000),
          },
          where: { id: attemptId, leaseToken, status: MalwareScanStatus.RUNNING },
        })
        .catch((error: unknown) => {
          this.logger.warn(
            { attemptId, errorCode: error instanceof Error ? error.name : 'UnknownError' },
            'Media scan heartbeat failed',
          );
        });
    }, interval);
  }

  private async *hashingStream(
    source: AsyncIterable<Uint8Array>,
    hash: ReturnType<typeof createHash>,
  ): AsyncGenerator<Uint8Array> {
    for await (const chunk of source) {
      hash.update(chunk);
      yield chunk;
    }
  }

  private checksumsMatch(expected: string, actual: string): boolean {
    const expectedBytes = Buffer.from(expected, 'hex');
    const actualBytes = Buffer.from(actual, 'hex');
    return (
      expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes)
    );
  }
}
