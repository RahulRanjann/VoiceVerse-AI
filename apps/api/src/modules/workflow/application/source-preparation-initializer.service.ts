import { Injectable } from '@nestjs/common';
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

import { uuidv7 } from '../../../shared/uuid';
import {
  SOURCE_PREPARATION_CONFIGURATION_HASH,
  SOURCE_PREPARATION_CONFIGURATION,
  SOURCE_PREPARATION_EVENT,
  SOURCE_PREPARATION_PIPELINE_VERSION,
  SOURCE_PREPARATION_STAGE_KEY,
} from '../domain/source-preparation.constants';

interface CleanVideoContext {
  createdByUserId: string;
  id: string;
  organizationId: string;
  projectId: string;
}

export interface SourcePreparationInitialization {
  attemptId: string;
  jobId: string;
  stageId: string;
}

/**
 * Creates the authoritative workflow graph inside the same transaction that
 * accepts a clean malware verdict. Every upsert is keyed by stable business
 * identity so replayed scan delivery cannot create duplicate work.
 */
@Injectable()
export class SourcePreparationInitializerService {
  async initialize(
    transaction: Prisma.TransactionClient,
    video: CleanVideoContext,
  ): Promise<SourcePreparationInitialization> {
    const job = await transaction.workflowJob.upsert({
      create: {
        createdByUserId: video.createdByUserId,
        id: uuidv7(),
        idempotencyKey: `source-preparation:${video.id}:${SOURCE_PREPARATION_PIPELINE_VERSION}`,
        kind: WorkflowJobKind.SOURCE_PREPARATION,
        organizationId: video.organizationId,
        pipelineVersion: SOURCE_PREPARATION_PIPELINE_VERSION,
        projectId: video.projectId,
        sourceVideoId: video.id,
        status: WorkflowJobStatus.QUEUED,
      },
      update: {},
      where: {
        sourceVideoId_kind_pipelineVersion: {
          kind: WorkflowJobKind.SOURCE_PREPARATION,
          pipelineVersion: SOURCE_PREPARATION_PIPELINE_VERSION,
          sourceVideoId: video.id,
        },
      },
    });

    const stage = await transaction.workflowStage.upsert({
      create: {
        configurationHash: SOURCE_PREPARATION_CONFIGURATION_HASH,
        configurationSnapshot: SOURCE_PREPARATION_CONFIGURATION,
        id: uuidv7(),
        jobId: job.id,
        key: SOURCE_PREPARATION_STAGE_KEY,
        kind: WorkflowStageKind.SOURCE_MEDIA_PREPARATION,
        maxAttempts: 3,
        ordinal: 0,
        progressBasisPoints: 0,
        status: WorkflowStageStatus.QUEUED,
        weightBasisPoints: 10_000,
      },
      update: {},
      where: { jobId_key: { jobId: job.id, key: SOURCE_PREPARATION_STAGE_KEY } },
    });

    const attempt = await transaction.workflowStageAttempt.upsert({
      create: {
        attemptNumber: 1,
        commandIdempotencyKey: `workflow-attempt:${stage.id}:1`,
        configurationHash: SOURCE_PREPARATION_CONFIGURATION_HASH,
        id: uuidv7(),
        stageId: stage.id,
        status: WorkflowAttemptStatus.QUEUED,
      },
      update: {},
      where: { stageId_attemptNumber: { attemptNumber: 1, stageId: stage.id } },
    });

    await this.recordInitialTransition(transaction, {
      deduplicationKey: `workflow-job:${job.id}:queued`,
      entityType: WorkflowEntityType.JOB,
      jobId: job.id,
      toStatus: WorkflowJobStatus.QUEUED,
    });
    await this.recordInitialTransition(transaction, {
      deduplicationKey: `workflow-stage:${stage.id}:queued`,
      entityType: WorkflowEntityType.STAGE,
      jobId: job.id,
      stageId: stage.id,
      toStatus: WorkflowStageStatus.QUEUED,
    });
    await this.recordInitialTransition(transaction, {
      attemptId: attempt.id,
      deduplicationKey: `workflow-attempt:${attempt.id}:queued`,
      entityType: WorkflowEntityType.ATTEMPT,
      jobId: job.id,
      stageId: stage.id,
      toStatus: WorkflowAttemptStatus.QUEUED,
    });
    await transaction.outboxEvent.upsert({
      create: {
        aggregateId: attempt.id,
        aggregateType: 'workflow_attempt',
        deduplicationKey: attempt.commandIdempotencyKey,
        eventType: SOURCE_PREPARATION_EVENT,
        id: uuidv7(),
        organizationId: video.organizationId,
        payload: { attemptId: attempt.id },
      },
      update: {},
      where: { deduplicationKey: attempt.commandIdempotencyKey },
    });
    await transaction.project.updateMany({
      data: { status: ProjectStatus.PROCESSING },
      where: {
        id: video.projectId,
        organizationId: video.organizationId,
        status: { in: [ProjectStatus.DRAFT, ProjectStatus.INGESTING] },
      },
    });

    return { attemptId: attempt.id, jobId: job.id, stageId: stage.id };
  }

  private async recordInitialTransition(
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
