export const SPEECH_EXECUTOR = Symbol('SPEECH_EXECUTOR');

export type SpeechCapability = 'VOCAL_SEPARATION' | 'TRANSCRIPTION' | 'SPEAKER_DIARIZATION';

export type SpeechInputArtifactKind =
  'CANONICAL_AUDIO' | 'ANALYSIS_AUDIO' | 'ISOLATED_SPEECH_AUDIO';

export type SpeechExecutorArtifactKind =
  | 'ANALYSIS_VOCAL_STEM'
  | 'ANALYSIS_ACCOMPANIMENT_STEM'
  | 'ISOLATED_SPEECH_AUDIO'
  | 'SEPARATION_MANIFEST'
  | 'TRANSCRIPT_MANIFEST'
  | 'DIARIZATION_MANIFEST';

export interface SpeechModelDescriptor {
  modelId: string;
  modelRevision: string;
  provider: string;
  runtimeVersion: string;
}

export interface SpeechCapabilityReadiness {
  capability: SpeechCapability;
  enabled: true;
  model: SpeechModelDescriptor;
  ready: true;
  schemaVersion: 'voiceverse.speech-capability.v1';
}

export interface SpeechInputArtifactReference {
  artifactId: string;
  byteSize: number;
  channels: number;
  durationUs: number;
  kind: SpeechInputArtifactKind;
  mediaType: 'audio/flac';
  sampleRateHz: number;
  sha256: string;
  storageKey: string;
}

interface SpeechExecutionCommand {
  attemptId: string;
  bucket: string;
  configurationHash: string;
  executionId: string;
  expectedModel: SpeechModelDescriptor;
  inputArtifact: SpeechInputArtifactReference;
}

export interface VocalSeparationCommand extends SpeechExecutionCommand {
  accompanimentStemKey: string;
  isolatedSpeechKey: string;
  manifestKey: string;
  vocalStemKey: string;
}

export interface TranscriptionCommand extends SpeechExecutionCommand {
  manifestKey: string;
  sourceLanguageTag: string;
}

export interface SpeakerDiarizationCommand extends SpeechExecutionCommand {
  manifestKey: string;
}

export interface SpeechGeneratedArtifact {
  channels?: number | null;
  codecName?: string | null;
  durationUs?: number | null;
  kind: SpeechExecutorArtifactKind;
  mediaType: 'application/json' | 'audio/flac';
  sampleRateHz?: number | null;
  sha256: string;
  sizeBytes: number;
}

interface SpeechExecutionResult {
  artifacts: SpeechGeneratedArtifact[];
  attemptId: string;
  executionId: string;
  model: SpeechModelDescriptor;
  producerVersion: string;
  schemaVersion: string;
}

export interface VocalSeparationResult extends SpeechExecutionResult {
  schemaVersion: 'voiceverse.separation.v1';
}

export interface TranscriptionResult extends SpeechExecutionResult {
  schemaVersion: 'voiceverse.transcript.v1';
  summary: {
    detectedLanguage: string;
    languageProbability?: number | null;
    segmentCount: number;
    wordCount: number;
  };
}

export interface SpeakerDiarizationResult extends SpeechExecutionResult {
  schemaVersion: 'voiceverse.diarization.v1';
  summary: {
    exclusiveTurnCount: number;
    speakerCount: number;
    turnCount: number;
  };
}

export interface SpeechExecutionOptions {
  signal?: AbortSignal;
}

export interface SpeechExecutorPort {
  checkReadiness(capability: SpeechCapability): Promise<SpeechCapabilityReadiness>;
  diarize(
    command: SpeakerDiarizationCommand,
    options?: SpeechExecutionOptions,
  ): Promise<SpeakerDiarizationResult>;
  separate(
    command: VocalSeparationCommand,
    options?: SpeechExecutionOptions,
  ): Promise<VocalSeparationResult>;
  transcribe(
    command: TranscriptionCommand,
    options?: SpeechExecutionOptions,
  ): Promise<TranscriptionResult>;
}

export class SpeechExecutorError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message = 'The speech executor could not complete the requested capability.',
  ) {
    super(message);
    this.name = 'SpeechExecutorError';
  }
}
