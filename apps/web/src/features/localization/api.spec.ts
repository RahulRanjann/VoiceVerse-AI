import { describe, expect, it, vi } from 'vitest';

import {
  createLocalizationTrack,
  createSceneGeneration,
  listGlossaryRevisions,
  listLocalizationScenes,
  listLocalizationTracks,
  selectTranslationRevision,
  updateDialogueTranslation,
  updateLocalizationScene,
  updateTranslationState,
} from './api';

describe('localization API', () => {
  it('encodes the project, track, scene, dialogue, and cursor route segments', async () => {
    const request = vi.fn().mockResolvedValue({ data: [] });

    await listLocalizationTracks(request, 'project/id');
    await listLocalizationScenes(request, 'project/id', 'track/id', {
      cursor: 'next+scene',
      limit: 12,
    });
    await updateLocalizationScene(request, 'project/id', 'track/id', 'scene/id', {
      expectedRevision: 3,
      title: 'Arrival',
    });

    expect(request).toHaveBeenNthCalledWith(1, '/projects/project%2Fid/localization-tracks');
    expect(request).toHaveBeenNthCalledWith(
      2,
      '/projects/project%2Fid/localization-tracks/track%2Fid/scenes?limit=12&cursor=next%2Bscene',
    );
    expect(request.mock.calls[2]?.[0]).toBe(
      '/projects/project%2Fid/localization-tracks/track%2Fid/scenes/scene%2Fid',
    );
  });

  it('mirrors bootstrap and expected-revision mutation bodies', async () => {
    const request = vi.fn().mockResolvedValue({});

    await createLocalizationTrack(request, 'project', {
      speechAnalysisJobId: 'job',
      targetLanguageId: 'language',
    });
    await updateDialogueTranslation(request, 'project', 'track', 'dialogue', {
      expectedRevision: 0,
      targetText: 'नमस्ते',
    });
    await selectTranslationRevision(request, 'project', 'track', 'dialogue', {
      expectedRevision: 4,
      revisionId: 'revision',
    });
    await updateTranslationState(request, 'project', 'track', 'dialogue', {
      expectedRevision: 5,
      state: 'IN_REVIEW',
    });

    expect(request.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ speechAnalysisJobId: 'job', targetLanguageId: 'language' }),
      method: 'POST',
    });
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ expectedRevision: 0, targetText: 'नमस्ते' }),
      method: 'PATCH',
    });
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      body: JSON.stringify({ expectedRevision: 4, revisionId: 'revision' }),
      method: 'POST',
    });
    expect(request.mock.calls[3]).toEqual([
      '/projects/project/localization-tracks/track/dialogues/dialogue/translation/state',
      {
        body: JSON.stringify({ expectedRevision: 5, state: 'IN_REVIEW' }),
        headers: undefined,
        method: 'PATCH',
      },
    ]);
  });

  it('uses bounded keyset history and preserves the idempotency key header', async () => {
    const request = vi.fn().mockResolvedValue({ data: [] });

    await listGlossaryRevisions(request, 'project', 'track', 'entry/id', {
      cursor: 'older+entry',
      limit: 50,
    });
    await createSceneGeneration(request, 'project', 'track', 'scene', 'web-unique-click');

    expect(request).toHaveBeenNthCalledWith(
      1,
      '/projects/project/localization-tracks/track/glossary/entry%2Fid/revisions?limit=50&cursor=older%2Bentry',
    );
    const [, init] = request.mock.calls[1] as [string, RequestInit];
    expect(new Headers(init.headers).get('idempotency-key')).toBe('web-unique-click');
    expect(init).toMatchObject({ body: JSON.stringify({ sceneId: 'scene' }), method: 'POST' });
  });
});
