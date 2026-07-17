import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ProjectStatus,
  type Prisma,
  WorkflowAttemptStatus,
  WorkflowEntityType,
  WorkflowJobKind,
  WorkflowJobStatus,
  WorkflowStageKind,
  WorkflowStageStatus,
} from '@voiceverse/database';
import { hostname } from 'node:os';

import type { Environment } from '../../../config/environment';
import { DatabaseService } from '../../../infrastructure/database/database.service';
import { uuidv7 } from '../../../shared/uuid';
import { SPEECH_STAGE_EVENTS } from '../domain/speech-analysis.constants';

const MAX_CAPACITY_DEFERRALS_PER_ATTEMPT = 12;

const claimedAttemptInclude = {
  stage: {
    include: {
      job: {
        include: {
          artifactInputs: { include: { artifact: { include: { audioMetadata: true } } } },
          project: { include: { sourceLanguage: true } },
          speechAnalysis: true,
        },
      },
    },
  },
} as const;

type AttemptRecord = Prisma.WorkflowStageAttemptGetPayload<{
  include: typeof claimedAttemptInclude;
}>;

export interface ClaimedSpeechAttempt {
  attemptId: string;
  attemptNumber: number;
  configurationHash: string;
  configurationSnapshot: Prisma.JsonValue;
  inputArtifacts: AttemptRecord['stage']['job']['artifactInputs'];
  jobId: string;
  leaseToken: string;
  maxAttempts: number;
  organizationId: string;
  projectId: string;
  sourceLanguageId: string;
  sourceLanguageTag: string;
  sourceVideoId: string;
  speechAnalysisId: string;
  stageId: string;
  stageKey: string;
  stageKind: WorkflowStageKind;
}

export interface SpeechAttemptHeartbeat {
  signal: AbortSignal;
  stop(): void;
}

type CompletionWriter = (transaction: Prisma.TransactionClient) => Promise<void>;

export class WorkflowJobTerminalError extends Error {
  constructor() {
    super('WorkflowJobTerminal');
    this.name = WorkflowJobTerminalError.name;
  }
}

/**
 * Capability-neutral state machine for the four speech-analysis stages. The
 * job row is locked during completion/failure so parallel diarization and ASR
 * commits cannot double-unlock character identification or complete the job
 * from a partially observed graph.
 */
@Injectable()
export class SpeechWorkflowCoordinatorService {
  private readonly logger = new Logger(SpeechWorkflowCoordinatorService.name);
  private readonly deliveryRecoverySeconds: number;
  private readonly leaseSeconds: number;
  private readonly transactionTimeoutMs: number;
  private readonly workerId = `${hostname()}:${process.pid}:${uuidv7()}`;

  constructor(
    private readonly database: DatabaseService,
    config: ConfigService<Environment, true>,
  ) {
    this.leaseSeconds = config.get('WORKFLOW_ATTEMPT_LEASE_SECONDS', { infer: true });
    this.transactionTimeoutMs = config.get('SPEECH_COMPLETION_TRANSACTION_TIMEOUT_MS', {
      infer: true,
    });
    this.deliveryRecoverySeconds = Math.max(
      60,
      config.get('OUTBOX_LEASE_SECONDS', { infer: true }) * 2,
    );
  }

  async claim(
    attemptId: string,
    expectedKind: WorkflowStageKind,
  ): Promise<ClaimedSpeechAttempt | null> {
    return this.database.client.$transaction(async (transaction) => {
      // Claim, completion, and failure all serialize on the workflow job. The
      // first lookup discovers the parent only; the authoritative graph is
      // re-read after the row lock so a sibling's terminal transition cannot
      // be overwritten from a stale attempt snapshot.
      const parent = await transaction.workflowStageAttempt.findUnique({
        select: { stage: { select: { jobId: true } } },
        where: { id: attemptId },
      });
      if (!parent) throw new Error('WorkflowAttemptNotFound');
      await this.lockJob(transaction, parent.stage.jobId);

      const attempt = await transaction.workflowStageAttempt.findUnique({
        include: claimedAttemptInclude,
        where: { id: attemptId },
      });
      if (!attempt) throw new Error('WorkflowAttemptNotFound');
      if (
        attempt.stage.job.kind !== WorkflowJobKind.SPEECH_ANALYSIS ||
        attempt.stage.kind !== expectedKind
      ) {
        throw new Error('SpeechWorkflowAttemptKindMismatch');
      }
      if (!attempt.stage.job.speechAnalysis) throw new Error('SpeechAnalysisRecordMissing');

      const now = new Date();
      if (attempt.status !== WorkflowAttemptStatus.QUEUED) return null;

      const jobActive =
        attempt.stage.job.status === WorkflowJobStatus.QUEUED ||
        attempt.stage.job.status === WorkflowJobStatus.RUNNING;
      const validQueuedParent =
        jobActive &&
        (attempt.stage.status === WorkflowStageStatus.QUEUED ||
          attempt.stage.status === WorkflowStageStatus.RETRY_WAIT) &&
        attempt.stage.readyAt !== null &&
        attempt.stage.readyAt <= now;
      if (!validQueuedParent) return null;

      const leaseToken = uuidv7();
      const leasedUntil = new Date(now.getTime() + this.leaseSeconds * 1_000);
      const won = await transaction.workflowStageAttempt.updateMany({
        data: {
          heartbeatAt: now,
          leaseToken,
          leasedUntil,
          errorCode: null,
          progressBasisPoints: 1_000,
          startedAt: now,
          status: WorkflowAttemptStatus.RUNNING,
          workerId: this.workerId,
        },
        where: { id: attempt.id, status: WorkflowAttemptStatus.QUEUED },
      });
      if (won.count !== 1) return null;

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
        deduplicationKey: `workflow-attempt:${attempt.id}:running:${attempt.recoveryCount}`,
        entityType: WorkflowEntityType.ATTEMPT,
        fromStatus: attempt.status,
        jobId: attempt.stage.job.id,
        stageId: attempt.stage.id,
        toStatus: WorkflowAttemptStatus.RUNNING,
      });
      await this.recordTransition(transaction, {
        deduplicationKey: `workflow-stage:${attempt.stage.id}:running:${attempt.attemptNumber}:${attempt.recoveryCount}`,
        entityType: WorkflowEntityType.STAGE,
        fromStatus: attempt.stage.status,
        jobId: attempt.stage.job.id,
        stageId: attempt.stage.id,
        toStatus: WorkflowStageStatus.RUNNING,
      });
      if (attempt.stage.job.status === WorkflowJobStatus.QUEUED) {
        await this.recordTransition(transaction, {
          deduplicationKey: `workflow-job:${attempt.stage.job.id}:running`,
          entityType: WorkflowEntityType.JOB,
          fromStatus: WorkflowJobStatus.QUEUED,
          jobId: attempt.stage.job.id,
          toStatus: WorkflowJobStatus.RUNNING,
        });
      }

      return {
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        configurationHash: attempt.configurationHash,
        configurationSnapshot: attempt.stage.configurationSnapshot,
        inputArtifacts: attempt.stage.job.artifactInputs,
        jobId: attempt.stage.job.id,
        leaseToken,
        maxAttempts: attempt.stage.maxAttempts,
        organizationId: attempt.stage.job.organizationId,
        projectId: attempt.stage.job.projectId,
        sourceLanguageId: attempt.stage.job.project.sourceLanguageId,
        sourceLanguageTag: attempt.stage.job.project.sourceLanguage.bcp47Tag,
        sourceVideoId: attempt.stage.job.sourceVideoId,
        speechAnalysisId: attempt.stage.job.speechAnalysis.id,
        stageId: attempt.stage.id,
        stageKey: attempt.stage.key,
        stageKind: attempt.stage.kind,
      };
    });
  }

  async complete(
    claimed: ClaimedSpeechAttempt,
    executorVersion: string,
    write: CompletionWriter,
  ): Promise<void> {
    await this.database.client.$transaction(
      async (transaction) => {
        await this.lockJob(transaction, claimed.jobId);
        const job = await transaction.workflowJob.findUniqueOrThrow({
          where: { id: claimed.jobId },
        });
        const jobActive =
          job.status === WorkflowJobStatus.QUEUED || job.status === WorkflowJobStatus.RUNNING;
        // A terminal sibling failure wins through the same job-row lock used by
        // completion. Do not commit normalized output from work that finished
        // after the authoritative job was failed or canceled.
        if (!jobActive) throw new WorkflowJobTerminalError();

        const now = new Date();
        const won = await transaction.workflowStageAttempt.updateMany({
          data: {
            completedAt: now,
            executorVersion: executorVersion.slice(0, 100),
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

        await write(transaction);
        await transaction.workflowStage.update({
          data: {
            completedAt: now,
            progressBasisPoints: 10_000,
            status: WorkflowStageStatus.SUCCEEDED,
          },
          where: { id: claimed.stageId },
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

        await this.unlockReadyStages(transaction, claimed, now);

        const remaining = await transaction.workflowStage.count({
          where: { jobId: claimed.jobId, status: { not: WorkflowStageStatus.SUCCEEDED } },
        });
        if (remaining === 0) {
          await transaction.workflowJob.update({
            data: {
              completedAt: now,
              failureCode: null,
              revision: { increment: 1 },
              status: WorkflowJobStatus.SUCCEEDED,
            },
            where: { id: claimed.jobId },
          });
          await transaction.projectSpeechAnalysisSelection.upsert({
            create: {
              organizationId: claimed.organizationId,
              projectId: claimed.projectId,
              selectedByUserId: null,
              speechAnalysisId: claimed.speechAnalysisId,
            },
            update: {
              revision: { increment: 1 },
              selectedAt: now,
              selectedByUserId: null,
              speechAnalysisId: claimed.speechAnalysisId,
            },
            where: {
              organizationId_projectId: {
                organizationId: claimed.organizationId,
                projectId: claimed.projectId,
              },
            },
          });
          await this.recordTransition(transaction, {
            deduplicationKey: `workflow-job:${claimed.jobId}:succeeded`,
            entityType: WorkflowEntityType.JOB,
            fromStatus: job.status,
            jobId: claimed.jobId,
            toStatus: WorkflowJobStatus.SUCCEEDED,
          });
          await transaction.auditLog.create({
            data: {
              action: 'workflow.speech_analysis.succeeded',
              id: uuidv7(),
              organizationId: claimed.organizationId,
              resourceId: claimed.jobId,
              resourceType: 'workflow_job',
            },
          });
        } else {
          await transaction.workflowJob.update({
            data: { revision: { increment: 1 } },
            where: { id: claimed.jobId },
          });
        }
      },
      { timeout: this.transactionTimeoutMs },
    );
  }

  async fail(
    claimed: ClaimedSpeechAttempt,
    errorCode: string,
    retryable: boolean,
    terminalStatus: 'FAILED' | 'TIMED_OUT' = WorkflowAttemptStatus.FAILED,
    leaseExpiredBefore?: Date,
  ): Promise<boolean> {
    return this.database.client.$transaction(async (transaction) => {
      await this.lockJob(transaction, claimed.jobId);
      const attempt = await transaction.workflowStageAttempt.findUnique({
        include: { stage: { include: { job: true } } },
        where: { id: claimed.attemptId },
      });
      if (!attempt || attempt.status !== WorkflowAttemptStatus.RUNNING) return false;
      const now = new Date();
      const code = errorCode.slice(0, 100);
      const won = await transaction.workflowStageAttempt.updateMany({
        data: {
          completedAt: now,
          errorCode: code,
          errorDetail: null,
          heartbeatAt: now,
          leaseToken: null,
          leasedUntil: null,
          status: terminalStatus,
        },
        where: {
          id: claimed.attemptId,
          leaseToken: claimed.leaseToken,
          ...(leaseExpiredBefore ? { leasedUntil: { lt: leaseExpiredBefore } } : {}),
          status: WorkflowAttemptStatus.RUNNING,
        },
      });
      if (won.count !== 1) return false;
      await this.recordTransition(transaction, {
        attemptId: claimed.attemptId,
        deduplicationKey: `workflow-attempt:${claimed.attemptId}:${terminalStatus.toLowerCase()}`,
        entityType: WorkflowEntityType.ATTEMPT,
        fromStatus: WorkflowAttemptStatus.RUNNING,
        jobId: claimed.jobId,
        reasonCode: code,
        stageId: claimed.stageId,
        toStatus: terminalStatus,
      });

      const jobActive =
        attempt.stage.job.status === WorkflowJobStatus.QUEUED ||
        attempt.stage.job.status === WorkflowJobStatus.RUNNING;
      if (jobActive && retryable && attempt.attemptNumber < attempt.stage.maxAttempts) {
        await this.scheduleRetry(transaction, claimed, attempt.attemptNumber + 1, code, now);
        return true;
      }

      await transaction.workflowStage.update({
        data: { completedAt: now, status: WorkflowStageStatus.FAILED },
        where: { id: claimed.stageId },
      });
      await this.recordTransition(transaction, {
        deduplicationKey: `workflow-stage:${claimed.stageId}:failed`,
        entityType: WorkflowEntityType.STAGE,
        fromStatus: WorkflowStageStatus.RUNNING,
        jobId: claimed.jobId,
        reasonCode: code,
        stageId: claimed.stageId,
        toStatus: WorkflowStageStatus.FAILED,
      });
      if (jobActive) {
        await this.cancelSiblingStages(transaction, claimed.jobId, claimed.stageId, now, code);
        await transaction.workflowJob.update({
          data: {
            completedAt: now,
            failureCode: code,
            revision: { increment: 1 },
            status: WorkflowJobStatus.FAILED,
          },
          where: { id: claimed.jobId },
        });
        await transaction.project.updateMany({
          data: { status: ProjectStatus.FAILED },
          where: { id: claimed.projectId, organizationId: claimed.organizationId },
        });
        await this.recordTransition(transaction, {
          deduplicationKey: `workflow-job:${claimed.jobId}:failed`,
          entityType: WorkflowEntityType.JOB,
          fromStatus: attempt.stage.job.status,
          jobId: claimed.jobId,
          reasonCode: code,
          toStatus: WorkflowJobStatus.FAILED,
        });
        await transaction.auditLog.create({
          data: {
            action: 'workflow.speech_analysis.failed',
            id: uuidv7(),
            metadata: { errorCode: code },
            organizationId: claimed.organizationId,
            resourceId: claimed.jobId,
            resourceType: 'workflow_job',
          },
        });
      }
      return true;
    });
  }

  /**
   * A 429 is rejected before provider execution, so it can safely return the
   * same immutable attempt to the delivery queue without consuming a semantic
   * model attempt. Deferrals are bounded to avoid hiding a broken deployment.
   */
  async deferForCapacity(claimed: ClaimedSpeechAttempt, errorCode: string): Promise<boolean> {
    return this.database.client.$transaction(async (transaction) => {
      await this.lockJob(transaction, claimed.jobId);
      const attempt = await transaction.workflowStageAttempt.findUnique({
        include: { stage: { include: { job: true } } },
        where: { id: claimed.attemptId },
      });
      if (
        !attempt ||
        attempt.status !== WorkflowAttemptStatus.RUNNING ||
        attempt.recoveryCount >= MAX_CAPACITY_DEFERRALS_PER_ATTEMPT ||
        (attempt.stage.job.status !== WorkflowJobStatus.QUEUED &&
          attempt.stage.job.status !== WorkflowJobStatus.RUNNING)
      ) {
        return false;
      }
      const now = new Date();
      const nextDeferral = attempt.recoveryCount + 1;
      const delaySeconds = Math.min(240, 15 * 2 ** Math.min(nextDeferral - 1, 4));
      const readyAt = new Date(now.getTime() + delaySeconds * 1_000);
      const code = errorCode.slice(0, 100);
      const won = await transaction.workflowStageAttempt.updateMany({
        data: {
          errorCode: code,
          heartbeatAt: now,
          leaseToken: null,
          leasedUntil: null,
          progressBasisPoints: 0,
          recoveryCount: { increment: 1 },
          status: WorkflowAttemptStatus.QUEUED,
        },
        where: {
          id: claimed.attemptId,
          leaseToken: claimed.leaseToken,
          recoveryCount: attempt.recoveryCount,
          status: WorkflowAttemptStatus.RUNNING,
        },
      });
      if (won.count !== 1) return false;
      await transaction.workflowStage.update({
        data: { progressBasisPoints: 0, readyAt, status: WorkflowStageStatus.RETRY_WAIT },
        where: { id: claimed.stageId },
      });
      await transaction.workflowJob.update({
        data: { revision: { increment: 1 } },
        where: { id: claimed.jobId },
      });
      await this.recordTransition(transaction, {
        attemptId: claimed.attemptId,
        deduplicationKey: `workflow-attempt:${claimed.attemptId}:capacity-deferred:${nextDeferral}`,
        entityType: WorkflowEntityType.ATTEMPT,
        fromStatus: WorkflowAttemptStatus.RUNNING,
        jobId: claimed.jobId,
        reasonCode: code,
        stageId: claimed.stageId,
        toStatus: WorkflowAttemptStatus.QUEUED,
      });
      await this.recordTransition(transaction, {
        deduplicationKey: `workflow-stage:${claimed.stageId}:capacity-deferred:${claimed.attemptNumber}:${nextDeferral}`,
        entityType: WorkflowEntityType.STAGE,
        fromStatus: WorkflowStageStatus.RUNNING,
        jobId: claimed.jobId,
        reasonCode: code,
        stageId: claimed.stageId,
        toStatus: WorkflowStageStatus.RETRY_WAIT,
      });
      const requeued = await transaction.outboxEvent.updateMany({
        data: {
          availableAt: readyAt,
          lastError: code,
          leaseId: null,
          leasedUntil: null,
          publishedAt: null,
          status: 'PENDING',
        },
        where: {
          deduplicationKey: attempt.commandIdempotencyKey,
          status: 'PUBLISHED',
        },
      });
      if (requeued.count !== 1) throw new Error('SpeechAttemptDeliveryOutboxMissing');
      return true;
    });
  }

  startHeartbeat(claimed: ClaimedSpeechAttempt): SpeechAttemptHeartbeat {
    const interval = Math.max(10_000, Math.floor((this.leaseSeconds * 1_000) / 3));
    const controller = new AbortController();
    const timer = setInterval(() => {
      const now = new Date();
      void this.database.client.workflowStageAttempt
        .updateMany({
          data: {
            heartbeatAt: now,
            leasedUntil: new Date(now.getTime() + this.leaseSeconds * 1_000),
          },
          where: {
            id: claimed.attemptId,
            leaseToken: claimed.leaseToken,
            status: WorkflowAttemptStatus.RUNNING,
          },
        })
        .then(({ count }) => {
          if (count === 1 || controller.signal.aborted) return;
          this.logger.warn(
            { attemptId: claimed.attemptId },
            'Speech workflow lease ownership lost; aborting executor request',
          );
          controller.abort(new Error('WorkflowAttemptLeaseLost'));
          clearInterval(timer);
        })
        .catch((error: unknown) => {
          this.logger.warn(
            {
              attemptId: claimed.attemptId,
              errorCode: error instanceof Error ? error.name : 'UnknownError',
            },
            'Speech workflow heartbeat failed',
          );
        });
    }, interval);
    return {
      signal: controller.signal,
      stop: () => clearInterval(timer),
    };
  }

  async recoverExpiredAttempts(limit = 25): Promise<number> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - this.deliveryRecoverySeconds * 1_000);
    const replayed = await this.database.client.$queryRaw<Array<{ id: string }>>`
      WITH candidates AS (
        SELECT event.id
        FROM outbox_events AS event
        INNER JOIN workflow_stage_attempts AS attempt
          ON attempt.command_idempotency_key = event.deduplication_key
        INNER JOIN workflow_stages AS stage ON stage.id = attempt.stage_id
        INNER JOIN workflow_jobs AS job ON job.id = stage.job_id
        WHERE event.status = 'published'
          AND event.event_type LIKE 'speech.%'
          AND event.published_at < ${staleBefore}
          AND job.status IN ('queued', 'running')
          AND (
            (
              attempt.status = 'queued'
              AND attempt.queued_at < ${staleBefore}
              AND stage.status IN ('queued', 'retry_wait')
              AND stage.ready_at <= ${now}
            )
          )
        ORDER BY event.published_at, event.id
        LIMIT ${limit}
        FOR UPDATE OF event SKIP LOCKED
      )
      UPDATE outbox_events AS event
      SET status = 'pending', available_at = ${now}, last_error = NULL,
          lease_id = NULL, leased_until = NULL, published_at = NULL
      FROM candidates
      WHERE event.id = candidates.id
      RETURNING event.id
    `;

    const expired = await this.database.client.workflowStageAttempt.findMany({
      include: claimedAttemptInclude,
      orderBy: [{ leasedUntil: 'asc' }, { id: 'asc' }],
      take: limit,
      where: {
        leasedUntil: { lt: now },
        stage: {
          job: { kind: WorkflowJobKind.SPEECH_ANALYSIS, status: WorkflowJobStatus.RUNNING },
          status: WorkflowStageStatus.RUNNING,
        },
        status: WorkflowAttemptStatus.RUNNING,
      },
    });
    let timedOut = 0;
    for (const attempt of expired) {
      if (!attempt.leaseToken || !attempt.stage.job.speechAnalysis) continue;
      const claimed = this.toClaimed(attempt, attempt.leaseToken);
      if (
        await this.fail(
          claimed,
          'WORKFLOW_ATTEMPT_LEASE_EXPIRED',
          true,
          WorkflowAttemptStatus.TIMED_OUT,
          now,
        )
      ) {
        timedOut += 1;
      }
    }
    const recovered = replayed.length + timedOut;
    if (recovered > 0) {
      this.logger.warn(
        { replayed: replayed.length, timedOut },
        'Stranded speech workflow deliveries recovered',
      );
    }
    return recovered;
  }

  private async unlockReadyStages(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedSpeechAttempt,
    now: Date,
  ): Promise<void> {
    const ready = await transaction.workflowStage.findMany({
      where: {
        dependencies: { every: { dependsOn: { status: WorkflowStageStatus.SUCCEEDED } } },
        jobId: claimed.jobId,
        status: WorkflowStageStatus.BLOCKED,
      },
    });
    for (const stage of ready) {
      const won = await transaction.workflowStage.updateMany({
        data: { readyAt: now, status: WorkflowStageStatus.QUEUED },
        where: { id: stage.id, status: WorkflowStageStatus.BLOCKED },
      });
      if (won.count !== 1) continue;
      const attempt = await transaction.workflowStageAttempt.create({
        data: {
          attemptNumber: 1,
          commandIdempotencyKey: `workflow-attempt:${stage.id}:1`,
          configurationHash: stage.configurationHash,
          id: uuidv7(),
          stageId: stage.id,
          status: WorkflowAttemptStatus.QUEUED,
        },
      });
      await this.recordTransition(transaction, {
        deduplicationKey: `workflow-stage:${stage.id}:queued`,
        entityType: WorkflowEntityType.STAGE,
        fromStatus: WorkflowStageStatus.BLOCKED,
        jobId: claimed.jobId,
        stageId: stage.id,
        toStatus: WorkflowStageStatus.QUEUED,
      });
      await this.recordTransition(transaction, {
        attemptId: attempt.id,
        deduplicationKey: `workflow-attempt:${attempt.id}:queued`,
        entityType: WorkflowEntityType.ATTEMPT,
        jobId: claimed.jobId,
        stageId: stage.id,
        toStatus: WorkflowAttemptStatus.QUEUED,
      });
      await transaction.outboxEvent.create({
        data: {
          aggregateId: attempt.id,
          aggregateType: 'workflow_attempt',
          deduplicationKey: attempt.commandIdempotencyKey,
          eventType: this.eventForStage(stage.kind),
          id: uuidv7(),
          organizationId: claimed.organizationId,
          payload: { attemptId: attempt.id },
        },
      });
    }
  }

  private async scheduleRetry(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedSpeechAttempt,
    nextAttemptNumber: number,
    errorCode: string,
    now: Date,
  ): Promise<void> {
    const delayMs = 5_000 * 2 ** (nextAttemptNumber - 2);
    const readyAt = new Date(now.getTime() + delayMs);
    const attemptId = uuidv7();
    const commandKey = `workflow-attempt:${claimed.stageId}:${nextAttemptNumber}`;
    await transaction.workflowStageAttempt.create({
      data: {
        attemptNumber: nextAttemptNumber,
        commandIdempotencyKey: commandKey,
        configurationHash: claimed.configurationHash,
        id: attemptId,
        stageId: claimed.stageId,
        status: WorkflowAttemptStatus.QUEUED,
      },
    });
    await transaction.workflowStage.update({
      data: { progressBasisPoints: 0, readyAt, status: WorkflowStageStatus.RETRY_WAIT },
      where: { id: claimed.stageId },
    });
    await transaction.workflowJob.update({
      data: { revision: { increment: 1 } },
      where: { id: claimed.jobId },
    });
    await this.recordTransition(transaction, {
      deduplicationKey: `workflow-stage:${claimed.stageId}:retry:${nextAttemptNumber}`,
      entityType: WorkflowEntityType.STAGE,
      fromStatus: WorkflowStageStatus.RUNNING,
      jobId: claimed.jobId,
      reasonCode: errorCode,
      stageId: claimed.stageId,
      toStatus: WorkflowStageStatus.RETRY_WAIT,
    });
    await this.recordTransition(transaction, {
      attemptId,
      deduplicationKey: `workflow-attempt:${attemptId}:queued`,
      entityType: WorkflowEntityType.ATTEMPT,
      jobId: claimed.jobId,
      stageId: claimed.stageId,
      toStatus: WorkflowAttemptStatus.QUEUED,
    });
    await transaction.outboxEvent.create({
      data: {
        aggregateId: attemptId,
        aggregateType: 'workflow_attempt',
        availableAt: readyAt,
        deduplicationKey: commandKey,
        eventType: this.eventForStage(claimed.stageKind),
        id: uuidv7(),
        organizationId: claimed.organizationId,
        payload: { attemptId },
      },
    });
  }

  private async cancelSiblingStages(
    transaction: Prisma.TransactionClient,
    jobId: string,
    failedStageId: string,
    now: Date,
    reasonCode: string,
  ): Promise<void> {
    const stages = await transaction.workflowStage.findMany({
      include: {
        attempts: {
          where: {
            status: {
              in: [WorkflowAttemptStatus.QUEUED, WorkflowAttemptStatus.RUNNING],
            },
          },
        },
      },
      where: {
        id: { not: failedStageId },
        jobId,
        status: {
          in: [
            WorkflowStageStatus.BLOCKED,
            WorkflowStageStatus.QUEUED,
            WorkflowStageStatus.RETRY_WAIT,
            WorkflowStageStatus.RUNNING,
          ],
        },
      },
    });
    for (const stage of stages) {
      await transaction.workflowStage.update({
        data: { completedAt: now, status: WorkflowStageStatus.CANCELED },
        where: { id: stage.id },
      });
      await this.recordTransition(transaction, {
        deduplicationKey: `workflow-stage:${stage.id}:canceled`,
        entityType: WorkflowEntityType.STAGE,
        fromStatus: stage.status,
        jobId,
        reasonCode,
        stageId: stage.id,
        toStatus: WorkflowStageStatus.CANCELED,
      });
      for (const attempt of stage.attempts) {
        const canceled = await transaction.workflowStageAttempt.updateMany({
          data: {
            completedAt: now,
            errorCode: reasonCode,
            heartbeatAt: now,
            leaseToken: null,
            leasedUntil: null,
            status: WorkflowAttemptStatus.CANCELED,
          },
          where: { id: attempt.id, status: attempt.status },
        });
        if (canceled.count !== 1) continue;
        await this.recordTransition(transaction, {
          attemptId: attempt.id,
          deduplicationKey: `workflow-attempt:${attempt.id}:canceled`,
          entityType: WorkflowEntityType.ATTEMPT,
          fromStatus: attempt.status,
          jobId,
          reasonCode,
          stageId: stage.id,
          toStatus: WorkflowAttemptStatus.CANCELED,
        });
      }
    }
  }

  private async lockJob(transaction: Prisma.TransactionClient, jobId: string): Promise<void> {
    const locked = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM workflow_jobs WHERE id = ${jobId}::uuid FOR UPDATE
    `;
    if (locked.length !== 1) throw new Error('WorkflowJobNotFound');
  }

  private eventForStage(kind: WorkflowStageKind): string {
    switch (kind) {
      case WorkflowStageKind.VOCAL_SEPARATION:
        return SPEECH_STAGE_EVENTS.VOCAL_SEPARATION;
      case WorkflowStageKind.SPEECH_RECOGNITION:
        return SPEECH_STAGE_EVENTS.SPEECH_RECOGNITION;
      case WorkflowStageKind.SPEAKER_DIARIZATION:
        return SPEECH_STAGE_EVENTS.SPEAKER_DIARIZATION;
      case WorkflowStageKind.CHARACTER_IDENTIFICATION:
        return SPEECH_STAGE_EVENTS.CHARACTER_IDENTIFICATION;
      default:
        throw new Error('UnsupportedSpeechWorkflowStage');
    }
  }

  private toClaimed(attempt: AttemptRecord, leaseToken: string): ClaimedSpeechAttempt {
    const analysis = attempt.stage.job.speechAnalysis;
    if (!analysis) throw new Error('SpeechAnalysisRecordMissing');
    return {
      attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber,
      configurationHash: attempt.configurationHash,
      configurationSnapshot: attempt.stage.configurationSnapshot,
      inputArtifacts: attempt.stage.job.artifactInputs,
      jobId: attempt.stage.job.id,
      leaseToken,
      maxAttempts: attempt.stage.maxAttempts,
      organizationId: attempt.stage.job.organizationId,
      projectId: attempt.stage.job.projectId,
      sourceLanguageId: attempt.stage.job.project.sourceLanguageId,
      sourceLanguageTag: attempt.stage.job.project.sourceLanguage.bcp47Tag,
      sourceVideoId: attempt.stage.job.sourceVideoId,
      speechAnalysisId: analysis.id,
      stageId: attempt.stage.id,
      stageKey: attempt.stage.key,
      stageKind: attempt.stage.kind,
    };
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
}
