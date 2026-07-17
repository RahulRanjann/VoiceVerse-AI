import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type Prisma,
  WorkflowAttemptStatus,
  WorkflowEntityType,
  WorkflowJobKind,
  WorkflowJobStatus,
  WorkflowStageKind,
  WorkflowStageStatus,
} from '@voiceverse/database';

import type { Environment } from '../../../config/environment';
import { uuidv7 } from '../../../shared/uuid';
import {
  configurationHash,
  SPEECH_ANALYSIS_PIPELINE_VERSION,
  speechStageDefinitions,
} from '../domain/speech-analysis.constants';

export interface SpeechAnalysisSource {
  analysisArtifactId: string;
  canonicalArtifactId: string;
  createdByUserId: string;
  organizationId: string;
  projectId: string;
  sourceLanguageId: string;
  sourceVideoId: string;
}

export interface SpeechAnalysisInitialization {
  jobId: string;
  speechAnalysisId: string;
}

/**
 * Persists the complete immutable stage graph before any queue wake-up exists.
 * PostgreSQL is authoritative; BullMQ only transports attempt IDs. Upserts make
 * scan replay and the bounded backfill reconciler converge on the same graph.
 */
@Injectable()
export class SpeechAnalysisInitializerService {
  private readonly definitions: ReturnType<typeof speechStageDefinitions>;
  readonly enabled: boolean;

  constructor(config: ConfigService<Environment, true>) {
    this.enabled = config.get('SPEECH_ANALYSIS_ENABLED', { infer: true });
    this.definitions = speechStageDefinitions({
      diarization: {
        modelId: config.get('DIARIZATION_MODEL_ID', { infer: true }),
        modelRevision: config.get('DIARIZATION_MODEL_REVISION', { infer: true }),
        provider: config.get('DIARIZATION_PROVIDER_NAME', { infer: true }),
        runtimeVersion: config.get('DIARIZATION_RUNTIME_VERSION', { infer: true }),
      },
      transcription: {
        modelId: config.get('TRANSCRIPTION_MODEL_ID', { infer: true }),
        modelRevision: config.get('TRANSCRIPTION_MODEL_REVISION', { infer: true }),
        provider: config.get('TRANSCRIPTION_PROVIDER_NAME', { infer: true }),
        runtimeVersion: config.get('TRANSCRIPTION_RUNTIME_VERSION', { infer: true }),
      },
      vocalSeparation: {
        modelId: config.get('VOCAL_SEPARATION_MODEL_ID', { infer: true }),
        modelRevision: config.get('VOCAL_SEPARATION_MODEL_REVISION', { infer: true }),
        provider: config.get('VOCAL_SEPARATION_PROVIDER_NAME', { infer: true }),
        runtimeVersion: config.get('VOCAL_SEPARATION_RUNTIME_VERSION', { infer: true }),
      },
    });
  }

  async initializeIfEnabled(
    transaction: Prisma.TransactionClient,
    source: SpeechAnalysisSource,
  ): Promise<SpeechAnalysisInitialization | null> {
    if (!this.enabled) return null;
    return this.initialize(transaction, source);
  }

  async initialize(
    transaction: Prisma.TransactionClient,
    source: SpeechAnalysisSource,
  ): Promise<SpeechAnalysisInitialization> {
    const job = await transaction.workflowJob.upsert({
      create: {
        createdByUserId: source.createdByUserId,
        id: uuidv7(),
        idempotencyKey: `speech-analysis:${source.sourceVideoId}:${SPEECH_ANALYSIS_PIPELINE_VERSION}`,
        kind: WorkflowJobKind.SPEECH_ANALYSIS,
        organizationId: source.organizationId,
        pipelineVersion: SPEECH_ANALYSIS_PIPELINE_VERSION,
        projectId: source.projectId,
        sourceVideoId: source.sourceVideoId,
        status: WorkflowJobStatus.QUEUED,
      },
      update: {},
      where: {
        sourceVideoId_kind_pipelineVersion: {
          kind: WorkflowJobKind.SPEECH_ANALYSIS,
          pipelineVersion: SPEECH_ANALYSIS_PIPELINE_VERSION,
          sourceVideoId: source.sourceVideoId,
        },
      },
    });

    await this.recordTransition(transaction, {
      deduplicationKey: `workflow-job:${job.id}:queued`,
      entityType: WorkflowEntityType.JOB,
      jobId: job.id,
      toStatus: WorkflowJobStatus.QUEUED,
    });

    const stages = new Map<string, { id: string }>();
    for (const definition of this.definitions) {
      const blocked = definition.dependencies.length > 0;
      const hash = configurationHash(definition.configuration);
      const stage = await transaction.workflowStage.upsert({
        create: {
          configurationHash: hash,
          configurationSnapshot: definition.configuration,
          id: uuidv7(),
          jobId: job.id,
          key: definition.key,
          kind: WorkflowStageKind[definition.kind],
          maxAttempts: definition.maxAttempts,
          ordinal: definition.ordinal,
          progressBasisPoints: 0,
          readyAt: blocked ? null : new Date(),
          status: blocked ? WorkflowStageStatus.BLOCKED : WorkflowStageStatus.QUEUED,
          weightBasisPoints: definition.weightBasisPoints,
        },
        update: {},
        where: { jobId_key: { jobId: job.id, key: definition.key } },
      });
      stages.set(definition.key, stage);
      await this.recordTransition(transaction, {
        deduplicationKey: `workflow-stage:${stage.id}:${blocked ? 'blocked' : 'queued'}`,
        entityType: WorkflowEntityType.STAGE,
        jobId: job.id,
        stageId: stage.id,
        toStatus: blocked ? WorkflowStageStatus.BLOCKED : WorkflowStageStatus.QUEUED,
      });
    }

    for (const definition of this.definitions) {
      const stage = this.requiredStage(stages, definition.key);
      for (const dependencyKey of definition.dependencies) {
        const dependency = this.requiredStage(stages, dependencyKey);
        await transaction.workflowStageDependency.upsert({
          create: {
            dependsOnStageId: dependency.id,
            id: uuidv7(),
            jobId: job.id,
            stageId: stage.id,
          },
          update: {},
          where: {
            stageId_dependsOnStageId: {
              dependsOnStageId: dependency.id,
              stageId: stage.id,
            },
          },
        });
      }
    }

    for (const definition of this.definitions.filter(
      ({ dependencies }) => dependencies.length === 0,
    )) {
      const stage = this.requiredStage(stages, definition.key);
      const attempt = await transaction.workflowStageAttempt.upsert({
        create: {
          attemptNumber: 1,
          commandIdempotencyKey: `workflow-attempt:${stage.id}:1`,
          configurationHash: configurationHash(definition.configuration),
          id: uuidv7(),
          stageId: stage.id,
          status: WorkflowAttemptStatus.QUEUED,
        },
        update: {},
        where: { stageId_attemptNumber: { attemptNumber: 1, stageId: stage.id } },
      });
      await this.recordTransition(transaction, {
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
          eventType: definition.eventType,
          id: uuidv7(),
          organizationId: source.organizationId,
          payload: { attemptId: attempt.id },
        },
        update: {},
        where: { deduplicationKey: attempt.commandIdempotencyKey },
      });
    }

    await this.snapshotInput(transaction, job.id, source, {
      artifactId: source.canonicalArtifactId,
      role: 'VOCAL_SEPARATION_SOURCE',
    });
    await this.snapshotInput(transaction, job.id, source, {
      artifactId: source.analysisArtifactId,
      role: 'DIARIZATION_SOURCE',
    });

    const speechAnalysis = await transaction.speechAnalysis.upsert({
      create: {
        id: uuidv7(),
        organizationId: source.organizationId,
        projectId: source.projectId,
        sourceLanguageId: source.sourceLanguageId,
        sourceVideoId: source.sourceVideoId,
        workflowJobId: job.id,
      },
      update: {},
      where: { workflowJobId: job.id },
    });

    return { jobId: job.id, speechAnalysisId: speechAnalysis.id };
  }

  private async snapshotInput(
    transaction: Prisma.TransactionClient,
    jobId: string,
    source: SpeechAnalysisSource,
    input: { artifactId: string; role: string },
  ): Promise<void> {
    await transaction.workflowJobArtifactInput.upsert({
      create: {
        artifactId: input.artifactId,
        id: uuidv7(),
        jobId,
        organizationId: source.organizationId,
        projectId: source.projectId,
        role: input.role,
        sourceVideoId: source.sourceVideoId,
      },
      update: {},
      where: { jobId_role: { jobId, role: input.role } },
    });
  }

  private requiredStage(stages: Map<string, { id: string }>, key: string): { id: string } {
    const stage = stages.get(key);
    if (!stage) throw new Error(`SpeechAnalysisStageMissing:${key}`);
    return stage;
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
