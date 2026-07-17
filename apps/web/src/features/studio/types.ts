export interface LanguageOption {
  id: string;
  bcp47Tag: string;
  englishName: string;
  nativeName?: string;
}

export type KnownWorkflowJobKind = 'SOURCE_PREPARATION' | 'SPEECH_ANALYSIS';

/**
 * The API may add workflow kinds independently of a web deployment. Keep the
 * transport type open and map unknown values to a safe, generic presentation.
 */
export type WorkflowJobKind = KnownWorkflowJobKind | (string & {});

export type WorkflowJobStatus =
  'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCEL_REQUESTED' | 'CANCELED';

export type WorkflowStageStatus =
  'QUEUED' | 'RUNNING' | 'RETRY_WAIT' | 'BLOCKED' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';

export type WorkflowAttemptStatus =
  'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELED';

export type VideoIngestStatus = 'AWAITING_UPLOAD' | 'UPLOADING' | 'UPLOADED' | 'ABORTED' | 'FAILED';

export type MediaSecurityStatus = 'PENDING' | 'SCANNING' | 'CLEAN' | 'INFECTED' | 'ERROR';

export type ResultAvailability = 'PENDING' | 'AVAILABLE' | 'UNAVAILABLE';

export interface PublicWorkflowFailure {
  category: 'INPUT' | 'DEPENDENCY' | 'CAPACITY' | 'INTERNAL';
  code: string;
  retryable: boolean;
}

export interface LatestWorkflowJob {
  id: string;
  kind: WorkflowJobKind;
  status: WorkflowJobStatus;
  pipelineVersion: string;
  progressBasisPoints: number;
  revision: number;
  failureCode: string | null;
  failure?: PublicWorkflowFailure | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  status: 'DRAFT' | 'INGESTING' | 'PROCESSING' | 'READY' | 'FAILED' | 'ARCHIVED';
  createdAt: string;
  updatedAt: string;
  sourceLanguage: LanguageOption;
  targetLanguages: LanguageOption[];
  latestJob: LatestWorkflowJob | null;
  latestVideo: {
    id: string;
    ingestStatus: VideoIngestStatus;
    securityStatus: MediaSecurityStatus;
  } | null;
}

export interface ProjectPage {
  data: ProjectSummary[];
  nextCursor: string | null;
}

export interface SpeechAnalysisResultSummary {
  transcript: {
    availability: ResultAvailability;
    segmentCount: number;
    transcribedDurationMs: number;
  };
  characters: {
    availability: ResultAvailability;
    count: number;
  };
}

export interface WorkflowJob extends LatestWorkflowJob {
  createdAt: string;
  projectId: string;
  project?: {
    id: string;
    name: string;
    sourceLanguage: LanguageOption;
    targetLanguages: LanguageOption[];
  };
  resultSummary?: SpeechAnalysisResultSummary | null;
  sourceVideo: {
    id: string;
    ingestStatus: VideoIngestStatus;
    securityStatus: MediaSecurityStatus;
  };
  media: {
    audio: {
      channelLayout: string | null;
      channels: number | null;
      codec: string | null;
      languageTag: string | null;
      sampleRateHz: number | null;
      selectionMethod: string;
      streamIndex: number;
    } | null;
    bitRate: number | null;
    container: string;
    durationMs: number | null;
    video: {
      codec: string | null;
      height: number | null;
      streamIndex: number;
      width: number | null;
    } | null;
  } | null;
  stages: WorkflowStage[];
}

export interface WorkflowStage {
  id: string;
  key: string;
  kind: string;
  status: WorkflowStageStatus;
  progressBasisPoints: number;
  attemptCount: number;
  ordinal?: number;
  startedAt?: string | null;
  completedAt: string | null;
  failure?: PublicWorkflowFailure | null;
  currentAttempt: {
    id: string;
    attemptNumber: number;
    status: WorkflowAttemptStatus;
    progressBasisPoints: number;
    errorCode: string | null;
    startedAt: string | null;
    completedAt: string | null;
  } | null;
}

export interface CharacterSummary {
  id: string;
  displayName: string;
  firstAppearanceMs: number;
  segmentCount: number;
  speakingDurationMs: number;
  confidenceBasisPoints: number;
}

export interface DialogueSegment {
  id: string;
  sequenceNumber: number;
  startMs: number;
  endMs: number;
  sourceText: string;
  sourceLanguageTag: string;
  transcriptionConfidenceBasisPoints: number;
  character: {
    id: string;
    displayName: string;
    assignmentConfidenceBasisPoints: number;
  } | null;
}

export interface AnalysisResultPage<T> {
  availability: ResultAvailability;
  analysisId: string | null;
  jobRevision: number;
  data: T[];
  totalCount: number;
  nextCursor: string | null;
}

export interface WorkflowJobPage {
  data: WorkflowJob[];
  nextCursor: string | null;
}
