import type { ConfigService } from '@nestjs/config';
import {
  ProjectStatus,
  type Prisma,
  WorkflowAttemptStatus,
  WorkflowJobKind,
  WorkflowJobStatus,
  WorkflowStageKind,
  WorkflowStageStatus,
} from '@voiceverse/database';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import type { DatabaseService } from '../../../infrastructure/database/database.service';
import { SPEECH_STAGE_EVENTS, SPEECH_STAGE_KEYS } from '../domain/speech-analysis.constants';
import {
  type ClaimedSpeechAttempt,
  SpeechWorkflowCoordinatorService,
} from './speech-workflow-coordinator.service';

const organizationId = '01900000-0000-7000-8000-000000000401';
const projectId = '01900000-0000-7000-8000-000000000402';
const sourceVideoId = '01900000-0000-7000-8000-000000000403';
const speechAnalysisId = '01900000-0000-7000-8000-000000000404';
const jobId = '01900000-0000-7000-8000-000000000405';
const characterStageId = '01900000-0000-7000-8000-000000000406';
const characterAttemptId = '01900000-0000-7000-8000-000000000407';

function config(): ConfigService<Environment, true> {
  const values: Partial<Environment> = {
    OUTBOX_LEASE_SECONDS: 30,
    SPEECH_COMPLETION_TRANSACTION_TIMEOUT_MS: 30_000,
    WORKFLOW_ATTEMPT_LEASE_SECONDS: 300,
  };
  return {
    get: vi.fn((key: keyof Environment) => values[key]),
  } as unknown as ConfigService<Environment, true>;
}

function claimed(
  stageKind: WorkflowStageKind,
  suffix: number,
  stageKey: string,
): ClaimedSpeechAttempt {
  return {
    attemptId: `01900000-0000-7000-8000-${String(suffix).padStart(12, '0')}`,
    attemptNumber: 1,
    configurationHash: 'f'.repeat(64),
    configurationSnapshot: { contractVersion: 1 },
    inputArtifacts: [],
    jobId,
    leaseToken: `01900000-0000-7000-8000-${String(suffix + 100).padStart(12, '0')}`,
    maxAttempts: 3,
    organizationId,
    projectId,
    sourceLanguageId: '01900000-0000-7000-8000-000000000408',
    sourceLanguageTag: 'en-US',
    sourceVideoId,
    speechAnalysisId,
    stageId: `01900000-0000-7000-8000-${String(suffix + 200).padStart(12, '0')}`,
    stageKey,
    stageKind,
  };
}

function createService(transaction: object) {
  const transactionRunner = vi.fn(
    async (
      operation: (transactionClient: Prisma.TransactionClient) => Promise<unknown>,
      _options?: { timeout?: number },
    ) => {
      void _options;
      return operation(transaction as Prisma.TransactionClient);
    },
  );
  const database = { client: { $transaction: transactionRunner } } as unknown as DatabaseService;
  return {
    service: new SpeechWorkflowCoordinatorService(database, config()),
    transactionRunner,
  };
}

function commonTransaction() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: jobId }]),
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    outboxEvent: {
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    project: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    projectSpeechAnalysisSelection: { upsert: vi.fn().mockResolvedValue({}) },
    workflowJob: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ status: WorkflowJobStatus.RUNNING }),
      update: vi.fn().mockResolvedValue({}),
    },
    workflowStage: {
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    workflowStageAttempt: {
      create: vi.fn().mockResolvedValue({
        commandIdempotencyKey: `workflow-attempt:${characterStageId}:1`,
        id: characterAttemptId,
      }),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    workflowStateTransition: { upsert: vi.fn().mockResolvedValue({}) },
  };
}

describe('SpeechWorkflowCoordinatorService', () => {
  it('aborts in-flight executor work when a heartbeat no longer owns the lease', async () => {
    vi.useFakeTimers();
    try {
      const updateMany = vi.fn().mockResolvedValue({ count: 0 });
      const database = {
        client: { workflowStageAttempt: { updateMany } },
      } as unknown as DatabaseService;
      const service = new SpeechWorkflowCoordinatorService(database, config());
      const heartbeat = service.startHeartbeat(
        claimed(
          WorkflowStageKind.SPEAKER_DIARIZATION,
          407,
          SPEECH_STAGE_KEYS.SPEAKER_DIARIZATION,
        ),
      );

      await vi.advanceTimersByTimeAsync(100_000);

      expect(updateMany).toHaveBeenCalledOnce();
      expect(heartbeat.signal.aborted).toBe(true);
      heartbeat.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never reclaims an expired running attempt under the same output namespace', async () => {
    const transaction = commonTransaction();
    const runningClaim = claimed(
      WorkflowStageKind.SPEAKER_DIARIZATION,
      408,
      SPEECH_STAGE_KEYS.SPEAKER_DIARIZATION,
    );
    transaction.workflowStageAttempt.findUnique
      .mockResolvedValueOnce({ stage: { jobId } })
      .mockResolvedValueOnce({
        id: runningClaim.attemptId,
        leaseToken: runningClaim.leaseToken,
        leasedUntil: new Date(Date.now() - 60_000),
        stage: {
          job: {
            kind: WorkflowJobKind.SPEECH_ANALYSIS,
            speechAnalysis: { id: speechAnalysisId },
            status: WorkflowJobStatus.RUNNING,
          },
          kind: WorkflowStageKind.SPEAKER_DIARIZATION,
          readyAt: new Date(Date.now() - 120_000),
          status: WorkflowStageStatus.RUNNING,
        },
        status: WorkflowAttemptStatus.RUNNING,
      });
    const { service } = createService(transaction);

    await expect(
      service.claim(runningClaim.attemptId, WorkflowStageKind.SPEAKER_DIARIZATION),
    ).resolves.toBeNull();

    expect(transaction.workflowStageAttempt.updateMany).not.toHaveBeenCalled();
    expect(transaction.workflowStage.update).not.toHaveBeenCalled();
  });

  it('times out an expired lease so retry allocation uses a new attempt namespace', async () => {
    const runningClaim = claimed(
      WorkflowStageKind.SPEAKER_DIARIZATION,
      409,
      SPEECH_STAGE_KEYS.SPEAKER_DIARIZATION,
    );
    const expiredAttempt = {
      attemptNumber: runningClaim.attemptNumber,
      configurationHash: runningClaim.configurationHash,
      id: runningClaim.attemptId,
      leaseToken: runningClaim.leaseToken,
      stage: {
        configurationSnapshot: runningClaim.configurationSnapshot,
        id: runningClaim.stageId,
        job: {
          artifactInputs: [],
          id: runningClaim.jobId,
          organizationId,
          project: {
            sourceLanguage: { bcp47Tag: runningClaim.sourceLanguageTag },
            sourceLanguageId: runningClaim.sourceLanguageId,
          },
          projectId,
          sourceVideoId,
          speechAnalysis: { id: speechAnalysisId },
        },
        key: runningClaim.stageKey,
        kind: runningClaim.stageKind,
        maxAttempts: runningClaim.maxAttempts,
      },
    };
    const database = {
      client: {
        $queryRaw: vi.fn().mockResolvedValue([]),
        workflowStageAttempt: { findMany: vi.fn().mockResolvedValue([expiredAttempt]) },
      },
    } as unknown as DatabaseService;
    const service = new SpeechWorkflowCoordinatorService(database, config());
    const fail = vi.spyOn(service, 'fail').mockResolvedValue(true);

    await expect(service.recoverExpiredAttempts()).resolves.toBe(1);

    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: runningClaim.attemptId,
        leaseToken: runningClaim.leaseToken,
      }),
      'WORKFLOW_ATTEMPT_LEASE_EXPIRED',
      true,
      WorkflowAttemptStatus.TIMED_OUT,
      expect.any(Date),
    );
  });

  it('does not claim from a stale delivery after the locked job became terminal', async () => {
    const transaction = commonTransaction();
    const queuedClaim = claimed(
      WorkflowStageKind.SPEAKER_DIARIZATION,
      409,
      SPEECH_STAGE_KEYS.SPEAKER_DIARIZATION,
    );
    transaction.workflowStageAttempt.findUnique
      .mockResolvedValueOnce({ stage: { jobId } })
      .mockResolvedValueOnce({
        id: queuedClaim.attemptId,
        leaseToken: null,
        leasedUntil: null,
        stage: {
          job: {
            kind: WorkflowJobKind.SPEECH_ANALYSIS,
            speechAnalysis: { id: speechAnalysisId },
            status: WorkflowJobStatus.FAILED,
          },
          kind: WorkflowStageKind.SPEAKER_DIARIZATION,
          readyAt: new Date(Date.now() - 1_000),
          status: WorkflowStageStatus.QUEUED,
        },
        status: WorkflowAttemptStatus.QUEUED,
      });
    const { service } = createService(transaction);

    await expect(
      service.claim(queuedClaim.attemptId, WorkflowStageKind.SPEAKER_DIARIZATION),
    ).resolves.toBeNull();

    expect(transaction.workflowStageAttempt.findUnique).toHaveBeenCalledTimes(2);
    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(transaction.workflowStageAttempt.updateMany).not.toHaveBeenCalled();
    expect(transaction.workflowStage.update).not.toHaveBeenCalled();
    expect(transaction.workflowJob.update).not.toHaveBeenCalled();
    expect(transaction.workflowStateTransition.upsert).not.toHaveBeenCalled();
  });

  it('unlocks a fan-in stage exactly once after both parallel prerequisites commit', async () => {
    const transaction = commonTransaction();
    transaction.workflowStage.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        configurationHash: 'c'.repeat(64),
        id: characterStageId,
        kind: WorkflowStageKind.CHARACTER_IDENTIFICATION,
      },
    ]);
    const { service, transactionRunner } = createService(transaction);
    const writeDiarization = vi.fn().mockResolvedValue(undefined);
    const writeTranscription = vi.fn().mockResolvedValue(undefined);

    await service.complete(
      claimed(WorkflowStageKind.SPEAKER_DIARIZATION, 410, SPEECH_STAGE_KEYS.SPEAKER_DIARIZATION),
      'diarization-v1',
      writeDiarization,
    );
    await service.complete(
      claimed(WorkflowStageKind.SPEECH_RECOGNITION, 411, SPEECH_STAGE_KEYS.SPEECH_RECOGNITION),
      'transcription-v1',
      writeTranscription,
    );

    expect(writeDiarization).toHaveBeenCalledOnce();
    expect(writeTranscription).toHaveBeenCalledOnce();
    expect(transaction.workflowStage.updateMany).toHaveBeenCalledOnce();
    expect(transaction.workflowStage.updateMany).toHaveBeenCalledWith({
      data: { readyAt: expect.any(Date), status: WorkflowStageStatus.QUEUED },
      where: { id: characterStageId, status: WorkflowStageStatus.BLOCKED },
    });
    expect(transaction.workflowStageAttempt.create).toHaveBeenCalledOnce();
    expect(transaction.outboxEvent.create).toHaveBeenCalledOnce();
    expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateId: characterAttemptId,
        deduplicationKey: `workflow-attempt:${characterStageId}:1`,
        eventType: SPEECH_STAGE_EVENTS.CHARACTER_IDENTIFICATION,
        organizationId,
        payload: { attemptId: characterAttemptId },
      }),
    });
    expect(transactionRunner).toHaveBeenCalledTimes(2);
    expect(transactionRunner.mock.calls[0]?.[1]).toEqual({ timeout: 30_000 });
  });

  it('schedules a retry with the stage-specific event and immutable configuration hash', async () => {
    const transaction = commonTransaction();
    const speechClaim = claimed(
      WorkflowStageKind.SPEECH_RECOGNITION,
      420,
      SPEECH_STAGE_KEYS.SPEECH_RECOGNITION,
    );
    transaction.workflowStageAttempt.findUnique.mockResolvedValue({
      attemptNumber: 1,
      stage: {
        job: { status: WorkflowJobStatus.RUNNING },
        maxAttempts: 3,
      },
      status: WorkflowAttemptStatus.RUNNING,
    });
    const retryAttemptId = '01900000-0000-7000-8000-000000000499';
    transaction.workflowStageAttempt.create.mockResolvedValue({ id: retryAttemptId });
    const { service } = createService(transaction);

    await expect(service.fail(speechClaim, 'CAPABILITY_SATURATED', true)).resolves.toBe(true);

    expect(transaction.workflowStageAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        attemptNumber: 2,
        commandIdempotencyKey: `workflow-attempt:${speechClaim.stageId}:2`,
        configurationHash: speechClaim.configurationHash,
        stageId: speechClaim.stageId,
        status: WorkflowAttemptStatus.QUEUED,
      }),
    });
    expect(transaction.workflowStage.update).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        progressBasisPoints: 0,
        readyAt: expect.any(Date),
        status: WorkflowStageStatus.RETRY_WAIT,
      }),
      where: { id: speechClaim.stageId },
    });
    expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        availableAt: expect.any(Date),
        eventType: SPEECH_STAGE_EVENTS.SPEECH_RECOGNITION,
        organizationId,
        payload: { attemptId: expect.any(String) },
      }),
    });
    expect(transaction.workflowJob.update).toHaveBeenCalledWith({
      data: { revision: { increment: 1 } },
      where: { id: jobId },
    });
  });

  it('defers pre-execution capacity pressure without consuming a semantic attempt', async () => {
    const transaction = commonTransaction();
    const speechClaim = claimed(
      WorkflowStageKind.SPEAKER_DIARIZATION,
      425,
      SPEECH_STAGE_KEYS.SPEAKER_DIARIZATION,
    );
    transaction.workflowStageAttempt.findUnique.mockResolvedValue({
      attemptNumber: 1,
      commandIdempotencyKey: `workflow-attempt:${speechClaim.stageId}:1`,
      recoveryCount: 0,
      stage: { job: { status: WorkflowJobStatus.RUNNING } },
      status: WorkflowAttemptStatus.RUNNING,
    });
    const { service } = createService(transaction);

    await expect(
      service.deferForCapacity(speechClaim, 'SPEECH_EXECUTOR_SATURATED'),
    ).resolves.toBe(true);

    expect(transaction.workflowStageAttempt.updateMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        recoveryCount: { increment: 1 },
        status: WorkflowAttemptStatus.QUEUED,
      }),
      where: expect.objectContaining({
        id: speechClaim.attemptId,
        leaseToken: speechClaim.leaseToken,
        recoveryCount: 0,
        status: WorkflowAttemptStatus.RUNNING,
      }),
    });
    expect(transaction.workflowStageAttempt.create).not.toHaveBeenCalled();
    expect(transaction.workflowStage.update).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: WorkflowStageStatus.RETRY_WAIT }),
      where: { id: speechClaim.stageId },
    });
    expect(transaction.outboxEvent.updateMany).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'PENDING' }),
      where: {
        deduplicationKey: `workflow-attempt:${speechClaim.stageId}:1`,
        status: 'PUBLISHED',
      },
    });
  });

  it('fails the job and cancels blocked, queued, and running siblings after a terminal failure', async () => {
    const transaction = commonTransaction();
    const failedClaim = claimed(
      WorkflowStageKind.VOCAL_SEPARATION,
      430,
      SPEECH_STAGE_KEYS.VOCAL_SEPARATION,
    );
    const blockedStageId = '01900000-0000-7000-8000-000000000431';
    const queuedStageId = '01900000-0000-7000-8000-000000000432';
    const queuedAttemptId = '01900000-0000-7000-8000-000000000433';
    const runningStageId = '01900000-0000-7000-8000-000000000434';
    const runningAttemptId = '01900000-0000-7000-8000-000000000435';
    transaction.workflowStageAttempt.findUnique.mockResolvedValue({
      attemptNumber: 3,
      stage: {
        job: { status: WorkflowJobStatus.RUNNING },
        maxAttempts: 3,
      },
      status: WorkflowAttemptStatus.RUNNING,
    });
    transaction.workflowStage.findMany.mockResolvedValue([
      { attempts: [], id: blockedStageId, status: WorkflowStageStatus.BLOCKED },
      {
        attempts: [{ id: queuedAttemptId, status: WorkflowAttemptStatus.QUEUED }],
        id: queuedStageId,
        status: WorkflowStageStatus.QUEUED,
      },
      {
        attempts: [{ id: runningAttemptId, status: WorkflowAttemptStatus.RUNNING }],
        id: runningStageId,
        status: WorkflowStageStatus.RUNNING,
      },
    ]);
    const { service } = createService(transaction);

    await expect(service.fail(failedClaim, 'SEPARATION_MODEL_FAILED', false)).resolves.toBe(true);

    expect(transaction.workflowStage.update).toHaveBeenCalledWith({
      data: { completedAt: expect.any(Date), status: WorkflowStageStatus.FAILED },
      where: { id: failedClaim.stageId },
    });
    expect(transaction.workflowStage.update).toHaveBeenCalledWith({
      data: { completedAt: expect.any(Date), status: WorkflowStageStatus.CANCELED },
      where: { id: blockedStageId },
    });
    expect(transaction.workflowStage.update).toHaveBeenCalledWith({
      data: { completedAt: expect.any(Date), status: WorkflowStageStatus.CANCELED },
      where: { id: queuedStageId },
    });
    expect(transaction.workflowStage.update).toHaveBeenCalledWith({
      data: { completedAt: expect.any(Date), status: WorkflowStageStatus.CANCELED },
      where: { id: runningStageId },
    });
    expect(transaction.workflowStageAttempt.updateMany).toHaveBeenCalledWith({
      data: {
        completedAt: expect.any(Date),
        errorCode: 'SEPARATION_MODEL_FAILED',
        heartbeatAt: expect.any(Date),
        leaseToken: null,
        leasedUntil: null,
        status: WorkflowAttemptStatus.CANCELED,
      },
      where: { id: queuedAttemptId, status: WorkflowAttemptStatus.QUEUED },
    });
    expect(transaction.workflowStageAttempt.updateMany).toHaveBeenCalledWith({
      data: {
        completedAt: expect.any(Date),
        errorCode: 'SEPARATION_MODEL_FAILED',
        heartbeatAt: expect.any(Date),
        leaseToken: null,
        leasedUntil: null,
        status: WorkflowAttemptStatus.CANCELED,
      },
      where: { id: runningAttemptId, status: WorkflowAttemptStatus.RUNNING },
    });
    expect(transaction.workflowJob.update).toHaveBeenCalledWith({
      data: expect.objectContaining({
        failureCode: 'SEPARATION_MODEL_FAILED',
        status: WorkflowJobStatus.FAILED,
      }),
      where: { id: jobId },
    });
    expect(transaction.project.updateMany).toHaveBeenCalledWith({
      data: { status: ProjectStatus.FAILED },
      where: { id: projectId, organizationId },
    });
    expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('does not commit sibling output after a terminal failure wins the job lock', async () => {
    const transaction = commonTransaction();
    transaction.workflowJob.findUniqueOrThrow.mockResolvedValue({
      status: WorkflowJobStatus.FAILED,
    });
    const { service } = createService(transaction);
    const write = vi.fn().mockResolvedValue(undefined);

    await expect(
      service.complete(
        claimed(WorkflowStageKind.SPEAKER_DIARIZATION, 438, SPEECH_STAGE_KEYS.SPEAKER_DIARIZATION),
        'executor-v1',
        write,
      ),
    ).rejects.toThrow('WorkflowJobTerminal');

    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(transaction.workflowJob.findUniqueOrThrow).toHaveBeenCalledOnce();
    expect(transaction.workflowStageAttempt.updateMany).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(transaction.workflowStage.update).not.toHaveBeenCalled();
  });

  it('does not write stage outputs after losing the attempt lease compare-and-set', async () => {
    const transaction = commonTransaction();
    transaction.workflowStageAttempt.updateMany.mockResolvedValue({ count: 0 });
    const { service } = createService(transaction);
    const write = vi.fn().mockResolvedValue(undefined);

    await expect(
      service.complete(
        claimed(WorkflowStageKind.SPEAKER_DIARIZATION, 440, SPEECH_STAGE_KEYS.SPEAKER_DIARIZATION),
        'executor-v1',
        write,
      ),
    ).rejects.toThrow('WorkflowAttemptLeaseLost');

    expect(write).not.toHaveBeenCalled();
    expect(transaction.workflowStage.update).not.toHaveBeenCalled();
  });
});
