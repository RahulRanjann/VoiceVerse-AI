import { createHash } from 'node:crypto';

export const SPEECH_ANALYSIS_PIPELINE_VERSION = 'speech-analysis.v1';

export const SPEECH_STAGE_KEYS = {
  CHARACTER_IDENTIFICATION: 'characters.resolve',
  SPEAKER_DIARIZATION: 'speech.diarize',
  SPEECH_RECOGNITION: 'speech.transcribe',
  VOCAL_SEPARATION: 'audio.vocals.separate',
} as const;

export const SPEECH_STAGE_EVENTS = {
  CHARACTER_IDENTIFICATION: 'speech.character_identification.execute',
  SPEAKER_DIARIZATION: 'speech.diarization.execute',
  SPEECH_RECOGNITION: 'speech.transcription.execute',
  VOCAL_SEPARATION: 'speech.vocal_separation.execute',
} as const;

export type SpeechProviderIdentity = {
  modelId: string;
  modelRevision: string;
  provider: string;
  runtimeVersion: string;
};

export interface SpeechProviderPolicy {
  diarization: SpeechProviderIdentity;
  transcription: SpeechProviderIdentity;
  vocalSeparation: SpeechProviderIdentity;
}

export function speechStageDefinitions(providerPolicy: SpeechProviderPolicy) {
  return [
    {
      configuration: {
        contractVersion: 1,
        isolatedSpeech: { channels: 1, codec: 'flac', sampleRateHz: 16_000 },
        provider: providerPolicy.vocalSeparation,
        purpose: 'analysis-only-stems',
      },
      dependencies: [],
      eventType: SPEECH_STAGE_EVENTS.VOCAL_SEPARATION,
      key: SPEECH_STAGE_KEYS.VOCAL_SEPARATION,
      kind: 'VOCAL_SEPARATION',
      maxAttempts: 3,
      ordinal: 0,
      weightBasisPoints: 2_500,
    },
    {
      configuration: {
        contractVersion: 1,
        input: 'analysis-audio',
        intervalConvention: 'half-open-microseconds',
        preserveOverlappingAndExclusiveTurns: true,
        provider: providerPolicy.diarization,
      },
      dependencies: [],
      eventType: SPEECH_STAGE_EVENTS.SPEAKER_DIARIZATION,
      key: SPEECH_STAGE_KEYS.SPEAKER_DIARIZATION,
      kind: 'SPEAKER_DIARIZATION',
      maxAttempts: 3,
      ordinal: 1,
      weightBasisPoints: 2_500,
    },
    {
      configuration: {
        contractVersion: 1,
        input: 'isolated-speech-audio',
        intervalConvention: 'half-open-microseconds',
        provider: providerPolicy.transcription,
        task: 'transcribe',
        wordTimestamps: true,
      },
      dependencies: [SPEECH_STAGE_KEYS.VOCAL_SEPARATION],
      eventType: SPEECH_STAGE_EVENTS.SPEECH_RECOGNITION,
      key: SPEECH_STAGE_KEYS.SPEECH_RECOGNITION,
      kind: 'SPEECH_RECOGNITION',
      maxAttempts: 3,
      ordinal: 2,
      weightBasisPoints: 3_000,
    },
    {
      configuration: {
        contractVersion: 1,
        nearestTurnToleranceUs: 250_000,
        persistVoiceEmbeddings: false,
        resolver: 'deterministic-timeline-v1',
      },
      dependencies: [SPEECH_STAGE_KEYS.SPEECH_RECOGNITION, SPEECH_STAGE_KEYS.SPEAKER_DIARIZATION],
      eventType: SPEECH_STAGE_EVENTS.CHARACTER_IDENTIFICATION,
      key: SPEECH_STAGE_KEYS.CHARACTER_IDENTIFICATION,
      kind: 'CHARACTER_IDENTIFICATION',
      maxAttempts: 2,
      ordinal: 3,
      weightBasisPoints: 2_000,
    },
  ] as const;
}

export const SPEECH_STAGE_DEFINITIONS = speechStageDefinitions({
  diarization: {
    modelId: 'feature-disabled',
    modelRevision: 'feature-disabled',
    provider: 'feature-disabled',
    runtimeVersion: 'feature-disabled',
  },
  transcription: {
    modelId: 'feature-disabled',
    modelRevision: 'feature-disabled',
    provider: 'feature-disabled',
    runtimeVersion: 'feature-disabled',
  },
  vocalSeparation: {
    modelId: 'feature-disabled',
    modelRevision: 'feature-disabled',
    provider: 'feature-disabled',
    runtimeVersion: 'feature-disabled',
  },
});

export type SpeechStageDefinition = (typeof SPEECH_STAGE_DEFINITIONS)[number];

export function configurationHash(configuration: object): string {
  return createHash('sha256').update(stableJson(configuration)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
