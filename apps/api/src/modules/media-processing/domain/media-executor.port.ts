export const MEDIA_EXECUTOR = Symbol('MEDIA_EXECUTOR');

export type MediaArtifactKind = 'ANALYSIS_AUDIO' | 'CANONICAL_AUDIO' | 'PROBE_MANIFEST';

export interface RationalValue {
  denominator: number;
  numerator: number;
}

export interface AudioStreamMetadata {
  bitRate?: number | null;
  channelLayout?: string | null;
  channels: number;
  codecName: string;
  durationMs?: number | null;
  isDefault: boolean;
  languageTag?: string | null;
  profile?: string | null;
  sampleRateHz: number;
  startTimeMs?: number | null;
  streamIndex: number;
  timeBase?: RationalValue | null;
}

export interface VideoStreamMetadata {
  bitRate?: number | null;
  codecName: string;
  durationMs?: number | null;
  frameRate?: RationalValue | null;
  height: number;
  isDefault: boolean;
  languageTag?: string | null;
  profile?: string | null;
  startTimeMs?: number | null;
  streamIndex: number;
  timeBase?: RationalValue | null;
  width: number;
}

export interface PreparedArtifactMetadata {
  channels?: number | null;
  codecName?: string | null;
  durationMs?: number | null;
  kind: MediaArtifactKind;
  mediaType: string;
  sampleRateHz?: number | null;
  sha256: string;
  sizeBytes: number;
}

export interface MediaPreparationCommand {
  analysisAudioKey: string;
  attemptId: string;
  bucket: string;
  canonicalAudioKey: string;
  configurationHash: string;
  executionId: string;
  expectedSourceSha256: string;
  expectedSourceSizeBytes: number;
  preferredAudioLanguageTag?: string;
  probeManifestKey: string;
  sourceKey: string;
}

export interface MediaPreparationResult {
  artifacts: PreparedArtifactMetadata[];
  attemptId: string;
  executionId: string;
  producerVersion: string;
  schemaVersion: string;
  source: {
    audioStreams: AudioStreamMetadata[];
    audioSelectionMethod: string;
    audioSelectionReason: string;
    bitRate?: number | null;
    containerFormats: string[];
    durationMs: number;
    selectedAudio: AudioStreamMetadata;
    sha256: string;
    sizeBytes: number;
    videoStreams: VideoStreamMetadata[];
  };
  tools: { ffmpeg: string; ffprobe: string };
}

export interface MediaExecutorPort {
  prepare(command: MediaPreparationCommand): Promise<MediaPreparationResult>;
}

export class MediaExecutorError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message = 'The media executor could not prepare the source.',
  ) {
    super(message);
    this.name = 'MediaExecutorError';
  }
}
