import type { AuthenticatedRequest } from '@/features/studio/api';
import type {
  GlossaryPage,
  GlossaryRevision,
  GlossaryRevisionInput,
  LocalizationHistoryPage,
  LocalizationScenePage,
  LocalizationTrack,
  LocalizationTrackPage,
  SceneRevision,
  SceneRevisionInput,
  SourceDialogueRevision,
  TranslationEditorState,
  TranslationGeneration,
  TranslationRevision,
} from './types';

function tracksPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/localization-tracks`;
}

function trackPath(projectId: string, trackId: string): string {
  return `${tracksPath(projectId)}/${encodeURIComponent(trackId)}`;
}

function jsonRequest(method: 'PATCH' | 'POST', body: object, headers?: HeadersInit): RequestInit {
  return { body: JSON.stringify(body), headers, method };
}

export function listLocalizationTracks(
  request: AuthenticatedRequest,
  projectId: string,
): Promise<LocalizationTrackPage> {
  return request<LocalizationTrackPage>(tracksPath(projectId));
}

export function createLocalizationTrack(
  request: AuthenticatedRequest,
  projectId: string,
  input: { speechAnalysisJobId: string; targetLanguageId: string },
): Promise<LocalizationTrack> {
  return request<LocalizationTrack>(tracksPath(projectId), jsonRequest('POST', input));
}

export function listLocalizationScenes(
  request: AuthenticatedRequest,
  projectId: string,
  trackId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<LocalizationScenePage> {
  const query = new URLSearchParams({ limit: String(options.limit ?? 8) });
  if (options.cursor) query.set('cursor', options.cursor);
  return request<LocalizationScenePage>(`${trackPath(projectId, trackId)}/scenes?${query}`);
}

export function updateLocalizationScene(
  request: AuthenticatedRequest,
  projectId: string,
  trackId: string,
  sceneId: string,
  input: SceneRevisionInput,
): Promise<SceneRevision> {
  return request<SceneRevision>(
    `${trackPath(projectId, trackId)}/scenes/${encodeURIComponent(sceneId)}`,
    jsonRequest('PATCH', input),
  );
}

export function listSceneRevisions(
  request: AuthenticatedRequest,
  projectId: string,
  trackId: string,
  sceneId: string,
  options: HistoryOptions = {},
): Promise<LocalizationHistoryPage<SceneRevision>> {
  return listHistory(
    request,
    `${trackPath(projectId, trackId)}/scenes/${encodeURIComponent(sceneId)}/revisions`,
    options,
  );
}

export function selectSceneRevision(
  request: AuthenticatedRequest,
  projectId: string,
  trackId: string,
  sceneId: string,
  input: SelectionInput,
): Promise<SceneRevision> {
  return request<SceneRevision>(
    `${trackPath(projectId, trackId)}/scenes/${encodeURIComponent(sceneId)}/selection`,
    jsonRequest('POST', input),
  );
}

export function updateSourceDialogue(
  request: AuthenticatedRequest,
  projectId: string,
  trackId: string,
  dialogueId: string,
  input: { expectedRevision: number; sourceText: string },
): Promise<SourceDialogueRevision> {
  return request<SourceDialogueRevision>(
    `${trackPath(projectId, trackId)}/dialogues/${encodeURIComponent(dialogueId)}/source`,
    jsonRequest('PATCH', input),
  );
}

export function listSourceRevisions(
  request: AuthenticatedRequest,
  projectId: string,
  trackId: string,
  dialogueId: string,
  options: HistoryOptions = {},
): Promise<LocalizationHistoryPage<SourceDialogueRevision>> {
  return listHistory(
    request,
    `${trackPath(projectId, trackId)}/dialogues/${encodeURIComponent(dialogueId)}/source/revisions`,
    options,
  );
}

export function selectSourceRevision(
  request: AuthenticatedRequest,
  projectId: string,
  trackId: string,
  dialogueId: string,
  input: SelectionInput,
): Promise<SourceDialogueRevision> {
  return request<SourceDialogueRevision>(
    `${trackPath(projectId, trackId)}/dialogues/${encodeURIComponent(dialogueId)}/source/selection`,
    jsonRequest('POST', input),
  );
}

export function updateDialogueTranslation(
  request: AuthenticatedRequest,
  projectId: string,
  trackId: string,
  dialogueId: string,
  input: { expectedRevision: number; targetText: string },
): Promise<TranslationRevision> {
  return request<TranslationRevision>(
    `${trackPath(projectId, trackId)}/dialogues/${encodeURIComponent(dialogueId)}/translation`,
    jsonRequest('PATCH', input),
  );
}

export function updateTranslationState(
  request: AuthenticatedRequest,
  projectId: string,
  trackId: string,
  dialogueId: string,
  input: { expectedRevision: number; state: TranslationEditorState },
): Promise<TranslationRevision> {
  return request<TranslationRevision>(
    `${trackPath(projectId, trackId)}/dialogues/${encodeURIComponent(dialogueId)}/translation/state`,
    jsonRequest('PATCH', input),
  );
}

export function listTranslationRevisions(
  request: AuthenticatedRequest,
  projectId: string,
  trackId: string,
  dialogueId: string,
  options: HistoryOptions = {},
): Promise<LocalizationHistoryPage<TranslationRevision>> {
  return listHistory(
    request,
    `${trackPath(projectId, trackId)}/dialogues/${encodeURIComponent(dialogueId)}/translation/revisions`,
    options,
  );
}

export function selectTranslationRevision(
  request: AuthenticatedRequest,
  projectId: string,
  trackId: string,
  dialogueId: string,
  input: SelectionInput,
): Promise<TranslationRevision> {
  return request<TranslationRevision>(
    `${trackPath(projectId, trackId)}/dialogues/${encodeURIComponent(dialogueId)}/translation/selection`,
    jsonRequest('POST', input),
  );
}

export function listGlossary(
  request: AuthenticatedRequest,
  projectId: string,
  trackId: string,
): Promise<GlossaryPage> {
  return request<GlossaryPage>(`${trackPath(projectId, trackId)}/glossary`);
}

export function createGlossaryEntry(
  request: AuthenticatedRequest,
  projectId: string,
  trackId: string,
  input: GlossaryRevisionInput,
): Promise<GlossaryRevision> {
  return request<GlossaryRevision>(
    `${trackPath(projectId, trackId)}/glossary`,
    jsonRequest('POST', input),
  );
}

export function updateGlossaryEntry(
  request: AuthenticatedRequest,
  projectId: string,
  trackId: string,
  entryId: string,
  input: GlossaryRevisionInput & { expectedRevision: number },
): Promise<GlossaryRevision> {
  return request<GlossaryRevision>(
    `${trackPath(projectId, trackId)}/glossary/${encodeURIComponent(entryId)}`,
    jsonRequest('PATCH', input),
  );
}

export function listGlossaryRevisions(
  request: AuthenticatedRequest,
  projectId: string,
  trackId: string,
  entryId: string,
  options: HistoryOptions = {},
): Promise<LocalizationHistoryPage<GlossaryRevision>> {
  return listHistory(
    request,
    `${trackPath(projectId, trackId)}/glossary/${encodeURIComponent(entryId)}/revisions`,
    options,
  );
}

export function selectGlossaryRevision(
  request: AuthenticatedRequest,
  projectId: string,
  trackId: string,
  entryId: string,
  input: SelectionInput,
): Promise<GlossaryRevision> {
  return request<GlossaryRevision>(
    `${trackPath(projectId, trackId)}/glossary/${encodeURIComponent(entryId)}/selection`,
    jsonRequest('POST', input),
  );
}

export function createSceneGeneration(
  request: AuthenticatedRequest,
  projectId: string,
  trackId: string,
  sceneId: string,
  idempotencyKey: string,
): Promise<TranslationGeneration> {
  return request<TranslationGeneration>(
    `${trackPath(projectId, trackId)}/generations`,
    jsonRequest('POST', { sceneId }, { 'Idempotency-Key': idempotencyKey }),
  );
}

export function getSceneGeneration(
  request: AuthenticatedRequest,
  projectId: string,
  trackId: string,
  generationId: string,
): Promise<TranslationGeneration> {
  return request<TranslationGeneration>(
    `${trackPath(projectId, trackId)}/generations/${encodeURIComponent(generationId)}`,
  );
}

interface HistoryOptions {
  cursor?: string;
  limit?: number;
}

interface SelectionInput {
  expectedRevision: number;
  revisionId: string;
}

function listHistory<T>(
  request: AuthenticatedRequest,
  path: string,
  options: HistoryOptions,
): Promise<LocalizationHistoryPage<T>> {
  const query = new URLSearchParams({ limit: String(options.limit ?? 25) });
  if (options.cursor) query.set('cursor', options.cursor);
  return request<LocalizationHistoryPage<T>>(`${path}?${query}`);
}
