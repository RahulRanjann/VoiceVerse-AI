import type { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import type { ObjectStoragePort } from '../../media-ingest/domain/object-storage.port';
import { SpeechManifestReadBudgetService } from './speech-manifest-read-budget.service';
import {
  type ManifestExpectation,
  SpeechManifestReaderService,
} from './speech-manifest-reader.service';

const attemptId = '01900000-0000-7000-8000-000000000201';
const executionId = '01900000-0000-7000-8000-000000000202';
const inputArtifactId = '01900000-0000-7000-8000-000000000203';
const configurationHash = 'a'.repeat(64);
const inputSha256 = 'b'.repeat(64);
const producerVersion = 'speech-executor-test';

function model() {
  return {
    modelId: 'test-model',
    modelRevision: 'model-sha-1234',
    provider: 'test-provider',
    runtimeVersion: '1.2.3',
  };
}

function transcriptManifest() {
  return {
    attemptId,
    configurationHash,
    executionId,
    inputArtifactId,
    inputSha256,
    language: { detectedLanguage: 'en', probability: 0.98, requestedBcp47: 'en-US' },
    model: model(),
    producerVersion,
    schemaVersion: 'voiceverse.transcript.v1',
    segments: [
      {
        averageLogProbability: -0.1,
        endUs: 2_000_000,
        noSpeechProbability: 0.01,
        ordinal: 0,
        startUs: 1_000_000,
        text: 'Hello world.',
        words: [
          {
            endUs: 1_400_000,
            ordinal: 0,
            probability: 0.99,
            startUs: 1_000_000,
            text: 'Hello',
          },
          {
            endUs: 2_000_000,
            ordinal: 1,
            probability: 0.97,
            startUs: 1_400_000,
            text: ' world.',
          },
        ],
      },
    ],
    timeline: { durationUs: 10_000_000, intervalConvention: 'HALF_OPEN', originUs: 0 },
  };
}

function diarizationManifest() {
  return {
    attemptId,
    configurationHash,
    executionId,
    exclusiveTurns: [
      { endUs: 2_000_000, ordinal: 0, speakerKey: 'speaker-0001', startUs: 1_000_000 },
      { endUs: 3_000_000, ordinal: 1, speakerKey: 'speaker-0002', startUs: 2_000_000 },
    ],
    inputArtifactId,
    inputSha256,
    model: model(),
    producerVersion,
    schemaVersion: 'voiceverse.diarization.v1',
    speakers: [
      {
        firstTurnUs: 1_000_000,
        localSpeakerKey: 'speaker-0001',
        providerLabel: 'SPEAKER_00',
        totalSpeechUs: 1_500_000,
      },
      {
        firstTurnUs: 1_500_000,
        localSpeakerKey: 'speaker-0002',
        providerLabel: 'SPEAKER_01',
        totalSpeechUs: 1_500_000,
      },
    ],
    timeline: { durationUs: 10_000_000, intervalConvention: 'HALF_OPEN', originUs: 0 },
    turns: [
      { endUs: 2_000_000, ordinal: 0, speakerKey: 'speaker-0001', startUs: 1_000_000 },
      { endUs: 3_000_000, ordinal: 1, speakerKey: 'speaker-0002', startUs: 1_500_000 },
    ],
  };
}

function separationManifest() {
  return {
    artifacts: [
      {
        channels: 2,
        codecName: 'flac',
        durationUs: 10_000_000,
        kind: 'ANALYSIS_VOCAL_STEM',
        mediaType: 'audio/flac',
        sampleRateHz: 48_000,
        sha256: 'c'.repeat(64),
        sizeBytes: 4_096,
      },
      {
        channels: 2,
        codecName: 'flac',
        durationUs: 10_000_000,
        kind: 'ANALYSIS_ACCOMPANIMENT_STEM',
        mediaType: 'audio/flac',
        sampleRateHz: 48_000,
        sha256: 'd'.repeat(64),
        sizeBytes: 4_096,
      },
      {
        channels: 1,
        codecName: 'flac',
        durationUs: 10_000_000,
        kind: 'ISOLATED_SPEECH_AUDIO',
        mediaType: 'audio/flac',
        sampleRateHz: 16_000,
        sha256: 'e'.repeat(64),
        sizeBytes: 2_048,
      },
    ],
    attemptId,
    configurationHash,
    executionId,
    inputArtifactId,
    inputSha256,
    model: model(),
    producerVersion,
    schemaVersion: 'voiceverse.separation.v1',
    timeline: { durationUs: 10_000_000, intervalConvention: 'HALF_OPEN', originUs: 0 },
  };
}

function serialize(manifest: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
}

function digest(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

async function* streamChunks(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    await Promise.resolve();
    yield chunk;
  }
}

function createHarness(
  manifest: unknown,
  artifactKind: ManifestExpectation['artifactKind'],
  options: {
    budget?: SpeechManifestReadBudgetService;
    budgetBytes?: number;
    chunks?: Uint8Array[];
    maxBytes?: number;
    sha256?: string;
    sizeBytes?: number;
    stream?: AsyncIterable<Uint8Array>;
  } = {},
) {
  const body = serialize(manifest);
  const expectedSha256 = options.sha256 ?? digest(body);
  const expectation: ManifestExpectation = {
    artifactKind,
    attemptId,
    bucket: 'voiceverse-private',
    configurationHash,
    executionId,
    inputArtifactId,
    inputDurationUs: 10_000_000,
    inputSha256,
    key: `outputs/${artifactKind}.json`,
    mediaType: 'application/json',
    model: model(),
    producerVersion,
    sha256: expectedSha256,
    sizeBytes: options.sizeBytes ?? body.byteLength,
  };
  const headObject = vi.fn<ObjectStoragePort['headObject']>().mockResolvedValue({
    byteSize: expectation.sizeBytes,
    mediaType: 'application/json',
    metadata: {
      'artifact-kind': artifactKind,
      'attempt-id': attemptId,
      'configuration-hash': configurationHash,
      'execution-id': executionId,
      producer: 'voiceverse-speech-executor',
      'producer-version': producerVersion,
      sha256: expectedSha256,
    },
  });
  const getObjectStream = vi
    .fn<ObjectStoragePort['getObjectStream']>()
    .mockResolvedValue(options.stream ?? streamChunks(options.chunks ?? [body]));
  const storage = { getObjectStream, headObject } as unknown as ObjectStoragePort;
  const values: Partial<Environment> = {
    SPEECH_MANIFEST_MAX_BYTES: options.maxBytes ?? 1_000_000,
    SPEECH_MANIFEST_MEMORY_BUDGET_BYTES: options.budgetBytes ?? 1_000_000,
  };
  const config = {
    get: vi.fn((key: keyof Environment) => values[key]),
  } as unknown as ConfigService<Environment, true>;
  const budget = options.budget ?? new SpeechManifestReadBudgetService(config);
  return {
    body,
    budget,
    expectation,
    getObjectStream,
    headObject,
    reader: new SpeechManifestReaderService(storage, config, budget),
  };
}

describe('SpeechManifestReaderService', () => {
  it('verifies the exact separation artifact set on the source timeline', async () => {
    const manifest = separationManifest();
    const harness = createHarness(manifest, 'separation_manifest');

    await expect(harness.reader.readSeparation(harness.expectation)).resolves.toEqual(manifest);

    manifest.artifacts[1]!.kind = 'ANALYSIS_VOCAL_STEM';
    const duplicateHarness = createHarness(manifest, 'separation_manifest');
    await expect(
      duplicateHarness.reader.readSeparation(duplicateHarness.expectation),
    ).rejects.toMatchObject({
      code: 'SEPARATION_MANIFEST_ARTIFACT_SET_INVALID',
      retryable: false,
    });
  });

  it('rejects a manifest bound to a different input timeline', async () => {
    const manifest = transcriptManifest();
    manifest.timeline.durationUs = 9_999_999;
    const harness = createHarness(manifest, 'transcript_manifest');

    await expect(harness.reader.readTranscript(harness.expectation)).rejects.toMatchObject({
      code: 'SPEECH_MANIFEST_TIMELINE_MISMATCH',
      retryable: false,
    });
  });

  it('verifies the immutable envelope, streamed digest, and half-open transcript timeline', async () => {
    const manifest = transcriptManifest();
    const harness = createHarness(manifest, 'transcript_manifest', {
      chunks: [serialize(manifest).slice(0, 64), serialize(manifest).slice(64)],
    });

    await expect(harness.reader.readTranscript(harness.expectation)).resolves.toEqual(manifest);
    expect(harness.headObject).toHaveBeenCalledWith({
      bucket: harness.expectation.bucket,
      key: harness.expectation.key,
    });
    expect(harness.getObjectStream).toHaveBeenCalledOnce();
  });

  it('accepts empty no-speech transcript and diarization manifests as successful evidence', async () => {
    const transcript = { ...transcriptManifest(), segments: [] };
    const transcriptHarness = createHarness(transcript, 'transcript_manifest');
    const diarization = {
      ...diarizationManifest(),
      exclusiveTurns: [],
      speakers: [],
      turns: [],
    };
    const diarizationHarness = createHarness(diarization, 'diarization_manifest');

    await expect(
      transcriptHarness.reader.readTranscript(transcriptHarness.expectation),
    ).resolves.toMatchObject({ segments: [] });
    await expect(
      diarizationHarness.reader.readDiarization(diarizationHarness.expectation),
    ).resolves.toMatchObject({ exclusiveTurns: [], speakers: [], turns: [] });
  });

  it('rejects an oversized declared object before any storage request', async () => {
    const harness = createHarness(transcriptManifest(), 'transcript_manifest', {
      maxBytes: 1_024,
      sizeBytes: 1_025,
    });

    await expect(harness.reader.readTranscript(harness.expectation)).rejects.toMatchObject({
      code: 'SPEECH_MANIFEST_TOO_LARGE',
      retryable: false,
    });
    expect(harness.headObject).not.toHaveBeenCalled();
    expect(harness.getObjectStream).not.toHaveBeenCalled();
  });

  it('shares one byte budget across concurrent readers and releases it after validation', async () => {
    const manifest = transcriptManifest();
    const body = serialize(manifest);
    let releaseStream!: () => void;
    let markStreamStarted!: () => void;
    const streamStarted = new Promise<void>((resolve) => {
      markStreamStarted = resolve;
    });
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const blockedStream = (async function* (): AsyncIterable<Uint8Array> {
      markStreamStarted();
      await streamReleased;
      yield body;
    })();
    const first = createHarness(manifest, 'transcript_manifest', {
      budgetBytes: body.byteLength,
      stream: blockedStream,
    });
    const second = createHarness(manifest, 'transcript_manifest', { budget: first.budget });

    const firstRead = first.reader.readTranscript(first.expectation);
    await streamStarted;
    try {
      await expect(second.reader.readTranscript(second.expectation)).rejects.toMatchObject({
        code: 'SPEECH_MANIFEST_MEMORY_BUDGET_EXHAUSTED',
        retryable: true,
      });
      expect(second.headObject).not.toHaveBeenCalled();
      expect(second.getObjectStream).not.toHaveBeenCalled();
    } finally {
      releaseStream();
    }

    await expect(firstRead).resolves.toEqual(manifest);
    await expect(second.reader.readTranscript(second.expectation)).resolves.toEqual(manifest);
  });

  it('releases admission after schema-level validation fails', async () => {
    const invalidManifest = {
      ...transcriptManifest(),
      executionId: '01900000-0000-7000-8000-000000000299',
    };
    const invalidBody = serialize(invalidManifest);
    const invalid = createHarness(invalidManifest, 'transcript_manifest', {
      budgetBytes: invalidBody.byteLength,
    });

    await expect(invalid.reader.readTranscript(invalid.expectation)).rejects.toMatchObject({
      code: 'SPEECH_MANIFEST_ENVELOPE_MISMATCH',
      retryable: false,
    });

    const validManifest = transcriptManifest();
    const valid = createHarness(validManifest, 'transcript_manifest', { budget: invalid.budget });
    expect(serialize(validManifest)).toHaveLength(invalidBody.byteLength);
    await expect(valid.reader.readTranscript(valid.expectation)).resolves.toEqual(validManifest);
  });

  it('stops a stream that exceeds its immutable declared size', async () => {
    const manifest = transcriptManifest();
    const body = serialize(manifest);
    const harness = createHarness(manifest, 'transcript_manifest', {
      chunks: [body, Buffer.from('unexpected-extra-bytes')],
    });

    await expect(harness.reader.readTranscript(harness.expectation)).rejects.toMatchObject({
      code: 'SPEECH_MANIFEST_TOO_LARGE',
      retryable: false,
    });
  });

  it('rejects metadata envelope drift before downloading the object', async () => {
    const harness = createHarness(diarizationManifest(), 'diarization_manifest');
    harness.headObject.mockResolvedValue({
      byteSize: harness.expectation.sizeBytes,
      mediaType: 'application/json',
      metadata: { sha256: harness.expectation.sha256 },
    });

    await expect(harness.reader.readDiarization(harness.expectation)).rejects.toMatchObject({
      code: 'SPEECH_MANIFEST_VERIFICATION_FAILED',
      retryable: false,
    });
    expect(harness.getObjectStream).not.toHaveBeenCalled();
  });

  it('rejects body digest drift even when object metadata repeats the expected digest', async () => {
    const harness = createHarness(transcriptManifest(), 'transcript_manifest', {
      sha256: '0'.repeat(64),
    });

    await expect(harness.reader.readTranscript(harness.expectation)).rejects.toMatchObject({
      code: 'SPEECH_MANIFEST_DIGEST_MISMATCH',
      retryable: false,
    });
  });

  it('rejects a validly signed manifest whose embedded execution envelope is different', async () => {
    const manifest = {
      ...transcriptManifest(),
      executionId: '01900000-0000-7000-8000-000000000299',
    };
    const harness = createHarness(manifest, 'transcript_manifest');

    await expect(harness.reader.readTranscript(harness.expectation)).rejects.toMatchObject({
      code: 'SPEECH_MANIFEST_ENVELOPE_MISMATCH',
      retryable: false,
    });
  });

  it('rejects a manifest whose embedded model differs from the executor result', async () => {
    const manifest = transcriptManifest();
    manifest.model.modelRevision = 'different-model-rollout';
    const harness = createHarness(manifest, 'transcript_manifest');

    await expect(harness.reader.readTranscript(harness.expectation)).rejects.toMatchObject({
      code: 'SPEECH_MANIFEST_ENVELOPE_MISMATCH',
      retryable: false,
    });
  });

  it('rejects diarization labels that cannot fit the normalized database schema', async () => {
    const manifest = diarizationManifest();
    manifest.speakers[0]!.providerLabel = 's'.repeat(101);
    const harness = createHarness(manifest, 'diarization_manifest');

    await expect(harness.reader.readDiarization(harness.expectation)).rejects.toMatchObject({
      name: 'ZodError',
    });
  });

  it('rejects overlapping transcript segments and overlapping exclusive speaker turns', async () => {
    const transcript = transcriptManifest();
    transcript.segments.push({
      ...transcript.segments[0]!,
      endUs: 2_500_000,
      ordinal: 1,
      startUs: 1_900_000,
      words: [],
    });
    const transcriptHarness = createHarness(transcript, 'transcript_manifest');
    await expect(
      transcriptHarness.reader.readTranscript(transcriptHarness.expectation),
    ).rejects.toMatchObject({ code: 'TRANSCRIPT_TIMELINE_INVALID', retryable: false });

    const diarization = diarizationManifest();
    diarization.exclusiveTurns[1] = {
      ...diarization.exclusiveTurns[1]!,
      startUs: 1_900_000,
    };
    const diarizationHarness = createHarness(diarization, 'diarization_manifest');
    await expect(
      diarizationHarness.reader.readDiarization(diarizationHarness.expectation),
    ).rejects.toMatchObject({ code: 'DIARIZATION_TIMELINE_INVALID', retryable: false });
  });

  it('rejects transcript words outside their parent half-open segment', async () => {
    const manifest = transcriptManifest();
    manifest.segments[0]!.words[0]!.startUs = 999_999;
    const harness = createHarness(manifest, 'transcript_manifest');

    await expect(harness.reader.readTranscript(harness.expectation)).rejects.toMatchObject({
      code: 'TRANSCRIPT_WORD_TIMELINE_INVALID',
      retryable: false,
    });
  });
});
