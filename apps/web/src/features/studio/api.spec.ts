import { describe, expect, it, vi } from 'vitest';

import {
  getWorkflowJob,
  getWorkflowJobResult,
  listDialogueSegments,
  listJobCharacters,
  listProjectJobs,
  listProjects,
} from './api';

describe('studio API', () => {
  it('uses one bounded project-list request for the dashboard', async () => {
    const request = vi.fn().mockResolvedValue({ data: [], nextCursor: null });

    await listProjects(request, 25);

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('/projects?limit=25');
  });

  it('encodes job resource identifiers and pagination cursors', async () => {
    const request = vi.fn().mockResolvedValue({ data: [], nextCursor: null });

    await listProjectJobs(request, 'project/id', { cursor: 'next+page', limit: 10 });
    await getWorkflowJob(request, 'job/id');

    expect(request).toHaveBeenNthCalledWith(
      1,
      '/projects/project%2Fid/jobs?limit=10&cursor=next%2Bpage',
    );
    expect(request).toHaveBeenNthCalledWith(2, '/jobs/job%2Fid');
  });

  it('sends a revision ETag when conditionally refreshing one job', async () => {
    const request = vi.fn().mockResolvedValue({
      data: null,
      etag: null,
      notModified: true,
      status: 304,
    });

    await getWorkflowJobResult(request, 'job/id', 17);

    const [path, init] = request.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/jobs/job%2Fid');
    expect(new Headers(init.headers).get('if-none-match')).toBe('W/"job-job/id-17"');
  });

  it('uses job-scoped cursor routes for characters and dialogue', async () => {
    const request = vi.fn().mockResolvedValue({
      availability: 'AVAILABLE',
      analysisId: 'analysis-1',
      jobRevision: 3,
      data: [],
      totalCount: 0,
      nextCursor: null,
    });

    await listJobCharacters(request, 'job/id', { limit: 6 });
    await listDialogueSegments(request, 'job/id', { cursor: 'next+page', limit: 25 });

    expect(request).toHaveBeenNthCalledWith(1, '/jobs/job%2Fid/characters?limit=6');
    expect(request).toHaveBeenNthCalledWith(
      2,
      '/jobs/job%2Fid/dialogue-segments?limit=25&cursor=next%2Bpage',
    );
  });
});
