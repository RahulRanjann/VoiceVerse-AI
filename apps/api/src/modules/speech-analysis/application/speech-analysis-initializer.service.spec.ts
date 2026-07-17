import type { ConfigService } from '@nestjs/config';
import {
  type Prisma,
  WorkflowAttemptStatus,
  WorkflowJobKind,
  WorkflowJobStatus,
  WorkflowStageStatus,
} from '@voiceverse/database';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import {
  SPEECH_ANALYSIS_PIPELINE_VERSION,
  SPEECH_STAGE_DEFINITIONS,
  SPEECH_STAGE_EVENTS,
  SPEECH_STAGE_KEYS,
} from '../domain/speech-analysis.constants';
import {
  SpeechAnalysisInitializerService,
  type SpeechAnalysisSource,
} from './speech-analysis-initializer.service';

const jobId = '01900000-0000-7000-8000-000000000301';
const speechAnalysisId = '01900000-0000-7000-8000-000000000302';

interface ReplayableUpsertInput<TCreate> {
  create: TCreate;
  update: Record<string, never>;
  where: Record<string, unknown>;
}

interface StageCreateInput {
  configurationHash: string;
  configurationSnapshot: unknown;
  key: string;
  readyAt: Date | null;
  status: WorkflowStageStatus;
}

interface AttemptCreateInput {
  stageId: string;
  status: WorkflowAttemptStatus;
}

interface OutboxCreateInput {
  aggregateType: string;
  eventType: string;
  organizationId: string;
  payload: { attemptId: string };
}

interface DependencyCreateInput {
  dependsOnStageId: string;
  stageId: string;
}

interface ArtifactInputCreateInput {
  artifactId: string;
  jobId: string;
  organizationId: string;
  projectId: string;
  role: string;
  sourceVideoId: string;
}

const source: SpeechAnalysisSource = {
  analysisArtifactId: '01900000-0000-7000-8000-000000000303',
  canonicalArtifactId: '01900000-0000-7000-8000-000000000304',
  createdByUserId: '01900000-0000-7000-8000-000000000305',
  organizationId: '01900000-0000-7000-8000-000000000306',
  projectId: '01900000-0000-7000-8000-000000000307',
  sourceLanguageId: '01900000-0000-7000-8000-000000000308',
  sourceVideoId: '01900000-0000-7000-8000-000000000309',
};

function config(enabled: boolean): ConfigService<Environment, true> {
  const values: Partial<Environment> = {
    DIARIZATION_MODEL_ID: 'pyannote-community-1',
    DIARIZATION_MODEL_REVISION: 'diarization-sha',
    DIARIZATION_PROVIDER_NAME: 'pyannote',
    DIARIZATION_RUNTIME_VERSION: 'pyannote-runtime-sha',
    SPEECH_ANALYSIS_ENABLED: enabled,
    TRANSCRIPTION_MODEL_ID: 'faster-whisper-large-v3',
    TRANSCRIPTION_MODEL_REVISION: 'transcription-sha',
    TRANSCRIPTION_PROVIDER_NAME: 'faster-whisper',
    TRANSCRIPTION_RUNTIME_VERSION: 'faster-whisper-runtime-sha',
    VOCAL_SEPARATION_MODEL_ID: 'separator-model',
    VOCAL_SEPARATION_MODEL_REVISION: 'separator-sha',
    VOCAL_SEPARATION_PROVIDER_NAME: 'audio-separator',
    VOCAL_SEPARATION_RUNTIME_VERSION: 'audio-separator-runtime-sha',
  };
  return {
    get: vi.fn((key: keyof Environment) => values[key]),
  } as unknown as ConfigService<Environment, true>;
}

function createTransactionHarness() {
  const stageIds = new Map<string, string>(
    SPEECH_STAGE_DEFINITIONS.map(
      (definition, index) =>
        [
          definition.key,
          `01900000-0000-7000-8000-${String(index + 310).padStart(12, '0')}`,
        ] as const,
    ),
  );
  const workflowJobUpsert = vi
    .fn<(input: ReplayableUpsertInput<Record<string, unknown>>) => Promise<{ id: string }>>()
    .mockResolvedValue({ id: jobId });
  const workflowStageUpsert = vi
    .fn<(input: ReplayableUpsertInput<StageCreateInput>) => Promise<{ id: string }>>()
    .mockImplementation((input) => {
      const id = stageIds.get(input.create.key);
      if (!id) throw new Error(`TestStageMissing:${input.create.key}`);
      return Promise.resolve({ id });
    });
  const workflowStageAttemptUpsert = vi
    .fn<
      (
        input: ReplayableUpsertInput<AttemptCreateInput>,
      ) => Promise<{ commandIdempotencyKey: string; id: string }>
    >()
    .mockImplementation((input) =>
      Promise.resolve({
        commandIdempotencyKey: `workflow-attempt:${input.create.stageId}:1`,
        id: `${input.create.stageId.slice(0, -1)}9`,
      }),
    );
  const workflowStageDependencyUpsert = vi
    .fn<(input: ReplayableUpsertInput<DependencyCreateInput>) => Promise<object>>()
    .mockResolvedValue({});
  const workflowStateTransitionUpsert = vi
    .fn<(input: ReplayableUpsertInput<Record<string, unknown>>) => Promise<object>>()
    .mockResolvedValue({});
  const outboxEventUpsert = vi
    .fn<(input: ReplayableUpsertInput<OutboxCreateInput>) => Promise<object>>()
    .mockResolvedValue({});
  const workflowJobArtifactInputUpsert = vi
    .fn<(input: ReplayableUpsertInput<ArtifactInputCreateInput>) => Promise<object>>()
    .mockResolvedValue({});
  const speechAnalysisUpsert = vi
    .fn<(input: ReplayableUpsertInput<Record<string, unknown>>) => Promise<{ id: string }>>()
    .mockResolvedValue({ id: speechAnalysisId });
  const transaction = {
    outboxEvent: { upsert: outboxEventUpsert },
    speechAnalysis: { upsert: speechAnalysisUpsert },
    workflowJob: { upsert: workflowJobUpsert },
    workflowJobArtifactInput: { upsert: workflowJobArtifactInputUpsert },
    workflowStage: { upsert: workflowStageUpsert },
    workflowStageAttempt: { upsert: workflowStageAttemptUpsert },
    workflowStageDependency: { upsert: workflowStageDependencyUpsert },
    workflowStateTransition: { upsert: workflowStateTransitionUpsert },
  };
  return {
    outboxEventUpsert,
    speechAnalysisUpsert,
    stageIds,
    transaction: transaction as unknown as Prisma.TransactionClient,
    workflowJobArtifactInputUpsert,
    workflowJobUpsert,
    workflowStageAttemptUpsert,
    workflowStageDependencyUpsert,
    workflowStageUpsert,
    workflowStateTransitionUpsert,
  };
}

describe('SpeechAnalysisInitializerService', () => {
  it('is a true no-op when the speech-analysis feature is disabled', async () => {
    const harness = createTransactionHarness();
    const service = new SpeechAnalysisInitializerService(config(false));

    await expect(service.initializeIfEnabled(harness.transaction, source)).resolves.toBeNull();

    expect(harness.workflowJobUpsert).not.toHaveBeenCalled();
    expect(harness.workflowStageUpsert).not.toHaveBeenCalled();
    expect(harness.outboxEventUpsert).not.toHaveBeenCalled();
  });

  it('persists the full DAG before creating exactly the two root deliveries', async () => {
    const harness = createTransactionHarness();
    const service = new SpeechAnalysisInitializerService(config(true));

    await expect(service.initializeIfEnabled(harness.transaction, source)).resolves.toEqual({
      jobId,
      speechAnalysisId,
    });

    expect(harness.workflowJobUpsert).toHaveBeenCalledWith({
      create: expect.objectContaining({
        idempotencyKey: `speech-analysis:${source.sourceVideoId}:${SPEECH_ANALYSIS_PIPELINE_VERSION}`,
        kind: WorkflowJobKind.SPEECH_ANALYSIS,
        organizationId: source.organizationId,
        pipelineVersion: SPEECH_ANALYSIS_PIPELINE_VERSION,
        projectId: source.projectId,
        sourceVideoId: source.sourceVideoId,
        status: WorkflowJobStatus.QUEUED,
      }),
      update: {},
      where: {
        sourceVideoId_kind_pipelineVersion: {
          kind: WorkflowJobKind.SPEECH_ANALYSIS,
          pipelineVersion: SPEECH_ANALYSIS_PIPELINE_VERSION,
          sourceVideoId: source.sourceVideoId,
        },
      },
    });
    expect(harness.workflowStageUpsert).toHaveBeenCalledTimes(4);
    const stages = harness.workflowStageUpsert.mock.calls.map(([input]) => input.create);
    expect(stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          configurationSnapshot: expect.objectContaining({
            provider: {
              modelId: 'separator-model',
              modelRevision: 'separator-sha',
              provider: 'audio-separator',
              runtimeVersion: 'audio-separator-runtime-sha',
            },
          }),
          key: SPEECH_STAGE_KEYS.VOCAL_SEPARATION,
          readyAt: expect.any(Date),
          status: WorkflowStageStatus.QUEUED,
        }),
        expect.objectContaining({
          configurationSnapshot: expect.objectContaining({
            provider: {
              modelId: 'pyannote-community-1',
              modelRevision: 'diarization-sha',
              provider: 'pyannote',
              runtimeVersion: 'pyannote-runtime-sha',
            },
          }),
          key: SPEECH_STAGE_KEYS.SPEAKER_DIARIZATION,
          readyAt: expect.any(Date),
          status: WorkflowStageStatus.QUEUED,
        }),
        expect.objectContaining({
          configurationSnapshot: expect.objectContaining({
            provider: {
              modelId: 'faster-whisper-large-v3',
              modelRevision: 'transcription-sha',
              provider: 'faster-whisper',
              runtimeVersion: 'faster-whisper-runtime-sha',
            },
          }),
          key: SPEECH_STAGE_KEYS.SPEECH_RECOGNITION,
          readyAt: null,
          status: WorkflowStageStatus.BLOCKED,
        }),
        expect.objectContaining({
          key: SPEECH_STAGE_KEYS.CHARACTER_IDENTIFICATION,
          readyAt: null,
          status: WorkflowStageStatus.BLOCKED,
        }),
      ]),
    );
    for (const stage of stages) {
      expect(stage.configurationHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stage.configurationSnapshot).toBeDefined();
    }

    expect(harness.workflowStageAttemptUpsert).toHaveBeenCalledTimes(2);
    expect(
      harness.workflowStageAttemptUpsert.mock.calls.map(([input]) => input.create.status),
    ).toEqual([WorkflowAttemptStatus.QUEUED, WorkflowAttemptStatus.QUEUED]);
    expect(harness.outboxEventUpsert).toHaveBeenCalledTimes(2);
    expect(harness.outboxEventUpsert.mock.calls.map(([input]) => input.create.eventType)).toEqual([
      SPEECH_STAGE_EVENTS.VOCAL_SEPARATION,
      SPEECH_STAGE_EVENTS.SPEAKER_DIARIZATION,
    ]);
    for (const [input] of harness.outboxEventUpsert.mock.calls) {
      expect(input).toMatchObject({
        create: {
          aggregateType: 'workflow_attempt',
          organizationId: source.organizationId,
          payload: { attemptId: expect.any(String) },
        },
        update: {},
        where: { deduplicationKey: expect.stringMatching(/^workflow-attempt:/) },
      });
    }
  });

  it('persists the exact dependency edges and immutable source-artifact snapshot roles', async () => {
    const harness = createTransactionHarness();
    const service = new SpeechAnalysisInitializerService(config(true));

    await service.initialize(harness.transaction, source);

    const dependencies = harness.workflowStageDependencyUpsert.mock.calls.map(
      ([input]) => input.create,
    );
    expect(dependencies).toHaveLength(3);
    expect(dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dependsOnStageId: harness.stageIds.get(SPEECH_STAGE_KEYS.VOCAL_SEPARATION),
          stageId: harness.stageIds.get(SPEECH_STAGE_KEYS.SPEECH_RECOGNITION),
        }),
        expect.objectContaining({
          dependsOnStageId: harness.stageIds.get(SPEECH_STAGE_KEYS.SPEECH_RECOGNITION),
          stageId: harness.stageIds.get(SPEECH_STAGE_KEYS.CHARACTER_IDENTIFICATION),
        }),
        expect.objectContaining({
          dependsOnStageId: harness.stageIds.get(SPEECH_STAGE_KEYS.SPEAKER_DIARIZATION),
          stageId: harness.stageIds.get(SPEECH_STAGE_KEYS.CHARACTER_IDENTIFICATION),
        }),
      ]),
    );

    expect(harness.workflowJobArtifactInputUpsert).toHaveBeenCalledTimes(2);
    expect(
      harness.workflowJobArtifactInputUpsert.mock.calls.map(([input]) => input.create),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: source.canonicalArtifactId,
          role: 'VOCAL_SEPARATION_SOURCE',
        }),
        expect.objectContaining({
          artifactId: source.analysisArtifactId,
          role: 'DIARIZATION_SOURCE',
        }),
      ]),
    );
    for (const [input] of harness.workflowJobArtifactInputUpsert.mock.calls) {
      expect(input).toMatchObject({
        create: {
          jobId,
          organizationId: source.organizationId,
          projectId: source.projectId,
          sourceVideoId: source.sourceVideoId,
        },
        update: {},
        where: { jobId_role: { jobId, role: expect.any(String) } },
      });
    }
  });

  it('uses conflict-safe empty updates for every replayable graph write', async () => {
    const harness = createTransactionHarness();
    const service = new SpeechAnalysisInitializerService(config(true));

    await service.initialize(harness.transaction, source);

    const replayableInputs = [
      ...harness.workflowJobUpsert.mock.calls.map(([input]) => input),
      ...harness.workflowStageUpsert.mock.calls.map(([input]) => input),
      ...harness.workflowStageAttemptUpsert.mock.calls.map(([input]) => input),
      ...harness.workflowStageDependencyUpsert.mock.calls.map(([input]) => input),
      ...harness.outboxEventUpsert.mock.calls.map(([input]) => input),
      ...harness.workflowJobArtifactInputUpsert.mock.calls.map(([input]) => input),
      ...harness.workflowStateTransitionUpsert.mock.calls.map(([input]) => input),
      ...harness.speechAnalysisUpsert.mock.calls.map(([input]) => input),
    ];
    expect(replayableInputs).not.toHaveLength(0);
    for (const input of replayableInputs) expect(input.update).toEqual({});
  });
});
