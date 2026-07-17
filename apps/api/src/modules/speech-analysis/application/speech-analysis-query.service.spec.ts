import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { OrganizationRole, WorkflowJobStatus } from '@voiceverse/database';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService } from '../../../infrastructure/database/database.service';
import type { AccessContext } from '../../identity/domain/access-context';
import { SpeechAnalysisResultAvailability } from '../presentation/speech-analysis-query.dto';
import { SpeechAnalysisQueryService } from './speech-analysis-query.service';

const organizationId = '01900000-0000-7000-8000-000000000001';
const jobId = '01900000-0000-7000-8000-000000000002';
const analysisId = '01900000-0000-7000-8000-000000000003';
const runId = '01900000-0000-7000-8000-000000000004';
const assignmentId = '01900000-0000-7000-8000-000000000005';
const characterId = '01900000-0000-7000-8000-000000000006';
const dialogueId = '01900000-0000-7000-8000-000000000007';

const context: AccessContext = {
  organizationId,
  role: OrganizationRole.VIEWER,
  sessionId: '01900000-0000-7000-8000-000000000008',
  userId: '01900000-0000-7000-8000-000000000009',
};

function committedJob(overrides: Record<string, unknown> = {}) {
  return {
    revision: 7,
    speechAnalysis: {
      characterIdentificationRun: { id: runId },
      id: analysisId,
      sourceLanguage: { bcp47Tag: 'en' },
    },
    status: WorkflowJobStatus.SUCCEEDED,
    ...overrides,
  };
}

function characterRow(overrides: Record<string, unknown> = {}) {
  return {
    character: { displayName: 'Asha', id: characterId },
    confidenceBasisPoints: 9_400,
    firstAppearanceTimeUs: 4_250_750n,
    id: assignmentId,
    segmentCount: 3,
    speakerCluster: { ordinal: 0 },
    speakingDurationUs: 9_500_999n,
    ...overrides,
  };
}

function dialogueRow(overrides: Record<string, unknown> = {}) {
  return {
    assignmentConfidenceBasisPoints: 8_900,
    endTimeUs: 6_750_999n,
    id: dialogueId,
    sequenceNumber: 1,
    speakerAssignment: { character: { displayName: 'Asha', id: characterId } },
    startTimeUs: 4_250_750n,
    text: 'The rain has finally stopped.',
    transcriptSegment: { languageTag: null },
    transcriptionConfidenceBasisPoints: 9_700,
    ...overrides,
  };
}

function createHarness() {
  const workflowJobFindFirst = vi.fn().mockResolvedValue(committedJob());
  const assignmentFindFirst = vi.fn().mockResolvedValue({ id: assignmentId });
  const assignmentFindMany = vi.fn().mockResolvedValue([]);
  const assignmentCount = vi.fn().mockResolvedValue(0);
  const dialogueFindFirst = vi.fn().mockResolvedValue({ id: dialogueId });
  const dialogueFindMany = vi.fn().mockResolvedValue([]);
  const dialogueCount = vi.fn().mockResolvedValue(0);
  const client = {
    dialogueSegment: {
      count: dialogueCount,
      findFirst: dialogueFindFirst,
      findMany: dialogueFindMany,
    },
    speakerCharacterAssignment: {
      count: assignmentCount,
      findFirst: assignmentFindFirst,
      findMany: assignmentFindMany,
    },
    workflowJob: { findFirst: workflowJobFindFirst },
  };
  const service = new SpeechAnalysisQueryService({ client } as unknown as DatabaseService);
  return {
    assignmentCount,
    assignmentFindFirst,
    assignmentFindMany,
    dialogueCount,
    dialogueFindFirst,
    dialogueFindMany,
    service,
    workflowJobFindFirst,
  };
}

describe('SpeechAnalysisQueryService', () => {
  it('uses the organization and speech-analysis kind in the ownership lookup', async () => {
    const harness = createHarness();
    harness.workflowJobFindFirst.mockResolvedValue(null);

    await expect(
      harness.service.listCharacters(context, jobId, { limit: 25 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.workflowJobFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: jobId,
          kind: 'SPEECH_ANALYSIS',
          organizationId,
        }),
      }),
    );
    expect(harness.assignmentFindMany).not.toHaveBeenCalled();
  });

  it('keeps incomplete results pending and terminal failures unavailable', async () => {
    const pending = createHarness();
    pending.workflowJobFindFirst.mockResolvedValue(
      committedJob({
        speechAnalysis: {
          characterIdentificationRun: null,
          id: analysisId,
          sourceLanguage: { bcp47Tag: 'en' },
        },
        status: WorkflowJobStatus.RUNNING,
      }),
    );

    await expect(pending.service.listCharacters(context, jobId, { limit: 25 })).resolves.toEqual({
      analysisId: null,
      availability: SpeechAnalysisResultAvailability.PENDING,
      data: [],
      jobRevision: 7,
      nextCursor: null,
      totalCount: 0,
    });

    const failed = createHarness();
    failed.workflowJobFindFirst.mockResolvedValue(
      committedJob({ status: WorkflowJobStatus.FAILED }),
    );
    await expect(
      failed.service.listDialogueSegments(context, jobId, { limit: 25 }),
    ).resolves.toEqual({
      analysisId: null,
      availability: SpeechAnalysisResultAvailability.UNAVAILABLE,
      data: [],
      jobRevision: 7,
      nextCursor: null,
      totalCount: 0,
    });
    expect(failed.dialogueFindMany).not.toHaveBeenCalled();
  });

  it('does not publish related result rows while the job is still active', async () => {
    const harness = createHarness();
    harness.workflowJobFindFirst.mockResolvedValue(
      committedJob({ status: WorkflowJobStatus.RUNNING }),
    );

    await expect(harness.service.listCharacters(context, jobId, { limit: 25 })).resolves.toEqual(
      expect.objectContaining({
        analysisId: null,
        availability: SpeechAnalysisResultAvailability.PENDING,
        data: [],
      }),
    );
    expect(harness.assignmentFindMany).not.toHaveBeenCalled();
  });

  it('keeps immutable job results readable when the project selects a newer analysis', async () => {
    const harness = createHarness();
    harness.assignmentCount.mockResolvedValue(0);

    await expect(harness.service.listCharacters(context, jobId, { limit: 25 })).resolves.toEqual(
      expect.objectContaining({
        analysisId,
        availability: SpeechAnalysisResultAvailability.AVAILABLE,
      }),
    );
    expect(harness.workflowJobFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          speechAnalysis: {
            select: expect.not.objectContaining({ projectSelection: expect.anything() }),
          },
        }),
      }),
    );
  });

  it('returns a stable character page without exposing a provider label', async () => {
    const harness = createHarness();
    harness.assignmentFindMany.mockResolvedValue([
      characterRow(),
      characterRow({ id: '01900000-0000-7000-8000-000000000010' }),
    ]);
    harness.assignmentCount.mockResolvedValue(11);

    const result = await harness.service.listCharacters(context, jobId, { limit: 1 });

    expect(result).toEqual({
      analysisId,
      availability: SpeechAnalysisResultAvailability.AVAILABLE,
      data: [
        {
          confidenceBasisPoints: 9_400,
          displayName: 'Asha',
          firstAppearanceMs: 4_250,
          id: characterId,
          segmentCount: 3,
          speakingDurationMs: 9_500,
        },
      ],
      jobRevision: 7,
      nextCursor: expect.any(String),
      totalCount: 11,
    });
    expect(JSON.stringify(result)).not.toContain('provider');
    expect(harness.assignmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ firstAppearanceTimeUs: 'asc' }, { id: 'asc' }],
        take: 2,
        where: { characterIdentificationRunId: runId },
      }),
    );
  });

  it('uses an analysis-bound keyset cursor and validates its persisted anchor', async () => {
    const harness = createHarness();
    harness.assignmentFindMany
      .mockResolvedValueOnce([
        characterRow(),
        characterRow({ id: '01900000-0000-7000-8000-000000000010' }),
      ])
      .mockResolvedValueOnce([]);
    harness.assignmentCount.mockResolvedValue(2);
    const firstPage = await harness.service.listCharacters(context, jobId, { limit: 1 });

    await harness.service.listCharacters(context, jobId, {
      cursor: firstPage.nextCursor ?? undefined,
      limit: 1,
    });

    expect(harness.assignmentFindFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        characterIdentificationRunId: runId,
        firstAppearanceTimeUs: 4_250_750n,
        id: assignmentId,
      },
    });
    expect(harness.assignmentFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          characterIdentificationRunId: runId,
          OR: [
            { firstAppearanceTimeUs: { gt: 4_250_750n } },
            { firstAppearanceTimeUs: 4_250_750n, id: { gt: assignmentId } },
          ],
        },
      }),
    );
  });

  it('rejects cursor tampering and a cursor from another analysis revision', async () => {
    const harness = createHarness();
    harness.assignmentFindMany.mockResolvedValue([
      characterRow(),
      characterRow({ id: '01900000-0000-7000-8000-000000000010' }),
    ]);
    harness.assignmentCount.mockResolvedValue(2);
    const firstPage = await harness.service.listCharacters(context, jobId, { limit: 1 });
    const cursor = firstPage.nextCursor!;
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const tampered = Buffer.from(JSON.stringify({ ...decoded, positionUs: '4250751' })).toString(
      'base64url',
    );
    harness.assignmentFindFirst.mockResolvedValueOnce(null);

    await expect(
      harness.service.listCharacters(context, jobId, { cursor: tampered, limit: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);

    harness.workflowJobFindFirst.mockResolvedValueOnce(
      committedJob({
        speechAnalysis: {
          characterIdentificationRun: {
            id: '01900000-0000-7000-8000-000000000012',
          },
          id: '01900000-0000-7000-8000-000000000011',
          sourceLanguage: { bcp47Tag: 'en' },
        },
      }),
    );
    await expect(
      harness.service.listCharacters(context, jobId, { cursor, limit: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns an available empty result for a committed no-speech analysis', async () => {
    const harness = createHarness();

    await expect(harness.service.listCharacters(context, jobId, { limit: 25 })).resolves.toEqual({
      analysisId,
      availability: SpeechAnalysisResultAvailability.AVAILABLE,
      data: [],
      jobRevision: 7,
      nextCursor: null,
      totalCount: 0,
    });
    await expect(
      harness.service.listDialogueSegments(context, jobId, { limit: 25 }),
    ).resolves.toEqual({
      analysisId,
      availability: SpeechAnalysisResultAvailability.AVAILABLE,
      data: [],
      jobRevision: 7,
      nextCursor: null,
      totalCount: 0,
    });
  });

  it('returns unresolved dialogue with a null character and a source-language fallback', async () => {
    const harness = createHarness();
    harness.dialogueFindMany.mockResolvedValue([
      dialogueRow({
        assignmentConfidenceBasisPoints: null,
        speakerAssignment: null,
        transcriptSegment: { languageTag: null },
        transcriptionConfidenceBasisPoints: null,
      }),
    ]);
    harness.dialogueCount.mockResolvedValue(1);

    await expect(
      harness.service.listDialogueSegments(context, jobId, { limit: 25 }),
    ).resolves.toEqual({
      analysisId,
      availability: SpeechAnalysisResultAvailability.AVAILABLE,
      data: [
        {
          character: null,
          endMs: 6_750,
          id: dialogueId,
          sequenceNumber: 1,
          sourceLanguageTag: 'en',
          sourceText: 'The rain has finally stopped.',
          startMs: 4_250,
          transcriptionConfidenceBasisPoints: 0,
        },
      ],
      jobRevision: 7,
      nextCursor: null,
      totalCount: 1,
    });
  });

  it('paginates dialogue by timeline and rejects a cursor for the other resource', async () => {
    const harness = createHarness();
    harness.dialogueFindMany
      .mockResolvedValueOnce([
        dialogueRow(),
        dialogueRow({ id: '01900000-0000-7000-8000-000000000010' }),
      ])
      .mockResolvedValueOnce([]);
    harness.dialogueCount.mockResolvedValue(2);
    const firstPage = await harness.service.listDialogueSegments(context, jobId, { limit: 1 });

    await harness.service.listDialogueSegments(context, jobId, {
      cursor: firstPage.nextCursor ?? undefined,
      limit: 1,
    });

    expect(harness.dialogueFindFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        characterIdentificationRunId: runId,
        id: dialogueId,
        startTimeUs: 4_250_750n,
      },
    });
    expect(harness.dialogueFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          characterIdentificationRunId: runId,
          OR: [
            { startTimeUs: { gt: 4_250_750n } },
            { startTimeUs: 4_250_750n, id: { gt: dialogueId } },
          ],
        },
      }),
    );

    const characters = createHarness();
    characters.assignmentFindMany.mockResolvedValue([
      characterRow(),
      characterRow({ id: '01900000-0000-7000-8000-000000000010' }),
    ]);
    characters.assignmentCount.mockResolvedValue(2);
    const characterPage = await characters.service.listCharacters(context, jobId, { limit: 1 });
    await expect(
      characters.service.listDialogueSegments(context, jobId, {
        cursor: characterPage.nextCursor ?? undefined,
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects unsafe persisted timeline values rather than losing precision', async () => {
    const harness = createHarness();
    harness.dialogueFindMany.mockResolvedValue([
      dialogueRow({ startTimeUs: (BigInt(Number.MAX_SAFE_INTEGER) + 1n) * 1_000n }),
    ]);
    harness.dialogueCount.mockResolvedValue(1);

    await expect(
      harness.service.listDialogueSegments(context, jobId, { limit: 25 }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
