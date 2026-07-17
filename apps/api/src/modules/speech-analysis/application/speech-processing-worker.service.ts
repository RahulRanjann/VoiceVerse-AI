import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaArtifactKind, type Prisma, WorkflowStageKind } from '@voiceverse/database';
import { Job, Worker } from 'bullmq';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { Environment } from '../../../config/environment';
import { DatabaseService } from '../../../infrastructure/database/database.service';
import { MetricsService } from '../../../observability/metrics.service';
import { ObjectStorageUnavailableError } from '../../media-ingest/domain/object-storage.error';
import {
  OBJECT_STORAGE,
  type ObjectStoragePort,
} from '../../media-ingest/domain/object-storage.port';
import {
  SPEECH_EXECUTOR,
  SpeechExecutorError,
  type SpeakerDiarizationResult,
  type SpeechExecutorPort,
  type SpeechGeneratedArtifact,
  type SpeechInputArtifactKind,
  type SpeechInputArtifactReference,
  type SpeechModelDescriptor,
  type TranscriptionResult,
  type VocalSeparationResult,
} from '../domain/speech-executor.port';
import {
  CHARACTER_IDENTIFICATION_QUEUE,
  DIARIZATION_QUEUE,
  EXECUTE_CHARACTER_IDENTIFICATION_JOB,
  EXECUTE_DIARIZATION_JOB,
  EXECUTE_TRANSCRIPTION_JOB,
  EXECUTE_VOCAL_SEPARATION_JOB,
  TRANSCRIPTION_QUEUE,
  VOCAL_SEPARATION_QUEUE,
} from '../infrastructure/speech-analysis.queue';
import {
  SpeechManifestReaderService,
  type ManifestExpectation,
  type SeparationManifest,
} from '../infrastructure/speech-manifest-reader.service';
import { SpeechAnalysisPersistenceService } from './speech-analysis-persistence.service';
import { SpeechCapabilityReadinessService } from './speech-capability-readiness.service';
import {
  type ClaimedSpeechAttempt,
  SpeechWorkflowCoordinatorService,
  WorkflowJobTerminalError,
} from './speech-workflow-coordinator.service';
import {
  DETERMINISTIC_TIMELINE_RESOLVER,
  TimelineMaterializerService,
} from './timeline-materializer.service';

const jobDataSchema = z.object({ attemptId: z.string().uuid() }).strict();
const providerConfigurationSchema = z
  .object({
    provider: z
      .object({
        modelId: z.string().min(1).max(128),
        modelRevision: z.string().min(1).max(128),
        provider: z.string().min(1).max(100),
        runtimeVersion: z.string().min(1).max(128),
      })
      .strict(),
  })
  .passthrough();
const characterConfigurationSchema = z
  .object({
    contractVersion: z.literal(1),
    nearestTurnToleranceUs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    persistVoiceEmbeddings: z.literal(false),
    resolver: z.literal(DETERMINISTIC_TIMELINE_RESOLVER),
  })
  .strict();
const NON_RETRYABLE_PRISMA_CONSTRAINT_CODES = new Set([
  'P2000', // value exceeds the target column length
  'P2002', // unique constraint
  'P2003', // foreign-key constraint
  'P2004', // database constraint
  'P2011', // null constraint
  'P2014', // required relation violation
  'P2020', // value outside the target column range
]);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_AUDIO_DURATION_DRIFT_US = 50_000;

type ArtifactWithAudio = Prisma.MediaArtifactGetPayload<{ include: { audioMetadata: true } }>;

type TranscriptionEvidence = Prisma.TranscriptionRunGetPayload<{
  include: {
    manifestArtifact: true;
    segments: { include: { words: true } };
  };
}>;

type DiarizationEvidence = Prisma.DiarizationRunGetPayload<{
  include: {
    clusters: { include: { turns: true } };
    manifestArtifact: true;
  };
}>;

interface CharacterEvidence {
  diarization: DiarizationEvidence;
  transcription: TranscriptionEvidence;
}

/**
 * Starts four independently scalable BullMQ consumers. GPU-heavy capabilities
 * share no in-process model state with the Nest worker; each call crosses the
 * authenticated provider-neutral executor port and persists only verified,
 * immutable outputs.
 */
@Injectable()
export class SpeechProcessingWorkerService implements OnApplicationShutdown {
  private readonly characterConcurrency: number;
  private readonly diarizationConcurrency: number;
  private readonly enabled: boolean;
  private readonly logger = new Logger(SpeechProcessingWorkerService.name);
  private lastReadinessWarningAt = 0;
  private readonly redisUrl: string;
  private readonly transcriptionConcurrency: number;
  private readonly vocalSeparationConcurrency: number;
  private connection?: Redis;
  private startPromise?: Promise<boolean>;
  private workers: Worker[] = [];

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
    private readonly coordinator: SpeechWorkflowCoordinatorService,
    @Inject(SPEECH_EXECUTOR) private readonly executor: SpeechExecutorPort,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStoragePort,
    private readonly manifests: SpeechManifestReaderService,
    private readonly persistence: SpeechAnalysisPersistenceService,
    private readonly materializer: TimelineMaterializerService,
    private readonly metrics: MetricsService,
    private readonly readiness: SpeechCapabilityReadinessService,
  ) {
    this.enabled = config.get('SPEECH_ANALYSIS_ENABLED', { infer: true });
    this.redisUrl = config.get('REDIS_URL', { infer: true });
    this.vocalSeparationConcurrency = config.get('VOCAL_SEPARATION_CONCURRENCY', {
      infer: true,
    });
    this.transcriptionConcurrency = config.get('TRANSCRIPTION_CONCURRENCY', { infer: true });
    this.diarizationConcurrency = config.get('DIARIZATION_CONCURRENCY', { infer: true });
    this.characterConcurrency = config.get('CHARACTER_IDENTIFICATION_CONCURRENCY', {
      infer: true,
    });
  }

  async ensureStarted(): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.workers.length > 0) return true;
    this.startPromise ??= this.startWhenReady();
    const started = await this.startPromise;
    if (!started) this.startPromise = undefined;
    return started;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    if (this.connection && this.connection.status !== 'end') await this.connection.quit();
  }

  async recoverExpiredAttempts(limit = 25): Promise<number> {
    if (!this.enabled) return 0;
    return this.coordinator.recoverExpiredAttempts(limit);
  }

  async processVocalSeparation(job: Job): Promise<void> {
    this.assertJob(job, EXECUTE_VOCAL_SEPARATION_JOB);
    const claimed = await this.claimJob(job, WorkflowStageKind.VOCAL_SEPARATION);
    if (!claimed) return;
    await this.executeClaimed(claimed, async (signal) => {
      const input = this.jobInput(claimed, 'VOCAL_SEPARATION_SOURCE');
      const prefix = this.outputPrefix(claimed);
      const keys = {
        ANALYSIS_ACCOMPANIMENT_STEM: `${prefix}/accompaniment.flac`,
        ANALYSIS_VOCAL_STEM: `${prefix}/vocals.flac`,
        ISOLATED_SPEECH_AUDIO: `${prefix}/isolated-speech.flac`,
        SEPARATION_MANIFEST: `${prefix}/separation-manifest.json`,
      } as const;
      const expectedModel = this.expectedModel(claimed);
      const inputReference = this.inputReference(input.artifact, 'CANONICAL_AUDIO');
      const result = await this.executor.separate(
        {
          accompanimentStemKey: keys.ANALYSIS_ACCOMPANIMENT_STEM,
          attemptId: claimed.attemptId,
          bucket: input.artifact.storageBucket,
          configurationHash: claimed.configurationHash,
          executionId: claimed.jobId,
          expectedModel,
          inputArtifact: inputReference,
          isolatedSpeechKey: keys.ISOLATED_SPEECH_AUDIO,
          manifestKey: keys.SEPARATION_MANIFEST,
          vocalStemKey: keys.ANALYSIS_VOCAL_STEM,
        },
        { signal },
      );
      this.assertExpectedModel(expectedModel, result.model);
      this.assertSeparationArtifacts(result, inputReference);
      await this.verifyArtifacts(
        claimed,
        result,
        input.artifact.storageBucket,
        keys,
        inputReference.sha256,
      );
      const manifestArtifact = this.artifact(result.artifacts, 'SEPARATION_MANIFEST');
      const manifest = await this.manifests.readSeparation(
        this.manifestExpectation(
          claimed,
          result,
          input.artifact,
          manifestArtifact,
          keys.SEPARATION_MANIFEST,
          'separation_manifest',
        ),
      );
      this.assertSeparationManifest(result, manifest);
      await this.coordinator.complete(claimed, result.producerVersion, (transaction) =>
        this.persistence.persistSeparation(
          transaction,
          claimed,
          result,
          input.artifact.storageBucket,
          keys,
          input.artifact.id,
        ),
      );
      this.recordArtifacts(result.artifacts);
    });
  }

  async processTranscription(job: Job): Promise<void> {
    this.assertJob(job, EXECUTE_TRANSCRIPTION_JOB);
    const claimed = await this.claimJob(job, WorkflowStageKind.SPEECH_RECOGNITION);
    if (!claimed) return;
    await this.executeClaimed(claimed, async (signal) => {
      const input = await this.producedArtifact(claimed, MediaArtifactKind.SPEECH_ANALYSIS_AUDIO);
      const manifestKey = `${this.outputPrefix(claimed)}/transcript-manifest.json`;
      const expectedModel = this.expectedModel(claimed);
      const inputReference = this.inputReference(input, 'ISOLATED_SPEECH_AUDIO');
      const result = await this.executor.transcribe(
        {
          attemptId: claimed.attemptId,
          bucket: input.storageBucket,
          configurationHash: claimed.configurationHash,
          executionId: claimed.jobId,
          expectedModel,
          inputArtifact: inputReference,
          manifestKey,
          sourceLanguageTag: claimed.sourceLanguageTag,
        },
        { signal },
      );
      this.assertExpectedModel(expectedModel, result.model);
      await this.verifyArtifacts(
        claimed,
        result,
        input.storageBucket,
        { TRANSCRIPT_MANIFEST: manifestKey },
        inputReference.sha256,
      );
      const metadata = this.artifact(result.artifacts, 'TRANSCRIPT_MANIFEST');
      const manifest = await this.manifests.readTranscript(
        this.manifestExpectation(
          claimed,
          result,
          input,
          metadata,
          manifestKey,
          'transcript_manifest',
        ),
      );
      if (manifest.language.requestedBcp47 !== claimed.sourceLanguageTag) {
        throw new SpeechExecutorError('TRANSCRIPTION_LANGUAGE_REQUEST_MISMATCH', false);
      }
      const wordCount = manifest.segments.reduce(
        (total, segment) => total + segment.words.length,
        0,
      );
      if (
        result.summary.segmentCount !== manifest.segments.length ||
        result.summary.wordCount !== wordCount ||
        result.summary.detectedLanguage !== manifest.language.detectedLanguage
      ) {
        throw new SpeechExecutorError('TRANSCRIPTION_SUMMARY_MISMATCH', false);
      }
      await this.coordinator.complete(claimed, result.producerVersion, (transaction) =>
        this.persistence.persistTranscription(
          transaction,
          claimed,
          result,
          manifest,
          { key: manifestKey, storageBucket: input.storageBucket },
          input.id,
        ),
      );
      this.recordArtifacts(result.artifacts);
    });
  }

  async processDiarization(job: Job): Promise<void> {
    this.assertJob(job, EXECUTE_DIARIZATION_JOB);
    const claimed = await this.claimJob(job, WorkflowStageKind.SPEAKER_DIARIZATION);
    if (!claimed) return;
    await this.executeClaimed(claimed, async (signal) => {
      const input = this.jobInput(claimed, 'DIARIZATION_SOURCE');
      const manifestKey = `${this.outputPrefix(claimed)}/diarization-manifest.json`;
      const expectedModel = this.expectedModel(claimed);
      const inputReference = this.inputReference(input.artifact, 'ANALYSIS_AUDIO');
      const result = await this.executor.diarize(
        {
          attemptId: claimed.attemptId,
          bucket: input.artifact.storageBucket,
          configurationHash: claimed.configurationHash,
          executionId: claimed.jobId,
          expectedModel,
          inputArtifact: inputReference,
          manifestKey,
        },
        { signal },
      );
      this.assertExpectedModel(expectedModel, result.model);
      await this.verifyArtifacts(
        claimed,
        result,
        input.artifact.storageBucket,
        { DIARIZATION_MANIFEST: manifestKey },
        inputReference.sha256,
      );
      const metadata = this.artifact(result.artifacts, 'DIARIZATION_MANIFEST');
      const manifest = await this.manifests.readDiarization(
        this.manifestExpectation(
          claimed,
          result,
          input.artifact,
          metadata,
          manifestKey,
          'diarization_manifest',
        ),
      );
      if (
        result.summary.speakerCount !== manifest.speakers.length ||
        result.summary.turnCount !== manifest.turns.length ||
        result.summary.exclusiveTurnCount !== manifest.exclusiveTurns.length
      ) {
        throw new SpeechExecutorError('DIARIZATION_SUMMARY_MISMATCH', false);
      }
      await this.coordinator.complete(claimed, result.producerVersion, (transaction) =>
        this.persistence.persistDiarization(
          transaction,
          claimed,
          result,
          manifest,
          { key: manifestKey, storageBucket: input.artifact.storageBucket },
          input.artifact.id,
        ),
      );
      this.recordArtifacts(result.artifacts);
    });
  }

  async processCharacterIdentification(job: Job): Promise<void> {
    this.assertJob(job, EXECUTE_CHARACTER_IDENTIFICATION_JOB);
    const claimed = await this.claimJob(job, WorkflowStageKind.CHARACTER_IDENTIFICATION);
    if (!claimed) return;
    await this.executeClaimed(claimed, async (signal) => {
      const configuration = this.characterConfiguration(claimed);
      const evidence = this.assertCharacterEvidence(await this.loadCharacterEvidence(claimed));
      const materialized = this.materializer.materialize({
        nearestTurnToleranceUs: BigInt(configuration.nearestTurnToleranceUs),
        resolver: configuration.resolver,
        speakerClusters: evidence.diarization.clusters.map((cluster) => ({
          id: cluster.id,
          ordinal: cluster.ordinal,
        })),
        speakerTurns: evidence.diarization.clusters.flatMap((cluster) =>
          cluster.turns.map((turn) => ({
            endTimeUs: turn.endTimeUs,
            id: turn.id,
            isExclusive: turn.isExclusive,
            isOverlapping: turn.hasOverlap,
            sequenceNumber: turn.sequenceNumber,
            speakerClusterId: cluster.id,
            startTimeUs: turn.startTimeUs,
          })),
        ),
        transcriptSegments: evidence.transcription.segments.map((segment) => ({
          confidenceBasisPoints: segment.confidenceBasisPoints,
          endTimeUs: segment.endTimeUs,
          id: segment.id,
          sequenceNumber: segment.sequenceNumber,
          startTimeUs: segment.startTimeUs,
          text: segment.text,
          words: segment.words.map((word) => ({
            confidenceBasisPoints: word.confidenceBasisPoints,
            endTimeUs: word.endTimeUs,
            id: word.id,
            sequenceNumber: word.sequenceNumber,
            startTimeUs: word.startTimeUs,
            text: word.text,
            transcriptSegmentId: segment.id,
          })),
        })),
      });
      const body = this.characterManifest(claimed, evidence, materialized);
      this.assertLeaseActive(signal);
      const manifestSha256 = createHash('sha256').update(body).digest('hex');
      const manifestKey = `${this.outputPrefix(claimed)}/character-identification-manifest.json`;
      const storageBucket = evidence.transcription.manifestArtifact.storageBucket;
      await this.storage.putImmutableObject({
        body,
        bucket: storageBucket,
        key: manifestKey,
        mediaType: 'application/json',
        metadata: {
          'artifact-kind': 'character_identification_manifest',
          'attempt-id': claimed.attemptId,
          'configuration-hash': claimed.configurationHash,
          'execution-id': claimed.jobId,
          producer: 'voiceverse-character-resolver',
          'producer-version': 'deterministic-timeline-v1',
        },
        sha256: manifestSha256,
      });
      await this.verifyCharacterManifest(
        claimed,
        storageBucket,
        manifestKey,
        body.byteLength,
        manifestSha256,
      );
      await this.coordinator.complete(claimed, 'deterministic-timeline-v1', (transaction) =>
        this.persistence.persistCharacters(transaction, claimed, materialized, {
          bodySize: body.byteLength,
          diarizationManifestArtifactId: evidence.diarization.manifestArtifact.id,
          diarizationRunId: evidence.diarization.id,
          manifestKey,
          manifestSha256,
          storageBucket,
          transcriptionManifestArtifactId: evidence.transcription.manifestArtifact.id,
          transcriptionRunId: evidence.transcription.id,
        }),
      );
      this.metrics.workflowArtifactRegistered('character_identification_manifest', body.byteLength);
    });
  }

  private createWorker(
    queueName: string,
    concurrency: number,
    processor: (job: Job) => Promise<void>,
  ): Worker {
    const worker = new Worker(queueName, processor, {
      concurrency,
      connection: this.connection!,
    });
    worker.on('failed', (job, error) => {
      this.logger.warn(
        { errorCode: error.name, queueJobId: job?.id, queueName },
        'Speech-analysis delivery failed',
      );
    });
    worker.on('error', (error) => {
      this.logger.error({ errorCode: error.name, queueName }, 'Speech-analysis worker error');
    });
    return worker;
  }

  private async startWhenReady(): Promise<boolean> {
    try {
      await this.readiness.assertAll();
    } catch (error) {
      const now = Date.now();
      if (now - this.lastReadinessWarningAt >= 30_000) {
        this.lastReadinessWarningAt = now;
        this.logger.warn(
          { errorCode: error instanceof Error ? error.name : 'UnknownError' },
          'Speech-analysis consumers remain paused until every executor capability is ready',
        );
      }
      return false;
    }
    if (this.workers.length > 0) return true;
    this.connection = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
    this.workers = [
      this.createWorker(VOCAL_SEPARATION_QUEUE, this.vocalSeparationConcurrency, (job) =>
        this.processVocalSeparation(job),
      ),
      this.createWorker(TRANSCRIPTION_QUEUE, this.transcriptionConcurrency, (job) =>
        this.processTranscription(job),
      ),
      this.createWorker(DIARIZATION_QUEUE, this.diarizationConcurrency, (job) =>
        this.processDiarization(job),
      ),
      this.createWorker(CHARACTER_IDENTIFICATION_QUEUE, this.characterConcurrency, (job) =>
        this.processCharacterIdentification(job),
      ),
    ];
    this.logger.log('Speech-analysis capability workers started after exact readiness handshake');
    return true;
  }

  private async claimJob(job: Job, kind: WorkflowStageKind): Promise<ClaimedSpeechAttempt | null> {
    const { attemptId } = jobDataSchema.parse(job.data);
    const capability = remoteCapabilityForStage(kind);
    // Check before acquiring the durable lease. An unavailable dependency is a
    // delivery condition, not a model attempt, so PostgreSQL remains QUEUED.
    if (capability) await this.readiness.assert(capability);
    return this.coordinator.claim(attemptId, kind);
  }

  private async executeClaimed(
    claimed: ClaimedSpeechAttempt,
    execute: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const stage = metricStage(claimed.stageKind);
    const startedAt = performance.now();
    let outcome: 'failed' | 'succeeded' = 'failed';
    this.metrics.workflowAttemptStarted(stage);
    const heartbeat = this.coordinator.startHeartbeat(claimed);
    try {
      await execute(heartbeat.signal);
      outcome = 'succeeded';
    } catch (error) {
      const failure = this.normalizeFailure(error);
      if (
        failure.code === 'SPEECH_EXECUTOR_SATURATED' &&
        (await this.coordinator.deferForCapacity(claimed, failure.code))
      ) {
        return;
      }
      await this.coordinator.fail(claimed, failure.code, failure.retryable);
    } finally {
      heartbeat.stop();
      this.metrics.workflowAttemptCompleted(
        stage,
        outcome,
        (performance.now() - startedAt) / 1_000,
      );
    }
  }

  private assertLeaseActive(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('WorkflowAttemptLeaseLost');
  }

  private jobInput(claimed: ClaimedSpeechAttempt, role: string) {
    const input = claimed.inputArtifacts.find((candidate) => candidate.role === role);
    if (!input) throw new SpeechExecutorError(`SPEECH_JOB_INPUT_MISSING_${role}`, false);
    return input;
  }

  private async producedArtifact(claimed: ClaimedSpeechAttempt, kind: MediaArtifactKind) {
    const artifact = await this.database.client.mediaArtifact.findFirst({
      include: { audioMetadata: true },
      where: {
        kind,
        organizationId: claimed.organizationId,
        producerAttempt: { stage: { jobId: claimed.jobId } },
        projectId: claimed.projectId,
        sourceVideoId: claimed.sourceVideoId,
      },
    });
    if (!artifact) throw new SpeechExecutorError(`SPEECH_INPUT_ARTIFACT_MISSING_${kind}`, false);
    return artifact;
  }

  private inputReference(
    artifact: ArtifactWithAudio,
    kind: SpeechInputArtifactKind,
  ): SpeechInputArtifactReference {
    if (
      artifact.mediaType !== 'audio/flac' ||
      !artifact.audioMetadata ||
      artifact.byteSize > MAX_SAFE_BIGINT
    ) {
      throw new SpeechExecutorError('SPEECH_INPUT_ARTIFACT_INVALID', false);
    }
    const durationUs = this.audioDurationUs(artifact);
    return {
      artifactId: artifact.id,
      byteSize: Number(artifact.byteSize),
      channels: artifact.audioMetadata.channels,
      durationUs,
      kind,
      mediaType: 'audio/flac',
      sampleRateHz: artifact.audioMetadata.sampleRateHz,
      sha256: artifact.sha256,
      storageKey: artifact.storageKey,
    };
  }

  private async verifyArtifacts(
    claimed: ClaimedSpeechAttempt,
    result: VocalSeparationResult | TranscriptionResult | SpeakerDiarizationResult,
    bucket: string,
    keys: Partial<Record<SpeechGeneratedArtifact['kind'], string>>,
    inputSha256: string,
  ): Promise<void> {
    await Promise.all(
      result.artifacts.map(async (artifact) => {
        const key = keys[artifact.kind];
        if (!key) throw new SpeechExecutorError('SPEECH_ARTIFACT_KEY_MISSING', false);
        const stored = await this.storage.headObject({ bucket, key });
        const metadata = stored.metadata ?? {};
        const valid =
          stored.byteSize === artifact.sizeBytes &&
          stored.mediaType === artifact.mediaType &&
          metadata['sha256'] === artifact.sha256 &&
          metadata['artifact-kind'] === artifact.kind.toLowerCase() &&
          metadata['execution-id'] === claimed.jobId &&
          metadata['attempt-id'] === claimed.attemptId &&
          metadata['configuration-hash'] === claimed.configurationHash &&
          metadata['producer'] === 'voiceverse-speech-executor' &&
          metadata['producer-version'] === result.producerVersion &&
          metadata['provider'] === result.model.provider &&
          metadata['model-id'] === result.model.modelId &&
          metadata['model-revision'] === result.model.modelRevision &&
          metadata['runtime-version'] === result.model.runtimeVersion &&
          metadata['contract-version'] === result.schemaVersion &&
          metadata['input-sha256'] === inputSha256;
        if (!valid) throw new SpeechExecutorError('SPEECH_ARTIFACT_VERIFICATION_FAILED', false);
      }),
    );
  }

  private manifestExpectation(
    claimed: ClaimedSpeechAttempt,
    result: VocalSeparationResult | TranscriptionResult | SpeakerDiarizationResult,
    input: ArtifactWithAudio,
    artifact: SpeechGeneratedArtifact,
    key: string,
    artifactKind: ManifestExpectation['artifactKind'],
  ): ManifestExpectation {
    return {
      artifactKind,
      attemptId: claimed.attemptId,
      bucket: input.storageBucket,
      configurationHash: claimed.configurationHash,
      executionId: claimed.jobId,
      inputArtifactId: input.id,
      inputDurationUs: this.audioDurationUs(input),
      inputSha256: input.sha256,
      key,
      mediaType: 'application/json',
      model: result.model,
      producerVersion: result.producerVersion,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
    };
  }

  private assertSeparationArtifacts(
    result: VocalSeparationResult,
    input: SpeechInputArtifactReference,
  ): void {
    const audioArtifacts = result.artifacts.filter(({ kind }) => kind !== 'SEPARATION_MANIFEST');
    const manifest = this.artifact(result.artifacts, 'SEPARATION_MANIFEST');
    if (audioArtifacts.length !== 3 || manifest.mediaType !== 'application/json') {
      throw new SpeechExecutorError('SEPARATION_ARTIFACT_CONTRACT_INVALID', false);
    }
    for (const artifact of audioArtifacts) {
      if (
        artifact.mediaType !== 'audio/flac' ||
        artifact.codecName !== 'flac' ||
        artifact.sampleRateHz == null ||
        artifact.channels == null ||
        artifact.durationUs == null ||
        Math.abs(artifact.durationUs - input.durationUs) > MAX_AUDIO_DURATION_DRIFT_US
      ) {
        throw new SpeechExecutorError('SEPARATION_AUDIO_METADATA_INVALID', false);
      }
      if (
        artifact.kind === 'ISOLATED_SPEECH_AUDIO' &&
        (artifact.sampleRateHz !== 16_000 || artifact.channels !== 1)
      ) {
        throw new SpeechExecutorError('ISOLATED_SPEECH_FORMAT_INVALID', false);
      }
      if (
        artifact.kind !== 'ISOLATED_SPEECH_AUDIO' &&
        (artifact.sampleRateHz !== input.sampleRateHz || artifact.channels !== input.channels)
      ) {
        throw new SpeechExecutorError('SEPARATION_STEM_FORMAT_INVALID', false);
      }
    }
  }

  private assertSeparationManifest(
    result: VocalSeparationResult,
    manifest: SeparationManifest,
  ): void {
    for (const embedded of manifest.artifacts) {
      const response = this.artifact(result.artifacts, embedded.kind);
      if (
        response.mediaType !== embedded.mediaType ||
        response.sha256 !== embedded.sha256 ||
        response.sizeBytes !== embedded.sizeBytes ||
        response.codecName !== embedded.codecName ||
        response.sampleRateHz !== embedded.sampleRateHz ||
        response.channels !== embedded.channels ||
        response.durationUs !== embedded.durationUs
      ) {
        throw new SpeechExecutorError('SEPARATION_MANIFEST_ARTIFACT_MISMATCH', false);
      }
    }
  }

  private audioDurationUs(artifact: ArtifactWithAudio): number {
    if (!artifact.audioMetadata) {
      throw new SpeechExecutorError('SPEECH_INPUT_ARTIFACT_INVALID', false);
    }
    const durationUs =
      artifact.audioMetadata.durationUs ?? artifact.audioMetadata.durationMs * 1_000n;
    if (durationUs <= 0n || durationUs > MAX_SAFE_BIGINT) {
      throw new SpeechExecutorError('SPEECH_INPUT_DURATION_UNSUPPORTED', false);
    }
    return Number(durationUs);
  }

  private expectedModel(claimed: ClaimedSpeechAttempt): SpeechModelDescriptor {
    const configuration = providerConfigurationSchema.safeParse(claimed.configurationSnapshot);
    if (!configuration.success) {
      throw new SpeechExecutorError('SPEECH_STAGE_CONFIGURATION_INVALID', false);
    }
    return configuration.data.provider;
  }

  private assertExpectedModel(
    expected: SpeechModelDescriptor,
    actual: SpeechModelDescriptor,
  ): void {
    if (
      actual.provider !== expected.provider ||
      actual.modelId !== expected.modelId ||
      actual.modelRevision !== expected.modelRevision ||
      actual.runtimeVersion !== expected.runtimeVersion
    ) {
      throw new SpeechExecutorError('SPEECH_EXECUTOR_MODEL_MISMATCH', false);
    }
  }

  private characterConfiguration(claimed: ClaimedSpeechAttempt) {
    const configuration = characterConfigurationSchema.safeParse(claimed.configurationSnapshot);
    if (!configuration.success) {
      throw new SpeechExecutorError('CHARACTER_STAGE_CONFIGURATION_INVALID', false);
    }
    return configuration.data;
  }

  private async loadCharacterEvidence(claimed: ClaimedSpeechAttempt) {
    const [transcription, diarization] = await Promise.all([
      this.database.client.transcriptionRun.findUnique({
        include: {
          manifestArtifact: true,
          segments: {
            include: { words: { orderBy: { sequenceNumber: 'asc' } } },
            orderBy: { sequenceNumber: 'asc' },
          },
        },
        where: { speechAnalysisId: claimed.speechAnalysisId },
      }),
      this.database.client.diarizationRun.findUnique({
        include: {
          clusters: {
            include: { turns: { orderBy: [{ startTimeUs: 'asc' }, { id: 'asc' }] } },
            orderBy: { ordinal: 'asc' },
          },
          manifestArtifact: true,
        },
        where: { speechAnalysisId: claimed.speechAnalysisId },
      }),
    ]);
    return { diarization, transcription };
  }

  private assertCharacterEvidence(evidence: {
    diarization: DiarizationEvidence | null;
    transcription: TranscriptionEvidence | null;
  }): CharacterEvidence {
    if (!evidence.transcription || !evidence.diarization) {
      throw new SpeechExecutorError('CHARACTER_IDENTIFICATION_INPUT_MISSING', false);
    }
    return evidence as CharacterEvidence;
  }

  private characterManifest(
    claimed: ClaimedSpeechAttempt,
    evidence: CharacterEvidence,
    materialized: ReturnType<TimelineMaterializerService['materialize']>,
  ): Uint8Array {
    const payload = {
      attemptId: claimed.attemptId,
      configurationHash: claimed.configurationHash,
      executionId: claimed.jobId,
      inputs: {
        diarizationRunId: evidence.diarization.id,
        transcriptionRunId: evidence.transcription.id,
      },
      mappings: materialized.characters.map((character) => ({
        firstAppearanceUs: character.firstAppearanceTimeUs.toString(),
        segmentCount: character.segmentCount,
        speakerClusterId: character.speakerClusterId,
        speakingDurationUs: character.speakingDurationUs.toString(),
        stableCharacterKey: character.stableKey,
        wordCount: character.wordCount,
      })),
      resolver: { name: 'deterministic-timeline', version: 'v1' },
      schemaVersion: 'voiceverse.character-identification.v1',
      summary: {
        characterCount: materialized.characters.length,
        dialogueSegmentCount: materialized.dialogueSegments.length,
        unresolvedSegmentCount: materialized.unresolvedSegmentCount,
      },
    };
    return Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  }

  private async verifyCharacterManifest(
    claimed: ClaimedSpeechAttempt,
    bucket: string,
    key: string,
    sizeBytes: number,
    sha256: string,
  ): Promise<void> {
    const stored = await this.storage.headObject({ bucket, key });
    const metadata = stored.metadata ?? {};
    if (
      stored.byteSize !== sizeBytes ||
      stored.mediaType !== 'application/json' ||
      metadata['sha256'] !== sha256 ||
      metadata['artifact-kind'] !== 'character_identification_manifest' ||
      metadata['execution-id'] !== claimed.jobId ||
      metadata['attempt-id'] !== claimed.attemptId ||
      metadata['configuration-hash'] !== claimed.configurationHash ||
      metadata['producer'] !== 'voiceverse-character-resolver' ||
      metadata['producer-version'] !== 'deterministic-timeline-v1'
    ) {
      throw new SpeechExecutorError('CHARACTER_MANIFEST_VERIFICATION_FAILED', false);
    }
  }

  private artifact(
    artifacts: SpeechGeneratedArtifact[],
    kind: SpeechGeneratedArtifact['kind'],
  ): SpeechGeneratedArtifact {
    const artifact = artifacts.find((candidate) => candidate.kind === kind);
    if (!artifact) throw new SpeechExecutorError(`SPEECH_ARTIFACT_MISSING_${kind}`, false);
    return artifact;
  }

  private recordArtifacts(artifacts: SpeechGeneratedArtifact[]): void {
    for (const artifact of artifacts) {
      const metricKind = databaseMetricKind(artifact.kind);
      this.metrics.workflowArtifactRegistered(metricKind, artifact.sizeBytes);
    }
  }

  private normalizeFailure(error: unknown): { code: string; retryable: boolean } {
    if (error instanceof SpeechExecutorError) {
      return { code: error.code.slice(0, 100), retryable: error.retryable };
    }
    if (error instanceof ObjectStorageUnavailableError) {
      return { code: 'OBJECT_STORAGE_UNAVAILABLE', retryable: true };
    }
    if (error instanceof z.ZodError) {
      return { code: 'SPEECH_MANIFEST_CONTRACT_INVALID', retryable: false };
    }
    if (error instanceof WorkflowJobTerminalError) {
      return { code: 'WORKFLOW_JOB_TERMINAL', retryable: false };
    }
    if (isNonRetryablePrismaConstraint(error)) {
      return { code: 'SPEECH_PERSISTENCE_CONSTRAINT_VIOLATION', retryable: false };
    }
    return {
      code: error instanceof Error ? error.name.slice(0, 100) : 'UNKNOWN_SPEECH_PROCESSING_ERROR',
      retryable: true,
    };
  }

  private outputPrefix(claimed: ClaimedSpeechAttempt): string {
    return `organizations/${claimed.organizationId}/projects/${claimed.projectId}/videos/${claimed.sourceVideoId}/speech-analysis/attempts/${claimed.attemptId}`;
  }

  private assertJob(job: Job, expectedName: string): void {
    if (job.name !== expectedName) throw new Error('UnsupportedSpeechProcessingJob');
  }
}

function isNonRetryablePrismaConstraint(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return (
    candidate.name === 'PrismaClientKnownRequestError' &&
    typeof candidate.code === 'string' &&
    NON_RETRYABLE_PRISMA_CONSTRAINT_CODES.has(candidate.code)
  );
}

function metricStage(kind: WorkflowStageKind) {
  switch (kind) {
    case WorkflowStageKind.VOCAL_SEPARATION:
      return 'vocal_separation' as const;
    case WorkflowStageKind.SPEECH_RECOGNITION:
      return 'speech_recognition' as const;
    case WorkflowStageKind.SPEAKER_DIARIZATION:
      return 'speaker_diarization' as const;
    case WorkflowStageKind.CHARACTER_IDENTIFICATION:
      return 'character_identification' as const;
    default:
      throw new Error('UnsupportedSpeechWorkflowStage');
  }
}

function remoteCapabilityForStage(kind: WorkflowStageKind) {
  switch (kind) {
    case WorkflowStageKind.VOCAL_SEPARATION:
      return 'VOCAL_SEPARATION' as const;
    case WorkflowStageKind.SPEECH_RECOGNITION:
      return 'TRANSCRIPTION' as const;
    case WorkflowStageKind.SPEAKER_DIARIZATION:
      return 'SPEAKER_DIARIZATION' as const;
    case WorkflowStageKind.CHARACTER_IDENTIFICATION:
      return null;
    default:
      throw new Error('UnsupportedSpeechWorkflowStage');
  }
}

function databaseMetricKind(kind: SpeechGeneratedArtifact['kind']) {
  switch (kind) {
    case 'ANALYSIS_VOCAL_STEM':
      return 'vocal_stem_audio' as const;
    case 'ANALYSIS_ACCOMPANIMENT_STEM':
      return 'accompaniment_stem_audio' as const;
    case 'ISOLATED_SPEECH_AUDIO':
      return 'speech_analysis_audio' as const;
    case 'SEPARATION_MANIFEST':
      return 'vocal_separation_manifest' as const;
    case 'TRANSCRIPT_MANIFEST':
      return 'transcription_manifest' as const;
    case 'DIARIZATION_MANIFEST':
      return 'diarization_manifest' as const;
  }
}
