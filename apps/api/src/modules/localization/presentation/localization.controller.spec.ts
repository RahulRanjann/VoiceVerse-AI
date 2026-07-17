import { OrganizationRole, TranslationEditorState } from '@voiceverse/database';
import { describe, expect, it, vi } from 'vitest';

import type { AccessContext } from '../../identity/domain/access-context';
import type { LocalizationService } from '../application/localization.service';
import { LocalizationController } from './localization.controller';

const context: AccessContext = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  role: OrganizationRole.EDITOR,
  sessionId: 'session',
  userId: '00000000-0000-4000-8000-000000000002',
};
const projectId = '00000000-0000-4000-8000-000000000003';
const trackId = '00000000-0000-4000-8000-000000000004';
const sceneId = '00000000-0000-4000-8000-000000000005';
const dialogueId = '00000000-0000-4000-8000-000000000006';

function harness() {
  const localization = {
    createGeneration: vi.fn().mockResolvedValue({ id: 'generation' }),
    listTracks: vi.fn().mockResolvedValue({ data: [] }),
    updateTranslation: vi.fn().mockResolvedValue({ id: 'revision' }),
    updateTranslationState: vi.fn().mockResolvedValue({ editorState: 'IN_REVIEW' }),
  } as unknown as LocalizationService;
  return {
    controller: new LocalizationController(localization),
    localization: localization as unknown as {
      createGeneration: ReturnType<typeof vi.fn>;
      listTracks: ReturnType<typeof vi.fn>;
      updateTranslation: ReturnType<typeof vi.fn>;
      updateTranslationState: ReturnType<typeof vi.fn>;
    },
  };
}

describe('LocalizationController', () => {
  it('passes the authenticated tenant scope to viewer-safe track listing', async () => {
    const test = harness();

    await expect(test.controller.listTracks(context, projectId)).resolves.toEqual({ data: [] });
    expect(test.localization.listTracks).toHaveBeenCalledWith(context, projectId);
  });

  it('preserves expectedRevision=0 for the first manual target edit', async () => {
    const test = harness();

    await test.controller.updateTranslation(context, projectId, trackId, dialogueId, {
      expectedRevision: 0,
      targetText: 'Namaste',
    });

    expect(test.localization.updateTranslation).toHaveBeenCalledWith(
      context,
      projectId,
      trackId,
      dialogueId,
      { expectedRevision: 0, targetText: 'Namaste' },
    );
  });

  it('forwards the Idempotency-Key without placing it in the generation body', async () => {
    const test = harness();

    await test.controller.createGeneration(context, projectId, trackId, 'generation-key-1', {
      sceneId,
    });

    expect(test.localization.createGeneration).toHaveBeenCalledWith(
      context,
      projectId,
      trackId,
      'generation-key-1',
      { sceneId },
    );
  });

  it('delegates CAS editor-state transitions to the localization service', async () => {
    const test = harness();

    await test.controller.updateTranslationState(context, projectId, trackId, dialogueId, {
      expectedRevision: 2,
      state: TranslationEditorState.IN_REVIEW,
    });

    expect(test.localization.updateTranslationState).toHaveBeenCalledWith(
      context,
      projectId,
      trackId,
      dialogueId,
      { expectedRevision: 2, state: TranslationEditorState.IN_REVIEW },
    );
  });
});
