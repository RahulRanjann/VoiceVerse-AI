import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MediaArtifactKind as DatabaseMediaArtifactKind,
  MediaSecurityStatus,
  MediaStreamKind,
  ProjectStatus,
  type Prisma,
  VideoIngestStatus,
  WorkflowAttemptStatus,
  WorkflowEntityType,
  WorkflowJobKind,
  WorkflowJobStatus,
  WorkflowStageKind,
  WorkflowStageStatus,
} from '@voiceverse/database';
import { Job, Worker } from 'bullmq';
import Redis from 'ioredis';
import { hostname } from 'node:os';
import { z } from 'zod';

import type { Environment } from '../../../config/environment';
import { DatabaseService } from '../../../infrastructure/database/database.service';
import { uuidv7 } from '../../../shared/uuid';
import { MetricsService } from '../../../observability/metrics.service';
import {
  OBJECT_STORAGE,
  type ObjectStoragePort,
} from '../../media-ingest/domain/object-storage.port';
import {
  MEDIA_EXECUTOR,
  MediaExecutorError,
  type MediaExecutorPort,
  type MediaPreparationResult,
  type PreparedArtifactMetadata,
} from '../domain/media-executor.port';
import {
  MEDIA_PROCESSING_QUEUE,
  PREPARE_SOURCE_MEDIA_JOB,
} from '../infrastructure/media-processing.queue';
import { SpeechAnalysisInitializerService } from '../../speech-analysis/application/speech-analysis-initializer.service';
import { SOURCE_PREPARATION_STAGE_KEY } from '../../workflow/domain/source-preparation.constants';

const jobDataSchema = z.object({ attemptId: z.string().uuid() });
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_LEASE_RECOVERIES_PER_ATTEMPT = 1;

type ClaimedAttempt = Awaited<ReturnType<MediaProcessingWorkerService['claimAttempt']>> & object;

@Injectable()
export class MediaProcessingWorkerService implements OnApplicationShutdown {
  private readonly logger = new Logger(MediaProcessingWorkerService.name);
  private readonly concurrency: number;
  private readonly leaseSeconds: number;
  private readonly deliveryRecoverySeconds: number;
  private readonly redisUrl: string;
  private readonly workerId = `${hostname()}:${process.pid}:${uuidv7()}`;
  private connection?: Redis;
  private worker?: Worker;

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStoragePort,
    @Inject(MEDIA_EXECUTOR) private readonly executor: MediaExecutorPort,
    private readonly metrics: MetricsService,
    private readonly speechAnalysisInitializer: SpeechAnalysisInitializerService,
  ) {
    this.concurrency = config.get('MEDIA_PROCESSING_CONCURRENCY', { infer: true });
    this.leaseSeconds = config.get('WORKFLOW_ATTEMPT_LEASE_SECONDS', { infer: true });
    this.deliveryRecoverySeconds = Math.max(
      60,
      config.get('OUTBOX_LEASE_SECONDS', { infer: true }) * 2,
    );
    this.redisUrl = config.get('REDIS_URL', { infer: true });
  }

  start(): void {
    if (this.worker) return;
    this.connection = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(MEDIA_PROCESSING_QUEUE, (job) => this.processJob(job), {
      concurrency: this.concurrency,
      connection: this.connection,
    });
    this.worker.on('failed', (job, error) => {
      this.logger.warn(
        { errorCode: error.name, queueJobId: job?.id },
        'Media processing delivery failed',
      );
    });
    this.worker.on('error', (error) => {
      this.logger.error({ errorCode: error.name }, 'Media processing worker error');
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    if (this.connection && this.connection.status !== 'end') await this.connection.quit();
  }

  async processJob(job: Job): Promise<void> {
    if (job.name !== PREPARE_SOURCE_MEDIA_JOB) throw new Error('UnsupportedMediaProcessingJob');
    const { attemptId } = jobDataSchema.parse(job.data);
    const claimed = await this.claimAttempt(attemptId);
    // A completed or concurrently owned attempt makes duplicate delivery a no-op.
    if (!claimed) return;

    const startedAt = performance.now();
    let outcome: 'failed' | 'succeeded' = 'failed';
    this.metrics.workflowAttemptStarted('source_media_preparation');
    const heartbeat = this.startHeartbeat(claimed.attemptId, claimed.leaseToken);
    try {
      if (claimed.sourceSecurityStatus !== MediaSecurityStatus.CLEAN) {
        throw new MediaExecutorError('SOURCE_SECURITY_NOT_CLEAN', false);
      }
      if (claimed.sourceIngestStatus !== VideoIngestStatus.UPLOADED) {
        throw new MediaExecutorError('SOURCE_UPLOAD_INCOMPLETE', false);
      }
      const expectedSourceSizeBytes = this.toSafeNumber(
        claimed.sourceByteSize,
        'SOURCE_SIZE_UNSUPPORTED',
      );
      if (!claimed.sourceSha256) {
        throw new MediaExecutorError('SOURCE_CHECKSUM_MISSING', false);
      }
      const prefix = this.outputPrefix(claimed);
      const result = await this.executor.prepare({
        analysisAudioKey: `${prefix}/analysis.flac`,
        attemptId: claimed.attemptId,
        bucket: claimed.storageBucket,
        canonicalAudioKey: `${prefix}/canonical.flac`,
        configurationHash: claimed.configurationHash,
        executionId: claimed.jobId,
        expectedSourceSha256: claimed.sourceSha256,
        expectedSourceSizeBytes,
        preferredAudioLanguageTag: claimed.sourceLanguageTag,
        probeManifestKey: `${prefix}/probe-manifest.json`,
        sourceKey: claimed.storageKey,
      });
      await this.verifyArtifacts(claimed, result, prefix);
      await this.completeAttempt(claimed, result, prefix);
      outcome = 'succeeded';
    } catch (error) {
      const failure = this.normalizeFailure(error);
      await this.failAttempt(claimed, failure.code, failure.retryable);
    } finally {
      clearInterval(heartbeat);
      this.metrics.workflowAttemptCompleted(
        'source_media_preparation',
        outcome,
        (performance.now() - startedAt) / 1_000,
      );
    }
  }

  /**
   * Re-publishes durable attempts whose BullMQ wake-up was lost. Expired running
   * attempts retain their identity and immutable output namespace so the next
   * delivery can reconcile a response lost after object creation.
   */
  async recoverExpiredAttempts(limit = 25): Promise<number> {
    const now = new Date();
    const staleQueuedBefore = new Date(now.getTime() - this.deliveryRecoverySeconds * 1_000);
    const stalePublishedBefore = staleQueuedBefore;
    const replayed = await this.database.client.$queryRaw<Array<{ id: string }>>`
      WITH candidates AS (
        SELECT event.id
        FROM outbox_events AS event
        INNER JOIN workflow_stage_attempts AS attempt
          ON attempt.command_idempotency_key = event.deduplication_key
        INNER JOIN workflow_stages AS stage ON stage.id = attempt.stage_id
        INNER JOIN workflow_jobs AS job ON job.id = stage.job_id
        WHERE event.status = 'published'
          AND event.event_type = 'workflow.stage.execute'
          AND job.kind = 'source_preparation'
          AND stage.kind = 'source_media_preparation'
          AND stage.key = ${SOURCE_PREPARATION_STAGE_KEY}
          AND event.published_at < ${stalePublishedBefore}
          AND (
            (
              attempt.status = 'queued'
              AND attempt.queued_at < ${staleQueuedBefore}
              AND stage.status IN ('queued', 'retry_wait')
              AND stage.ready_at <= ${now}
              AND job.status IN ('queued', 'running')
            )
            OR
            (
              attempt.status = 'running'
              AND attempt.leased_until < ${now}
              AND attempt.recovery_count < ${MAX_LEASE_RECOVERIES_PER_ATTEMPT}
              AND stage.status = 'running'
              AND job.status = 'running'
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

    const exhausted = await this.database.client.workflowStageAttempt.findMany({
      orderBy: [{ leasedUntil: 'asc' }, { id: 'asc' }],
      select: { id: true, leaseToken: true },
      take: limit,
      where: {
        leasedUntil: { lt: now },
        recoveryCount: { gte: MAX_LEASE_RECOVERIES_PER_ATTEMPT },
        stage: {
          job: {
            kind: WorkflowJobKind.SOURCE_PREPARATION,
            status: WorkflowJobStatus.RUNNING,
          },
          key: SOURCE_PREPARATION_STAGE_KEY,
          kind: WorkflowStageKind.SOURCE_MEDIA_PREPARATION,
          status: WorkflowStageStatus.RUNNING,
        },
        status: WorkflowAttemptStatus.RUNNING,
      },
    });
    let timedOut = 0;
    for (const attempt of exhausted) {
      if (!attempt.leaseToken) continue;
      const transitioned = await this.failAttemptById(
        attempt.id,
        attempt.leaseToken,
        'WORKFLOW_ATTEMPT_LEASE_EXPIRED',
        true,
        WorkflowAttemptStatus.TIMED_OUT,
        now,
      );
      if (transitioned) timedOut += 1;
    }
    const recovered = replayed.length + timedOut;
    if (recovered > 0) {
      this.logger.warn({ recovered }, 'Stranded workflow deliveries scheduled for replay');
    }
    return recovered;
  }

  private async claimAttempt(attemptId: string) {
    return this.database.client.$transaction(async (transaction) => {
      const attempt = await transaction.workflowStageAttempt.findUnique({
        include: {
          stage: {
            include: {
              job: {
                include: {
                  sourceVideo: true,
                  project: { include: { sourceLanguage: true } },
                },
              },
            },
          },
        },
        where: { id: attemptId },
      });
      if (!attempt) throw new Error('WorkflowAttemptNotFound');
      if (
        attempt.stage.job.kind !== WorkflowJobKind.SOURCE_PREPARATION ||
        attempt.stage.kind !== WorkflowStageKind.SOURCE_MEDIA_PREPARATION ||
        attempt.stage.key !== SOURCE_PREPARATION_STAGE_KEY
      ) {
        throw new Error('SourcePreparationAttemptKindMismatch');
      }
      const now = new Date();
      const recoveringExpiredLease =
        attempt.status === WorkflowAttemptStatus.RUNNING &&
        attempt.leaseToken !== null &&
        attempt.leasedUntil !== null &&
        attempt.leasedUntil < now;
      const claimingQueued = attempt.status === WorkflowAttemptStatus.QUEUED;
      if (!claimingQueued && !recoveringExpiredLease) return null;
      const validQueuedParent =
        claimingQueued &&
        (attempt.stage.status === WorkflowStageStatus.QUEUED ||
          attempt.stage.status === WorkflowStageStatus.RETRY_WAIT) &&
        (attempt.stage.job.status === WorkflowJobStatus.QUEUED ||
          attempt.stage.job.status === WorkflowJobStatus.RUNNING);
      const validRecoveryParent =
        recoveringExpiredLease &&
        attempt.stage.status === WorkflowStageStatus.RUNNING &&
        attempt.stage.job.status === WorkflowJobStatus.RUNNING;
      if (!validQueuedParent && !validRecoveryParent) {
        return null;
      }

      const leasedUntil = new Date(now.getTime() + this.leaseSeconds * 1_000);
      const leaseToken = uuidv7();
      const claimed = await transaction.workflowStageAttempt.updateMany({
        data: {
          heartbeatAt: now,
          leaseToken,
          leasedUntil,
          ...(claimingQueued
            ? {
                progressBasisPoints: 1_000,
                startedAt: now,
                status: WorkflowAttemptStatus.RUNNING,
              }
            : {}),
          ...(recoveringExpiredLease ? { recoveryCount: { increment: 1 } } : {}),
          workerId: this.workerId,
        },
        where: recoveringExpiredLease
          ? {
              id: attempt.id,
              leaseToken: attempt.leaseToken,
              leasedUntil: { lt: now },
              recoveryCount: { lt: MAX_LEASE_RECOVERIES_PER_ATTEMPT },
              status: WorkflowAttemptStatus.RUNNING,
            }
          : { id: attempt.id, status: WorkflowAttemptStatus.QUEUED },
      });
      if (claimed.count !== 1) return null;

      if (claimingQueued) {
        await transaction.workflowStage.update({
          data: {
            progressBasisPoints: 1_000,
            startedAt: attempt.stage.startedAt ?? now,
            status: WorkflowStageStatus.RUNNING,
          },
          where: { id: attempt.stage.id },
        });
        await transaction.workflowJob.update({
          data: {
            revision: { increment: 1 },
            startedAt: attempt.stage.job.startedAt ?? now,
            status: WorkflowJobStatus.RUNNING,
          },
          where: { id: attempt.stage.job.id },
        });
        await this.recordTransition(transaction, {
          attemptId: attempt.id,
          deduplicationKey: `workflow-attempt:${attempt.id}:running`,
          entityType: WorkflowEntityType.ATTEMPT,
          fromStatus: attempt.status,
          jobId: attempt.stage.job.id,
          stageId: attempt.stage.id,
          toStatus: WorkflowAttemptStatus.RUNNING,
        });
        await this.recordTransition(transaction, {
          deduplicationKey: `workflow-stage:${attempt.stage.id}:running:${attempt.attemptNumber}`,
          entityType: WorkflowEntityType.STAGE,
          fromStatus: attempt.stage.status,
          jobId: attempt.stage.job.id,
          stageId: attempt.stage.id,
          toStatus: WorkflowStageStatus.RUNNING,
        });
        await this.recordTransition(transaction, {
          deduplicationKey: `workflow-job:${attempt.stage.job.id}:running`,
          entityType: WorkflowEntityType.JOB,
          fromStatus: attempt.stage.job.status,
          jobId: attempt.stage.job.id,
          toStatus: WorkflowJobStatus.RUNNING,
        });
      } else {
        this.logger.warn(
          { attemptId: attempt.id },
          'Expired workflow attempt lease reclaimed for idempotent reconciliation',
        );
      }

      const video = attempt.stage.job.sourceVideo;
      return {
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        configurationHash: attempt.configurationHash,
        createdByUserId: attempt.stage.job.createdByUserId,
        jobId: attempt.stage.job.id,
        leaseToken,
        maxAttempts: attempt.stage.maxAttempts,
        organizationId: attempt.stage.job.organizationId,
        projectId: attempt.stage.job.projectId,
        sourceByteSize: video.byteSize,
        sourceLanguageTag: attempt.stage.job.project.sourceLanguage.bcp47Tag,
        sourceLanguageId: attempt.stage.job.project.sourceLanguageId,
        sourceIngestStatus: video.ingestStatus,
        sourceSecurityStatus: video.securityStatus,
        sourceSha256: video.sha256,
        stageId: attempt.stage.id,
        storageBucket: video.storageBucket,
        storageKey: video.storageKey,
        videoId: video.id,
      };
    });
  }

  private async completeAttempt(
    claimed: ClaimedAttempt,
    result: MediaPreparationResult,
    prefix: string,
  ): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      const now = new Date();
      const won = await transaction.workflowStageAttempt.updateMany({
        data: {
          completedAt: now,
          executorVersion: result.producerVersion,
          heartbeatAt: now,
          leaseToken: null,
          leasedUntil: null,
          progressBasisPoints: 10_000,
          status: WorkflowAttemptStatus.SUCCEEDED,
        },
        where: {
          id: claimed.attemptId,
          leaseToken: claimed.leaseToken,
          status: WorkflowAttemptStatus.RUNNING,
        },
      });
      if (won.count !== 1) throw new Error('WorkflowAttemptLeaseLost');

      const artifacts = await this.persistArtifacts(transaction, claimed, result, prefix);
      await this.persistProbe(transaction, claimed, result, artifacts.PROBE_MANIFEST);
      await this.speechAnalysisInitializer.initializeIfEnabled(transaction, {
        analysisArtifactId: artifacts.ANALYSIS_AUDIO,
        canonicalArtifactId: artifacts.CANONICAL_AUDIO,
        createdByUserId: claimed.createdByUserId,
        organizationId: claimed.organizationId,
        projectId: claimed.projectId,
        sourceLanguageId: claimed.sourceLanguageId,
        sourceVideoId: claimed.videoId,
      });
      await transaction.workflowStage.update({
        data: {
          completedAt: now,
          progressBasisPoints: 10_000,
          status: WorkflowStageStatus.SUCCEEDED,
        },
        where: { id: claimed.stageId },
      });
      await transaction.workflowJob.update({
        data: {
          completedAt: now,
          failureCode: null,
          revision: { increment: 1 },
          status: WorkflowJobStatus.SUCCEEDED,
        },
        where: { id: claimed.jobId },
      });
      await this.recordTransition(transaction, {
        attemptId: claimed.attemptId,
        deduplicationKey: `workflow-attempt:${claimed.attemptId}:succeeded`,
        entityType: WorkflowEntityType.ATTEMPT,
        fromStatus: WorkflowAttemptStatus.RUNNING,
        jobId: claimed.jobId,
        stageId: claimed.stageId,
        toStatus: WorkflowAttemptStatus.SUCCEEDED,
      });
      await this.recordTransition(transaction, {
        deduplicationKey: `workflow-stage:${claimed.stageId}:succeeded`,
        entityType: WorkflowEntityType.STAGE,
        fromStatus: WorkflowStageStatus.RUNNING,
        jobId: claimed.jobId,
        stageId: claimed.stageId,
        toStatus: WorkflowStageStatus.SUCCEEDED,
      });
      await this.recordTransition(transaction, {
        deduplicationKey: `workflow-job:${claimed.jobId}:succeeded`,
        entityType: WorkflowEntityType.JOB,
        fromStatus: WorkflowJobStatus.RUNNING,
        jobId: claimed.jobId,
        toStatus: WorkflowJobStatus.SUCCEEDED,
      });
      await transaction.auditLog.create({
        data: {
          action: 'workflow.source_preparation.succeeded',
          id: uuidv7(),
          organizationId: claimed.organizationId,
          resourceId: claimed.jobId,
          resourceType: 'workflow_job',
        },
      });
    });
    for (const artifact of result.artifacts) {
      this.metrics.workflowArtifactRegistered(
        artifact.kind.toLowerCase() as 'analysis_audio' | 'canonical_audio' | 'probe_manifest',
        artifact.sizeBytes,
      );
    }
  }

  private async persistArtifacts(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedAttempt,
    result: MediaPreparationResult,
    prefix: string,
  ): Promise<Record<'ANALYSIS_AUDIO' | 'CANONICAL_AUDIO' | 'PROBE_MANIFEST', string>> {
    const keys = {
      ANALYSIS_AUDIO: `${prefix}/analysis.flac`,
      CANONICAL_AUDIO: `${prefix}/canonical.flac`,
      PROBE_MANIFEST: `${prefix}/probe-manifest.json`,
    } as const;
    const artifactIds = {
      ANALYSIS_AUDIO: uuidv7(),
      CANONICAL_AUDIO: uuidv7(),
      PROBE_MANIFEST: uuidv7(),
    };
    for (const kind of Object.keys(keys) as Array<keyof typeof keys>) {
      const metadata = this.artifact(result, kind);
      await transaction.mediaArtifact.create({
        data: {
          byteSize: BigInt(metadata.sizeBytes),
          configurationHash: claimed.configurationHash,
          id: artifactIds[kind],
          kind: DatabaseMediaArtifactKind[kind],
          mediaType: metadata.mediaType,
          organizationId: claimed.organizationId,
          producerAttemptId: claimed.attemptId,
          producerName: 'voiceverse-media-executor',
          producerVersion: result.producerVersion,
          projectId: claimed.projectId,
          sha256: metadata.sha256,
          sourceVideoId: claimed.videoId,
          storageBucket: claimed.storageBucket,
          storageKey: keys[kind],
          ...(kind !== 'PROBE_MANIFEST'
            ? {
                audioMetadata: {
                  create: this.audioArtifactData(metadata),
                },
              }
            : {}),
        },
      });
    }
    await transaction.artifactLineage.createMany({
      data: Object.values(artifactIds).map((outputArtifactId) => ({
        id: uuidv7(),
        inputVideoId: claimed.videoId,
        organizationId: claimed.organizationId,
        outputArtifactId,
        projectId: claimed.projectId,
        role: 'source',
        sourceVideoId: claimed.videoId,
      })),
    });
    return artifactIds;
  }

  private async persistProbe(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedAttempt,
    result: MediaPreparationResult,
    manifestArtifactId: string,
  ): Promise<void> {
    const probeId = uuidv7();
    await transaction.mediaProbe.create({
      data: {
        attemptId: claimed.attemptId,
        bitRate: result.source.bitRate == null ? null : BigInt(result.source.bitRate),
        contractVersion: 1,
        durationMs: BigInt(result.source.durationMs),
        ffprobeVersion: result.tools.ffprobe.slice(0, 100),
        formatName: result.source.containerFormats.join(',').slice(0, 100),
        id: probeId,
        manifestArtifactId,
        sourceVideoId: claimed.videoId,
      },
    });

    const streamIds = new Map<number, string>();
    for (const stream of result.source.audioStreams) {
      const streamId = uuidv7();
      streamIds.set(stream.streamIndex, streamId);
      await transaction.mediaStream.create({
        data: {
          audio: {
            create: {
              channelLayout: stream.channelLayout,
              channels: stream.channels,
              sampleRateHz: stream.sampleRateHz,
            },
          },
          bitRate: stream.bitRate == null ? null : BigInt(stream.bitRate),
          codecName: stream.codecName,
          codecProfile: stream.profile,
          defaultDisposition: stream.isDefault,
          durationMs: stream.durationMs == null ? null : BigInt(stream.durationMs),
          id: streamId,
          kind: MediaStreamKind.AUDIO,
          languageTag: stream.languageTag,
          probeId,
          startTimeMs: stream.startTimeMs == null ? null : BigInt(stream.startTimeMs),
          streamIndex: stream.streamIndex,
          timeBaseDenominator: stream.timeBase?.denominator,
          timeBaseNumerator: stream.timeBase?.numerator,
        },
      });
    }
    for (const stream of result.source.videoStreams) {
      await transaction.mediaStream.create({
        data: {
          bitRate: stream.bitRate == null ? null : BigInt(stream.bitRate),
          codecName: stream.codecName,
          codecProfile: stream.profile,
          defaultDisposition: stream.isDefault,
          durationMs: stream.durationMs == null ? null : BigInt(stream.durationMs),
          id: uuidv7(),
          kind: MediaStreamKind.VIDEO,
          languageTag: stream.languageTag,
          probeId,
          startTimeMs: stream.startTimeMs == null ? null : BigInt(stream.startTimeMs),
          streamIndex: stream.streamIndex,
          timeBaseDenominator: stream.timeBase?.denominator,
          timeBaseNumerator: stream.timeBase?.numerator,
          video: {
            create: {
              frameRateDenominator: stream.frameRate?.denominator,
              frameRateNumerator: stream.frameRate?.numerator,
              height: stream.height,
              width: stream.width,
            },
          },
        },
      });
    }
    const selectedStreamId = streamIds.get(result.source.selectedAudio.streamIndex);
    if (!selectedStreamId) throw new Error('SelectedAudioStreamMissingFromProbe');
    await transaction.mediaTrackSelection.create({
      data: {
        id: uuidv7(),
        probeId,
        role: 'PRIMARY_AUDIO',
        selectionMethod: result.source.audioSelectionMethod.slice(0, 80),
        streamId: selectedStreamId,
      },
    });
  }

  private async failAttempt(
    claimed: ClaimedAttempt,
    errorCode: string,
    retryable: boolean,
  ): Promise<void> {
    await this.failAttemptById(
      claimed.attemptId,
      claimed.leaseToken,
      errorCode,
      retryable,
      WorkflowAttemptStatus.FAILED,
    );
  }

  private async failAttemptById(
    attemptId: string,
    leaseToken: string,
    errorCode: string,
    retryable: boolean,
    terminalStatus: 'FAILED' | 'TIMED_OUT',
    leaseExpiredBefore?: Date,
  ): Promise<boolean> {
    return this.database.client.$transaction(async (transaction) => {
      const attempt = await transaction.workflowStageAttempt.findUnique({
        include: { stage: { include: { job: true } } },
        where: { id: attemptId },
      });
      if (!attempt || attempt.status !== WorkflowAttemptStatus.RUNNING) return false;
      const now = new Date();
      const won = await transaction.workflowStageAttempt.updateMany({
        data: {
          completedAt: now,
          errorCode: errorCode.slice(0, 100),
          errorDetail: null,
          heartbeatAt: now,
          leaseToken: null,
          leasedUntil: null,
          status: terminalStatus,
        },
        where: {
          id: attempt.id,
          leaseToken,
          ...(leaseExpiredBefore ? { leasedUntil: { lt: leaseExpiredBefore } } : {}),
          status: WorkflowAttemptStatus.RUNNING,
        },
      });
      if (won.count !== 1) return false;
      await this.recordTransition(transaction, {
        attemptId: attempt.id,
        deduplicationKey: `workflow-attempt:${attempt.id}:${terminalStatus.toLowerCase()}`,
        entityType: WorkflowEntityType.ATTEMPT,
        fromStatus: WorkflowAttemptStatus.RUNNING,
        jobId: attempt.stage.jobId,
        reasonCode: errorCode.slice(0, 100),
        stageId: attempt.stageId,
        toStatus: terminalStatus,
      });

      if (retryable && attempt.attemptNumber < attempt.stage.maxAttempts) {
        const nextAttemptNumber = attempt.attemptNumber + 1;
        const nextAttemptId = uuidv7();
        const commandKey = `workflow-attempt:${attempt.stageId}:${nextAttemptNumber}`;
        await transaction.workflowStageAttempt.create({
          data: {
            attemptNumber: nextAttemptNumber,
            commandIdempotencyKey: commandKey,
            configurationHash: attempt.configurationHash,
            id: nextAttemptId,
            stageId: attempt.stageId,
          },
        });
        await transaction.workflowStage.update({
          data: {
            progressBasisPoints: 0,
            readyAt: new Date(now.getTime() + 5_000 * 2 ** (nextAttemptNumber - 2)),
            status: WorkflowStageStatus.RETRY_WAIT,
          },
          where: { id: attempt.stageId },
        });
        await transaction.workflowJob.update({
          data: { revision: { increment: 1 } },
          where: { id: attempt.stage.jobId },
        });
        await this.recordTransition(transaction, {
          deduplicationKey: `workflow-stage:${attempt.stageId}:retry:${nextAttemptNumber}`,
          entityType: WorkflowEntityType.STAGE,
          fromStatus: WorkflowStageStatus.RUNNING,
          jobId: attempt.stage.jobId,
          reasonCode: errorCode.slice(0, 100),
          stageId: attempt.stageId,
          toStatus: WorkflowStageStatus.RETRY_WAIT,
        });
        await this.recordTransition(transaction, {
          attemptId: nextAttemptId,
          deduplicationKey: `workflow-attempt:${nextAttemptId}:queued`,
          entityType: WorkflowEntityType.ATTEMPT,
          jobId: attempt.stage.jobId,
          stageId: attempt.stageId,
          toStatus: WorkflowAttemptStatus.QUEUED,
        });
        await transaction.outboxEvent.create({
          data: {
            aggregateId: nextAttemptId,
            aggregateType: 'workflow_attempt',
            availableAt: new Date(now.getTime() + 5_000 * 2 ** (nextAttemptNumber - 2)),
            deduplicationKey: commandKey,
            eventType: 'workflow.stage.execute',
            id: uuidv7(),
            organizationId: attempt.stage.job.organizationId,
            payload: { attemptId: nextAttemptId },
          },
        });
        return true;
      }

      await transaction.workflowStage.update({
        data: { completedAt: now, status: WorkflowStageStatus.FAILED },
        where: { id: attempt.stageId },
      });
      await transaction.workflowJob.update({
        data: {
          completedAt: now,
          failureCode: errorCode.slice(0, 100),
          revision: { increment: 1 },
          status: WorkflowJobStatus.FAILED,
        },
        where: { id: attempt.stage.jobId },
      });
      await transaction.project.updateMany({
        data: { status: ProjectStatus.FAILED },
        where: {
          id: attempt.stage.job.projectId,
          organizationId: attempt.stage.job.organizationId,
        },
      });
      await this.recordTransition(transaction, {
        deduplicationKey: `workflow-stage:${attempt.stageId}:failed`,
        entityType: WorkflowEntityType.STAGE,
        fromStatus: WorkflowStageStatus.RUNNING,
        jobId: attempt.stage.jobId,
        reasonCode: errorCode.slice(0, 100),
        stageId: attempt.stageId,
        toStatus: WorkflowStageStatus.FAILED,
      });
      await this.recordTransition(transaction, {
        deduplicationKey: `workflow-job:${attempt.stage.jobId}:failed`,
        entityType: WorkflowEntityType.JOB,
        fromStatus: attempt.stage.job.status,
        jobId: attempt.stage.jobId,
        reasonCode: errorCode.slice(0, 100),
        toStatus: WorkflowJobStatus.FAILED,
      });
      await transaction.auditLog.create({
        data: {
          action: 'workflow.source_preparation.failed',
          id: uuidv7(),
          metadata: { errorCode: errorCode.slice(0, 100) },
          organizationId: attempt.stage.job.organizationId,
          resourceId: attempt.stage.jobId,
          resourceType: 'workflow_job',
        },
      });
      return true;
    });
  }

  private startHeartbeat(attemptId: string, leaseToken: string): ReturnType<typeof setInterval> {
    const interval = Math.max(10_000, Math.floor((this.leaseSeconds * 1_000) / 3));
    return setInterval(() => {
      const now = new Date();
      void this.database.client.workflowStageAttempt
        .updateMany({
          data: {
            heartbeatAt: now,
            leasedUntil: new Date(now.getTime() + this.leaseSeconds * 1_000),
          },
          where: { id: attemptId, leaseToken, status: WorkflowAttemptStatus.RUNNING },
        })
        .catch((error: unknown) => {
          this.logger.warn(
            { attemptId, errorCode: error instanceof Error ? error.name : 'UnknownError' },
            'Workflow attempt heartbeat failed',
          );
        });
    }, interval);
  }

  private async recordTransition(
    transaction: Prisma.TransactionClient,
    data: Omit<Prisma.WorkflowStateTransitionUncheckedCreateInput, 'id'>,
  ): Promise<void> {
    await transaction.workflowStateTransition.upsert({
      create: { ...data, id: uuidv7() },
      update: {},
      where: { deduplicationKey: data.deduplicationKey },
    });
  }

  private outputPrefix(claimed: ClaimedAttempt): string {
    return `organizations/${claimed.organizationId}/projects/${claimed.projectId}/videos/${claimed.videoId}/attempts/${claimed.attemptId}`;
  }

  private async verifyArtifacts(
    claimed: ClaimedAttempt,
    result: MediaPreparationResult,
    prefix: string,
  ): Promise<void> {
    const keys = {
      ANALYSIS_AUDIO: `${prefix}/analysis.flac`,
      CANONICAL_AUDIO: `${prefix}/canonical.flac`,
      PROBE_MANIFEST: `${prefix}/probe-manifest.json`,
    } as const;

    await Promise.all(
      result.artifacts.map(async (artifact) => {
        const stored = await this.storage.headObject({
          bucket: claimed.storageBucket,
          key: keys[artifact.kind],
        });
        const metadata = stored.metadata ?? {};
        const valid =
          stored.byteSize === artifact.sizeBytes &&
          stored.mediaType === artifact.mediaType &&
          metadata['sha256'] === artifact.sha256 &&
          metadata['artifact-kind'] === artifact.kind.toLowerCase() &&
          metadata['execution-id'] === claimed.jobId &&
          metadata['attempt-id'] === claimed.attemptId &&
          metadata['configuration-hash'] === claimed.configurationHash &&
          metadata['producer'] === 'voiceverse-media-executor' &&
          metadata['producer-version'] === result.producerVersion &&
          metadata['ffmpeg-version'] === result.tools.ffmpeg;
        if (!valid) {
          throw new MediaExecutorError('MEDIA_ARTIFACT_VERIFICATION_FAILED', false);
        }
      }),
    );
  }

  private artifact(
    result: MediaPreparationResult,
    kind: 'ANALYSIS_AUDIO' | 'CANONICAL_AUDIO' | 'PROBE_MANIFEST',
  ): PreparedArtifactMetadata {
    const artifact = result.artifacts.find((candidate) => candidate.kind === kind);
    if (!artifact) throw new Error(`MediaExecutorArtifactMissing:${kind}`);
    return artifact;
  }

  private audioArtifactData(metadata: PreparedArtifactMetadata) {
    if (
      !metadata.codecName ||
      !metadata.sampleRateHz ||
      !metadata.channels ||
      metadata.durationMs == null
    ) {
      throw new Error('MediaExecutorAudioMetadataIncomplete');
    }
    return {
      channels: metadata.channels,
      codecName: metadata.codecName,
      durationMs: BigInt(metadata.durationMs),
      sampleRateHz: metadata.sampleRateHz,
    };
  }

  private normalizeFailure(error: unknown): { code: string; retryable: boolean } {
    if (error instanceof MediaExecutorError) {
      return { code: error.code.slice(0, 100), retryable: error.retryable };
    }
    return {
      code: error instanceof Error ? error.name.slice(0, 100) : 'UNKNOWN_MEDIA_PROCESSING_ERROR',
      retryable: true,
    };
  }

  private toSafeNumber(value: bigint, code: string): number {
    if (value > MAX_SAFE_BIGINT) throw new MediaExecutorError(code, false);
    return Number(value);
  }
}
