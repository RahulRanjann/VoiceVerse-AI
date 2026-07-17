import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import {
  OrganizationRole,
  TranslationEditorState,
  WorkflowJobKind,
  WorkflowJobStatus,
} from '@voiceverse/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import type { DatabaseService } from '../../../infrastructure/database/database.service';
import type { AccessContext } from '../../identity/domain/access-context';
import { LocalizationService } from './localization.service';

const organizationId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
const projectId = '00000000-0000-4000-8000-000000000003';
const jobId = '00000000-0000-4000-8000-000000000004';
const analysisId = '00000000-0000-4000-8000-000000000005';
const sourceLanguageId = '00000000-0000-4000-8000-000000000006';
const targetLanguageId = '00000000-0000-4000-8000-000000000007';
const trackId = '00000000-0000-4000-8000-000000000008';
const workspaceId = '00000000-0000-4000-8000-000000000009';
const sceneId = '00000000-0000-4000-8000-000000000010';
const sceneRevisionId = '00000000-0000-4000-8000-000000000011';
const dialogueId = '00000000-0000-4000-8000-000000000012';
const sourceRevisionId = '00000000-0000-4000-8000-000000000013';
const translationId = '00000000-0000-4000-8000-000000000014';
const translationRevisionId = '00000000-0000-4000-8000-000000000015';
const glossaryRevisionId = '00000000-0000-4000-8000-000000000016';
const secondGlossaryRevisionId = '00000000-0000-4000-8000-000000000017';

const context: AccessContext = {
  organizationId,
  role: OrganizationRole.EDITOR,
  sessionId: 'session',
  userId,
};

const configValues: Partial<Environment> = {
  TRANSLATION_ENABLED: true,
  TRANSLATION_MODEL_ID: 'voiceverse/model',
  TRANSLATION_MODEL_REVISION: 'model-sha',
  TRANSLATION_PROMPT_VERSION: 'prompt-v1',
  TRANSLATION_PROVIDER_NAME: 'provider',
  TRANSLATION_RUNTIME_VERSION: 'runtime-v1',
};

function config() {
  return {
    get: vi.fn((key: keyof Environment) => configValues[key]),
  } as unknown as ConfigService<Environment, true>;
}

function trackScope() {
  return {
    createdAt: new Date('2026-07-17T00:00:00.000Z'),
    id: trackId,
    organizationId,
    projectId,
    targetLanguage: {
      language: { bcp47Tag: 'hi-IN', englishName: 'Hindi', id: targetLanguageId },
    },
    targetLanguageId,
    workspace: {
      id: workspaceId,
      speechAnalysis: {
        id: analysisId,
        sourceLanguage: { bcp47Tag: 'en-US', englishName: 'English', id: sourceLanguageId },
      },
    },
    workspaceId,
  };
}

function mockClient() {
  const client: Record<string, any> = {
    $transaction: vi.fn(async (callback: (transaction: unknown) => unknown) => callback(client)),
    auditLog: { create: vi.fn() },
    dialogueTranslation: { create: vi.fn(), findUnique: vi.fn() },
    glossaryEntry: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    glossaryRevision: {
      aggregate: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    glossarySelection: { create: vi.fn(), updateMany: vi.fn() },
    localizationScene: {
      count: vi.fn(),
      createMany: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    localizationSceneRevision: {
      aggregate: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    localizationSceneSelection: { createMany: vi.fn(), updateMany: vi.fn() },
    localizationTrack: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    localizationWorkspace: { create: vi.fn(), findFirst: vi.fn() },
    localizedDialogue: { createMany: vi.fn(), findFirst: vi.fn() },
    outboxEvent: { create: vi.fn() },
    project: { findFirst: vi.fn() },
    sourceDialogueRevision: {
      aggregate: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    sourceDialogueSelection: { createMany: vi.fn(), updateMany: vi.fn() },
    translationGeneration: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
    translationRevision: {
      aggregate: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    translationSelection: { create: vi.fn(), updateMany: vi.fn() },
    workflowJob: { findFirst: vi.fn() },
  };
  return client;
}

function service(client: Record<string, any>) {
  return new LocalizationService({ client } as unknown as DatabaseService, config());
}

describe('LocalizationService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies viewer writes before touching the tenant database', async () => {
    const client = mockClient();
    const viewer = { ...context, role: OrganizationRole.VIEWER };

    await expect(
      service(client).createTrack(viewer, projectId, {
        speechAnalysisJobId: jobId,
        targetLanguageId,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it('does not reveal a speech-analysis job from another tenant or project', async () => {
    const client = mockClient();
    client.workflowJob.findFirst.mockResolvedValue(null);

    await expect(
      service(client).createTrack(context, projectId, {
        speechAnalysisJobId: jobId,
        targetLanguageId,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(client.localizationWorkspace.create).not.toHaveBeenCalled();
  });

  it('requires a succeeded, committed M5 character-identification result', async () => {
    const client = mockClient();
    client.workflowJob.findFirst.mockResolvedValue({
      kind: WorkflowJobKind.SPEECH_ANALYSIS,
      project: { targetLanguages: [{ language: { id: targetLanguageId } }] },
      speechAnalysis: null,
      status: WorkflowJobStatus.RUNNING,
    });

    await expect(
      service(client).createTrack(context, projectId, {
        speechAnalysisJobId: jobId,
        targetLanguageId,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects an M5 dialogue that exceeds the localization UTF-8 byte limit', async () => {
    const client = mockClient();
    client.workflowJob.findFirst.mockResolvedValue({
      kind: WorkflowJobKind.SPEECH_ANALYSIS,
      project: {
        targetLanguages: [
          {
            language: { bcp47Tag: 'hi-IN', englishName: 'Hindi', id: targetLanguageId },
          },
        ],
      },
      speechAnalysis: {
        characterIdentificationRun: {
          dialogueSegments: [
            {
              endTimeUs: 1_000_000n,
              id: '00000000-0000-4000-8000-000000000101',
              sequenceNumber: 1,
              startTimeUs: 0n,
              text: '😀'.repeat(17_000),
            },
          ],
          id: '00000000-0000-4000-8000-000000000100',
        },
        id: analysisId,
        projectSelection: { speechAnalysisId: analysisId },
        sourceLanguage: { bcp47Tag: 'en-US', englishName: 'English', id: sourceLanguageId },
        sourceLanguageId,
      },
      status: WorkflowJobStatus.SUCCEEDED,
    });
    client.localizationWorkspace.findFirst.mockResolvedValue(null);
    client.localizationWorkspace.create.mockResolvedValue({
      id: workspaceId,
      speechAnalysisId: analysisId,
    });
    client.localizationTrack.findUnique.mockResolvedValue(null);
    client.localizationTrack.create.mockResolvedValue({ id: trackId });
    client.localizationScene.count.mockResolvedValue(0);

    await expect(
      service(client).createTrack(context, projectId, {
        speechAnalysisJobId: jobId,
        targetLanguageId,
      }),
    ).rejects.toThrow('65,536-byte');
    expect(client.localizationScene.createMany).not.toHaveBeenCalled();
  });

  it('bootstraps once and returns the same track on retry without duplicate scenes', async () => {
    const client = mockClient();
    let workspace: { id: string; speechAnalysisId: string } | null = null;
    let track: { id: string } | null = null;
    let scenesCreated = false;
    client.workflowJob.findFirst.mockResolvedValue({
      kind: WorkflowJobKind.SPEECH_ANALYSIS,
      project: {
        targetLanguages: [
          {
            language: { bcp47Tag: 'hi-IN', englishName: 'Hindi', id: targetLanguageId },
          },
        ],
      },
      speechAnalysis: {
        characterIdentificationRun: {
          dialogueSegments: [
            {
              endTimeUs: 1_000_000n,
              id: '00000000-0000-4000-8000-000000000101',
              sequenceNumber: 1,
              startTimeUs: 0n,
              text: 'Hello',
            },
          ],
          id: '00000000-0000-4000-8000-000000000100',
        },
        id: analysisId,
        projectSelection: { speechAnalysisId: analysisId },
        sourceLanguage: { bcp47Tag: 'en-US', englishName: 'English', id: sourceLanguageId },
        sourceLanguageId,
      },
      status: WorkflowJobStatus.SUCCEEDED,
    });
    client.localizationWorkspace.findFirst.mockImplementation(() => workspace);
    client.localizationWorkspace.create.mockImplementation(({ data }: any) => {
      workspace = { id: data.id, speechAnalysisId: data.speechAnalysisId };
      return workspace;
    });
    client.localizationTrack.findUnique.mockImplementation(() => track);
    client.localizationTrack.create.mockImplementation(({ data }: any) => {
      track = { id: data.id };
      return track;
    });
    client.localizationScene.count.mockImplementation(() => (scenesCreated ? 1 : 0));
    client.localizationScene.createMany.mockImplementation(() => {
      scenesCreated = true;
      return { count: 1 };
    });
    client.localizationTrack.findUniqueOrThrow.mockResolvedValue(trackScope());
    const localization = service(client);

    const first = await localization.createTrack(context, projectId, {
      speechAnalysisJobId: jobId,
      targetLanguageId,
    });
    const second = await localization.createTrack(context, projectId, {
      speechAnalysisJobId: jobId,
      targetLanguageId,
    });

    expect(second.id).toBe(first.id);
    expect(client.localizationWorkspace.create).toHaveBeenCalledTimes(1);
    expect(client.localizationTrack.create).toHaveBeenCalledTimes(1);
    expect(client.localizationScene.createMany).toHaveBeenCalledTimes(1);
    expect(client.sourceDialogueRevision.createMany).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale scene selection before appending a revision', async () => {
    const client = mockClient();
    client.localizationTrack.findFirst.mockResolvedValue(trackScope());
    client.localizationScene.findFirst.mockResolvedValue({
      id: sceneId,
      selection: {
        revision: 2,
        selectedRevision: {
          culturalContext: null,
          endTimeUs: 1_000_000n,
          id: sceneRevisionId,
          revisionNumber: 1,
          startTimeUs: 0n,
          summary: null,
          title: null,
        },
      },
    });

    await expect(
      service(client).updateScene(context, projectId, trackId, sceneId, {
        expectedRevision: 1,
        title: 'New title',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(client.localizationSceneRevision.create).not.toHaveBeenCalled();
  });

  it('reopens every target selection when source text is revised', async () => {
    const client = mockClient();
    client.localizationTrack.findFirst.mockResolvedValue(trackScope());
    client.localizedDialogue.findFirst.mockResolvedValue({
      id: dialogueId,
      sourceSelection: {
        revision: 1,
        selectedRevision: { id: sourceRevisionId, revisionNumber: 1, sourceText: 'old source' },
        selectedRevisionId: sourceRevisionId,
      },
    });
    client.sourceDialogueRevision.aggregate.mockResolvedValue({
      _max: { revisionNumber: 1 },
    });
    client.sourceDialogueRevision.create.mockResolvedValue({
      createdAt: new Date('2026-07-17T00:00:00.000Z'),
      createdByUserId: userId,
      id: '00000000-0000-4000-8000-000000000097',
      localizedDialogueId: dialogueId,
      revisionNumber: 2,
      sourceText: 'new source',
    });
    client.sourceDialogueSelection.updateMany.mockResolvedValue({ count: 1 });
    client.translationSelection.updateMany.mockResolvedValue({ count: 2 });

    await service(client).updateSourceDialogue(context, projectId, trackId, dialogueId, {
      expectedRevision: 1,
      sourceText: 'new source',
    });

    expect(client.translationSelection.updateMany).toHaveBeenCalledWith({
      data: {
        editorState: TranslationEditorState.DRAFT,
        revision: { increment: 1 },
        updatedByUserId: userId,
      },
      where: {
        dialogueTranslation: { localizedDialogueId: dialogueId },
        organizationId,
        projectId,
        workspaceId,
      },
    });
  });

  it('scopes undo revisions to the owned dialogue and audits identifiers only', async () => {
    const client = mockClient();
    client.localizationTrack.findFirst.mockResolvedValue(trackScope());
    client.localizedDialogue.findFirst.mockResolvedValue({
      id: dialogueId,
      sourceSelection: {
        revision: 3,
        selectedRevision: { id: sourceRevisionId, revisionNumber: 3, sourceText: 'current' },
        selectedRevisionId: sourceRevisionId,
      },
    });
    client.sourceDialogueRevision.findFirst.mockResolvedValueOnce(null);

    await expect(
      service(client).selectSourceRevision(context, projectId, trackId, dialogueId, {
        expectedRevision: 3,
        revisionId: '00000000-0000-4000-8000-000000000099',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(client.sourceDialogueSelection.updateMany).not.toHaveBeenCalled();

    const historical = {
      createdAt: new Date('2026-07-17T00:00:00.000Z'),
      createdByUserId: userId,
      id: '00000000-0000-4000-8000-000000000098',
      localizedDialogueId: dialogueId,
      revisionNumber: 1,
      sourceText: 'historical secret',
    };
    client.sourceDialogueRevision.findFirst.mockResolvedValueOnce(historical);
    client.sourceDialogueSelection.updateMany.mockResolvedValue({ count: 1 });

    await service(client).selectSourceRevision(context, projectId, trackId, dialogueId, {
      expectedRevision: 3,
      revisionId: historical.id,
    });

    expect(client.translationSelection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          editorState: TranslationEditorState.DRAFT,
          revision: { increment: 1 },
        }),
      }),
    );
    const auditData = client.auditLog.create.mock.calls[0][0].data;
    expect(JSON.stringify(auditData.metadata)).not.toContain('historical secret');
    expect(auditData.metadata).toMatchObject({
      dialogueId,
      revisionId: historical.id,
      revisionNumber: 1,
      selectionRevision: 4,
      trackId,
    });
  });

  it('enforces CAS review transitions and audits the state change without target text', async () => {
    const client = mockClient();
    client.localizationTrack.findFirst.mockResolvedValue(trackScope());
    client.localizedDialogue.findFirst.mockResolvedValue({
      id: dialogueId,
      sourceSelection: {
        revision: 1,
        selectedRevision: { id: sourceRevisionId, revisionNumber: 1, sourceText: 'source' },
        selectedRevisionId: sourceRevisionId,
      },
    });
    const selectedRevision = {
      createdAt: new Date('2026-07-17T00:00:00.000Z'),
      createdByUserId: userId,
      dialogueTranslationId: translationId,
      generationId: null,
      id: translationRevisionId,
      localizedDialogueId: dialogueId,
      revisionNumber: 2,
      sourceDialogueRevisionId: sourceRevisionId,
      translatedText: 'target secret',
    };
    client.dialogueTranslation.findUnique.mockResolvedValue({
      id: translationId,
      selection: {
        editorState: TranslationEditorState.APPROVED,
        revision: 5,
        selectedRevision,
        selectedRevisionId: translationRevisionId,
      },
    });
    client.translationSelection.updateMany.mockResolvedValue({ count: 1 });

    const response = await service(client).updateTranslationState(
      context,
      projectId,
      trackId,
      dialogueId,
      { expectedRevision: 5, state: TranslationEditorState.DRAFT },
    );

    expect(response).toMatchObject({
      editorState: TranslationEditorState.DRAFT,
      selectionRevision: 6,
    });
    const audit = client.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe('localization.dialogue.translation_state.approved_to_draft');
    expect(JSON.stringify(audit)).not.toContain('target secret');

    client.dialogueTranslation.findUnique.mockResolvedValue({
      id: translationId,
      selection: {
        editorState: TranslationEditorState.DRAFT,
        revision: 6,
        selectedRevision,
        selectedRevisionId: translationRevisionId,
      },
    });
    await expect(
      service(client).updateTranslationState(context, projectId, trackId, dialogueId, {
        expectedRevision: 6,
        state: TranslationEditorState.APPROVED,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    client.dialogueTranslation.findUnique.mockResolvedValue({
      id: translationId,
      selection: {
        editorState: TranslationEditorState.DRAFT,
        revision: 7,
        selectedRevision: {
          ...selectedRevision,
          sourceDialogueRevisionId: '00000000-0000-4000-8000-000000000096',
        },
        selectedRevisionId: translationRevisionId,
      },
    });
    await expect(
      service(client).updateTranslationState(context, projectId, trackId, dialogueId, {
        expectedRevision: 7,
        state: TranslationEditorState.IN_REVIEW,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(client.translationSelection.updateMany).toHaveBeenCalledTimes(1);
  });

  it('rejects a glossary target when doNotTranslate is enabled before persistence', async () => {
    const client = mockClient();

    await expect(
      service(client).createGlossaryEntry(context, projectId, trackId, {
        caseSensitive: false,
        doNotTranslate: true,
        sourceTerm: 'VoiceVerse',
        targetTerm: 'VoiceVerse',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it('caps each track glossary before creating another immutable entry', async () => {
    const client = mockClient();
    client.localizationTrack.findFirst.mockResolvedValue(trackScope());
    client.glossaryEntry.count.mockResolvedValue(200);

    await expect(
      service(client).createGlossaryEntry(context, projectId, trackId, {
        caseSensitive: false,
        doNotTranslate: false,
        sourceTerm: 'Monsoon',
        targetTerm: 'मानसून',
      }),
    ).rejects.toThrow('A localization track is limited to 200 glossary entries.');
    expect(client.glossaryEntry.create).not.toHaveBeenCalled();
  });

  it('snapshots exact revisions, active targets and glossary, then replays idempotently', async () => {
    const client = mockClient();
    const now = new Date('2026-07-17T00:00:00.000Z');
    let persisted: any = null;
    client.localizationTrack.findFirst.mockResolvedValue(trackScope());
    client.translationGeneration.findUnique.mockImplementation(() => persisted);
    client.localizationScene.findFirst.mockResolvedValue({
      dialogues: [
        {
          dialogueSegment: {
            speakerAssignment: {
              character: { displayName: 'Asha', id: userId, stableKey: 'character-1' },
            },
          },
          endTimeUs: 2_000_000n,
          id: dialogueId,
          sequenceNumber: 7,
          sourceSelection: {
            selectedRevision: { id: sourceRevisionId, sourceText: 'source secret' },
          },
          startTimeUs: 1_000_000n,
          translations: [
            {
              id: translationId,
              selection: { revision: 4, selectedRevisionId: translationRevisionId },
            },
          ],
        },
      ],
      id: sceneId,
      selection: {
        selectedRevision: {
          culturalContext: 'context secret',
          id: sceneRevisionId,
          summary: 'narrative secret',
          title: 'title secret',
        },
      },
    });
    client.glossaryEntry.findMany.mockResolvedValue([
      {
        id: '00000000-0000-4000-8000-000000000018',
        selection: {
          selectedNormalizedSourceTerm: 'friend',
          selectedRevision: {
            caseSensitive: false,
            doNotTranslate: false,
            id: glossaryRevisionId,
            notes: 'glossary secret',
            sourceTerm: 'friend',
            targetTerm: 'dost',
          },
        },
      },
      {
        id: '00000000-0000-4000-8000-000000000019',
        selection: {
          selectedNormalizedSourceTerm: 'apple',
          selectedRevision: {
            caseSensitive: false,
            doNotTranslate: false,
            id: secondGlossaryRevisionId,
            notes: null,
            sourceTerm: 'Apple',
            targetTerm: 'Seb',
          },
        },
      },
    ]);
    client.translationGeneration.create.mockImplementation(({ data }: any) => {
      persisted = {
        ...data,
        attemptCount: 0,
        completedAt: null,
        createdAt: now,
        errorCode: null,
        maxAttempts: 3,
        queuedAt: now,
        startedAt: null,
        updatedAt: now,
      };
      return persisted;
    });
    const localization = service(client);

    const first = await localization.createGeneration(
      context,
      projectId,
      trackId,
      'generation-key-1',
      { sceneId },
    );
    const second = await localization.createGeneration(
      context,
      projectId,
      trackId,
      'generation-key-1',
      { sceneId },
    );
    await expect(
      localization.createGeneration(context, projectId, trackId, 'generation-key-1', {
        sceneId: '00000000-0000-4000-8000-000000000099',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(second.id).toBe(first.id);
    expect(client.translationGeneration.create).toHaveBeenCalledTimes(1);
    const snapshot = client.translationGeneration.create.mock.calls[0][0].data;
    expect(snapshot.configurationSnapshot).toEqual({
      expectedModel: {
        modelId: 'voiceverse/model',
        modelRevision: 'model-sha',
        provider: 'provider',
        runtimeVersion: 'runtime-v1',
      },
      promptVersion: 'prompt-v1',
      schemaVersion: 'voiceverse.translation-configuration.v1',
    });
    expect(snapshot.inputSnapshot.dialogues[0]).toMatchObject({
      dialogueId,
      ordinal: 0,
      sourceRevisionId,
      sourceText: 'source secret',
      translationId,
      translationRevisionId,
      translationSelectionRevision: 4,
    });
    expect(
      snapshot.inputSnapshot.glossaryRevisions.map(
        (revision: { glossaryRevisionId: string }) => revision.glossaryRevisionId,
      ),
    ).toEqual([secondGlossaryRevisionId, glossaryRevisionId]);
    expect(snapshot.contextSnapshot.sceneContext.sceneRevisionId).toBe(sceneRevisionId);
    expect(client.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'localization.translation.requested',
          payload: { generationId: first.id },
        }),
      }),
    );
    const audit = client.auditLog.create.mock.calls[0][0].data;
    expect(audit.metadata).toEqual({
      generationId: first.id,
      sceneId,
      sceneRevisionId,
      trackId,
    });
    expect(JSON.stringify(audit)).not.toMatch(/source secret|context secret|glossary secret/u);

    persisted = null;
    client.glossaryEntry.findMany.mockResolvedValue(
      Array.from({ length: 201 }, (_, index) => ({
        id: `entry-${String(index).padStart(3, '0')}`,
        selection: {
          selectedNormalizedSourceTerm: `term-${String(index).padStart(3, '0')}`,
          selectedRevision: {
            caseSensitive: false,
            doNotTranslate: false,
            id: glossaryRevisionId,
            notes: null,
            sourceTerm: `term ${index}`,
            targetTerm: `target ${index}`,
          },
        },
      })),
    );
    await expect(
      localization.createGeneration(context, projectId, trackId, 'generation-key-2', {
        sceneId,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(client.translationGeneration.create).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized input snapshot before creating a generation', async () => {
    const client = mockClient();
    client.localizationTrack.findFirst.mockResolvedValue(trackScope());
    client.translationGeneration.findUnique.mockResolvedValue(null);
    client.glossaryEntry.findMany.mockResolvedValue([]);
    client.localizationScene.findFirst.mockResolvedValue({
      dialogues: Array.from({ length: 60 }, (_, index) => {
        const suffix = String(index + 100).padStart(12, '0');
        const startTimeUs = BigInt(index * 1_000_000);
        return {
          dialogueSegment: { speakerAssignment: null },
          endTimeUs: startTimeUs + 500_000n,
          id: `00000000-0000-4000-8000-${suffix}`,
          sequenceNumber: index,
          sourceSelection: {
            selectedRevision: {
              id: `10000000-0000-4000-8000-${suffix}`,
              sourceText: 'x'.repeat(18_000),
            },
          },
          startTimeUs,
          translations: [],
        };
      }),
      id: sceneId,
      selection: {
        selectedRevision: {
          culturalContext: null,
          id: sceneRevisionId,
          summary: null,
          title: null,
        },
      },
    });

    await expect(
      service(client).createGeneration(context, projectId, trackId, 'generation-key-large', {
        sceneId,
      }),
    ).rejects.toThrow('The translation input snapshot exceeds its byte limit.');
    expect(client.translationGeneration.create).not.toHaveBeenCalled();
    expect(client.outboxEvent.create).not.toHaveBeenCalled();
  });
});
