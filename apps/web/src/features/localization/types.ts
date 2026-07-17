export interface LocalizationLanguage {
  id: string;
  bcp47Tag: string;
  englishName: string;
}

export interface LocalizationTrack {
  id: string;
  projectId: string;
  workspaceId: string;
  speechAnalysisId: string;
  createdAt: string;
  generationEnabled: boolean;
  sourceLanguage: LocalizationLanguage;
  targetLanguage: LocalizationLanguage;
}

export interface LocalizationTrackPage {
  data: LocalizationTrack[];
}

export interface SceneRevision {
  id: string;
  sceneId?: string;
  revisionNumber: number;
  selectionRevision?: number;
  title: string | null;
  narrative: string | null;
  culturalNotes: string | null;
  startMs: number;
  endMs: number;
  createdAt?: string;
  createdByUserId?: string;
}

export interface SourceDialogueRevision {
  id: string;
  dialogueId: string;
  revisionNumber: number;
  selectionRevision?: number;
  sourceText: string;
  createdAt?: string;
  createdByUserId?: string;
}

export type TranslationEditorState = 'DRAFT' | 'IN_REVIEW' | 'APPROVED';

export interface TranslationRevision {
  id: string;
  dialogueId: string;
  translationId: string;
  revisionNumber: number;
  selectionRevision?: number;
  sourceRevisionId: string;
  targetText: string;
  editorState: TranslationEditorState;
  generationId: string | null;
  createdAt?: string;
  createdByUserId?: string;
}

export interface GlossaryRevision {
  id: string;
  entryId: string;
  revisionNumber: number;
  selectionRevision?: number;
  sourceTerm: string;
  targetTerm: string | null;
  notes: string | null;
  caseSensitive: boolean;
  doNotTranslate: boolean;
  createdAt?: string;
  createdByUserId?: string;
}

export interface LocalizationDialogue {
  id: string;
  ordinal: number;
  startMs: number;
  endMs: number;
  character: { id: string; name: string } | null;
  source: {
    revisionId: string;
    revisionNumber: number;
    selectionRevision: number;
    text: string;
  };
  translation: {
    translationId: string;
    revisionId: string;
    revisionNumber: number;
    selectionRevision: number;
    sourceRevisionId: string;
    editorState: TranslationEditorState;
    text: string;
  } | null;
}

export interface LocalizationScene {
  id: string;
  ordinal: number;
  selectionRevision: number;
  revision: Omit<SceneRevision, 'sceneId' | 'selectionRevision'>;
  dialogues: LocalizationDialogue[];
}

export interface LocalizationScenePage {
  track: LocalizationTrack;
  total: number;
  nextCursor: string | null;
  data: LocalizationScene[];
}

export interface LocalizationHistoryPage<T> {
  data: T[];
  nextCursor: string | null;
  selectedRevisionId: string | null;
  selectionRevision: number;
}

export interface GlossaryPage {
  trackId: string;
  data: GlossaryRevision[];
}

export type TranslationGenerationStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface TranslationGeneration {
  id: string;
  trackId: string;
  sceneId: string;
  status: TranslationGenerationStatus;
  attemptCount: number;
  maxAttempts: number;
  inputRevisionHash: string;
  model: {
    provider: string;
    modelId: string;
    modelRevision: string;
    runtimeVersion: string;
  };
  promptVersion: string;
  errorCode: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SceneRevisionInput {
  expectedRevision: number;
  title?: string | null;
  narrative?: string | null;
  culturalNotes?: string | null;
}

export interface GlossaryRevisionInput {
  sourceTerm: string;
  targetTerm: string | null;
  notes: string | null;
  caseSensitive: boolean;
  doNotTranslate: boolean;
}
