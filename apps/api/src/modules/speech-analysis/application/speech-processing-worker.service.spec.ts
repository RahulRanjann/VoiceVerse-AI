import type { ConfigService } from '@nestjs/config';
import { MediaArtifactKind, type Prisma, WorkflowStageKind } from '@voiceverse/database';
import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import type { DatabaseService } from '../../../infrastructure/database/database.service';
import type { MetricsService } from '../../../observability/metrics.service';
import type { ObjectStoragePort } from '../../media-ingest/domain/object-storage.port';
import {
  SpeechExecutorError,
  type SpeakerDiarizationResult,
  type SpeechExecutorPort,
  type SpeechGeneratedArtifact,
  type TranscriptionResult,
  type VocalSeparationResult,
} from '../domain/speech-executor.port';
import {
  EXECUTE_CHARACTER_IDENTIFICATION_JOB,
  EXECUTE_DIARIZATION_JOB,
  EXECUTE_TRANSCRIPTION_JOB,
  EXECUTE_VOCAL_SEPARATION_JOB,
} from '../infrastructure/speech-analysis.queue';
import type { SpeechManifestReaderService } from '../infrastructure/speech-manifest-reader.service';
import type { SpeechAnalysisPersistenceService } from './speech-analysis-persistence.service';
import type { SpeechCapabilityReadinessService } from './speech-capability-readiness.service';
import { SpeechProcessingWorkerService } from './speech-processing-worker.service';
import type {
  ClaimedSpeechAttempt,
  SpeechWorkflowCoordinatorService,
} from './speech-workflow-coordinator.service';
import { TimelineMaterializerService } from './timeline-materializer.service';

const organizationId = '01900000-0000-7000-8000-000000000501';
const projectId = '01900000-0000-7000-8000-000000000502';
const sourceVideoId = '01900000-0000-7000-8000-000000000503';
const speechAnalysisId = '01900000-0000-7000-8000-000000000504';
const jobId = '01900000-0000-7000-8000-000000000505';
const analysisArtifactId = '01900000-0000-7000-8000-000000000506';
const isolatedArtifactId = '01900000-0000-7000-8000-000000000507';
const canonicalArtifactId = '01900000-0000-7000-8000-000000000509';
const bucket = 'voiceverse-private';

function audioArtifact(
  id: string,
  kind: MediaArtifactKind,
  storageKey: string,
  sampleRateHz = 16_000,
  channels = 1,
) {
  return {
    audioMetadata: {
      channels,
      durationMs: 10_000n,
      sampleRateHz,
    },
    byteSize: 4_096n,
    id,
    kind,
    mediaType: 'audio/flac',
    sha256: id === analysisArtifactId ? 'a'.repeat(64) : 'b'.repeat(64),
    storageBucket: bucket,
    storageKey,
  };
}

const analysisArtifact = audioArtifact(
  analysisArtifactId,
  MediaArtifactKind.ANALYSIS_AUDIO,
  'inputs/analysis.flac',
);
const isolatedArtifact = audioArtifact(
  isolatedArtifactId,
  MediaArtifactKind.SPEECH_ANALYSIS_AUDIO,
  'outputs/isolated-speech.flac',
);
const canonicalArtifact = audioArtifact(
  canonicalArtifactId,
  MediaArtifactKind.CANONICAL_AUDIO,
  'inputs/canonical.flac',
  48_000,
  2,
);

function claimed(kind: WorkflowStageKind, suffix: number): ClaimedSpeechAttempt {
  return {
    attemptId: `01900000-0000-7000-8000-${String(suffix).padStart(12, '0')}`,
    attemptNumber: 1,
    configurationHash: 'f'.repeat(64),
    configurationSnapshot:
      kind === WorkflowStageKind.CHARACTER_IDENTIFICATION
        ? {
            contractVersion: 1,
            nearestTurnToleranceUs: 250_000,
            persistVoiceEmbeddings: false,
            resolver: 'deterministic-timeline-v1',
          }
        : {
            contractVersion: 1,
            provider: {
              modelId: model().modelId,
              modelRevision: model().modelRevision,
              provider: model().provider,
              runtimeVersion: model().runtimeVersion,
            },
          },
    inputArtifacts: [
      kind === WorkflowStageKind.VOCAL_SEPARATION
        ? {
            artifact: canonicalArtifact,
            artifactId: canonicalArtifact.id,
            role: 'VOCAL_SEPARATION_SOURCE',
          }
        : {
            artifact: analysisArtifact,
            artifactId: analysisArtifact.id,
            role: 'DIARIZATION_SOURCE',
          },
    ] as ClaimedSpeechAttempt['inputArtifacts'],
    jobId,
    leaseToken: `01900000-0000-7000-8000-${String(suffix + 100).padStart(12, '0')}`,
    maxAttempts: 3,
    organizationId,
    projectId,
    sourceLanguageId: '01900000-0000-7000-8000-000000000508',
    sourceLanguageTag: 'en-US',
    sourceVideoId,
    speechAnalysisId,
    stageId: `01900000-0000-7000-8000-${String(suffix + 200).padStart(12, '0')}`,
    stageKey: kind.toLowerCase(),
    stageKind: kind,
  };
}

function model() {
  return {
    modelId: 'test-model',
    modelRevision: 'model-sha-1234',
    provider: 'test-provider',
    runtimeVersion: '1.2.3',
  };
}

function manifestArtifact(
  kind: 'DIARIZATION_MANIFEST' | 'SEPARATION_MANIFEST' | 'TRANSCRIPT_MANIFEST',
): SpeechGeneratedArtifact {
  return {
    kind,
    mediaType: 'application/json',
    sha256:
      kind === 'DIARIZATION_MANIFEST'
        ? 'c'.repeat(64)
        : kind === 'TRANSCRIPT_MANIFEST'
          ? 'd'.repeat(64)
          : 'e'.repeat(64),
    sizeBytes: 1_024,
  };
}

function separationResult(attemptId: string): VocalSeparationResult {
  const audioArtifact = (
    kind: 'ANALYSIS_ACCOMPANIMENT_STEM' | 'ANALYSIS_VOCAL_STEM' | 'ISOLATED_SPEECH_AUDIO',
    sha256: string,
    sampleRateHz: number,
    channels: number,
  ): SpeechGeneratedArtifact => ({
    channels,
    codecName: 'flac',
    durationUs: 10_000_000,
    kind,
    mediaType: 'audio/flac',
    sampleRateHz,
    sha256,
    sizeBytes: 4_096,
  });
  return {
    artifacts: [
      audioArtifact('ANALYSIS_VOCAL_STEM', '1'.repeat(64), 48_000, 2),
      audioArtifact('ANALYSIS_ACCOMPANIMENT_STEM', '2'.repeat(64), 48_000, 2),
      audioArtifact('ISOLATED_SPEECH_AUDIO', '3'.repeat(64), 16_000, 1),
      manifestArtifact('SEPARATION_MANIFEST'),
    ],
    attemptId,
    executionId: jobId,
    model: model(),
    producerVersion: 'speech-executor-test',
    schemaVersion: 'voiceverse.separation.v1',
  };
}

function diarizationResult(attemptId: string): SpeakerDiarizationResult {
  return {
    artifacts: [manifestArtifact('DIARIZATION_MANIFEST')],
    attemptId,
    executionId: jobId,
    model: model(),
    producerVersion: 'speech-executor-test',
    schemaVersion: 'voiceverse.diarization.v1',
    summary: { exclusiveTurnCount: 0, speakerCount: 0, turnCount: 0 },
  };
}

function transcriptionResult(attemptId: string): TranscriptionResult {
  return {
    artifacts: [manifestArtifact('TRANSCRIPT_MANIFEST')],
    attemptId,
    executionId: jobId,
    model: model(),
    producerVersion: 'speech-executor-test',
    schemaVersion: 'voiceverse.transcript.v1',
    summary: {
      detectedLanguage: 'en',
      languageProbability: 0.99,
      segmentCount: 0,
      wordCount: 0,
    },
  };
}

function config(): ConfigService<Environment, true> {
  const values: Partial<Environment> = {
    CHARACTER_IDENTIFICATION_CONCURRENCY: 2,
    DIARIZATION_CONCURRENCY: 1,
    REDIS_URL: 'redis://localhost:6379/0',
    SPEECH_ANALYSIS_ENABLED: true,
    TRANSCRIPTION_CONCURRENCY: 1,
    VOCAL_SEPARATION_CONCURRENCY: 1,
  };
  return {
    get: vi.fn((key: keyof Environment) => values[key]),
  } as unknown as ConfigService<Environment, true>;
}

function createHarness() {
  const databaseClient = {
    diarizationRun: { findUnique: vi.fn() },
    mediaArtifact: { findFirst: vi.fn().mockResolvedValue(isolatedArtifact) },
    transcriptionRun: { findUnique: vi.fn() },
  };
  const claim = vi.fn();
  const complete = vi.fn(
    async (
      _claimed: ClaimedSpeechAttempt,
      _executorVersion: string,
      write: (transaction: Prisma.TransactionClient) => Promise<void>,
    ) => write({} as Prisma.TransactionClient),
  );
  const fail = vi.fn().mockResolvedValue(true);
  const deferForCapacity = vi.fn().mockResolvedValue(true);
  const coordinator = {
    claim,
    complete,
    deferForCapacity,
    fail,
    startHeartbeat: vi.fn().mockReturnValue({
      signal: new AbortController().signal,
      stop: vi.fn(),
    }),
  };
  const diarize = vi.fn<SpeechExecutorPort['diarize']>();
  const separate = vi.fn<SpeechExecutorPort['separate']>();
  const transcribe = vi.fn<SpeechExecutorPort['transcribe']>();
  const executor = { checkReadiness: vi.fn(), diarize, separate, transcribe };
  const storedObjects = new Map<
    string,
    { byteSize: number; mediaType: string; metadata: Record<string, string> }
  >();
  const headObject = vi.fn<ObjectStoragePort['headObject']>(({ key }) => {
    const stored = storedObjects.get(key);
    if (!stored) throw new Error(`TestStoredObjectMissing:${key}`);
    return Promise.resolve(stored);
  });
  const putImmutableObject = vi.fn<ObjectStoragePort['putImmutableObject']>((input) => {
    storedObjects.set(input.key, {
      byteSize: input.body.byteLength,
      mediaType: input.mediaType,
      metadata: { ...input.metadata, sha256: input.sha256 },
    });
    return Promise.resolve();
  });
  const storage = { headObject, putImmutableObject };
  const readDiarization = vi.fn();
  const readSeparation = vi.fn();
  const readTranscript = vi.fn();
  const manifests = { readDiarization, readSeparation, readTranscript };
  const persistCharacters = vi.fn().mockResolvedValue(undefined);
  const persistDiarization = vi.fn().mockResolvedValue(undefined);
  const persistSeparation = vi.fn().mockResolvedValue(undefined);
  const persistTranscription = vi.fn().mockResolvedValue(undefined);
  const persistence = {
    persistCharacters,
    persistDiarization,
    persistSeparation,
    persistTranscription,
  };
  const metrics = {
    workflowArtifactRegistered: vi.fn(),
    workflowAttemptCompleted: vi.fn(),
    workflowAttemptStarted: vi.fn(),
  };
  const materializer = new TimelineMaterializerService();
  const materialize = vi.spyOn(materializer, 'materialize');
  const readiness = { assert: vi.fn().mockResolvedValue(undefined), assertAll: vi.fn() };
  const service = new SpeechProcessingWorkerService(
    { client: databaseClient } as unknown as DatabaseService,
    config(),
    coordinator as unknown as SpeechWorkflowCoordinatorService,
    executor,
    storage as unknown as ObjectStoragePort,
    manifests as unknown as SpeechManifestReaderService,
    persistence as unknown as SpeechAnalysisPersistenceService,
    materializer,
    metrics as unknown as MetricsService,
    readiness as unknown as SpeechCapabilityReadinessService,
  );

  function registerExecutorArtifact(
    claimedAttempt: ClaimedSpeechAttempt,
    result: SpeakerDiarizationResult | TranscriptionResult | VocalSeparationResult,
    artifact: SpeechGeneratedArtifact,
    key: string,
    metadataOverrides: Record<string, string> = {},
  ): void {
    storedObjects.set(key, {
      byteSize: artifact.sizeBytes,
      mediaType: artifact.mediaType,
      metadata: {
        'artifact-kind': artifact.kind.toLowerCase(),
        'attempt-id': claimedAttempt.attemptId,
        'configuration-hash': claimedAttempt.configurationHash,
        'contract-version': result.schemaVersion,
        'execution-id': claimedAttempt.jobId,
        'input-sha256':
          result.schemaVersion === 'voiceverse.diarization.v1'
            ? analysisArtifact.sha256
            : canonicalArtifact.sha256,
        'model-id': result.model.modelId,
        'model-revision': result.model.modelRevision,
        'runtime-version': result.model.runtimeVersion,
        producer: 'voiceverse-speech-executor',
        'producer-version': result.producerVersion,
        provider: result.model.provider,
        sha256: artifact.sha256,
        ...metadataOverrides,
      },
    });
  }

  return {
    claim,
    complete,
    databaseClient,
    deferForCapacity,
    diarize,
    fail,
    headObject,
    manifests,
    materialize,
    metrics,
    persistence,
    putImmutableObject,
    readiness,
    registerExecutorArtifact,
    separate,
    service,
    transcribe,
  };
}

function outputKey(claimedAttempt: ClaimedSpeechAttempt, filename: string): string {
  return `organizations/${organizationId}/projects/${projectId}/videos/${sourceVideoId}/speech-analysis/attempts/${claimedAttempt.attemptId}/${filename}`;
}

describe('SpeechProcessingWorkerService', () => {
  it('does not start queue consumers before the exact capability handshake passes', async () => {
    const harness = createHarness();
    harness.readiness.assertAll.mockRejectedValue(new Error('SpeechProviderNotReady'));

    await expect(harness.service.ensureStarted()).resolves.toBe(false);

    expect(harness.readiness.assertAll).toHaveBeenCalledOnce();
  });

  it('leaves a delivery unclaimed when its remote capability is unavailable', async () => {
    const harness = createHarness();
    const diarizationClaim = claimed(WorkflowStageKind.SPEAKER_DIARIZATION, 504);
    harness.readiness.assert.mockRejectedValue(new Error('SpeechExecutorUnavailable'));
    const job = {
      data: { attemptId: diarizationClaim.attemptId },
      name: EXECUTE_DIARIZATION_JOB,
    } as Job;

    await expect(harness.service.processDiarization(job)).rejects.toThrow(
      'SpeechExecutorUnavailable',
    );

    expect(harness.claim).not.toHaveBeenCalled();
    expect(harness.fail).not.toHaveBeenCalled();
    expect(harness.diarize).not.toHaveBeenCalled();
  });

  it('verifies and persists the complete separation contract from canonical audio', async () => {
    const harness = createHarness();
    const separationClaim = claimed(WorkflowStageKind.VOCAL_SEPARATION, 505);
    const result = separationResult(separationClaim.attemptId);
    const keys = {
      ANALYSIS_ACCOMPANIMENT_STEM: outputKey(separationClaim, 'accompaniment.flac'),
      ANALYSIS_VOCAL_STEM: outputKey(separationClaim, 'vocals.flac'),
      ISOLATED_SPEECH_AUDIO: outputKey(separationClaim, 'isolated-speech.flac'),
      SEPARATION_MANIFEST: outputKey(separationClaim, 'separation-manifest.json'),
    } as const;
    harness.claim.mockResolvedValue(separationClaim);
    harness.separate.mockResolvedValue(result);
    for (const artifact of result.artifacts) {
      const key = keys[artifact.kind as keyof typeof keys];
      if (!key) throw new Error('Unexpected separation artifact in test fixture');
      harness.registerExecutorArtifact(separationClaim, result, artifact, key);
    }
    harness.manifests.readSeparation.mockResolvedValue({
      artifacts: result.artifacts.filter(({ kind }) => kind !== 'SEPARATION_MANIFEST'),
    });
    const job = {
      data: { attemptId: separationClaim.attemptId },
      name: EXECUTE_VOCAL_SEPARATION_JOB,
    } as Job;

    await harness.service.processVocalSeparation(job);

    expect(harness.separate).toHaveBeenCalledWith(
      expect.objectContaining({
        inputArtifact: expect.objectContaining({
          artifactId: canonicalArtifactId,
          channels: 2,
          kind: 'CANONICAL_AUDIO',
          sampleRateHz: 48_000,
        }),
        accompanimentStemKey: keys.ANALYSIS_ACCOMPANIMENT_STEM,
        isolatedSpeechKey: keys.ISOLATED_SPEECH_AUDIO,
        manifestKey: keys.SEPARATION_MANIFEST,
        vocalStemKey: keys.ANALYSIS_VOCAL_STEM,
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(harness.manifests.readSeparation).toHaveBeenCalledOnce();
    expect(harness.persistence.persistSeparation).toHaveBeenCalledWith(
      expect.anything(),
      separationClaim,
      result,
      bucket,
      keys,
      canonicalArtifactId,
    );
    expect(harness.complete).toHaveBeenCalledOnce();
  });

  it('uses the snapshotted M4 analysis audio directly for diarization', async () => {
    const harness = createHarness();
    const diarizationClaim = claimed(WorkflowStageKind.SPEAKER_DIARIZATION, 510);
    const result = diarizationResult(diarizationClaim.attemptId);
    const key = outputKey(diarizationClaim, 'diarization-manifest.json');
    harness.claim.mockResolvedValue(diarizationClaim);
    harness.diarize.mockResolvedValue(result);
    harness.registerExecutorArtifact(diarizationClaim, result, result.artifacts[0]!, key);
    harness.manifests.readDiarization.mockResolvedValue({
      exclusiveTurns: [],
      speakers: [],
      turns: [],
    });
    const job = {
      data: { attemptId: diarizationClaim.attemptId },
      name: EXECUTE_DIARIZATION_JOB,
    } as Job;

    await harness.service.processDiarization(job);

    expect(harness.claim).toHaveBeenCalledWith(
      diarizationClaim.attemptId,
      WorkflowStageKind.SPEAKER_DIARIZATION,
    );
    expect(harness.diarize).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket,
        inputArtifact: expect.objectContaining({
          artifactId: analysisArtifactId,
          kind: 'ANALYSIS_AUDIO',
          storageKey: analysisArtifact.storageKey,
        }),
        manifestKey: key,
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(harness.databaseClient.mediaArtifact.findFirst).not.toHaveBeenCalled();
    expect(harness.persistence.persistDiarization).toHaveBeenCalledWith(
      expect.anything(),
      diarizationClaim,
      result,
      expect.objectContaining({ speakers: [], turns: [] }),
      { key, storageBucket: bucket },
      analysisArtifactId,
    );
  });

  it('queries the same-job separation derivative and sends only isolated speech to ASR', async () => {
    const harness = createHarness();
    const transcriptionClaim = claimed(WorkflowStageKind.SPEECH_RECOGNITION, 520);
    const result = transcriptionResult(transcriptionClaim.attemptId);
    const key = outputKey(transcriptionClaim, 'transcript-manifest.json');
    harness.claim.mockResolvedValue(transcriptionClaim);
    harness.transcribe.mockResolvedValue(result);
    harness.registerExecutorArtifact(transcriptionClaim, result, result.artifacts[0]!, key);
    harness.manifests.readTranscript.mockResolvedValue({
      language: { detectedLanguage: 'en', requestedBcp47: 'en-US' },
      segments: [],
    });
    const job = {
      data: { attemptId: transcriptionClaim.attemptId },
      name: EXECUTE_TRANSCRIPTION_JOB,
    } as Job;

    await harness.service.processTranscription(job);

    expect(harness.databaseClient.mediaArtifact.findFirst).toHaveBeenCalledWith({
      include: { audioMetadata: true },
      where: {
        kind: MediaArtifactKind.SPEECH_ANALYSIS_AUDIO,
        organizationId,
        producerAttempt: { stage: { jobId } },
        projectId,
        sourceVideoId,
      },
    });
    expect(harness.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        inputArtifact: expect.objectContaining({
          artifactId: isolatedArtifactId,
          kind: 'ISOLATED_SPEECH_AUDIO',
          storageKey: isolatedArtifact.storageKey,
        }),
        manifestKey: key,
        sourceLanguageTag: 'en-US',
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(harness.persistence.persistTranscription).toHaveBeenCalledWith(
      expect.anything(),
      transcriptionClaim,
      result,
      expect.objectContaining({ segments: [] }),
      { key, storageBucket: bucket },
      isolatedArtifactId,
    );
  });

  it('materializes empty no-speech evidence as a successful zero-character result', async () => {
    const harness = createHarness();
    const characterClaim = claimed(WorkflowStageKind.CHARACTER_IDENTIFICATION, 530);
    harness.claim.mockResolvedValue(characterClaim);
    harness.databaseClient.transcriptionRun.findUnique.mockResolvedValue({
      id: '01900000-0000-7000-8000-000000000531',
      manifestArtifact: {
        id: '01900000-0000-7000-8000-000000000532',
        storageBucket: bucket,
      },
      segments: [],
    });
    harness.databaseClient.diarizationRun.findUnique.mockResolvedValue({
      clusters: [],
      id: '01900000-0000-7000-8000-000000000533',
      manifestArtifact: { id: '01900000-0000-7000-8000-000000000534' },
    });
    const job = {
      data: { attemptId: characterClaim.attemptId },
      name: EXECUTE_CHARACTER_IDENTIFICATION_JOB,
    } as Job;

    await harness.service.processCharacterIdentification(job);

    expect(harness.materialize).toHaveBeenCalledWith(
      expect.objectContaining({
        nearestTurnToleranceUs: 250_000n,
        resolver: 'deterministic-timeline-v1',
      }),
    );
    expect(harness.putImmutableObject).toHaveBeenCalledOnce();
    const body = harness.putImmutableObject.mock.calls[0]?.[0].body;
    expect(body).toBeDefined();
    const manifest = JSON.parse(Buffer.from(body!).toString('utf8')) as {
      mappings: unknown[];
      summary: {
        characterCount: number;
        dialogueSegmentCount: number;
        unresolvedSegmentCount: number;
      };
    };
    expect(manifest.mappings).toEqual([]);
    expect(manifest.summary).toEqual({
      characterCount: 0,
      dialogueSegmentCount: 0,
      unresolvedSegmentCount: 0,
    });
    expect(harness.persistence.persistCharacters).toHaveBeenCalledWith(
      expect.anything(),
      characterClaim,
      { characters: [], dialogueSegments: [], unresolvedSegmentCount: 0 },
      expect.objectContaining({ storageBucket: bucket }),
    );
    expect(harness.complete).toHaveBeenCalledWith(
      characterClaim,
      'deterministic-timeline-v1',
      expect.any(Function),
    );
  });

  it('fails character identification when its immutable resolver snapshot is not exact', async () => {
    const harness = createHarness();
    const characterClaim = claimed(WorkflowStageKind.CHARACTER_IDENTIFICATION, 535);
    characterClaim.configurationSnapshot = {
      contractVersion: 1,
      nearestTurnToleranceUs: 250_000,
      persistVoiceEmbeddings: false,
      resolver: 'deterministic-timeline-v1',
      unversionedProviderOption: true,
    };
    harness.claim.mockResolvedValue(characterClaim);
    const job = {
      data: { attemptId: characterClaim.attemptId },
      name: EXECUTE_CHARACTER_IDENTIFICATION_JOB,
    } as Job;

    await harness.service.processCharacterIdentification(job);

    expect(harness.fail).toHaveBeenCalledWith(
      characterClaim,
      'CHARACTER_STAGE_CONFIGURATION_INVALID',
      false,
    );
    expect(harness.databaseClient.transcriptionRun.findUnique).not.toHaveBeenCalled();
    expect(harness.materialize).not.toHaveBeenCalled();
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it('does not retry deterministic Prisma constraint failures after GPU output exists', async () => {
    const harness = createHarness();
    const diarizationClaim = claimed(WorkflowStageKind.SPEAKER_DIARIZATION, 538);
    const result = diarizationResult(diarizationClaim.attemptId);
    const key = outputKey(diarizationClaim, 'diarization-manifest.json');
    const constraintError = Object.assign(new Error('value too long'), {
      code: 'P2000',
      name: 'PrismaClientKnownRequestError',
    });
    harness.claim.mockResolvedValue(diarizationClaim);
    harness.diarize.mockResolvedValue(result);
    harness.registerExecutorArtifact(diarizationClaim, result, result.artifacts[0]!, key);
    harness.manifests.readDiarization.mockResolvedValue({
      exclusiveTurns: [],
      speakers: [],
      turns: [],
    });
    harness.persistence.persistDiarization.mockRejectedValue(constraintError);
    const job = {
      data: { attemptId: diarizationClaim.attemptId },
      name: EXECUTE_DIARIZATION_JOB,
    } as Job;

    await harness.service.processDiarization(job);

    expect(harness.fail).toHaveBeenCalledWith(
      diarizationClaim,
      'SPEECH_PERSISTENCE_CONSTRAINT_VIOLATION',
      false,
    );
  });

  it('defers executor saturation without consuming a semantic attempt', async () => {
    const harness = createHarness();
    const diarizationClaim = claimed(WorkflowStageKind.SPEAKER_DIARIZATION, 540);
    harness.claim.mockResolvedValue(diarizationClaim);
    harness.diarize.mockRejectedValue(
      new SpeechExecutorError('SPEECH_EXECUTOR_SATURATED', true),
    );
    const job = {
      data: { attemptId: diarizationClaim.attemptId },
      name: EXECUTE_DIARIZATION_JOB,
    } as Job;

    await harness.service.processDiarization(job);

    expect(harness.deferForCapacity).toHaveBeenCalledWith(
      diarizationClaim,
      'SPEECH_EXECUTOR_SATURATED',
    );
    expect(harness.fail).not.toHaveBeenCalled();
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.metrics.workflowAttemptCompleted).toHaveBeenCalledWith(
      'speaker_diarization',
      'failed',
      expect.any(Number),
    );
  });

  it('rejects a provider model that differs from the immutable stage snapshot', async () => {
    const harness = createHarness();
    const diarizationClaim = claimed(WorkflowStageKind.SPEAKER_DIARIZATION, 550);
    const result = diarizationResult(diarizationClaim.attemptId);
    result.model.modelRevision = 'unexpected-rollout';
    harness.claim.mockResolvedValue(diarizationClaim);
    harness.diarize.mockResolvedValue(result);
    const job = {
      data: { attemptId: diarizationClaim.attemptId },
      name: EXECUTE_DIARIZATION_JOB,
    } as Job;

    await harness.service.processDiarization(job);

    expect(harness.fail).toHaveBeenCalledWith(
      diarizationClaim,
      'SPEECH_EXECUTOR_MODEL_MISMATCH',
      false,
    );
    expect(harness.headObject).not.toHaveBeenCalled();
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it.each([
    ['runtime-version', 'unexpected-runtime'],
    ['contract-version', 'voiceverse.unexpected.v1'],
    ['input-sha256', '0'.repeat(64)],
  ])('rejects artifact provenance with a mismatched %s', async (field, value) => {
    const harness = createHarness();
    const diarizationClaim = claimed(WorkflowStageKind.SPEAKER_DIARIZATION, 560);
    const result = diarizationResult(diarizationClaim.attemptId);
    const key = outputKey(diarizationClaim, 'diarization-manifest.json');
    harness.claim.mockResolvedValue(diarizationClaim);
    harness.diarize.mockResolvedValue(result);
    harness.registerExecutorArtifact(diarizationClaim, result, result.artifacts[0]!, key, {
      [field]: value,
    });
    const job = {
      data: { attemptId: diarizationClaim.attemptId },
      name: EXECUTE_DIARIZATION_JOB,
    } as Job;

    await harness.service.processDiarization(job);

    expect(harness.fail).toHaveBeenCalledWith(
      diarizationClaim,
      'SPEECH_ARTIFACT_VERIFICATION_FAILED',
      false,
    );
    expect(harness.manifests.readDiarization).not.toHaveBeenCalled();
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it('rejects separation stems that do not preserve the canonical channel format', async () => {
    const harness = createHarness();
    const separationClaim = claimed(WorkflowStageKind.VOCAL_SEPARATION, 570);
    const result = separationResult(separationClaim.attemptId);
    const vocalStem = result.artifacts.find(({ kind }) => kind === 'ANALYSIS_VOCAL_STEM');
    if (!vocalStem) throw new Error('TestVocalStemMissing');
    vocalStem.sampleRateHz = 44_100;
    harness.claim.mockResolvedValue(separationClaim);
    harness.separate.mockResolvedValue(result);
    const job = {
      data: { attemptId: separationClaim.attemptId },
      name: EXECUTE_VOCAL_SEPARATION_JOB,
    } as Job;

    await harness.service.processVocalSeparation(job);

    expect(harness.fail).toHaveBeenCalledWith(
      separationClaim,
      'SEPARATION_STEM_FORMAT_INVALID',
      false,
    );
    expect(harness.headObject).not.toHaveBeenCalled();
    expect(harness.complete).not.toHaveBeenCalled();
  });
});
