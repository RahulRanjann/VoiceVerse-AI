import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { Environment } from '../../../config/environment';
import {
  OBJECT_STORAGE,
  type ObjectStoragePort,
} from '../../media-ingest/domain/object-storage.port';
import { SpeechExecutorError, type SpeechModelDescriptor } from '../domain/speech-executor.port';
import { SpeechManifestReadBudgetService } from './speech-manifest-read-budget.service';

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const safeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const probabilitySchema = z.number().min(0).max(1);
const modelSchema = z
  .object({
    modelId: z.string().min(1).max(128),
    modelRevision: z.string().min(1).max(128),
    provider: z.string().min(1).max(100),
    runtimeVersion: z.string().min(1).max(128),
  })
  .strict();
const timelineSchema = z
  .object({
    durationUs: positiveSafeIntegerSchema,
    intervalConvention: z.literal('HALF_OPEN'),
    originUs: z.literal(0),
  })
  .strict();
const transcriptWordSchema = z
  .object({
    endUs: positiveSafeIntegerSchema,
    ordinal: z.number().int().nonnegative(),
    probability: probabilitySchema.nullish(),
    startUs: safeIntegerSchema,
    text: z.string().min(1).max(512),
  })
  .strict();
const transcriptSegmentSchema = z
  .object({
    averageLogProbability: z.number().min(-100).max(0).nullish(),
    endUs: positiveSafeIntegerSchema,
    noSpeechProbability: probabilitySchema.nullish(),
    ordinal: z.number().int().nonnegative(),
    startUs: safeIntegerSchema,
    text: z.string().min(1).max(20_000),
    words: z.array(transcriptWordSchema).max(50_000),
  })
  .strict();
const transcriptManifestSchema = z
  .object({
    attemptId: z.string().uuid(),
    configurationHash: sha256Schema,
    executionId: z.string().uuid(),
    inputArtifactId: z.string().uuid(),
    inputSha256: sha256Schema,
    language: z
      .object({
        detectedLanguage: z.string().min(2).max(35),
        probability: probabilitySchema.nullish(),
        requestedBcp47: z.string().min(2).max(64),
      })
      .strict(),
    model: modelSchema,
    producerVersion: z.string().min(1).max(100),
    schemaVersion: z.literal('voiceverse.transcript.v1'),
    segments: z.array(transcriptSegmentSchema).max(250_000),
    timeline: timelineSchema,
  })
  .strict();
const diarizationTurnSchema = z
  .object({
    endUs: positiveSafeIntegerSchema,
    ordinal: z.number().int().nonnegative(),
    speakerKey: z.string().regex(/^speaker-[0-9]{4,}$/),
    startUs: safeIntegerSchema,
  })
  .strict();
const diarizationManifestSchema = z
  .object({
    attemptId: z.string().uuid(),
    configurationHash: sha256Schema,
    executionId: z.string().uuid(),
    exclusiveTurns: z.array(diarizationTurnSchema).max(500_000),
    inputArtifactId: z.string().uuid(),
    inputSha256: sha256Schema,
    model: modelSchema,
    producerVersion: z.string().min(1).max(100),
    schemaVersion: z.literal('voiceverse.diarization.v1'),
    speakers: z
      .array(
        z
          .object({
            firstTurnUs: safeIntegerSchema,
            localSpeakerKey: z.string().regex(/^speaker-[0-9]{4,}$/),
            providerLabel: z.string().min(1).max(100),
            totalSpeechUs: positiveSafeIntegerSchema,
          })
          .strict(),
      )
      .max(10_000),
    timeline: timelineSchema,
    turns: z.array(diarizationTurnSchema).max(500_000),
  })
  .strict();
const separationArtifactSchema = z
  .object({
    channels: z.number().int().positive().max(32),
    codecName: z.literal('flac'),
    durationUs: positiveSafeIntegerSchema,
    kind: z.enum(['ANALYSIS_VOCAL_STEM', 'ANALYSIS_ACCOMPANIMENT_STEM', 'ISOLATED_SPEECH_AUDIO']),
    mediaType: z.literal('audio/flac'),
    sampleRateHz: z.number().int().positive().max(384_000),
    sha256: sha256Schema,
    sizeBytes: positiveSafeIntegerSchema,
  })
  .strict();
const separationManifestSchema = z
  .object({
    artifacts: z.array(separationArtifactSchema).length(3),
    attemptId: z.string().uuid(),
    configurationHash: sha256Schema,
    executionId: z.string().uuid(),
    inputArtifactId: z.string().uuid(),
    inputSha256: sha256Schema,
    model: modelSchema,
    producerVersion: z.string().min(1).max(100),
    schemaVersion: z.literal('voiceverse.separation.v1'),
    timeline: timelineSchema,
  })
  .strict();

export type TranscriptManifest = z.infer<typeof transcriptManifestSchema>;
export type DiarizationManifest = z.infer<typeof diarizationManifestSchema>;
export type SeparationManifest = z.infer<typeof separationManifestSchema>;

export interface ManifestExpectation {
  artifactKind: 'diarization_manifest' | 'separation_manifest' | 'transcript_manifest';
  attemptId: string;
  bucket: string;
  configurationHash: string;
  executionId: string;
  inputArtifactId: string;
  inputDurationUs: number;
  inputSha256: string;
  key: string;
  mediaType: 'application/json';
  model: SpeechModelDescriptor;
  producerVersion: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * Reads immutable manifests through a bounded stream, verifies their S3
 * envelope and digest, then validates the provider-neutral schema. The worker
 * never trusts a compact executor response as proof that durable output exists.
 */
@Injectable()
export class SpeechManifestReaderService {
  private readonly maxBytes: number;

  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStoragePort,
    config: ConfigService<Environment, true>,
    private readonly readBudget: SpeechManifestReadBudgetService,
  ) {
    this.maxBytes = config.get('SPEECH_MANIFEST_MAX_BYTES', { infer: true });
  }

  async readTranscript(expectation: ManifestExpectation): Promise<TranscriptManifest> {
    return this.withAdmission(expectation, async () => {
      const manifest = transcriptManifestSchema.parse(await this.readJson(expectation));
      this.assertEnvelope(manifest, expectation);
      this.assertInputDuration(manifest.timeline.durationUs, expectation.inputDurationUs);
      this.assertTranscriptTimeline(manifest);
      return manifest;
    });
  }

  async readSeparation(expectation: ManifestExpectation): Promise<SeparationManifest> {
    return this.withAdmission(expectation, async () => {
      const manifest = separationManifestSchema.parse(await this.readJson(expectation));
      this.assertEnvelope(manifest, expectation);
      this.assertInputDuration(manifest.timeline.durationUs, expectation.inputDurationUs);
      const kinds = manifest.artifacts.map(({ kind }) => kind);
      if (new Set(kinds).size !== 3) {
        throw new SpeechExecutorError('SEPARATION_MANIFEST_ARTIFACT_SET_INVALID', false);
      }
      return manifest;
    });
  }

  async readDiarization(expectation: ManifestExpectation): Promise<DiarizationManifest> {
    return this.withAdmission(expectation, async () => {
      const manifest = diarizationManifestSchema.parse(await this.readJson(expectation));
      this.assertEnvelope(manifest, expectation);
      this.assertInputDuration(manifest.timeline.durationUs, expectation.inputDurationUs);
      this.assertDiarizationTimeline(manifest);
      return manifest;
    });
  }

  private async withAdmission<T>(
    expectation: ManifestExpectation,
    read: () => Promise<T>,
  ): Promise<T> {
    // Permanent object contract violations must not consume retry attempts or
    // be hidden behind the temporary process-memory saturation signal.
    if (expectation.sizeBytes > this.maxBytes) {
      throw new SpeechExecutorError('SPEECH_MANIFEST_TOO_LARGE', false);
    }

    const reservation = this.readBudget.acquire(expectation.sizeBytes);
    try {
      return await read();
    } finally {
      reservation.release();
    }
  }

  private async readJson(expectation: ManifestExpectation): Promise<unknown> {
    if (expectation.sizeBytes > this.maxBytes) {
      throw new SpeechExecutorError('SPEECH_MANIFEST_TOO_LARGE', false);
    }
    const stored = await this.storage.headObject({
      bucket: expectation.bucket,
      key: expectation.key,
    });
    const metadata = stored.metadata ?? {};
    const validEnvelope =
      stored.byteSize === expectation.sizeBytes &&
      stored.mediaType === expectation.mediaType &&
      metadata['sha256'] === expectation.sha256 &&
      metadata['artifact-kind'] === expectation.artifactKind &&
      metadata['execution-id'] === expectation.executionId &&
      metadata['attempt-id'] === expectation.attemptId &&
      metadata['configuration-hash'] === expectation.configurationHash &&
      metadata['producer'] === 'voiceverse-speech-executor' &&
      metadata['producer-version'] === expectation.producerVersion;
    if (!validEnvelope) {
      throw new SpeechExecutorError('SPEECH_MANIFEST_VERIFICATION_FAILED', false);
    }

    const stream = await this.storage.getObjectStream({
      bucket: expectation.bucket,
      key: expectation.key,
    });
    const digest = createHash('sha256');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (bytes > this.maxBytes || bytes > expectation.sizeBytes) {
        throw new SpeechExecutorError('SPEECH_MANIFEST_TOO_LARGE', false);
      }
      digest.update(chunk);
      chunks.push(chunk);
    }
    if (bytes !== expectation.sizeBytes || digest.digest('hex') !== expectation.sha256) {
      throw new SpeechExecutorError('SPEECH_MANIFEST_DIGEST_MISMATCH', false);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new SpeechExecutorError('SPEECH_MANIFEST_JSON_INVALID', false);
    }
  }

  private assertEnvelope(
    manifest: {
      attemptId: string;
      configurationHash: string;
      executionId: string;
      inputArtifactId: string;
      inputSha256: string;
      model: SpeechModelDescriptor;
      producerVersion: string;
    },
    expectation: ManifestExpectation,
  ): void {
    if (
      manifest.attemptId !== expectation.attemptId ||
      manifest.executionId !== expectation.executionId ||
      manifest.configurationHash !== expectation.configurationHash ||
      manifest.inputArtifactId !== expectation.inputArtifactId ||
      manifest.inputSha256 !== expectation.inputSha256 ||
      manifest.model.provider !== expectation.model.provider ||
      manifest.model.modelId !== expectation.model.modelId ||
      manifest.model.modelRevision !== expectation.model.modelRevision ||
      manifest.model.runtimeVersion !== expectation.model.runtimeVersion ||
      manifest.producerVersion !== expectation.producerVersion
    ) {
      throw new SpeechExecutorError('SPEECH_MANIFEST_ENVELOPE_MISMATCH', false);
    }
  }

  private assertTranscriptTimeline(manifest: TranscriptManifest): void {
    let previousEndUs = 0;
    for (const [segmentIndex, segment] of manifest.segments.entries()) {
      if (
        segment.ordinal !== segmentIndex ||
        segment.startUs < previousEndUs ||
        segment.endUs <= segment.startUs ||
        segment.endUs > manifest.timeline.durationUs
      ) {
        throw new SpeechExecutorError('TRANSCRIPT_TIMELINE_INVALID', false);
      }
      let previousWordEndUs = segment.startUs;
      for (const [wordIndex, word] of segment.words.entries()) {
        if (
          word.ordinal !== wordIndex ||
          word.startUs < previousWordEndUs ||
          word.endUs <= word.startUs ||
          word.startUs < segment.startUs ||
          word.endUs > segment.endUs
        ) {
          throw new SpeechExecutorError('TRANSCRIPT_WORD_TIMELINE_INVALID', false);
        }
        previousWordEndUs = word.endUs;
      }
      previousEndUs = segment.endUs;
    }
  }

  private assertDiarizationTimeline(manifest: DiarizationManifest): void {
    const speakerKeys = new Set(manifest.speakers.map(({ localSpeakerKey }) => localSpeakerKey));
    if (speakerKeys.size !== manifest.speakers.length) {
      throw new SpeechExecutorError('DIARIZATION_SPEAKER_DUPLICATE', false);
    }
    this.assertTurns(manifest.turns, manifest.timeline.durationUs, speakerKeys, false);
    this.assertTurns(manifest.exclusiveTurns, manifest.timeline.durationUs, speakerKeys, true);
    const speakersWithTurns = new Set(
      [...manifest.turns, ...manifest.exclusiveTurns].map(({ speakerKey }) => speakerKey),
    );
    if ([...speakerKeys].some((speakerKey) => !speakersWithTurns.has(speakerKey))) {
      throw new SpeechExecutorError('DIARIZATION_SPEAKER_WITHOUT_TURN', false);
    }
  }

  private assertInputDuration(actual: number, expected: number): void {
    if (actual !== expected) {
      throw new SpeechExecutorError('SPEECH_MANIFEST_TIMELINE_MISMATCH', false);
    }
  }

  private assertTurns(
    turns: DiarizationManifest['turns'],
    durationUs: number,
    speakerKeys: Set<string>,
    exclusive: boolean,
  ): void {
    let previousEndUs = 0;
    let previousStartUs = 0;
    for (const [index, turn] of turns.entries()) {
      const outOfOrder =
        turn.startUs < previousStartUs ||
        (turn.startUs === previousStartUs && turn.endUs < previousEndUs);
      if (
        turn.ordinal !== index ||
        turn.endUs <= turn.startUs ||
        turn.endUs > durationUs ||
        !speakerKeys.has(turn.speakerKey) ||
        outOfOrder ||
        (exclusive && turn.startUs < previousEndUs)
      ) {
        throw new SpeechExecutorError('DIARIZATION_TIMELINE_INVALID', false);
      }
      previousStartUs = turn.startUs;
      previousEndUs = turn.endUs;
    }
  }
}

export function probabilityToBasisPoints(value: number | null | undefined): number | null {
  return value == null ? null : Math.round(value * 10_000);
}

export function averageLogProbabilityToBasisPoints(
  value: number | null | undefined,
): number | null {
  return value == null ? null : Math.round(Math.exp(value) * 10_000);
}
