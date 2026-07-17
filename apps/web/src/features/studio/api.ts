import type { ApiResponse } from '@/lib/api';
import type {
  AnalysisResultPage,
  CharacterSummary,
  DialogueSegment,
  ProjectPage,
  WorkflowJob,
  WorkflowJobPage,
} from './types';

export type AuthenticatedRequest = <T>(path: string, init?: RequestInit) => Promise<T>;
export type AuthenticatedResultRequest = <T>(
  path: string,
  init?: RequestInit,
) => Promise<ApiResponse<T>>;

export function listProjects(request: AuthenticatedRequest, limit = 25): Promise<ProjectPage> {
  const query = new URLSearchParams({ limit: String(limit) });
  return request<ProjectPage>(`/projects?${query}`);
}

export function listProjectJobs(
  request: AuthenticatedRequest,
  projectId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<WorkflowJobPage> {
  const query = new URLSearchParams({ limit: String(options.limit ?? 20) });
  if (options.cursor) query.set('cursor', options.cursor);
  return request<WorkflowJobPage>(`/projects/${encodeURIComponent(projectId)}/jobs?${query}`);
}

export function getWorkflowJob(request: AuthenticatedRequest, jobId: string): Promise<WorkflowJob> {
  return request<WorkflowJob>(`/jobs/${encodeURIComponent(jobId)}`);
}

export function getWorkflowJobResult(
  request: AuthenticatedResultRequest,
  jobId: string,
  knownRevision?: number,
): Promise<ApiResponse<WorkflowJob>> {
  const headers = new Headers();
  if (knownRevision !== undefined) {
    headers.set('if-none-match', `W/"job-${jobId}-${knownRevision}"`);
  }
  return request<WorkflowJob>(`/jobs/${encodeURIComponent(jobId)}`, { headers });
}

export function listJobCharacters(
  request: AuthenticatedRequest,
  jobId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<AnalysisResultPage<CharacterSummary>> {
  return listAnalysisResults(request, jobId, 'characters', options);
}

export function listDialogueSegments(
  request: AuthenticatedRequest,
  jobId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<AnalysisResultPage<DialogueSegment>> {
  return listAnalysisResults(request, jobId, 'dialogue-segments', options);
}

function listAnalysisResults<T>(
  request: AuthenticatedRequest,
  jobId: string,
  resource: 'characters' | 'dialogue-segments',
  options: { cursor?: string; limit?: number },
): Promise<AnalysisResultPage<T>> {
  const query = new URLSearchParams({ limit: String(options.limit ?? 25) });
  if (options.cursor) query.set('cursor', options.cursor);
  return request<AnalysisResultPage<T>>(`/jobs/${encodeURIComponent(jobId)}/${resource}?${query}`);
}
