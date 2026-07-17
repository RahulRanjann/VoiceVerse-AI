import type { ConfigService } from '@nestjs/config';
import {
  MediaSecurityStatus,
  VideoIngestStatus,
  WorkflowAttemptStatus,
  WorkflowJobKind,
  WorkflowJobStatus,
  WorkflowStageKind,
  WorkflowStageStatus,
} from '@voiceverse/database';
import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import type { DatabaseService } from '../../../infrastructure/database/database.service';
import type { MetricsService } from '../../../observability/metrics.service';
import type { ObjectStoragePort } from '../../media-ingest/domain/object-storage.port';
import type { SpeechAnalysisInitializerService } from '../../speech-analysis/application/speech-analysis-initializer.service';
import { SOURCE_PREPARATION_STAGE_KEY } from '../../workflow/domain/source-preparation.constants';
import {
  MediaExecutorError,
  type MediaExecutorPort,
  type MediaPreparationResult,
} from '../domain/media-executor.port';
import { PREPARE_SOURCE_MEDIA_JOB } from '../infrastructure/media-processing.queue';
import { MediaProcessingWorkerService } from './media-processing-worker.service';

const organizationId = '01900000-0000-7000-8000-000000000002';
const projectId = '01900000-0000-7000-8000-000000000003';
const videoId = '01900000-0000-7000-8000-000000000020';
const jobId = '01900000-0000-7000-8000-000000000030';
const stageId = '01900000-0000-7000-8000-000000000031';
const attemptId = '01900000-0000-7000-8000-000000000032';
const checksum = 'a'.repeat(64);

function queuedAttempt() {
  return {
    attemptNumber: 1,
    configurationHash: 'f'.repeat(64),
    id: attemptId,
    stage: {
      id: stageId,
      job: {
        id: jobId,
        kind: WorkflowJobKind.SOURCE_PREPARATION,
        organizationId,
        project: { sourceLanguage: { bcp47Tag: 'en' } },
        projectId,
        sourceVideo: {
          byteSize: 5n,
          id: videoId,
          ingestStatus: VideoIngestStatus.UPLOADED,
          securityStatus: MediaSecurityStatus.CLEAN,
          sha256: checksum,
          storageBucket: 'voiceverse-test',
          storageKey: 'source/video.mp4',
        },
        startedAt: null,
        status: WorkflowJobStatus.QUEUED,
      },
      jobId,
      key: SOURCE_PREPARATION_STAGE_KEY,
      kind: WorkflowStageKind.SOURCE_MEDIA_PREPARATION,
      maxAttempts: 3,
      startedAt: null,
      status: WorkflowStageStatus.QUEUED,
    },
    stageId,
    status: WorkflowAttemptStatus.QUEUED,
  };
}

function expiredRunningAttempt() {
  const queued = queuedAttempt();
  return {
    ...queued,
    heartbeatAt: new Date(Date.now() - 60_000),
    leasedUntil: new Date(Date.now() - 30_000),
    leaseToken: '01900000-0000-7000-8000-000000000099',
    recoveryCount: 0,
    stage: {
      ...queued.stage,
      job: { ...queued.stage.job, status: WorkflowJobStatus.RUNNING },
      status: WorkflowStageStatus.RUNNING,
    },
    startedAt: new Date(Date.now() - 120_000),
    status: WorkflowAttemptStatus.RUNNING,
  };
}

function successfulResult(): MediaPreparationResult {
  const selectedAudio = {
    channelLayout: 'stereo',
    channels: 2,
    codecName: 'aac',
    durationMs: 1_000,
    isDefault: true,
    languageTag: 'en',
    sampleRateHz: 48_000,
    streamIndex: 1,
  };
  return {
    artifacts: [
      {
        channels: 2,
        codecName: 'flac',
        durationMs: 1_000,
        kind: 'CANONICAL_AUDIO',
        mediaType: 'audio/flac',
        sampleRateHz: 48_000,
        sha256: 'b'.repeat(64),
        sizeBytes: 200,
      },
      {
        channels: 1,
        codecName: 'flac',
        durationMs: 1_000,
        kind: 'ANALYSIS_AUDIO',
        mediaType: 'audio/flac',
        sampleRateHz: 16_000,
        sha256: 'c'.repeat(64),
        sizeBytes: 100,
      },
      {
        kind: 'PROBE_MANIFEST',
        mediaType: 'application/json',
        sha256: 'd'.repeat(64),
        sizeBytes: 500,
      },
    ],
    attemptId,
    executionId: jobId,
    producerVersion: 'test-executor-version',
    schemaVersion: 'voiceverse.media-probe.v1',
    source: {
      audioSelectionMethod: 'DEFAULT_THEN_LANGUAGE_THEN_LOWEST_INDEX',
      audioSelectionReason: 'DEFAULT_DISPOSITION',
      audioStreams: [selectedAudio],
      containerFormats: ['mov', 'mp4'],
      durationMs: 1_000,
      selectedAudio,
      sha256: checksum,
      sizeBytes: 5,
      videoStreams: [
        {
          codecName: 'h264',
          frameRate: { denominator: 1, numerator: 24 },
          height: 1_080,
          isDefault: true,
          streamIndex: 0,
          width: 1_920,
        },
      ],
    },
    tools: { ffmpeg: '8.0', ffprobe: '8.0' },
  };
}

function createHarness() {
  const attemptFindUnique = vi.fn().mockResolvedValue(queuedAttempt());
  const client = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    artifactLineage: { createMany: vi.fn().mockResolvedValue({ count: 3 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    mediaArtifact: { create: vi.fn().mockResolvedValue({}) },
    mediaProbe: { create: vi.fn().mockResolvedValue({}) },
    mediaStream: { create: vi.fn().mockResolvedValue({}) },
    mediaTrackSelection: { create: vi.fn().mockResolvedValue({}) },
    outboxEvent: {
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    project: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    workflowJob: { update: vi.fn().mockResolvedValue({}) },
    workflowStage: { update: vi.fn().mockResolvedValue({}) },
    workflowStageAttempt: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: attemptFindUnique,
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    workflowStateTransition: { upsert: vi.fn().mockResolvedValue({}) },
  };
  const transaction = vi.fn(
    async (operation: (transactionClient: typeof client) => Promise<unknown>) => operation(client),
  );
  Object.assign(client, { $transaction: transaction });
  const result = successfulResult();
  const prepare = vi.fn<MediaExecutorPort['prepare']>().mockResolvedValue(result);
  const executor = { prepare };
  const headObject = vi.fn<ObjectStoragePort['headObject']>(({ key }) => {
    const kind = key.endsWith('/analysis.flac')
      ? 'ANALYSIS_AUDIO'
      : key.endsWith('/canonical.flac')
        ? 'CANONICAL_AUDIO'
        : 'PROBE_MANIFEST';
    const artifact = result.artifacts.find((candidate) => candidate.kind === kind);
    if (!artifact) throw new Error('Missing test artifact');
    return Promise.resolve({
      byteSize: artifact.sizeBytes,
      mediaType: artifact.mediaType,
      metadata: {
        'artifact-kind': kind.toLowerCase(),
        'attempt-id': attemptId,
        'configuration-hash': 'f'.repeat(64),
        'execution-id': jobId,
        'ffmpeg-version': result.tools.ffmpeg,
        producer: 'voiceverse-media-executor',
        'producer-version': result.producerVersion,
        sha256: artifact.sha256,
      },
    });
  });
  const storage = { headObject };
  const initializeIfEnabled = vi.fn().mockResolvedValue(null);
  const values: Partial<Environment> = {
    APP_VERSION: 'test-version',
    MEDIA_PROCESSING_CONCURRENCY: 1,
    OUTBOX_LEASE_SECONDS: 30,
    REDIS_URL: 'redis://localhost:6379/0',
    WORKFLOW_ATTEMPT_LEASE_SECONDS: 300,
  };
  const config = {
    get: vi.fn((key: keyof Environment) => values[key]),
  } as unknown as ConfigService<Environment, true>;
  const service = new MediaProcessingWorkerService(
    { client } as unknown as DatabaseService,
    config,
    storage as unknown as ObjectStoragePort,
    executor,
    {
      workflowArtifactRegistered: vi.fn(),
      workflowAttemptCompleted: vi.fn(),
      workflowAttemptStarted: vi.fn(),
    } as unknown as MetricsService,
    { initializeIfEnabled } as unknown as SpeechAnalysisInitializerService,
  );
  const job = { data: { attemptId }, name: PREPARE_SOURCE_MEDIA_JOB } as Job;
  return {
    attemptFindUnique,
    client,
    executor,
    headObject,
    initializeIfEnabled,
    job,
    prepare,
    service,
  };
}

describe('MediaProcessingWorkerService', () => {
  it('claims clean media, executes with server-generated keys, and commits immutable artifacts', async () => {
    const harness = createHarness();

    await harness.service.processJob(harness.job);

    expect(harness.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId,
        expectedSourceSha256: checksum,
        preferredAudioLanguageTag: 'en',
        sourceKey: 'source/video.mp4',
      }),
    );
    const command = harness.prepare.mock.calls[0]?.[0];
    expect(command?.canonicalAudioKey).toContain(`/attempts/${attemptId}/canonical.flac`);
    expect(harness.client.mediaArtifact.create).toHaveBeenCalledTimes(3);
    expect(harness.headObject).toHaveBeenCalledTimes(3);
    expect(harness.client.artifactLineage.createMany).toHaveBeenCalledTimes(1);
    expect(harness.client.workflowJob.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: WorkflowJobStatus.SUCCEEDED }),
      }),
    );
    expect(harness.initializeIfEnabled).toHaveBeenCalledOnce();
  });

  it('turns a retryable executor failure into a new authoritative database attempt', async () => {
    const harness = createHarness();
    harness.prepare.mockRejectedValue(new MediaExecutorError('OBJECT_STORAGE_UNAVAILABLE', true));
    harness.attemptFindUnique.mockResolvedValueOnce(queuedAttempt()).mockResolvedValueOnce({
      ...queuedAttempt(),
      stage: { ...queuedAttempt().stage, job: queuedAttempt().stage.job },
      status: WorkflowAttemptStatus.RUNNING,
    });

    await harness.service.processJob(harness.job);

    expect(harness.client.workflowStageAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ attemptNumber: 2 }) }),
    );
    expect(harness.client.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'workflow.stage.execute' }),
      }),
    );
    expect(harness.client.workflowStage.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: WorkflowStageStatus.RETRY_WAIT }),
      }),
    );
  });

  it('acknowledges duplicate delivery without invoking the executor', async () => {
    const harness = createHarness();
    harness.attemptFindUnique.mockResolvedValue({
      ...queuedAttempt(),
      status: WorkflowAttemptStatus.SUCCEEDED,
    });

    await harness.service.processJob(harness.job);

    expect(harness.prepare).not.toHaveBeenCalled();
  });

  it.each([
    {
      jobKind: WorkflowJobKind.SPEECH_ANALYSIS,
      stageKey: 'speech.diarize',
      stageKind: WorkflowStageKind.SPEAKER_DIARIZATION,
    },
    {
      jobKind: WorkflowJobKind.SOURCE_PREPARATION,
      stageKey: 'source.media.unexpected',
      stageKind: WorkflowStageKind.SOURCE_MEDIA_PREPARATION,
    },
  ])(
    'rejects a delivery outside the source-preparation worker boundary',
    async ({ jobKind, stageKey, stageKind }) => {
      const harness = createHarness();
      const attempt = queuedAttempt();
      harness.attemptFindUnique.mockResolvedValue({
        ...attempt,
        stage: {
          ...attempt.stage,
          job: { ...attempt.stage.job, kind: jobKind },
          key: stageKey,
          kind: stageKind,
        },
      });

      await expect(harness.service.processJob(harness.job)).rejects.toThrow(
        'SourcePreparationAttemptKindMismatch',
      );

      expect(harness.client.workflowStageAttempt.updateMany).not.toHaveBeenCalled();
      expect(harness.prepare).not.toHaveBeenCalled();
    },
  );

  it('fails closed before registration when stored artifact metadata does not match', async () => {
    const harness = createHarness();
    harness.headObject.mockResolvedValueOnce({
      byteSize: 1,
      mediaType: 'audio/flac',
      metadata: {},
    });
    harness.attemptFindUnique.mockResolvedValueOnce(queuedAttempt()).mockResolvedValueOnce({
      ...queuedAttempt(),
      status: WorkflowAttemptStatus.RUNNING,
    });

    await harness.service.processJob(harness.job);

    expect(harness.client.mediaArtifact.create).not.toHaveBeenCalled();
    expect(harness.client.workflowStageAttempt.create).not.toHaveBeenCalled();
    expect(harness.client.workflowJob.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failureCode: 'MEDIA_ARTIFACT_VERIFICATION_FAILED',
          status: WorkflowJobStatus.FAILED,
        }),
      }),
    );
  });

  it('re-publishes a stale queued attempt when its BullMQ delivery was lost', async () => {
    const harness = createHarness();
    harness.client.$queryRaw.mockResolvedValue([{ id: attemptId }]);

    await expect(harness.service.recoverExpiredAttempts()).resolves.toBe(1);

    const query = harness.client.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray;
    expect(query.join(' ')).toContain('event.published_at');
    expect(query.join(' ')).toContain("event.status = 'published'");
    expect(query.join(' ')).toContain("job.kind = 'source_preparation'");
    expect(query.join(' ')).toContain("stage.kind = 'source_media_preparation'");

    expect(harness.client.workflowStageAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          stage: expect.objectContaining({
            job: {
              kind: WorkflowJobKind.SOURCE_PREPARATION,
              status: WorkflowJobStatus.RUNNING,
            },
            key: SOURCE_PREPARATION_STAGE_KEY,
            kind: WorkflowStageKind.SOURCE_MEDIA_PREPARATION,
          }),
        }),
      }),
    );
  });

  it('reclaims an expired lease using a cutoff in the compare-and-set claim', async () => {
    const harness = createHarness();
    const expired = expiredRunningAttempt();
    harness.attemptFindUnique.mockResolvedValue(expired);

    await harness.service.processJob(harness.job);

    expect(harness.client.workflowStageAttempt.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          leaseToken: expired.leaseToken,
          leasedUntil: expect.objectContaining({ lt: expect.any(Date) }),
          recoveryCount: { lt: 1 },
          status: WorkflowAttemptStatus.RUNNING,
        }),
      }),
    );
    expect(harness.prepare).toHaveBeenCalledTimes(1);
  });

  it('does not execute when a heartbeat renews the lease before recovery wins', async () => {
    const harness = createHarness();
    harness.attemptFindUnique.mockResolvedValue(expiredRunningAttempt());
    harness.client.workflowStageAttempt.updateMany.mockResolvedValueOnce({ count: 0 });

    await harness.service.processJob(harness.job);

    expect(harness.prepare).not.toHaveBeenCalled();
  });

  it('uses the lease cutoff when timing out an exhausted recovery budget', async () => {
    const harness = createHarness();
    const exhausted = { ...expiredRunningAttempt(), recoveryCount: 1 };
    harness.client.workflowStageAttempt.findMany.mockResolvedValue([
      { id: exhausted.id, leaseToken: exhausted.leaseToken },
    ]);
    harness.attemptFindUnique.mockResolvedValue(exhausted);
    harness.client.workflowStageAttempt.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(harness.service.recoverExpiredAttempts()).resolves.toBe(0);

    expect(harness.client.workflowStageAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          leasedUntil: expect.objectContaining({ lt: expect.any(Date) }),
        }),
      }),
    );
    expect(harness.client.workflowStageAttempt.create).not.toHaveBeenCalled();
  });
});
