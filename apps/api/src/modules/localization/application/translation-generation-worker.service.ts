import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, TranslationEditorState, TranslationGenerationStatus } from '@voiceverse/database';
import { Job, Worker } from 'bullmq';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { z } from 'zod';

import type { Environment } from '../../../config/environment';
import { DatabaseService } from '../../../infrastructure/database/database.service';
import { uuidv7 } from '../../../shared/uuid';
import {
  TRANSLATION_EXECUTOR,
  TranslationExecutorError,
  type TranslationExecutionCommand,
  type TranslationExecutionResult,
  type TranslationExecutorPort,
} from '../domain/translation-executor.port';
import {
  EXECUTE_SCENE_TRANSLATION_JOB,
  LOCALIZATION_TRANSLATION_EVENT,
  LOCALIZATION_TRANSLATION_QUEUE,
} from '../infrastructure/localization.queue';
import { TranslationCapabilityReadinessService } from './translation-capability-readiness.service';

const uuidSchema = z.string().uuid();
const sourceTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0)
  .refine((value) => Array.from(value).length <= 20_000)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 65_536);
const modelSchema = z
  .object({
    modelId: z.string().min(1).max(128),
    modelRevision: z.string().min(1).max(128),
    provider: z.string().min(1).max(100),
    runtimeVersion: z.string().min(1).max(128),
  })
  .strict();
const configurationSnapshotSchema = z
  .object({
    expectedModel: modelSchema,
    promptVersion: z.string().min(1).max(100),
    schemaVersion: z.literal('voiceverse.translation-configuration.v1'),
  })
  .strict();
const characterSchema = z
  .object({ characterId: uuidSchema, name: z.string().trim().min(1).max(160) })
  .strict();
const dialogueSnapshotSchema = z
  .object({
    character: characterSchema.nullable(),
    dialogueId: uuidSchema,
    endUs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    ordinal: z.number().int().nonnegative().max(199),
    sourceRevisionId: uuidSchema,
    sourceText: sourceTextSchema,
    startUs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    translationId: uuidSchema.nullable(),
    translationRevisionId: uuidSchema.nullable(),
    translationSelectionRevision: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endUs <= value.startUs) {
      context.addIssue({ code: 'custom', message: 'Dialogue timing is invalid.' });
    }
    const targetFields = [
      value.translationId,
      value.translationRevisionId,
      value.translationSelectionRevision,
    ];
    const populated = targetFields.filter((candidate) => candidate !== null).length;
    if (populated !== 0 && populated !== targetFields.length) {
      context.addIssue({
        code: 'custom',
        message: 'Translation selection snapshot is incomplete.',
      });
    }
  });
const glossarySnapshotSchema = z
  .object({
    caseSensitive: z.boolean(),
    doNotTranslate: z.boolean(),
    glossaryRevisionId: uuidSchema,
    notes: z.string().max(2_000).nullable(),
    sourceTerm: z.string().trim().min(1).max(500),
    targetTerm: z.string().trim().min(1).max(500).nullable(),
  })
  .strict()
  .refine((value) => value.doNotTranslate === (value.targetTerm === null), {
    message: 'Glossary target policy is invalid.',
  });
const inputSnapshotSchema = z
  .object({
    dialogues: z.array(dialogueSnapshotSchema).min(1).max(200),
    glossaryRevisions: z.array(glossarySnapshotSchema).max(200),
    schemaVersion: z.literal('voiceverse.translation-input.v1'),
    sourceLanguageTag: z.string().min(2).max(35),
    targetLanguageTag: z.string().min(2).max(35),
  })
  .strict()
  .superRefine((value, context) => {
    const dialogueIds = new Set<string>();
    const sourceRevisionIds = new Set<string>();
    value.dialogues.forEach((dialogue, index) => {
      if (dialogue.ordinal !== index) {
        context.addIssue({ code: 'custom', message: 'Dialogue ordinals are not contiguous.' });
      }
      if (
        dialogueIds.has(dialogue.dialogueId) ||
        sourceRevisionIds.has(dialogue.sourceRevisionId)
      ) {
        context.addIssue({ code: 'custom', message: 'Dialogue snapshot contains duplicate IDs.' });
      }
      dialogueIds.add(dialogue.dialogueId);
      sourceRevisionIds.add(dialogue.sourceRevisionId);
    });
    if (value.sourceLanguageTag.toLowerCase() === value.targetLanguageTag.toLowerCase()) {
      context.addIssue({ code: 'custom', message: 'Translation languages must differ.' });
    }
  });
const contextSnapshotSchema = z
  .object({
    sceneContext: z
      .object({
        culturalNotes: z.string().max(8_000).nullable(),
        narrative: z.string().max(4_000).nullable(),
        sceneRevisionId: uuidSchema,
        title: z.string().max(200).nullable(),
      })
      .strict(),
    schemaVersion: z.literal('voiceverse.translation-context.v1'),
  })
  .strict();
const jobDataSchema = z.object({ generationId: uuidSchema }).strict();

type ConfigurationSnapshot = z.infer<typeof configurationSnapshotSchema>;
type InputSnapshot = z.infer<typeof inputSnapshotSchema>;
type ContextSnapshot = z.infer<typeof contextSnapshotSchema>;

interface ClaimedGeneration {
  attemptCount: number;
  configurationHash: string;
  configurationSnapshot: Prisma.JsonValue;
  contextSnapshot: Prisma.JsonValue;
  contextSnapshotHash: string;
  createdByUserId: string;
  executionId: string;
  id: string;
  inputRevisionHash: string;
  inputSnapshot: Prisma.JsonValue;
  leaseToken: string;
  maxAttempts: number;
  organizationId: string;
  projectId: string;
  sceneId: string;
  trackId: string;
  workspaceId: string;
}

class StaleTranslationInputError extends Error {
  constructor() {
    super('The editorial selection changed while translation was running.');
    this.name = 'StaleTranslationInputError';
  }
}

@Injectable()
export class TranslationGenerationWorkerService implements OnApplicationShutdown {
  private readonly concurrency: number;
  private connection?: Redis;
  private readonly enabled: boolean;
  private readonly leaseSeconds: number;
  private lastReadinessWarningAt = 0;
  private readonly logger = new Logger(TranslationGenerationWorkerService.name);
  private readonly redisUrl: string;
  private startPromise?: Promise<boolean>;
  private worker?: Worker;

  constructor(
    private readonly database: DatabaseService,
    config: ConfigService<Environment, true>,
    @Inject(TRANSLATION_EXECUTOR) private readonly executor: TranslationExecutorPort,
    private readonly readiness: TranslationCapabilityReadinessService,
  ) {
    this.enabled = config.get('TRANSLATION_ENABLED', { infer: true });
    this.redisUrl = config.get('REDIS_URL', { infer: true });
    this.concurrency = config.get('TRANSLATION_CONCURRENCY', { infer: true });
    this.leaseSeconds = config.get('TRANSLATION_GENERATION_LEASE_SECONDS', { infer: true });
  }

  async ensureStarted(): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.worker) return true;
    this.startPromise ??= this.startWhenReady();
    const started = await this.startPromise;
    if (!started) this.startPromise = undefined;
    return started;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    if (this.connection && this.connection.status !== 'end') await this.connection.quit();
  }

  async processTranslation(job: Job): Promise<void> {
    if (job.name !== EXECUTE_SCENE_TRANSLATION_JOB) {
      throw new Error('UnexpectedTranslationQueueJob');
    }
    const { generationId } = jobDataSchema.parse(job.data);
    // Dependency readiness is checked before spending a durable model attempt.
    await this.readiness.assert();
    const claimed = await this.claim(generationId);
    if (!claimed) return;
    const heartbeat = this.startHeartbeat(claimed);
    try {
      const snapshots = this.parseSnapshots(claimed);
      const command = this.command(claimed, snapshots);
      const result = await this.executor.translate(command, { signal: heartbeat.signal });
      await this.complete(claimed, snapshots, result);
    } catch (error) {
      const failure = this.normalizeFailure(error);
      await this.fail(claimed, failure.code, failure.retryable);
    } finally {
      heartbeat.stop();
    }
  }

  async recoverExpiredGenerations(limit = 25): Promise<number> {
    if (!this.enabled) return 0;
    const now = new Date();
    const staleDeliveriesBefore = new Date(now.getTime() - this.leaseSeconds * 1_000);
    const replayed = await this.database.client.$queryRaw<Array<{ id: string }>>`
      WITH candidates AS (
        SELECT event.id
        FROM outbox_events AS event
        INNER JOIN translation_generations AS generation
          ON generation.id = event.aggregate_id
        WHERE event.event_type = ${LOCALIZATION_TRANSLATION_EVENT}
          AND event.status = 'published'
          AND event.published_at < ${staleDeliveriesBefore}
          AND generation.status = 'queued'
        ORDER BY event.published_at, event.id
        LIMIT ${limit}
        FOR UPDATE OF event SKIP LOCKED
      )
      UPDATE outbox_events AS event
      SET status = 'pending', available_at = ${now}, last_error = NULL,
          lease_id = NULL, leased_until = NULL, published_at = NULL
      FROM candidates
      WHERE event.id = candidates.id
      RETURNING event.id
    `;

    const expired = await this.database.client.translationGeneration.findMany({
      orderBy: [{ leasedUntil: 'asc' }, { id: 'asc' }],
      take: limit,
      where: { leasedUntil: { lt: now }, status: TranslationGenerationStatus.RUNNING },
    });
    let recovered = replayed.length;
    for (const generation of expired) {
      if (!generation.leaseToken || !generation.executionId) continue;
      const claimed = this.toClaimed(generation, generation.leaseToken, generation.executionId);
      if (await this.fail(claimed, 'TRANSLATION_GENERATION_LEASE_EXPIRED', true, now)) {
        recovered += 1;
      }
    }
    if (recovered > 0) {
      this.logger.warn({ recovered }, 'Stranded translation generation deliveries recovered');
    }
    return recovered;
  }

  private async startWhenReady(): Promise<boolean> {
    try {
      await this.readiness.assert();
    } catch (error) {
      const now = Date.now();
      if (now - this.lastReadinessWarningAt >= 30_000) {
        this.lastReadinessWarningAt = now;
        this.logger.warn(
          { errorCode: error instanceof Error ? error.name : 'UnknownError' },
          'Translation consumer remains paused until the pinned executor is ready',
        );
      }
      return false;
    }
    if (this.worker) return true;
    this.connection = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(
      LOCALIZATION_TRANSLATION_QUEUE,
      (job) => this.processTranslation(job),
      { concurrency: this.concurrency, connection: this.connection },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.warn(
        { errorCode: error.name, queueJobId: job?.id },
        'Translation delivery failed',
      );
    });
    this.worker.on('error', (error) => {
      this.logger.error({ errorCode: error.name }, 'Translation worker error');
    });
    this.logger.log('Translation worker started after exact readiness handshake');
    return true;
  }

  private async claim(generationId: string): Promise<ClaimedGeneration | null> {
    const generation = await this.database.client.translationGeneration.findFirst({
      where: { id: generationId, status: TranslationGenerationStatus.QUEUED },
    });
    if (!generation) return null;
    if (generation.attemptCount >= generation.maxAttempts) {
      const exhaustedAt = new Date();
      await this.database.client.translationGeneration.updateMany({
        data: {
          completedAt: exhaustedAt,
          errorCode: 'TRANSLATION_ATTEMPTS_EXHAUSTED',
          errorDetail: 'Translation generation exhausted its bounded attempts.',
          executionId: uuidv7(),
          heartbeatAt: null,
          startedAt: exhaustedAt,
          status: TranslationGenerationStatus.FAILED,
        },
        where: {
          attemptCount: generation.attemptCount,
          id: generation.id,
          status: TranslationGenerationStatus.QUEUED,
        },
      });
      return null;
    }

    const now = new Date();
    const leaseToken = uuidv7();
    const executionId = uuidv7();
    const leasedUntil = new Date(now.getTime() + this.leaseSeconds * 1_000);
    const won = await this.database.client.$queryRaw<Array<{ id: string }>>`
      WITH candidate AS (
        SELECT id
        FROM translation_generations
        WHERE id = ${generation.id}::uuid
          AND status = 'queued'
          AND attempt_count < max_attempts
        FOR UPDATE SKIP LOCKED
      )
      UPDATE translation_generations AS generation
      SET status = 'running',
          attempt_count = generation.attempt_count + 1,
          lease_token = ${leaseToken}::uuid,
          leased_until = ${leasedUntil},
          heartbeat_at = ${now},
          execution_id = ${executionId}::uuid,
          started_at = ${now},
          completed_at = NULL,
          error_code = NULL,
          error_detail = NULL,
          updated_at = ${now}
      FROM candidate
      WHERE generation.id = candidate.id
      RETURNING generation.id
    `;
    if (won.length !== 1) return null;
    const claimed = await this.database.client.translationGeneration.findUniqueOrThrow({
      where: { id: generation.id },
    });
    return this.toClaimed(claimed, leaseToken, executionId);
  }

  private toClaimed(
    generation: {
      attemptCount: number;
      configurationHash: string;
      configurationSnapshot: Prisma.JsonValue;
      contextSnapshot: Prisma.JsonValue;
      contextSnapshotHash: string;
      createdByUserId: string;
      id: string;
      inputRevisionHash: string;
      inputSnapshot: Prisma.JsonValue;
      maxAttempts: number;
      organizationId: string;
      projectId: string;
      sceneId: string;
      trackId: string;
      workspaceId: string;
    },
    leaseToken: string,
    executionId: string,
  ): ClaimedGeneration {
    return { ...generation, executionId, leaseToken };
  }

  private parseSnapshots(claimed: ClaimedGeneration): {
    configuration: ConfigurationSnapshot;
    context: ContextSnapshot;
    input: InputSnapshot;
  } {
    const configuration = configurationSnapshotSchema.safeParse(claimed.configurationSnapshot);
    const context = contextSnapshotSchema.safeParse(claimed.contextSnapshot);
    const input = inputSnapshotSchema.safeParse(claimed.inputSnapshot);
    if (!configuration.success || !context.success || !input.success) {
      throw new TranslationExecutorError('TRANSLATION_SNAPSHOT_INVALID', false);
    }
    if (
      this.hash(configuration.data) !== claimed.configurationHash ||
      this.hash(context.data) !== claimed.contextSnapshotHash ||
      this.hash(input.data) !== claimed.inputRevisionHash
    ) {
      throw new TranslationExecutorError('TRANSLATION_SNAPSHOT_HASH_MISMATCH', false);
    }
    return { configuration: configuration.data, context: context.data, input: input.data };
  }

  private command(
    claimed: ClaimedGeneration,
    snapshots: {
      configuration: ConfigurationSnapshot;
      context: ContextSnapshot;
      input: InputSnapshot;
    },
  ): TranslationExecutionCommand {
    return {
      dialogues: snapshots.input.dialogues.map((dialogue) => ({
        character: dialogue.character,
        dialogueId: dialogue.dialogueId,
        endUs: dialogue.endUs,
        ordinal: dialogue.ordinal,
        sourceRevisionId: dialogue.sourceRevisionId,
        sourceText: dialogue.sourceText,
        startUs: dialogue.startUs,
      })),
      executionId: claimed.executionId,
      expectedModel: snapshots.configuration.expectedModel,
      generationId: claimed.id,
      glossaryRevisions: snapshots.input.glossaryRevisions,
      promptVersion: snapshots.configuration.promptVersion,
      sceneContext: snapshots.context.sceneContext,
      schemaVersion: 'voiceverse.translation-command.v1',
      sourceLanguageTag: snapshots.input.sourceLanguageTag,
      targetLanguageTag: snapshots.input.targetLanguageTag,
    };
  }

  private async complete(
    claimed: ClaimedGeneration,
    snapshots: {
      configuration: ConfigurationSnapshot;
      context: ContextSnapshot;
      input: InputSnapshot;
    },
    result: TranslationExecutionResult,
  ): Promise<void> {
    await this.database.client.$transaction(
      async (transaction) => {
        const locked = await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM translation_generations
          WHERE id = ${claimed.id}::uuid
            AND lease_token = ${claimed.leaseToken}::uuid
            AND execution_id = ${claimed.executionId}::uuid
            AND status = 'running'
            AND leased_until > CURRENT_TIMESTAMP
          FOR UPDATE
        `;
        if (locked.length !== 1) throw new Error('TranslationGenerationLeaseLost');

        await this.assertSelectionsCurrent(transaction, claimed, snapshots);
        const targetByDialogue = new Map(
          result.translations.map((translation) => [translation.dialogueId, translation]),
        );
        const dialogueIds = snapshots.input.dialogues.map(({ dialogueId }) => dialogueId);
        const existing = await transaction.dialogueTranslation.findMany({
          include: {
            revisions: { orderBy: { revisionNumber: 'desc' }, take: 1 },
            selection: true,
          },
          where: {
            localizedDialogueId: { in: dialogueIds },
            organizationId: claimed.organizationId,
            projectId: claimed.projectId,
            trackId: claimed.trackId,
          },
        });
        const existingByDialogue = new Map(
          existing.map((translation) => [translation.localizedDialogueId, translation]),
        );

        for (const source of snapshots.input.dialogues) {
          const generated = targetByDialogue.get(source.dialogueId);
          if (!generated) throw new TranslationExecutorError('TRANSLATION_RESULT_MISSING', false);
          const current = existingByDialogue.get(source.dialogueId);
          this.assertTargetSelectionCurrent(source, current);
          const translationId = current?.id ?? uuidv7();
          if (!current) {
            await transaction.dialogueTranslation.create({
              data: {
                createdByUserId: claimed.createdByUserId,
                id: translationId,
                localizedDialogueId: source.dialogueId,
                organizationId: claimed.organizationId,
                projectId: claimed.projectId,
                trackId: claimed.trackId,
                workspaceId: claimed.workspaceId,
              },
            });
          }
          const revisionId = uuidv7();
          const revisionNumber = (current?.revisions[0]?.revisionNumber ?? 0) + 1;
          await transaction.translationRevision.create({
            data: {
              createdByUserId: claimed.createdByUserId,
              dialogueTranslationId: translationId,
              generationId: claimed.id,
              id: revisionId,
              localizedDialogueId: source.dialogueId,
              organizationId: claimed.organizationId,
              projectId: claimed.projectId,
              revisionNumber,
              sourceDialogueRevisionId: source.sourceRevisionId,
              trackId: claimed.trackId,
              translatedText: generated.targetText,
              workspaceId: claimed.workspaceId,
            },
          });
          if (!current) {
            await transaction.translationSelection.create({
              data: {
                dialogueTranslationId: translationId,
                editorState: TranslationEditorState.DRAFT,
                organizationId: claimed.organizationId,
                projectId: claimed.projectId,
                selectedRevisionId: revisionId,
                trackId: claimed.trackId,
                updatedByUserId: claimed.createdByUserId,
                workspaceId: claimed.workspaceId,
              },
            });
          } else {
            const won = await transaction.translationSelection.updateMany({
              data: {
                editorState: TranslationEditorState.DRAFT,
                revision: { increment: 1 },
                selectedAt: new Date(),
                selectedRevisionId: revisionId,
                updatedByUserId: claimed.createdByUserId,
              },
              where: {
                dialogueTranslationId: current.id,
                organizationId: claimed.organizationId,
                projectId: claimed.projectId,
                revision: source.translationSelectionRevision!,
                selectedRevisionId: source.translationRevisionId!,
                trackId: claimed.trackId,
                workspaceId: claimed.workspaceId,
              },
            });
            if (won.count !== 1) throw new StaleTranslationInputError();
          }
        }

        const now = new Date();
        const won = await transaction.translationGeneration.updateMany({
          data: {
            completedAt: now,
            errorCode: null,
            errorDetail: null,
            heartbeatAt: null,
            leaseToken: null,
            leasedUntil: null,
            status: TranslationGenerationStatus.SUCCEEDED,
          },
          where: {
            executionId: claimed.executionId,
            id: claimed.id,
            leaseToken: claimed.leaseToken,
            status: TranslationGenerationStatus.RUNNING,
          },
        });
        if (won.count !== 1) throw new Error('TranslationGenerationLeaseLost');
        await transaction.auditLog.create({
          data: {
            action: 'localization.translation_generation.succeeded',
            actorUserId: claimed.createdByUserId,
            id: uuidv7(),
            metadata: {
              attemptCount: claimed.attemptCount,
              dialogueCount: snapshots.input.dialogues.length,
              producerVersion: result.producerVersion,
            },
            organizationId: claimed.organizationId,
            resourceId: claimed.id,
            resourceType: 'translation_generation',
          },
        });
      },
      { isolationLevel: 'Serializable', timeout: 30_000 },
    );
  }

  private async assertSelectionsCurrent(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedGeneration,
    snapshots: {
      configuration: ConfigurationSnapshot;
      context: ContextSnapshot;
      input: InputSnapshot;
    },
  ): Promise<void> {
    const scene = await transaction.localizationSceneSelection.findFirst({
      where: {
        organizationId: claimed.organizationId,
        projectId: claimed.projectId,
        sceneId: claimed.sceneId,
        selectedRevisionId: snapshots.context.sceneContext.sceneRevisionId,
      },
    });
    if (!scene) throw new StaleTranslationInputError();

    const sourceSelections = await transaction.sourceDialogueSelection.findMany({
      select: { localizedDialogueId: true, selectedRevisionId: true },
      where: {
        localizedDialogueId: {
          in: snapshots.input.dialogues.map(({ dialogueId }) => dialogueId),
        },
        organizationId: claimed.organizationId,
        projectId: claimed.projectId,
      },
    });
    const sources = new Map(
      sourceSelections.map((selection) => [
        selection.localizedDialogueId,
        selection.selectedRevisionId,
      ]),
    );
    if (
      snapshots.input.dialogues.some(
        (dialogue) => sources.get(dialogue.dialogueId) !== dialogue.sourceRevisionId,
      )
    ) {
      throw new StaleTranslationInputError();
    }

    const glossarySelections = await transaction.glossarySelection.findMany({
      select: { selectedRevisionId: true },
      where: {
        organizationId: claimed.organizationId,
        projectId: claimed.projectId,
        trackId: claimed.trackId,
      },
    });
    const currentGlossary = glossarySelections
      .map(({ selectedRevisionId }) => selectedRevisionId)
      .sort();
    const snapshotGlossary = snapshots.input.glossaryRevisions
      .map(({ glossaryRevisionId }) => glossaryRevisionId)
      .sort();
    if (
      currentGlossary.length !== snapshotGlossary.length ||
      currentGlossary.some((revisionId, index) => revisionId !== snapshotGlossary[index])
    ) {
      throw new StaleTranslationInputError();
    }
  }

  private assertTargetSelectionCurrent(
    source: InputSnapshot['dialogues'][number],
    current:
      | {
          id: string;
          revisions: Array<{ revisionNumber: number }>;
          selection: { revision: number; selectedRevisionId: string } | null;
        }
      | undefined,
  ): void {
    if (source.translationId === null) {
      if (current) throw new StaleTranslationInputError();
      return;
    }
    if (
      !current?.selection ||
      current.id !== source.translationId ||
      current.selection.selectedRevisionId !== source.translationRevisionId ||
      current.selection.revision !== source.translationSelectionRevision
    ) {
      throw new StaleTranslationInputError();
    }
  }

  private async fail(
    claimed: ClaimedGeneration,
    code: string,
    retryable: boolean,
    leaseExpiredBefore?: Date,
  ): Promise<boolean> {
    return this.database.client.$transaction(async (transaction) => {
      const now = new Date();
      const leaseWindow = leaseExpiredBefore ? { lt: leaseExpiredBefore } : { gt: now };
      const generation = await transaction.translationGeneration.findFirst({
        where: {
          id: claimed.id,
          leaseToken: claimed.leaseToken,
          leasedUntil: leaseWindow,
          status: TranslationGenerationStatus.RUNNING,
        },
      });
      if (!generation) return false;
      const shouldRetry = retryable && generation.attemptCount < generation.maxAttempts;
      const won = await transaction.translationGeneration.updateMany({
        data: shouldRetry
          ? {
              completedAt: null,
              errorCode: null,
              errorDetail: null,
              executionId: null,
              heartbeatAt: null,
              leaseToken: null,
              leasedUntil: null,
              startedAt: null,
              status: TranslationGenerationStatus.QUEUED,
            }
          : {
              completedAt: now,
              errorCode: code,
              errorDetail: 'Translation generation could not be completed.',
              heartbeatAt: null,
              leaseToken: null,
              leasedUntil: null,
              status: TranslationGenerationStatus.FAILED,
            },
        where: {
          id: claimed.id,
          leaseToken: claimed.leaseToken,
          leasedUntil: leaseWindow,
          status: TranslationGenerationStatus.RUNNING,
        },
      });
      if (won.count !== 1) return false;
      if (shouldRetry) {
        const nextAttempt = generation.attemptCount + 1;
        const delayMs = 5_000 * 2 ** Math.max(0, nextAttempt - 2);
        await transaction.outboxEvent.create({
          data: {
            aggregateId: claimed.id,
            aggregateType: 'translation_generation',
            availableAt: new Date(now.getTime() + delayMs),
            deduplicationKey: `translation-generation:${claimed.id}:attempt:${nextAttempt}`,
            eventType: LOCALIZATION_TRANSLATION_EVENT,
            id: uuidv7(),
            organizationId: claimed.organizationId,
            payload: { generationId: claimed.id },
          },
        });
      } else {
        await transaction.auditLog.create({
          data: {
            action: 'localization.translation_generation.failed',
            actorUserId: claimed.createdByUserId,
            id: uuidv7(),
            metadata: { attemptCount: generation.attemptCount, errorCode: code },
            organizationId: claimed.organizationId,
            resourceId: claimed.id,
            resourceType: 'translation_generation',
          },
        });
      }
      return true;
    });
  }

  private startHeartbeat(claimed: ClaimedGeneration): {
    signal: AbortSignal;
    stop(): void;
  } {
    const interval = Math.max(10_000, Math.floor((this.leaseSeconds * 1_000) / 3));
    const controller = new AbortController();
    const timer = setInterval(() => {
      const now = new Date();
      void this.database.client.translationGeneration
        .updateMany({
          data: {
            heartbeatAt: now,
            leasedUntil: new Date(now.getTime() + this.leaseSeconds * 1_000),
          },
          where: {
            id: claimed.id,
            leaseToken: claimed.leaseToken,
            status: TranslationGenerationStatus.RUNNING,
          },
        })
        .then(({ count }) => {
          if (count === 1 || controller.signal.aborted) return;
          controller.abort(new Error('TranslationGenerationLeaseLost'));
          clearInterval(timer);
        })
        .catch((error: unknown) => {
          this.logger.warn(
            {
              errorCode: error instanceof Error ? error.name : 'UnknownError',
              generationId: claimed.id,
            },
            'Translation generation heartbeat failed',
          );
        });
    }, interval);
    return { signal: controller.signal, stop: () => clearInterval(timer) };
  }

  private normalizeFailure(error: unknown): { code: string; retryable: boolean } {
    if (error instanceof TranslationExecutorError) {
      return { code: error.code, retryable: error.retryable };
    }
    if (error instanceof StaleTranslationInputError) {
      return { code: 'TRANSLATION_STALE_INPUT', retryable: false };
    }
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'P2034') {
      return { code: 'TRANSLATION_SERIALIZATION_CONFLICT', retryable: true };
    }
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      code: aborted ? 'TRANSLATION_GENERATION_LEASE_LOST' : 'TRANSLATION_INTERNAL_ERROR',
      retryable: !aborted,
    };
  }

  private hash(value: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(this.canonical(value)))
      .digest('hex');
  }

  private canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.canonical(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, this.canonical(item)]),
      );
    }
    return value;
  }
}
