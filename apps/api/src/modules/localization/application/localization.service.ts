import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OrganizationRole,
  OutboxStatus,
  type Prisma,
  TranslationEditorState,
  TranslationGenerationStatus,
  WorkflowJobKind,
  WorkflowJobStatus,
} from '@voiceverse/database';

import type { Environment } from '../../../config/environment';
import { DatabaseService } from '../../../infrastructure/database/database.service';
import { uuidv7 } from '../../../shared/uuid';
import type { AccessContext } from '../../identity/domain/access-context';
import { LOCALIZATION_TRANSLATION_EVENT } from '../infrastructure/localization.queue';
import type {
  CreateGlossaryEntryDto,
  CreateLocalizationTrackDto,
  GenerateSceneTranslationDto,
  ListLocalizationHistoryQueryDto,
  ListLocalizationScenesQueryDto,
  SelectLocalizationRevisionDto,
  UpdateGlossaryRevisionDto,
  UpdateSceneRevisionDto,
  UpdateSourceDialogueRevisionDto,
  UpdateTranslationRevisionDto,
  UpdateTranslationStateDto,
} from '../presentation/localization.dto';
import { partitionLocalizationScenes } from './localization-partitioner';
import {
  type CanonicalJson,
  canonicalJsonHash,
  deterministicLocalizationUuid,
  glossaryComparisonKey,
  normalizeGlossarySourceTerm,
  normalizeOptionalEditorialText,
  normalizeRequiredEditorialText,
  stableJson,
} from './localization-values';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idempotencyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const historyCursorPattern = /^[A-Za-z0-9_-]+$/;
const snapshotJsonByteLimits = {
  configuration: 60_000,
  context: 250_000,
  input: 1_000_000,
} as const;

const trackScopeSelect = {
  createdAt: true,
  id: true,
  organizationId: true,
  projectId: true,
  targetLanguage: {
    select: {
      language: { select: { bcp47Tag: true, englishName: true, id: true } },
    },
  },
  targetLanguageId: true,
  workspace: {
    select: {
      id: true,
      speechAnalysis: {
        select: {
          id: true,
          sourceLanguage: { select: { bcp47Tag: true, englishName: true, id: true } },
        },
      },
    },
  },
  workspaceId: true,
} as const;

type TrackScope = Prisma.LocalizationTrackGetPayload<{ select: typeof trackScopeSelect }>;
type Transaction = Prisma.TransactionClient;

interface SceneCursor {
  version: 1;
  trackId: string;
  ordinal: number;
  id: string;
}

interface HistoryCursor {
  version: 1;
  resourceId: string;
  revisionNumber: number;
  id: string;
}

interface NormalizedGlossaryInput {
  sourceTerm: string;
  normalizedSourceTerm: string;
  targetTerm: string | null;
  notes: string | null;
  caseSensitive: boolean;
  doNotTranslate: boolean;
}

@Injectable()
export class LocalizationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  async createTrack(context: AccessContext, projectId: string, input: CreateLocalizationTrackDto) {
    this.assertCanEdit(context);
    this.assertUuid(projectId, 'project');
    this.assertUuid(input.speechAnalysisJobId, 'speech-analysis job');
    this.assertUuid(input.targetLanguageId, 'target language');

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.database.client.$transaction(
          (transaction) => this.createTrackTransaction(transaction, context, projectId, input),
          { isolationLevel: 'Serializable' },
        );
      } catch (error) {
        if (this.isRetryableTransactionError(error) && attempt < 3) continue;
        if (this.isUniqueConstraintViolation(error)) {
          const winner = await this.findIdempotentTrack(
            context,
            projectId,
            input.speechAnalysisJobId,
            input.targetLanguageId,
          );
          if (winner) return winner;
          if (attempt < 3) continue;
        }
        throw error;
      }
    }
    throw new ConflictException('The localization workspace changed concurrently.');
  }

  async listTracks(context: AccessContext, projectId: string) {
    this.assertUuid(projectId, 'project');
    const project = await this.database.client.project.findFirst({
      select: { id: true },
      where: { id: projectId, organizationId: context.organizationId },
    });
    if (!project) throw new NotFoundException('Project not found.');
    const tracks = await this.database.client.localizationTrack.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: trackScopeSelect,
      where: { organizationId: context.organizationId, projectId },
    });
    return {
      data: tracks
        .map((track) => this.toTrackResponse(track))
        .sort(
          (left, right) =>
            left.targetLanguage.englishName.localeCompare(right.targetLanguage.englishName) ||
            left.createdAt.localeCompare(right.createdAt) ||
            left.id.localeCompare(right.id),
        ),
    };
  }

  async listScenes(
    context: AccessContext,
    projectId: string,
    trackId: string,
    query: ListLocalizationScenesQueryDto,
  ) {
    const track = await this.ownedTrack(context, projectId, trackId);
    const cursor = query.cursor ? this.decodeSceneCursor(query.cursor, track.id) : undefined;
    const where = {
      organizationId: context.organizationId,
      projectId,
      workspaceId: track.workspaceId,
      ...(cursor
        ? {
            OR: [
              { ordinal: { gt: cursor.ordinal } },
              { id: { gt: cursor.id }, ordinal: cursor.ordinal },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.database.client.localizationScene.findMany({
        orderBy: [{ ordinal: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          ordinal: true,
          selection: {
            select: {
              revision: true,
              selectedRevision: {
                select: {
                  culturalContext: true,
                  endTimeUs: true,
                  id: true,
                  revisionNumber: true,
                  startTimeUs: true,
                  summary: true,
                  title: true,
                },
              },
            },
          },
          dialogues: {
            orderBy: [{ sequenceNumber: 'asc' }, { id: 'asc' }],
            select: {
              dialogueSegment: {
                select: {
                  speakerAssignment: {
                    select: {
                      character: { select: { displayName: true, id: true, stableKey: true } },
                    },
                  },
                },
              },
              endTimeUs: true,
              id: true,
              sequenceNumber: true,
              sourceSelection: {
                select: {
                  revision: true,
                  selectedRevision: {
                    select: { id: true, revisionNumber: true, sourceText: true },
                  },
                },
              },
              startTimeUs: true,
              translations: {
                select: {
                  id: true,
                  selection: {
                    select: {
                      editorState: true,
                      revision: true,
                      selectedRevision: {
                        select: {
                          id: true,
                          revisionNumber: true,
                          sourceDialogueRevisionId: true,
                          translatedText: true,
                        },
                      },
                    },
                  },
                },
                take: 1,
                where: { trackId: track.id },
              },
            },
            take: 200,
          },
        },
        take: query.limit + 1,
        where,
      }),
      this.database.client.localizationScene.count({
        where: {
          organizationId: context.organizationId,
          projectId,
          workspaceId: track.workspaceId,
        },
      }),
    ]);
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      data: page.map((scene) => this.toSceneResponse(scene)),
      nextCursor:
        hasMore && last
          ? this.encodeCursor({ id: last.id, ordinal: last.ordinal, trackId, version: 1 })
          : null,
      total,
      track: this.toTrackResponse(track),
    };
  }

  private async createTrackTransaction(
    transaction: Transaction,
    context: AccessContext,
    projectId: string,
    input: CreateLocalizationTrackDto,
  ) {
    const job = await transaction.workflowJob.findFirst({
      select: {
        kind: true,
        project: {
          select: {
            targetLanguages: {
              select: {
                language: { select: { bcp47Tag: true, englishName: true, id: true } },
              },
              where: { languageId: input.targetLanguageId },
            },
          },
        },
        speechAnalysis: {
          select: {
            characterIdentificationRun: {
              select: {
                dialogueSegments: {
                  orderBy: [{ sequenceNumber: 'asc' }, { id: 'asc' }],
                  select: {
                    endTimeUs: true,
                    id: true,
                    sequenceNumber: true,
                    startTimeUs: true,
                    text: true,
                  },
                },
                id: true,
              },
            },
            id: true,
            projectSelection: { select: { speechAnalysisId: true } },
            sourceLanguage: {
              select: { bcp47Tag: true, englishName: true, id: true },
            },
            sourceLanguageId: true,
          },
        },
        status: true,
      },
      where: {
        id: input.speechAnalysisJobId,
        organizationId: context.organizationId,
        projectId,
      },
    });
    if (!job) throw new NotFoundException('Speech-analysis job not found.');
    if (job.kind !== WorkflowJobKind.SPEECH_ANALYSIS) {
      throw new ConflictException('The selected workflow job is not a speech-analysis job.');
    }
    if (job.status !== WorkflowJobStatus.SUCCEEDED) {
      throw new ConflictException('Speech analysis must succeed before localization can begin.');
    }
    const analysis = job.speechAnalysis;
    if (
      !analysis?.characterIdentificationRun ||
      analysis.projectSelection?.speechAnalysisId !== analysis.id
    ) {
      throw new ConflictException(
        'The speech-analysis result is not the committed project result.',
      );
    }
    if (analysis.sourceLanguageId === input.targetLanguageId) {
      throw new BadRequestException('The target language must differ from the source language.');
    }
    if (job.project.targetLanguages.length !== 1) {
      throw new BadRequestException('The target language is not configured for this project.');
    }

    const workspaceId = deterministicLocalizationUuid(
      `workspace:${context.organizationId}:${projectId}:${analysis.id}`,
    );
    let workspace = await transaction.localizationWorkspace.findFirst({
      select: { id: true, speechAnalysisId: true },
      where: { organizationId: context.organizationId, projectId },
    });
    if (workspace && workspace.speechAnalysisId !== analysis.id) {
      throw new ConflictException(
        'This project localization workspace is pinned to another committed analysis.',
      );
    }
    workspace ??= await transaction.localizationWorkspace.create({
      data: {
        createdByUserId: context.userId,
        id: workspaceId,
        organizationId: context.organizationId,
        projectId,
        speechAnalysisId: analysis.id,
      },
      select: { id: true, speechAnalysisId: true },
    });

    let track = await transaction.localizationTrack.findUnique({
      select: { id: true },
      where: {
        workspaceId_targetLanguageId: {
          targetLanguageId: input.targetLanguageId,
          workspaceId: workspace.id,
        },
      },
    });
    const trackCreated = !track;
    track ??= await transaction.localizationTrack.create({
      data: {
        createdByUserId: context.userId,
        id: deterministicLocalizationUuid(`track:${workspace.id}:${input.targetLanguageId}`),
        organizationId: context.organizationId,
        projectId,
        targetLanguageId: input.targetLanguageId,
        workspaceId: workspace.id,
      },
      select: { id: true },
    });

    const sceneCount = await transaction.localizationScene.count({
      where: { workspaceId: workspace.id },
    });
    if (sceneCount === 0) {
      await this.bootstrapWorkspace(
        transaction,
        context,
        projectId,
        workspace.id,
        analysis.id,
        analysis.characterIdentificationRun.dialogueSegments,
      );
    }
    if (trackCreated) {
      await this.audit(
        transaction,
        context,
        'localization.track.created',
        'localization_track',
        track.id,
        {
          speechAnalysisId: analysis.id,
          targetLanguageId: input.targetLanguageId,
          trackId: track.id,
          workspaceId: workspace.id,
        },
      );
    }

    const result = await transaction.localizationTrack.findUniqueOrThrow({
      select: trackScopeSelect,
      where: { id: track.id },
    });
    return this.toTrackResponse(result);
  }

  private async bootstrapWorkspace(
    transaction: Transaction,
    context: AccessContext,
    projectId: string,
    workspaceId: string,
    speechAnalysisId: string,
    dialogueSegments: Array<{
      id: string;
      sequenceNumber: number;
      startTimeUs: bigint;
      endTimeUs: bigint;
      text: string;
    }>,
  ): Promise<void> {
    for (const dialogue of dialogueSegments) {
      if (!dialogue.text.trim()) {
        throw new ConflictException(
          'The committed speech analysis contains a blank dialogue segment.',
        );
      }
      if (Buffer.byteLength(dialogue.text, 'utf8') > 65_536) {
        throw new ConflictException(
          'A committed dialogue segment exceeds the 65,536-byte localization limit.',
        );
      }
    }
    const partitions = partitionLocalizationScenes(dialogueSegments);
    if (partitions.length === 0) {
      throw new ConflictException('The committed speech analysis contains no dialogue segments.');
    }
    const scenes = partitions.map((partition) => ({
      ...partition,
      id: deterministicLocalizationUuid(`scene:${workspaceId}:${partition.ordinal}`),
    }));

    await transaction.localizationScene.createMany({
      data: scenes.map((scene) => ({
        createdByUserId: context.userId,
        id: scene.id,
        ordinal: scene.ordinal,
        organizationId: context.organizationId,
        projectId,
        workspaceId,
      })),
    });
    await transaction.localizationSceneRevision.createMany({
      data: scenes.map((scene) => ({
        createdByUserId: context.userId,
        endTimeUs: scene.endTimeUs,
        id: deterministicLocalizationUuid(`scene-revision:${scene.id}:1`),
        organizationId: context.organizationId,
        projectId,
        revisionNumber: 1,
        sceneId: scene.id,
        startTimeUs: scene.startTimeUs,
        workspaceId,
      })),
    });
    await transaction.localizationSceneSelection.createMany({
      data: scenes.map((scene) => ({
        organizationId: context.organizationId,
        projectId,
        revision: 1,
        sceneId: scene.id,
        selectedRevisionId: deterministicLocalizationUuid(`scene-revision:${scene.id}:1`),
        updatedByUserId: context.userId,
        workspaceId,
      })),
    });

    const dialogues = scenes.flatMap((scene) =>
      scene.dialogues.map((dialogue) => ({
        dialogue,
        id: deterministicLocalizationUuid(`dialogue:${workspaceId}:${dialogue.id}`),
        sceneId: scene.id,
      })),
    );
    await transaction.localizedDialogue.createMany({
      data: dialogues.map(({ dialogue, id, sceneId }) => ({
        createdByUserId: context.userId,
        dialogueSegmentId: dialogue.id,
        endTimeUs: dialogue.endTimeUs,
        id,
        organizationId: context.organizationId,
        projectId,
        sceneId,
        sequenceNumber: dialogue.sequenceNumber,
        speechAnalysisId,
        startTimeUs: dialogue.startTimeUs,
        workspaceId,
      })),
    });
    await transaction.sourceDialogueRevision.createMany({
      data: dialogues.map(({ dialogue, id }) => ({
        createdByUserId: context.userId,
        id: deterministicLocalizationUuid(`source-revision:${id}:1`),
        localizedDialogueId: id,
        organizationId: context.organizationId,
        projectId,
        revisionNumber: 1,
        sourceText: dialogue.text,
        workspaceId,
      })),
    });
    await transaction.sourceDialogueSelection.createMany({
      data: dialogues.map(({ id }) => ({
        localizedDialogueId: id,
        organizationId: context.organizationId,
        projectId,
        revision: 1,
        selectedRevisionId: deterministicLocalizationUuid(`source-revision:${id}:1`),
        updatedByUserId: context.userId,
        workspaceId,
      })),
    });
  }

  private async findIdempotentTrack(
    context: AccessContext,
    projectId: string,
    jobId: string,
    targetLanguageId: string,
  ) {
    const track = await this.database.client.localizationTrack.findFirst({
      select: trackScopeSelect,
      where: {
        organizationId: context.organizationId,
        projectId,
        targetLanguageId,
        workspace: { speechAnalysis: { workflowJobId: jobId } },
      },
    });
    return track ? this.toTrackResponse(track) : null;
  }

  async updateScene(
    context: AccessContext,
    projectId: string,
    trackId: string,
    sceneId: string,
    input: UpdateSceneRevisionDto,
  ) {
    this.assertCanEdit(context);
    this.assertUuid(sceneId, 'scene');
    return this.database.client
      .$transaction(
        async (transaction) => {
          const track = await this.ownedTrack(context, projectId, trackId, transaction);
          const scene = await transaction.localizationScene.findFirst({
            select: {
              id: true,
              selection: {
                select: {
                  revision: true,
                  selectedRevision: {
                    select: {
                      culturalContext: true,
                      endTimeUs: true,
                      id: true,
                      revisionNumber: true,
                      startTimeUs: true,
                      summary: true,
                      title: true,
                    },
                  },
                },
              },
            },
            where: {
              id: sceneId,
              organizationId: context.organizationId,
              projectId,
              workspaceId: track.workspaceId,
            },
          });
          if (!scene?.selection) throw new NotFoundException('Localization scene not found.');
          this.assertExpectedRevision(scene.selection.revision, input.expectedRevision);
          const current = scene.selection.selectedRevision;
          const hasTitle = Object.prototype.hasOwnProperty.call(input, 'title');
          const hasNarrative = Object.prototype.hasOwnProperty.call(input, 'narrative');
          const hasCulturalNotes = Object.prototype.hasOwnProperty.call(input, 'culturalNotes');
          if (!hasTitle && !hasNarrative && !hasCulturalNotes) {
            throw new BadRequestException('At least one scene field must be supplied.');
          }
          const title = hasTitle ? normalizeOptionalEditorialText(input.title) : current.title;
          const summary = hasNarrative
            ? normalizeOptionalEditorialText(input.narrative)
            : current.summary;
          const culturalContext = hasCulturalNotes
            ? normalizeOptionalEditorialText(input.culturalNotes)
            : current.culturalContext;
          if (
            title === current.title &&
            summary === current.summary &&
            culturalContext === current.culturalContext
          ) {
            throw new BadRequestException('The scene edit does not change the active revision.');
          }

          const revisionNumber = await this.nextSceneRevisionNumber(transaction, sceneId);
          const revision = await transaction.localizationSceneRevision.create({
            data: {
              createdByUserId: context.userId,
              culturalContext,
              endTimeUs: current.endTimeUs,
              id: uuidv7(),
              organizationId: context.organizationId,
              projectId,
              revisionNumber,
              sceneId,
              startTimeUs: current.startTimeUs,
              summary,
              title,
              workspaceId: track.workspaceId,
            },
          });
          await this.casSceneSelection(
            transaction,
            context,
            projectId,
            track.workspaceId,
            sceneId,
            revision.id,
            input.expectedRevision,
          );
          await this.audit(
            transaction,
            context,
            'localization.scene.revision.created',
            'localization_scene',
            sceneId,
            {
              revisionId: revision.id,
              revisionNumber,
              sceneId,
              selectionRevision: input.expectedRevision + 1,
              trackId,
            },
          );
          return this.toSceneRevisionResponse(revision, input.expectedRevision + 1);
        },
        { isolationLevel: 'Serializable' },
      )
      .catch((error) => this.rethrowWriteConflict(error));
  }

  async listSceneRevisions(
    context: AccessContext,
    projectId: string,
    trackId: string,
    sceneId: string,
    query: ListLocalizationHistoryQueryDto,
  ) {
    this.assertUuid(sceneId, 'scene');
    const track = await this.ownedTrack(context, projectId, trackId);
    const scene = await this.database.client.localizationScene.findFirst({
      select: { id: true, selection: { select: { revision: true, selectedRevisionId: true } } },
      where: {
        id: sceneId,
        organizationId: context.organizationId,
        projectId,
        workspaceId: track.workspaceId,
      },
    });
    if (!scene?.selection) throw new NotFoundException('Localization scene not found.');
    const cursor = query.cursor ? this.decodeHistoryCursor(query.cursor, sceneId) : undefined;
    const rows = await this.database.client.localizationSceneRevision.findMany({
      orderBy: [{ revisionNumber: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      where: {
        organizationId: context.organizationId,
        projectId,
        sceneId,
        workspaceId: track.workspaceId,
        ...this.historyWhere(cursor),
      },
    });
    return this.historyResponse(rows, query.limit, scene.selection, (row) =>
      this.toSceneRevisionResponse(row),
    );
  }

  async selectSceneRevision(
    context: AccessContext,
    projectId: string,
    trackId: string,
    sceneId: string,
    input: SelectLocalizationRevisionDto,
  ) {
    this.assertCanEdit(context);
    this.assertUuid(sceneId, 'scene');
    this.assertUuid(input.revisionId, 'scene revision');
    return this.database.client
      .$transaction(
        async (transaction) => {
          const track = await this.ownedTrack(context, projectId, trackId, transaction);
          const revision = await transaction.localizationSceneRevision.findFirst({
            where: {
              id: input.revisionId,
              organizationId: context.organizationId,
              projectId,
              sceneId,
              workspaceId: track.workspaceId,
            },
          });
          if (!revision) throw new NotFoundException('Scene revision not found.');
          const selection = await transaction.localizationSceneSelection.findFirst({
            where: {
              organizationId: context.organizationId,
              projectId,
              sceneId,
              workspaceId: track.workspaceId,
            },
          });
          if (!selection) throw new NotFoundException('Localization scene not found.');
          this.assertExpectedRevision(selection.revision, input.expectedRevision);
          if (selection.selectedRevisionId === revision.id) {
            throw new BadRequestException('This scene revision is already active.');
          }
          await this.casSceneSelection(
            transaction,
            context,
            projectId,
            track.workspaceId,
            sceneId,
            revision.id,
            input.expectedRevision,
          );
          await this.audit(
            transaction,
            context,
            'localization.scene.selection.changed',
            'localization_scene',
            sceneId,
            {
              revisionId: revision.id,
              revisionNumber: revision.revisionNumber,
              sceneId,
              selectionRevision: input.expectedRevision + 1,
              trackId,
            },
          );
          return this.toSceneRevisionResponse(revision, input.expectedRevision + 1);
        },
        { isolationLevel: 'Serializable' },
      )
      .catch((error) => this.rethrowWriteConflict(error));
  }

  async updateSourceDialogue(
    context: AccessContext,
    projectId: string,
    trackId: string,
    dialogueId: string,
    input: UpdateSourceDialogueRevisionDto,
  ) {
    this.assertCanEdit(context);
    this.assertUuid(dialogueId, 'dialogue');
    let sourceText: string;
    try {
      sourceText = normalizeRequiredEditorialText(input.sourceText, 'Source text');
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Source text is invalid.',
      );
    }
    return this.database.client
      .$transaction(
        async (transaction) => {
          const track = await this.ownedTrack(context, projectId, trackId, transaction);
          const dialogue = await this.ownedDialogue(
            transaction,
            context,
            projectId,
            track,
            dialogueId,
          );
          if (!dialogue.sourceSelection) {
            throw new NotFoundException('Dialogue source selection not found.');
          }
          this.assertExpectedRevision(dialogue.sourceSelection.revision, input.expectedRevision);
          if (dialogue.sourceSelection.selectedRevision.sourceText === sourceText) {
            throw new BadRequestException('The source edit does not change the active revision.');
          }
          const revisionNumber = await this.nextSourceRevisionNumber(transaction, dialogueId);
          const revision = await transaction.sourceDialogueRevision.create({
            data: {
              createdByUserId: context.userId,
              id: uuidv7(),
              localizedDialogueId: dialogueId,
              organizationId: context.organizationId,
              projectId,
              revisionNumber,
              sourceText,
              workspaceId: track.workspaceId,
            },
          });
          await this.casSourceSelection(
            transaction,
            context,
            projectId,
            track.workspaceId,
            dialogueId,
            revision.id,
            input.expectedRevision,
          );
          await this.reopenTranslationsAfterSourceChange(
            transaction,
            context,
            projectId,
            track.workspaceId,
            dialogueId,
          );
          await this.audit(
            transaction,
            context,
            'localization.dialogue.source_revision.created',
            'localized_dialogue',
            dialogueId,
            {
              dialogueId,
              revisionId: revision.id,
              revisionNumber,
              selectionRevision: input.expectedRevision + 1,
              trackId,
            },
          );
          return this.toSourceRevisionResponse(revision, input.expectedRevision + 1);
        },
        { isolationLevel: 'Serializable' },
      )
      .catch((error) => this.rethrowWriteConflict(error));
  }

  async listSourceRevisions(
    context: AccessContext,
    projectId: string,
    trackId: string,
    dialogueId: string,
    query: ListLocalizationHistoryQueryDto,
  ) {
    this.assertUuid(dialogueId, 'dialogue');
    const track = await this.ownedTrack(context, projectId, trackId);
    const dialogue = await this.ownedDialogue(
      this.database.client,
      context,
      projectId,
      track,
      dialogueId,
    );
    if (!dialogue.sourceSelection) throw new NotFoundException('Dialogue source not found.');
    const cursor = query.cursor ? this.decodeHistoryCursor(query.cursor, dialogueId) : undefined;
    const rows = await this.database.client.sourceDialogueRevision.findMany({
      orderBy: [{ revisionNumber: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      where: {
        localizedDialogueId: dialogueId,
        organizationId: context.organizationId,
        projectId,
        workspaceId: track.workspaceId,
        ...this.historyWhere(cursor),
      },
    });
    return this.historyResponse(rows, query.limit, dialogue.sourceSelection, (row) =>
      this.toSourceRevisionResponse(row),
    );
  }

  async selectSourceRevision(
    context: AccessContext,
    projectId: string,
    trackId: string,
    dialogueId: string,
    input: SelectLocalizationRevisionDto,
  ) {
    this.assertCanEdit(context);
    this.assertUuid(dialogueId, 'dialogue');
    this.assertUuid(input.revisionId, 'source revision');
    return this.database.client
      .$transaction(
        async (transaction) => {
          const track = await this.ownedTrack(context, projectId, trackId, transaction);
          const dialogue = await this.ownedDialogue(
            transaction,
            context,
            projectId,
            track,
            dialogueId,
          );
          if (!dialogue.sourceSelection) throw new NotFoundException('Dialogue source not found.');
          const revision = await transaction.sourceDialogueRevision.findFirst({
            where: {
              id: input.revisionId,
              localizedDialogueId: dialogueId,
              organizationId: context.organizationId,
              projectId,
              workspaceId: track.workspaceId,
            },
          });
          if (!revision) throw new NotFoundException('Source revision not found.');
          this.assertExpectedRevision(dialogue.sourceSelection.revision, input.expectedRevision);
          if (dialogue.sourceSelection.selectedRevisionId === revision.id) {
            throw new BadRequestException('This source revision is already active.');
          }
          await this.casSourceSelection(
            transaction,
            context,
            projectId,
            track.workspaceId,
            dialogueId,
            revision.id,
            input.expectedRevision,
          );
          await this.reopenTranslationsAfterSourceChange(
            transaction,
            context,
            projectId,
            track.workspaceId,
            dialogueId,
          );
          await this.audit(
            transaction,
            context,
            'localization.dialogue.source_selection.changed',
            'localized_dialogue',
            dialogueId,
            {
              dialogueId,
              revisionId: revision.id,
              revisionNumber: revision.revisionNumber,
              selectionRevision: input.expectedRevision + 1,
              trackId,
            },
          );
          return this.toSourceRevisionResponse(revision, input.expectedRevision + 1);
        },
        { isolationLevel: 'Serializable' },
      )
      .catch((error) => this.rethrowWriteConflict(error));
  }

  async updateTranslation(
    context: AccessContext,
    projectId: string,
    trackId: string,
    dialogueId: string,
    input: UpdateTranslationRevisionDto,
  ) {
    this.assertCanEdit(context);
    this.assertUuid(dialogueId, 'dialogue');
    let translatedText: string;
    try {
      translatedText = normalizeRequiredEditorialText(input.targetText, 'Target text');
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Target text is invalid.',
      );
    }

    return this.database.client
      .$transaction(
        async (transaction) => {
          const track = await this.ownedTrack(context, projectId, trackId, transaction);
          const dialogue = await this.ownedDialogue(
            transaction,
            context,
            projectId,
            track,
            dialogueId,
          );
          if (!dialogue.sourceSelection) throw new NotFoundException('Dialogue source not found.');
          let translation = await transaction.dialogueTranslation.findUnique({
            select: {
              id: true,
              selection: {
                select: {
                  editorState: true,
                  revision: true,
                  selectedRevision: { select: { id: true, translatedText: true } },
                  selectedRevisionId: true,
                },
              },
            },
            where: { trackId_localizedDialogueId: { localizedDialogueId: dialogueId, trackId } },
          });
          const currentSelectionRevision = translation?.selection?.revision ?? 0;
          this.assertExpectedRevision(currentSelectionRevision, input.expectedRevision);
          if (translation?.selection?.selectedRevision.translatedText === translatedText) {
            throw new BadRequestException(
              'The translation edit does not change the active revision.',
            );
          }
          if (!translation) {
            translation = await transaction.dialogueTranslation.create({
              data: {
                createdByUserId: context.userId,
                id: deterministicLocalizationUuid(`translation:${trackId}:${dialogueId}`),
                localizedDialogueId: dialogueId,
                organizationId: context.organizationId,
                projectId,
                trackId,
                workspaceId: track.workspaceId,
              },
              select: {
                id: true,
                selection: {
                  select: {
                    editorState: true,
                    revision: true,
                    selectedRevision: { select: { id: true, translatedText: true } },
                    selectedRevisionId: true,
                  },
                },
              },
            });
          }
          const revisionNumber = await this.nextTranslationRevisionNumber(
            transaction,
            translation.id,
          );
          const revision = await transaction.translationRevision.create({
            data: {
              createdByUserId: context.userId,
              dialogueTranslationId: translation.id,
              id: uuidv7(),
              localizedDialogueId: dialogueId,
              organizationId: context.organizationId,
              projectId,
              revisionNumber,
              sourceDialogueRevisionId: dialogue.sourceSelection.selectedRevision.id,
              trackId,
              translatedText,
              workspaceId: track.workspaceId,
            },
          });
          const selectionRevision = input.expectedRevision + 1;
          if (input.expectedRevision === 0) {
            await transaction.translationSelection.create({
              data: {
                dialogueTranslationId: translation.id,
                editorState: TranslationEditorState.DRAFT,
                organizationId: context.organizationId,
                projectId,
                revision: 1,
                selectedRevisionId: revision.id,
                trackId,
                updatedByUserId: context.userId,
                workspaceId: track.workspaceId,
              },
            });
          } else {
            const updated = await transaction.translationSelection.updateMany({
              data: {
                editorState: TranslationEditorState.DRAFT,
                revision: { increment: 1 },
                selectedAt: new Date(),
                selectedRevisionId: revision.id,
                updatedByUserId: context.userId,
              },
              where: {
                dialogueTranslationId: translation.id,
                organizationId: context.organizationId,
                projectId,
                revision: input.expectedRevision,
                trackId,
              },
            });
            if (updated.count !== 1) throw this.selectionConflict();
          }
          await this.audit(
            transaction,
            context,
            'localization.dialogue.translation_revision.created',
            'dialogue_translation',
            translation.id,
            {
              dialogueId,
              revisionId: revision.id,
              revisionNumber,
              selectionRevision,
              trackId,
              translationId: translation.id,
            },
          );
          return this.toTranslationRevisionResponse(
            revision,
            TranslationEditorState.DRAFT,
            selectionRevision,
          );
        },
        { isolationLevel: 'Serializable' },
      )
      .catch((error) => this.rethrowWriteConflict(error));
  }

  async updateTranslationState(
    context: AccessContext,
    projectId: string,
    trackId: string,
    dialogueId: string,
    input: UpdateTranslationStateDto,
  ) {
    this.assertCanEdit(context);
    this.assertUuid(dialogueId, 'dialogue');
    return this.database.client
      .$transaction(
        async (transaction) => {
          const track = await this.ownedTrack(context, projectId, trackId, transaction);
          const dialogue = await this.ownedDialogue(
            transaction,
            context,
            projectId,
            track,
            dialogueId,
          );
          const translation = await transaction.dialogueTranslation.findUnique({
            select: {
              id: true,
              selection: {
                select: {
                  editorState: true,
                  revision: true,
                  selectedRevision: true,
                  selectedRevisionId: true,
                },
              },
            },
            where: { trackId_localizedDialogueId: { localizedDialogueId: dialogueId, trackId } },
          });
          if (!translation?.selection) {
            throw new NotFoundException('Dialogue translation not found.');
          }
          this.assertExpectedRevision(translation.selection.revision, input.expectedRevision);
          this.assertEditorStateTransition(translation.selection.editorState, input.state);
          if (
            input.state !== TranslationEditorState.DRAFT &&
            translation.selection.selectedRevision.sourceDialogueRevisionId !==
              dialogue.sourceSelection?.selectedRevisionId
          ) {
            throw new ConflictException(
              'The active source changed. Edit or regenerate this translation before review.',
            );
          }
          const updated = await transaction.translationSelection.updateMany({
            data: {
              editorState: input.state,
              revision: { increment: 1 },
              updatedByUserId: context.userId,
            },
            where: {
              dialogueTranslationId: translation.id,
              organizationId: context.organizationId,
              projectId,
              revision: input.expectedRevision,
              trackId,
            },
          });
          if (updated.count !== 1) throw this.selectionConflict();
          const selectedRevision = translation.selection.selectedRevision;
          await this.audit(
            transaction,
            context,
            `localization.dialogue.translation_state.${translation.selection.editorState.toLowerCase()}_to_${input.state.toLowerCase()}`,
            'dialogue_translation',
            translation.id,
            {
              dialogueId,
              revisionId: selectedRevision.id,
              revisionNumber: selectedRevision.revisionNumber,
              selectionRevision: input.expectedRevision + 1,
              trackId,
              translationId: translation.id,
            },
          );
          return this.toTranslationRevisionResponse(
            selectedRevision,
            input.state,
            input.expectedRevision + 1,
          );
        },
        { isolationLevel: 'Serializable' },
      )
      .catch((error) => this.rethrowWriteConflict(error));
  }

  async listTranslationRevisions(
    context: AccessContext,
    projectId: string,
    trackId: string,
    dialogueId: string,
    query: ListLocalizationHistoryQueryDto,
  ) {
    this.assertUuid(dialogueId, 'dialogue');
    const track = await this.ownedTrack(context, projectId, trackId);
    await this.ownedDialogue(this.database.client, context, projectId, track, dialogueId);
    const translation = await this.database.client.dialogueTranslation.findUnique({
      select: {
        id: true,
        selection: {
          select: { editorState: true, revision: true, selectedRevisionId: true },
        },
      },
      where: { trackId_localizedDialogueId: { localizedDialogueId: dialogueId, trackId } },
    });
    if (!translation)
      return { data: [], nextCursor: null, selectedRevisionId: null, selectionRevision: 0 };
    const cursor = query.cursor
      ? this.decodeHistoryCursor(query.cursor, translation.id)
      : undefined;
    const rows = await this.database.client.translationRevision.findMany({
      orderBy: [{ revisionNumber: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      where: {
        dialogueTranslationId: translation.id,
        localizedDialogueId: dialogueId,
        organizationId: context.organizationId,
        projectId,
        trackId,
        workspaceId: track.workspaceId,
        ...this.historyWhere(cursor),
      },
    });
    return this.historyResponse(
      rows,
      query.limit,
      translation.selection ?? { revision: 0, selectedRevisionId: null },
      (row) =>
        this.toTranslationRevisionResponse(
          row,
          translation.selection?.editorState ?? TranslationEditorState.DRAFT,
        ),
    );
  }

  async selectTranslationRevision(
    context: AccessContext,
    projectId: string,
    trackId: string,
    dialogueId: string,
    input: SelectLocalizationRevisionDto,
  ) {
    this.assertCanEdit(context);
    this.assertUuid(dialogueId, 'dialogue');
    this.assertUuid(input.revisionId, 'translation revision');
    return this.database.client
      .$transaction(
        async (transaction) => {
          const track = await this.ownedTrack(context, projectId, trackId, transaction);
          await this.ownedDialogue(transaction, context, projectId, track, dialogueId);
          const translation = await transaction.dialogueTranslation.findUnique({
            select: {
              id: true,
              selection: {
                select: {
                  editorState: true,
                  revision: true,
                  selectedRevisionId: true,
                },
              },
            },
            where: { trackId_localizedDialogueId: { localizedDialogueId: dialogueId, trackId } },
          });
          if (!translation?.selection)
            throw new NotFoundException('Dialogue translation not found.');
          const revision = await transaction.translationRevision.findFirst({
            where: {
              dialogueTranslationId: translation.id,
              id: input.revisionId,
              localizedDialogueId: dialogueId,
              organizationId: context.organizationId,
              projectId,
              trackId,
              workspaceId: track.workspaceId,
            },
          });
          if (!revision) throw new NotFoundException('Translation revision not found.');
          this.assertExpectedRevision(translation.selection.revision, input.expectedRevision);
          if (translation.selection.selectedRevisionId === revision.id) {
            throw new BadRequestException('This translation revision is already active.');
          }
          const updated = await transaction.translationSelection.updateMany({
            data: {
              editorState: TranslationEditorState.DRAFT,
              revision: { increment: 1 },
              selectedAt: new Date(),
              selectedRevisionId: revision.id,
              updatedByUserId: context.userId,
            },
            where: {
              dialogueTranslationId: translation.id,
              organizationId: context.organizationId,
              projectId,
              revision: input.expectedRevision,
              trackId,
            },
          });
          if (updated.count !== 1) throw this.selectionConflict();
          await this.audit(
            transaction,
            context,
            'localization.dialogue.translation_selection.changed',
            'dialogue_translation',
            translation.id,
            {
              dialogueId,
              revisionId: revision.id,
              revisionNumber: revision.revisionNumber,
              selectionRevision: input.expectedRevision + 1,
              trackId,
              translationId: translation.id,
            },
          );
          return this.toTranslationRevisionResponse(
            revision,
            TranslationEditorState.DRAFT,
            input.expectedRevision + 1,
          );
        },
        { isolationLevel: 'Serializable' },
      )
      .catch((error) => this.rethrowWriteConflict(error));
  }

  async listGlossary(context: AccessContext, projectId: string, trackId: string) {
    const track = await this.ownedTrack(context, projectId, trackId);
    const entries = await this.database.client.glossaryEntry.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        selection: {
          select: {
            revision: true,
            selectedRevision: true,
          },
        },
      },
      take: 201,
      where: {
        organizationId: context.organizationId,
        projectId,
        trackId,
        workspaceId: track.workspaceId,
      },
    });
    if (entries.length > 200) {
      throw new ConflictException('A localization track is limited to 200 glossary entries.');
    }
    return {
      data: entries
        .filter(
          (entry): entry is typeof entry & { selection: NonNullable<typeof entry.selection> } =>
            entry.selection !== null,
        )
        .map((entry) =>
          this.toGlossaryRevisionResponse(
            entry.selection.selectedRevision,
            entry.selection.revision,
          ),
        )
        .sort(
          (left, right) =>
            left.sourceTerm.localeCompare(right.sourceTerm) ||
            left.entryId.localeCompare(right.entryId),
        ),
      trackId,
    };
  }

  async createGlossaryEntry(
    context: AccessContext,
    projectId: string,
    trackId: string,
    input: CreateGlossaryEntryDto,
  ) {
    this.assertCanEdit(context);
    const normalized = this.normalizeGlossaryInput(input);
    return this.database.client
      .$transaction(
        async (transaction) => {
          const track = await this.ownedTrack(context, projectId, trackId, transaction);
          const entryCount = await transaction.glossaryEntry.count({
            where: {
              organizationId: context.organizationId,
              projectId,
              trackId,
              workspaceId: track.workspaceId,
            },
          });
          if (entryCount >= 200) {
            throw new ConflictException('A localization track is limited to 200 glossary entries.');
          }
          const entryId = uuidv7();
          const revisionId = uuidv7();
          await transaction.glossaryEntry.create({
            data: {
              createdByUserId: context.userId,
              id: entryId,
              organizationId: context.organizationId,
              projectId,
              trackId,
              workspaceId: track.workspaceId,
            },
          });
          const revision = await transaction.glossaryRevision.create({
            data: {
              ...normalized,
              createdByUserId: context.userId,
              glossaryEntryId: entryId,
              id: revisionId,
              organizationId: context.organizationId,
              projectId,
              revisionNumber: 1,
              trackId,
              workspaceId: track.workspaceId,
            },
          });
          await transaction.glossarySelection.create({
            data: {
              glossaryEntryId: entryId,
              organizationId: context.organizationId,
              projectId,
              revision: 1,
              selectedCaseSensitive: normalized.caseSensitive,
              selectedNormalizedSourceTerm: normalized.normalizedSourceTerm,
              selectedRevisionId: revisionId,
              trackId,
              updatedByUserId: context.userId,
              workspaceId: track.workspaceId,
            },
          });
          await this.audit(
            transaction,
            context,
            'localization.glossary.revision.created',
            'glossary_entry',
            entryId,
            {
              entryId,
              revisionId,
              revisionNumber: 1,
              selectionRevision: 1,
              trackId,
            },
          );
          return this.toGlossaryRevisionResponse(revision, 1);
        },
        { isolationLevel: 'Serializable' },
      )
      .catch((error) => this.rethrowGlossaryWriteError(error));
  }

  async updateGlossaryEntry(
    context: AccessContext,
    projectId: string,
    trackId: string,
    entryId: string,
    input: UpdateGlossaryRevisionDto,
  ) {
    this.assertCanEdit(context);
    this.assertUuid(entryId, 'glossary entry');
    const normalized = this.normalizeGlossaryInput(input);
    return this.database.client
      .$transaction(
        async (transaction) => {
          const track = await this.ownedTrack(context, projectId, trackId, transaction);
          const entry = await this.ownedGlossaryEntry(
            transaction,
            context,
            projectId,
            track,
            entryId,
          );
          if (!entry.selection) throw new NotFoundException('Glossary entry not found.');
          this.assertExpectedRevision(entry.selection.revision, input.expectedRevision);
          const active = entry.selection.selectedRevision;
          if (
            active.sourceTerm === normalized.sourceTerm &&
            active.targetTerm === normalized.targetTerm &&
            active.notes === normalized.notes &&
            active.caseSensitive === normalized.caseSensitive &&
            active.doNotTranslate === normalized.doNotTranslate
          ) {
            throw new BadRequestException('The glossary edit does not change the active revision.');
          }
          const revisionNumber = await this.nextGlossaryRevisionNumber(transaction, entryId);
          const revision = await transaction.glossaryRevision.create({
            data: {
              ...normalized,
              createdByUserId: context.userId,
              glossaryEntryId: entryId,
              id: uuidv7(),
              organizationId: context.organizationId,
              projectId,
              revisionNumber,
              trackId,
              workspaceId: track.workspaceId,
            },
          });
          await this.casGlossarySelection(
            transaction,
            context,
            projectId,
            track,
            entryId,
            revision,
            input.expectedRevision,
          );
          await this.audit(
            transaction,
            context,
            'localization.glossary.revision.created',
            'glossary_entry',
            entryId,
            {
              entryId,
              revisionId: revision.id,
              revisionNumber,
              selectionRevision: input.expectedRevision + 1,
              trackId,
            },
          );
          return this.toGlossaryRevisionResponse(revision, input.expectedRevision + 1);
        },
        { isolationLevel: 'Serializable' },
      )
      .catch((error) => this.rethrowGlossaryWriteError(error));
  }

  async listGlossaryRevisions(
    context: AccessContext,
    projectId: string,
    trackId: string,
    entryId: string,
    query: ListLocalizationHistoryQueryDto,
  ) {
    this.assertUuid(entryId, 'glossary entry');
    const track = await this.ownedTrack(context, projectId, trackId);
    const entry = await this.ownedGlossaryEntry(
      this.database.client,
      context,
      projectId,
      track,
      entryId,
    );
    if (!entry.selection) throw new NotFoundException('Glossary entry not found.');
    const cursor = query.cursor ? this.decodeHistoryCursor(query.cursor, entryId) : undefined;
    const rows = await this.database.client.glossaryRevision.findMany({
      orderBy: [{ revisionNumber: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      where: {
        glossaryEntryId: entryId,
        organizationId: context.organizationId,
        projectId,
        trackId,
        workspaceId: track.workspaceId,
        ...this.historyWhere(cursor),
      },
    });
    return this.historyResponse(rows, query.limit, entry.selection, (row) =>
      this.toGlossaryRevisionResponse(row),
    );
  }

  async selectGlossaryRevision(
    context: AccessContext,
    projectId: string,
    trackId: string,
    entryId: string,
    input: SelectLocalizationRevisionDto,
  ) {
    this.assertCanEdit(context);
    this.assertUuid(entryId, 'glossary entry');
    this.assertUuid(input.revisionId, 'glossary revision');
    return this.database.client
      .$transaction(
        async (transaction) => {
          const track = await this.ownedTrack(context, projectId, trackId, transaction);
          const entry = await this.ownedGlossaryEntry(
            transaction,
            context,
            projectId,
            track,
            entryId,
          );
          if (!entry.selection) throw new NotFoundException('Glossary entry not found.');
          const revision = await transaction.glossaryRevision.findFirst({
            where: {
              glossaryEntryId: entryId,
              id: input.revisionId,
              organizationId: context.organizationId,
              projectId,
              trackId,
              workspaceId: track.workspaceId,
            },
          });
          if (!revision) throw new NotFoundException('Glossary revision not found.');
          this.assertExpectedRevision(entry.selection.revision, input.expectedRevision);
          if (entry.selection.selectedRevisionId === revision.id) {
            throw new BadRequestException('This glossary revision is already active.');
          }
          await this.casGlossarySelection(
            transaction,
            context,
            projectId,
            track,
            entryId,
            revision,
            input.expectedRevision,
          );
          await this.audit(
            transaction,
            context,
            'localization.glossary.selection.changed',
            'glossary_entry',
            entryId,
            {
              entryId,
              revisionId: revision.id,
              revisionNumber: revision.revisionNumber,
              selectionRevision: input.expectedRevision + 1,
              trackId,
            },
          );
          return this.toGlossaryRevisionResponse(revision, input.expectedRevision + 1);
        },
        { isolationLevel: 'Serializable' },
      )
      .catch((error) => this.rethrowGlossaryWriteError(error));
  }

  async createGeneration(
    context: AccessContext,
    projectId: string,
    trackId: string,
    idempotencyKey: string,
    input: GenerateSceneTranslationDto,
  ) {
    this.assertCanEdit(context);
    this.assertUuid(input.sceneId, 'scene');
    if (!idempotencyPattern.test(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key must be 8-128 safe ASCII characters.');
    }
    const track = await this.ownedTrack(context, projectId, trackId);
    const existing = await this.database.client.translationGeneration.findUnique({
      where: { trackId_idempotencyKey: { idempotencyKey, trackId } },
    });
    if (existing) {
      this.assertGenerationRequestMatches(existing.sceneId, input.sceneId);
      return this.toGenerationResponse(existing);
    }
    if (!this.config.get('TRANSLATION_ENABLED', { infer: true })) {
      throw new ConflictException('Translation generation is disabled.');
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.database.client.$transaction(
          (transaction) =>
            this.createGenerationTransaction(
              transaction,
              context,
              projectId,
              track,
              idempotencyKey,
              input.sceneId,
            ),
          { isolationLevel: 'Serializable' },
        );
      } catch (error) {
        if (this.isRetryableTransactionError(error) && attempt < 3) continue;
        if (this.isUniqueConstraintViolation(error)) {
          const winner = await this.database.client.translationGeneration.findUnique({
            where: { trackId_idempotencyKey: { idempotencyKey, trackId } },
          });
          if (winner) {
            this.assertGenerationRequestMatches(winner.sceneId, input.sceneId);
            return this.toGenerationResponse(winner);
          }
          if (attempt < 3) continue;
        }
        throw error;
      }
    }
    throw new ConflictException('The translation request changed concurrently.');
  }

  async getGeneration(
    context: AccessContext,
    projectId: string,
    trackId: string,
    generationId: string,
  ) {
    this.assertUuid(generationId, 'generation');
    const track = await this.ownedTrack(context, projectId, trackId);
    const generation = await this.database.client.translationGeneration.findFirst({
      where: {
        id: generationId,
        organizationId: context.organizationId,
        projectId,
        trackId,
        workspaceId: track.workspaceId,
      },
    });
    if (!generation) throw new NotFoundException('Translation generation not found.');
    return this.toGenerationResponse(generation);
  }

  private async createGenerationTransaction(
    transaction: Transaction,
    context: AccessContext,
    projectId: string,
    knownTrack: TrackScope,
    idempotencyKey: string,
    sceneId: string,
  ) {
    const existing = await transaction.translationGeneration.findUnique({
      where: { trackId_idempotencyKey: { idempotencyKey, trackId: knownTrack.id } },
    });
    if (existing) {
      this.assertGenerationRequestMatches(existing.sceneId, sceneId);
      return this.toGenerationResponse(existing);
    }
    const track = await this.ownedTrack(context, projectId, knownTrack.id, transaction);
    const scene = await transaction.localizationScene.findFirst({
      select: {
        id: true,
        selection: {
          select: {
            selectedRevision: {
              select: {
                culturalContext: true,
                id: true,
                summary: true,
                title: true,
              },
            },
          },
        },
        dialogues: {
          orderBy: [{ sequenceNumber: 'asc' }, { id: 'asc' }],
          select: {
            dialogueSegment: {
              select: {
                speakerAssignment: {
                  select: {
                    character: { select: { displayName: true, id: true, stableKey: true } },
                  },
                },
              },
            },
            endTimeUs: true,
            id: true,
            sequenceNumber: true,
            sourceSelection: {
              select: {
                selectedRevision: { select: { id: true, sourceText: true } },
              },
            },
            startTimeUs: true,
            translations: {
              select: {
                id: true,
                selection: { select: { revision: true, selectedRevisionId: true } },
              },
              take: 1,
              where: { trackId: track.id },
            },
          },
          take: 201,
        },
      },
      where: {
        id: sceneId,
        organizationId: context.organizationId,
        projectId,
        workspaceId: track.workspaceId,
      },
    });
    if (!scene?.selection) throw new NotFoundException('Localization scene not found.');
    if (scene.dialogues.length === 0) {
      throw new ConflictException('A scene without dialogue cannot be translated.');
    }
    if (scene.dialogues.length > 200) {
      throw new ConflictException('A translation generation is limited to 200 dialogues.');
    }
    if (scene.dialogues.some((dialogue) => !dialogue.sourceSelection)) {
      throw new ConflictException('Every dialogue must have an active source revision.');
    }
    if (
      scene.dialogues.some((dialogue) => {
        const sourceText = dialogue.sourceSelection!.selectedRevision.sourceText;
        return (
          Array.from(sourceText).length > 20_000 || Buffer.byteLength(sourceText, 'utf8') > 65_536
        );
      })
    ) {
      throw new ConflictException(
        'A selected source dialogue exceeds the translation executor limit.',
      );
    }
    const glossary = await transaction.glossaryEntry.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        selection: {
          select: {
            selectedNormalizedSourceTerm: true,
            selectedRevision: {
              select: {
                caseSensitive: true,
                doNotTranslate: true,
                id: true,
                notes: true,
                sourceTerm: true,
                targetTerm: true,
              },
            },
          },
        },
      },
      where: {
        organizationId: context.organizationId,
        projectId,
        selection: { isNot: null },
        trackId: track.id,
        workspaceId: track.workspaceId,
      },
      take: 201,
    });
    if (glossary.length > 200) {
      throw new ConflictException('A translation generation is limited to 200 glossary entries.');
    }
    const selectedGlossary = glossary
      .flatMap((entry) => {
        if (!entry.selection) return [];
        return [
          {
            entryId: entry.id,
            normalizedSourceTerm: entry.selection.selectedNormalizedSourceTerm,
            revision: entry.selection.selectedRevision,
          },
        ];
      })
      .sort(
        (left, right) =>
          this.compareStableStrings(left.normalizedSourceTerm, right.normalizedSourceTerm) ||
          this.compareStableStrings(left.entryId, right.entryId),
      );

    const expectedModel = {
      modelId: this.config.get('TRANSLATION_MODEL_ID', { infer: true }),
      modelRevision: this.config.get('TRANSLATION_MODEL_REVISION', { infer: true }),
      provider: this.config.get('TRANSLATION_PROVIDER_NAME', { infer: true }),
      runtimeVersion: this.config.get('TRANSLATION_RUNTIME_VERSION', { infer: true }),
    };
    const promptVersion = this.config.get('TRANSLATION_PROMPT_VERSION', { infer: true });
    const configurationSnapshot = {
      expectedModel,
      promptVersion,
      schemaVersion: 'voiceverse.translation-configuration.v1',
    } satisfies CanonicalJson;
    const inputSnapshot = {
      dialogues: scene.dialogues.map((dialogue, ordinal) => {
        const source = dialogue.sourceSelection!.selectedRevision;
        const character = dialogue.dialogueSegment.speakerAssignment?.character;
        const translation = dialogue.translations[0];
        return {
          character: character
            ? {
                characterId: character.id,
                name: character.displayName ?? character.stableKey,
              }
            : null,
          dialogueId: dialogue.id,
          endUs: this.safeMicroseconds(dialogue.endTimeUs),
          ordinal,
          sourceRevisionId: source.id,
          sourceText: source.sourceText,
          startUs: this.safeMicroseconds(dialogue.startTimeUs),
          translationId: translation?.id ?? null,
          translationRevisionId: translation?.selection?.selectedRevisionId ?? null,
          translationSelectionRevision: translation?.selection?.revision ?? null,
        };
      }),
      glossaryRevisions: selectedGlossary.map(({ revision }) => ({
        caseSensitive: revision.caseSensitive,
        doNotTranslate: revision.doNotTranslate,
        glossaryRevisionId: revision.id,
        notes: revision.notes,
        sourceTerm: revision.sourceTerm,
        targetTerm: revision.targetTerm,
      })),
      schemaVersion: 'voiceverse.translation-input.v1',
      sourceLanguageTag: track.workspace.speechAnalysis.sourceLanguage.bcp47Tag,
      targetLanguageTag: track.targetLanguage.language.bcp47Tag,
    } satisfies CanonicalJson;
    const activeScene = scene.selection.selectedRevision;
    const contextSnapshot = {
      sceneContext: {
        culturalNotes: activeScene.culturalContext,
        narrative: activeScene.summary,
        sceneRevisionId: activeScene.id,
        title: activeScene.title,
      },
      schemaVersion: 'voiceverse.translation-context.v1',
    } satisfies CanonicalJson;
    this.assertSnapshotSize(configurationSnapshot, 'configuration');
    this.assertSnapshotSize(inputSnapshot, 'input');
    this.assertSnapshotSize(contextSnapshot, 'context');
    const generationId = deterministicLocalizationUuid(`generation:${track.id}:${idempotencyKey}`);
    const generation = await transaction.translationGeneration.create({
      data: {
        configurationHash: canonicalJsonHash(configurationSnapshot),
        configurationSnapshot,
        contextSnapshot,
        contextSnapshotHash: canonicalJsonHash(contextSnapshot),
        createdByUserId: context.userId,
        id: generationId,
        idempotencyKey,
        inputRevisionHash: canonicalJsonHash(inputSnapshot),
        inputSnapshot,
        modelId: expectedModel.modelId,
        modelRevision: expectedModel.modelRevision,
        organizationId: context.organizationId,
        projectId,
        promptVersion,
        providerName: expectedModel.provider,
        runtimeVersion: expectedModel.runtimeVersion,
        sceneId,
        status: TranslationGenerationStatus.QUEUED,
        trackId: track.id,
        workspaceId: track.workspaceId,
      },
    });
    await transaction.outboxEvent.create({
      data: {
        aggregateId: generationId,
        aggregateType: 'translation_generation',
        deduplicationKey: `${LOCALIZATION_TRANSLATION_EVENT}:${generationId}`,
        eventType: LOCALIZATION_TRANSLATION_EVENT,
        id: deterministicLocalizationUuid(
          `outbox:${LOCALIZATION_TRANSLATION_EVENT}:${generationId}`,
        ),
        organizationId: context.organizationId,
        payload: { generationId },
        status: OutboxStatus.PENDING,
      },
    });
    await this.audit(
      transaction,
      context,
      'localization.translation.generation.requested',
      'translation_generation',
      generationId,
      {
        generationId,
        sceneId,
        sceneRevisionId: activeScene.id,
        trackId: track.id,
      },
    );
    return this.toGenerationResponse(generation);
  }

  private async ownedTrack(
    context: AccessContext,
    projectId: string,
    trackId: string,
    client: Transaction = this.database.client,
  ): Promise<TrackScope> {
    this.assertUuid(projectId, 'project');
    this.assertUuid(trackId, 'localization track');
    const track = await client.localizationTrack.findFirst({
      select: trackScopeSelect,
      where: { id: trackId, organizationId: context.organizationId, projectId },
    });
    if (!track) throw new NotFoundException('Localization track not found.');
    return track;
  }

  private async ownedDialogue(
    client: Transaction,
    context: AccessContext,
    projectId: string,
    track: TrackScope,
    dialogueId: string,
  ) {
    const dialogue = await client.localizedDialogue.findFirst({
      select: {
        id: true,
        sourceSelection: {
          select: {
            revision: true,
            selectedRevision: {
              select: { id: true, revisionNumber: true, sourceText: true },
            },
            selectedRevisionId: true,
          },
        },
      },
      where: {
        id: dialogueId,
        organizationId: context.organizationId,
        projectId,
        workspaceId: track.workspaceId,
      },
    });
    if (!dialogue) throw new NotFoundException('Localized dialogue not found.');
    return dialogue;
  }

  private async ownedGlossaryEntry(
    client: Transaction,
    context: AccessContext,
    projectId: string,
    track: TrackScope,
    entryId: string,
  ) {
    const entry = await client.glossaryEntry.findFirst({
      select: {
        id: true,
        selection: {
          select: {
            revision: true,
            selectedRevision: true,
            selectedRevisionId: true,
          },
        },
      },
      where: {
        id: entryId,
        organizationId: context.organizationId,
        projectId,
        trackId: track.id,
        workspaceId: track.workspaceId,
      },
    });
    if (!entry) throw new NotFoundException('Glossary entry not found.');
    return entry;
  }

  private async nextSceneRevisionNumber(transaction: Transaction, sceneId: string) {
    const result = await transaction.localizationSceneRevision.aggregate({
      _max: { revisionNumber: true },
      where: { sceneId },
    });
    return (result._max.revisionNumber ?? 0) + 1;
  }

  private async nextSourceRevisionNumber(transaction: Transaction, dialogueId: string) {
    const result = await transaction.sourceDialogueRevision.aggregate({
      _max: { revisionNumber: true },
      where: { localizedDialogueId: dialogueId },
    });
    return (result._max.revisionNumber ?? 0) + 1;
  }

  private async nextTranslationRevisionNumber(transaction: Transaction, translationId: string) {
    const result = await transaction.translationRevision.aggregate({
      _max: { revisionNumber: true },
      where: { dialogueTranslationId: translationId },
    });
    return (result._max.revisionNumber ?? 0) + 1;
  }

  private async nextGlossaryRevisionNumber(transaction: Transaction, entryId: string) {
    const result = await transaction.glossaryRevision.aggregate({
      _max: { revisionNumber: true },
      where: { glossaryEntryId: entryId },
    });
    return (result._max.revisionNumber ?? 0) + 1;
  }

  private async casSceneSelection(
    transaction: Transaction,
    context: AccessContext,
    projectId: string,
    workspaceId: string,
    sceneId: string,
    revisionId: string,
    expectedRevision: number,
  ): Promise<void> {
    const updated = await transaction.localizationSceneSelection.updateMany({
      data: {
        revision: { increment: 1 },
        selectedAt: new Date(),
        selectedRevisionId: revisionId,
        updatedByUserId: context.userId,
      },
      where: {
        organizationId: context.organizationId,
        projectId,
        revision: expectedRevision,
        sceneId,
        workspaceId,
      },
    });
    if (updated.count !== 1) throw this.selectionConflict();
  }

  private async casSourceSelection(
    transaction: Transaction,
    context: AccessContext,
    projectId: string,
    workspaceId: string,
    dialogueId: string,
    revisionId: string,
    expectedRevision: number,
  ): Promise<void> {
    const updated = await transaction.sourceDialogueSelection.updateMany({
      data: {
        revision: { increment: 1 },
        selectedAt: new Date(),
        selectedRevisionId: revisionId,
        updatedByUserId: context.userId,
      },
      where: {
        localizedDialogueId: dialogueId,
        organizationId: context.organizationId,
        projectId,
        revision: expectedRevision,
        workspaceId,
      },
    });
    if (updated.count !== 1) throw this.selectionConflict();
  }

  private async reopenTranslationsAfterSourceChange(
    transaction: Transaction,
    context: AccessContext,
    projectId: string,
    workspaceId: string,
    dialogueId: string,
  ): Promise<void> {
    await transaction.translationSelection.updateMany({
      data: {
        editorState: TranslationEditorState.DRAFT,
        revision: { increment: 1 },
        updatedByUserId: context.userId,
      },
      where: {
        dialogueTranslation: { localizedDialogueId: dialogueId },
        organizationId: context.organizationId,
        projectId,
        workspaceId,
      },
    });
  }

  private async casGlossarySelection(
    transaction: Transaction,
    context: AccessContext,
    projectId: string,
    track: TrackScope,
    entryId: string,
    revision: {
      id: string;
      normalizedSourceTerm: string;
      caseSensitive: boolean;
    },
    expectedRevision: number,
  ): Promise<void> {
    const updated = await transaction.glossarySelection.updateMany({
      data: {
        revision: { increment: 1 },
        selectedAt: new Date(),
        selectedCaseSensitive: revision.caseSensitive,
        selectedNormalizedSourceTerm: revision.normalizedSourceTerm,
        selectedRevisionId: revision.id,
        updatedByUserId: context.userId,
      },
      where: {
        glossaryEntryId: entryId,
        organizationId: context.organizationId,
        projectId,
        revision: expectedRevision,
        trackId: track.id,
        workspaceId: track.workspaceId,
      },
    });
    if (updated.count !== 1) throw this.selectionConflict();
  }

  private normalizeGlossaryInput(
    input: CreateGlossaryEntryDto | UpdateGlossaryRevisionDto,
  ): NormalizedGlossaryInput {
    const sourceTerm = normalizeGlossarySourceTerm(input.sourceTerm);
    if (!sourceTerm) throw new BadRequestException('Glossary source term cannot be blank.');
    const targetTerm = normalizeOptionalEditorialText(input.targetTerm);
    if (!input.doNotTranslate && !targetTerm) {
      throw new BadRequestException(
        'Glossary target term is required unless doNotTranslate is true.',
      );
    }
    if (input.doNotTranslate && targetTerm) {
      throw new BadRequestException(
        'Glossary target term must be omitted when doNotTranslate is true.',
      );
    }
    return {
      caseSensitive: input.caseSensitive,
      doNotTranslate: input.doNotTranslate,
      normalizedSourceTerm: glossaryComparisonKey(sourceTerm, input.caseSensitive),
      notes: normalizeOptionalEditorialText(input.notes),
      sourceTerm,
      targetTerm,
    };
  }

  private historyWhere(cursor: HistoryCursor | undefined) {
    return cursor
      ? {
          OR: [
            { revisionNumber: { lt: cursor.revisionNumber } },
            { id: { lt: cursor.id }, revisionNumber: cursor.revisionNumber },
          ],
        }
      : {};
  }

  private historyResponse<T extends { id: string; revisionNumber: number }, R>(
    rows: T[],
    limit: number,
    selection: { revision: number; selectedRevisionId: string | null },
    map: (row: T) => R,
  ) {
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(map),
      nextCursor:
        hasMore && last
          ? this.encodeCursor({
              id: last.id,
              resourceId: this.historyResourceId(last),
              revisionNumber: last.revisionNumber,
              version: 1,
            })
          : null,
      selectedRevisionId: selection.selectedRevisionId,
      selectionRevision: selection.revision,
    };
  }

  private historyResourceId(row: Record<string, unknown>): string {
    for (const key of [
      'sceneId',
      'localizedDialogueId',
      'dialogueTranslationId',
      'glossaryEntryId',
    ]) {
      if (typeof row[key] === 'string') return row[key];
    }
    throw new BadRequestException('Revision history cannot be paginated.');
  }

  private encodeCursor(value: SceneCursor | HistoryCursor): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  private decodeSceneCursor(value: string, trackId: string): SceneCursor {
    const parsed = this.decodeCursor(value);
    if (
      parsed.version !== 1 ||
      parsed.trackId !== trackId ||
      typeof parsed.ordinal !== 'number' ||
      !Number.isInteger(parsed.ordinal) ||
      parsed.ordinal < 1 ||
      typeof parsed.id !== 'string' ||
      !uuidPattern.test(parsed.id)
    ) {
      throw new BadRequestException('The scene cursor is invalid for this track.');
    }
    return parsed as unknown as SceneCursor;
  }

  private decodeHistoryCursor(value: string, resourceId: string): HistoryCursor {
    const parsed = this.decodeCursor(value);
    if (
      parsed.version !== 1 ||
      parsed.resourceId !== resourceId ||
      typeof parsed.revisionNumber !== 'number' ||
      !Number.isInteger(parsed.revisionNumber) ||
      parsed.revisionNumber < 1 ||
      typeof parsed.id !== 'string' ||
      !uuidPattern.test(parsed.id)
    ) {
      throw new BadRequestException('The revision cursor is invalid for this resource.');
    }
    return parsed as unknown as HistoryCursor;
  }

  private decodeCursor(value: string): Record<string, unknown> {
    try {
      if (!historyCursorPattern.test(value)) throw new Error('invalid alphabet');
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('invalid cursor');
      }
      return parsed as Record<string, unknown>;
    } catch {
      throw new BadRequestException('The localization cursor is invalid.');
    }
  }

  private toTrackResponse(track: TrackScope) {
    return {
      createdAt: track.createdAt.toISOString(),
      generationEnabled: this.config.get('TRANSLATION_ENABLED', { infer: true }),
      id: track.id,
      projectId: track.projectId,
      sourceLanguage: track.workspace.speechAnalysis.sourceLanguage,
      speechAnalysisId: track.workspace.speechAnalysis.id,
      targetLanguage: track.targetLanguage.language,
      workspaceId: track.workspaceId,
    };
  }

  private toSceneResponse(scene: {
    id: string;
    ordinal: number;
    selection: null | {
      revision: number;
      selectedRevision: {
        culturalContext: string | null;
        endTimeUs: bigint;
        id: string;
        revisionNumber: number;
        startTimeUs: bigint;
        summary: string | null;
        title: string | null;
      };
    };
    dialogues: Array<{
      dialogueSegment: {
        speakerAssignment: null | {
          character: { displayName: string | null; id: string; stableKey: string };
        };
      };
      endTimeUs: bigint;
      id: string;
      sequenceNumber: number;
      sourceSelection: null | {
        revision: number;
        selectedRevision: { id: string; revisionNumber: number; sourceText: string };
      };
      startTimeUs: bigint;
      translations: Array<{
        id: string;
        selection: null | {
          editorState: TranslationEditorState;
          revision: number;
          selectedRevision: {
            id: string;
            revisionNumber: number;
            sourceDialogueRevisionId: string;
            translatedText: string;
          };
        };
      }>;
    }>;
  }) {
    if (!scene.selection) throw new ConflictException('The scene has no active revision.');
    return {
      dialogues: scene.dialogues.map((dialogue) => {
        const character = dialogue.dialogueSegment.speakerAssignment?.character;
        const translation = dialogue.translations[0];
        return {
          character: character
            ? {
                id: character.id,
                name: character.displayName ?? character.stableKey,
              }
            : null,
          endMs: this.microsecondsToMilliseconds(dialogue.endTimeUs),
          id: dialogue.id,
          ordinal: dialogue.sequenceNumber,
          source: dialogue.sourceSelection
            ? {
                revisionId: dialogue.sourceSelection.selectedRevision.id,
                revisionNumber: dialogue.sourceSelection.selectedRevision.revisionNumber,
                selectionRevision: dialogue.sourceSelection.revision,
                text: dialogue.sourceSelection.selectedRevision.sourceText,
              }
            : null,
          startMs: this.microsecondsToMilliseconds(dialogue.startTimeUs),
          translation: translation?.selection
            ? {
                editorState: translation.selection.editorState,
                revisionId: translation.selection.selectedRevision.id,
                revisionNumber: translation.selection.selectedRevision.revisionNumber,
                selectionRevision: translation.selection.revision,
                sourceRevisionId: translation.selection.selectedRevision.sourceDialogueRevisionId,
                text: translation.selection.selectedRevision.translatedText,
                translationId: translation.id,
              }
            : null,
        };
      }),
      id: scene.id,
      ordinal: scene.ordinal,
      revision: {
        culturalNotes: scene.selection.selectedRevision.culturalContext,
        endMs: this.microsecondsToMilliseconds(scene.selection.selectedRevision.endTimeUs),
        id: scene.selection.selectedRevision.id,
        narrative: scene.selection.selectedRevision.summary,
        revisionNumber: scene.selection.selectedRevision.revisionNumber,
        startMs: this.microsecondsToMilliseconds(scene.selection.selectedRevision.startTimeUs),
        title: scene.selection.selectedRevision.title,
      },
      selectionRevision: scene.selection.revision,
    };
  }

  private toSceneRevisionResponse(
    revision: {
      createdAt?: Date;
      createdByUserId?: string;
      culturalContext: string | null;
      endTimeUs: bigint;
      id: string;
      revisionNumber: number;
      sceneId: string;
      startTimeUs: bigint;
      summary: string | null;
      title: string | null;
    },
    selectionRevision?: number,
  ) {
    return {
      createdAt: revision.createdAt?.toISOString(),
      createdByUserId: revision.createdByUserId,
      culturalNotes: revision.culturalContext,
      endMs: this.microsecondsToMilliseconds(revision.endTimeUs),
      id: revision.id,
      narrative: revision.summary,
      revisionNumber: revision.revisionNumber,
      sceneId: revision.sceneId,
      selectionRevision,
      startMs: this.microsecondsToMilliseconds(revision.startTimeUs),
      title: revision.title,
    };
  }

  private toSourceRevisionResponse(
    revision: {
      createdAt?: Date;
      createdByUserId?: string;
      id: string;
      localizedDialogueId: string;
      revisionNumber: number;
      sourceText: string;
    },
    selectionRevision?: number,
  ) {
    return {
      createdAt: revision.createdAt?.toISOString(),
      createdByUserId: revision.createdByUserId,
      dialogueId: revision.localizedDialogueId,
      id: revision.id,
      revisionNumber: revision.revisionNumber,
      selectionRevision,
      sourceText: revision.sourceText,
    };
  }

  private toTranslationRevisionResponse(
    revision: {
      createdAt?: Date;
      createdByUserId?: string;
      dialogueTranslationId: string;
      generationId?: string | null;
      id: string;
      localizedDialogueId: string;
      revisionNumber: number;
      sourceDialogueRevisionId: string;
      translatedText: string;
    },
    editorState: TranslationEditorState,
    selectionRevision?: number,
  ) {
    return {
      createdAt: revision.createdAt?.toISOString(),
      createdByUserId: revision.createdByUserId,
      dialogueId: revision.localizedDialogueId,
      editorState,
      generationId: revision.generationId ?? null,
      id: revision.id,
      revisionNumber: revision.revisionNumber,
      selectionRevision,
      sourceRevisionId: revision.sourceDialogueRevisionId,
      targetText: revision.translatedText,
      translationId: revision.dialogueTranslationId,
    };
  }

  private toGlossaryRevisionResponse(
    revision: {
      caseSensitive: boolean;
      createdAt?: Date;
      createdByUserId?: string;
      doNotTranslate: boolean;
      glossaryEntryId: string;
      id: string;
      notes: string | null;
      revisionNumber: number;
      sourceTerm: string;
      targetTerm: string | null;
    },
    selectionRevision?: number,
  ) {
    return {
      caseSensitive: revision.caseSensitive,
      createdAt: revision.createdAt?.toISOString(),
      createdByUserId: revision.createdByUserId,
      doNotTranslate: revision.doNotTranslate,
      entryId: revision.glossaryEntryId,
      id: revision.id,
      notes: revision.notes,
      revisionNumber: revision.revisionNumber,
      selectionRevision,
      sourceTerm: revision.sourceTerm,
      targetTerm: revision.targetTerm,
    };
  }

  private toGenerationResponse(generation: {
    attemptCount: number;
    completedAt: Date | null;
    createdAt: Date;
    errorCode: string | null;
    id: string;
    inputRevisionHash: string;
    maxAttempts: number;
    modelId: string;
    modelRevision: string;
    promptVersion: string;
    providerName: string;
    queuedAt: Date;
    runtimeVersion: string;
    sceneId: string;
    startedAt: Date | null;
    status: TranslationGenerationStatus;
    trackId: string;
    updatedAt: Date;
  }) {
    return {
      attemptCount: generation.attemptCount,
      completedAt: generation.completedAt?.toISOString() ?? null,
      createdAt: generation.createdAt.toISOString(),
      errorCode: generation.errorCode,
      id: generation.id,
      inputRevisionHash: generation.inputRevisionHash,
      maxAttempts: generation.maxAttempts,
      model: {
        modelId: generation.modelId,
        modelRevision: generation.modelRevision,
        provider: generation.providerName,
        runtimeVersion: generation.runtimeVersion,
      },
      promptVersion: generation.promptVersion,
      queuedAt: generation.queuedAt.toISOString(),
      sceneId: generation.sceneId,
      startedAt: generation.startedAt?.toISOString() ?? null,
      status: generation.status,
      trackId: generation.trackId,
      updatedAt: generation.updatedAt.toISOString(),
    };
  }

  private async audit(
    transaction: Transaction,
    context: AccessContext,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: Record<string, number | string>,
  ): Promise<void> {
    await transaction.auditLog.create({
      data: {
        action,
        actorUserId: context.userId,
        id: uuidv7(),
        metadata,
        organizationId: context.organizationId,
        resourceId,
        resourceType,
      },
    });
  }

  private assertExpectedRevision(actual: number, expected: number): void {
    if (actual !== expected) throw this.selectionConflict();
  }

  private assertEditorStateTransition(
    current: TranslationEditorState,
    requested: TranslationEditorState,
  ): void {
    const allowed =
      (current === TranslationEditorState.DRAFT &&
        requested === TranslationEditorState.IN_REVIEW) ||
      (current === TranslationEditorState.IN_REVIEW &&
        (requested === TranslationEditorState.DRAFT ||
          requested === TranslationEditorState.APPROVED)) ||
      (current === TranslationEditorState.APPROVED && requested === TranslationEditorState.DRAFT);
    if (!allowed) {
      throw new BadRequestException(
        `Translation state cannot move from ${current} to ${requested}.`,
      );
    }
  }

  private selectionConflict(): ConflictException {
    return new ConflictException('The active selection changed. Refresh and retry the edit.');
  }

  private assertGenerationRequestMatches(existingSceneId: string, requestedSceneId: string): void {
    if (existingSceneId !== requestedSceneId) {
      throw new ConflictException(
        'The Idempotency-Key was already used for another translation request.',
      );
    }
  }

  private assertCanEdit(context: AccessContext): void {
    if (context.role === OrganizationRole.VIEWER) {
      throw new ForbiddenException('This organization role cannot edit localization content.');
    }
  }

  private assertUuid(value: string, resource: string): void {
    if (!uuidPattern.test(value)) throw new BadRequestException(`The ${resource} ID is invalid.`);
  }

  private microsecondsToMilliseconds(value: bigint): number {
    return Math.round(Number(value) / 1_000);
  }

  private safeMicroseconds(value: bigint): number {
    const converted = Number(value);
    if (!Number.isSafeInteger(converted)) {
      throw new ConflictException('Dialogue timing exceeds the translation contract range.');
    }
    return converted;
  }

  private assertSnapshotSize(
    snapshot: CanonicalJson,
    kind: keyof typeof snapshotJsonByteLimits,
  ): void {
    if (Buffer.byteLength(stableJson(snapshot), 'utf8') > snapshotJsonByteLimits[kind]) {
      throw new ConflictException(`The translation ${kind} snapshot exceeds its byte limit.`);
    }
  }

  private compareStableStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    return this.prismaErrorCode(error) === 'P2002';
  }

  private isRetryableTransactionError(error: unknown): boolean {
    return this.prismaErrorCode(error) === 'P2034';
  }

  private prismaErrorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : undefined;
  }

  private rethrowWriteConflict(error: unknown): never {
    if (this.isUniqueConstraintViolation(error) || this.isRetryableTransactionError(error)) {
      throw this.selectionConflict();
    }
    throw error;
  }

  private rethrowGlossaryWriteError(error: unknown): never {
    if (this.isUniqueConstraintViolation(error)) {
      throw new ConflictException(
        'An active glossary entry already uses this source term and case mode.',
      );
    }
    return this.rethrowWriteConflict(error);
  }
}
