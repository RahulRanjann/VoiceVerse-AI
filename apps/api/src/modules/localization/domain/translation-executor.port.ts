export const TRANSLATION_EXECUTOR = Symbol('TRANSLATION_EXECUTOR');

export interface TranslationModelDescriptor {
  modelId: string;
  modelRevision: string;
  provider: string;
  runtimeVersion: string;
}

export interface TranslationCapabilityReadiness {
  capability: 'SCENE_TRANSLATION';
  enabled: true;
  model: TranslationModelDescriptor;
  ready: true;
  schemaVersion: 'voiceverse.translation-capability.v1';
}

export interface TranslationSceneContext {
  culturalNotes: string | null;
  narrative: string | null;
  sceneRevisionId: string;
  title: string | null;
}

export interface TranslationGlossaryItem {
  caseSensitive: boolean;
  doNotTranslate: boolean;
  glossaryRevisionId: string;
  notes: string | null;
  sourceTerm: string;
  targetTerm: string | null;
}

export interface TranslationDialogueItem {
  character: { characterId: string; name: string } | null;
  dialogueId: string;
  endUs: number;
  ordinal: number;
  sourceRevisionId: string;
  sourceText: string;
  startUs: number;
}

export interface TranslationExecutionCommand {
  dialogues: TranslationDialogueItem[];
  executionId: string;
  expectedModel: TranslationModelDescriptor;
  generationId: string;
  glossaryRevisions: TranslationGlossaryItem[];
  promptVersion: string;
  sceneContext: TranslationSceneContext;
  schemaVersion: 'voiceverse.translation-command.v1';
  sourceLanguageTag: string;
  targetLanguageTag: string;
}

export interface GeneratedTranslation {
  dialogueId: string;
  sourceRevisionId: string;
  targetText: string;
}

export interface TranslationExecutionResult {
  executionId: string;
  generationId: string;
  model: TranslationModelDescriptor;
  producerVersion: string;
  promptVersion: string;
  schemaVersion: 'voiceverse.translation.v1';
  sourceLanguageTag: string;
  targetLanguageTag: string;
  translations: GeneratedTranslation[];
}

export interface TranslationExecutionOptions {
  signal?: AbortSignal;
}

export interface TranslationExecutorPort {
  checkReadiness(): Promise<TranslationCapabilityReadiness>;
  translate(
    command: TranslationExecutionCommand,
    options?: TranslationExecutionOptions,
  ): Promise<TranslationExecutionResult>;
}

export class TranslationExecutorError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message = 'The translation executor could not complete the requested scene.',
  ) {
    super(message);
    this.name = 'TranslationExecutorError';
  }
}
