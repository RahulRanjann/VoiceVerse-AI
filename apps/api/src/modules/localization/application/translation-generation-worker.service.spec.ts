import type { ConfigService } from '@nestjs/config';
import { TranslationGenerationStatus } from '@voiceverse/database';
import type { Job } from 'bullmq';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import type { DatabaseService } from '../../../infrastructure/database/database.service';
import {
  TranslationExecutorError,
  type TranslationExecutorPort,
} from '../domain/translation-executor.port';
import { EXECUTE_SCENE_TRANSLATION_JOB } from '../infrastructure/localization.queue';
import type { TranslationCapabilityReadinessService } from './translation-capability-readiness.service';
import { TranslationGenerationWorkerService } from './translation-generation-worker.service';

const ids = {
  actor: '01900000-0000-7000-8000-000000000401',
  dialogue: '01900000-0000-7000-8000-000000000402',
  generation: '01900000-0000-7000-8000-000000000403',
  organization: '01900000-0000-7000-8000-000000000404',
  project: '01900000-0000-7000-8000-000000000405',
  scene: '01900000-0000-7000-8000-000000000406',
  sceneRevision: '01900000-0000-7000-8000-000000000407',
  sourceRevision: '01900000-0000-7000-8000-000000000408',
  track: '01900000-0000-7000-8000-000000000409',
  workspace: '01900000-0000-7000-8000-000000000410',
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function hash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function snapshots() {
  const configurationSnapshot = {
    expectedModel: {
      modelId: 'approved-model',
      modelRevision: 'sha-model',
      provider: 'approved-provider',
      runtimeVersion: 'runtime-1',
    },
    promptVersion: 'scene-translation-v1',
    schemaVersion: 'voiceverse.translation-configuration.v1',
  };
  const contextSnapshot = {
    sceneContext: {
      culturalNotes: 'Sensitive cultural context',
      narrative: 'Sensitive narrative context',
      sceneRevisionId: ids.sceneRevision,
      title: 'Opening',
    },
    schemaVersion: 'voiceverse.translation-context.v1',
  };
  const inputSnapshot = {
    dialogues: [
      {
        character: null,
        dialogueId: ids.dialogue,
        endUs: 2_000_000,
        ordinal: 0,
        sourceRevisionId: ids.sourceRevision,
        sourceText: 'Sensitive source line',
        startUs: 1_000_000,
        translationId: null,
        translationRevisionId: null,
        translationSelectionRevision: null,
      },
    ],
    glossaryRevisions: [],
    schemaVersion: 'voiceverse.translation-input.v1',
    sourceLanguageTag: 'en-US',
    targetLanguageTag: 'hi-IN',
  };
  return { configurationSnapshot, contextSnapshot, inputSnapshot };
}

function generation() {
  const value = snapshots();
  return {
    attemptCount: 1,
    completedAt: null,
    configurationHash: hash(value.configurationSnapshot),
    configurationSnapshot: value.configurationSnapshot,
    contextSnapshot: value.contextSnapshot,
    contextSnapshotHash: hash(value.contextSnapshot),
    createdAt: new Date(),
    createdByUserId: ids.actor,
    errorCode: null,
    errorDetail: null,
    executionId: '01900000-0000-7000-8000-000000000411',
    heartbeatAt: new Date(),
    id: ids.generation,
    idempotencyKey: 'generation-key',
    inputRevisionHash: hash(value.inputSnapshot),
    inputSnapshot: value.inputSnapshot,
    leaseToken: '01900000-0000-7000-8000-000000000412',
    leasedUntil: new Date(Date.now() + 300_000),
    maxAttempts: 3,
    modelId: 'approved-model',
    modelRevision: 'sha-model',
    organizationId: ids.organization,
    projectId: ids.project,
    promptVersion: 'scene-translation-v1',
    providerName: 'approved-provider',
    queuedAt: new Date(),
    runtimeVersion: 'runtime-1',
    sceneId: ids.scene,
    startedAt: new Date(),
    status: TranslationGenerationStatus.RUNNING,
    trackId: ids.track,
    updatedAt: new Date(),
    workspaceId: ids.workspace,
  };
}

function harness(options: { staleSource?: boolean } = {}) {
  const claimed = generation();
  const completionLock = vi.fn().mockResolvedValue([{ id: ids.generation }]);
  const translationCreate = vi.fn().mockResolvedValue({});
  const revisionCreate = vi.fn().mockResolvedValue({});
  const selectionCreate = vi.fn().mockResolvedValue({});
  const auditCreate = vi.fn().mockResolvedValue({});
  const outboxCreate = vi.fn().mockResolvedValue({});
  const transactionGenerationFind = vi.fn().mockResolvedValue(claimed);
  const transactionGenerationUpdate = vi.fn().mockResolvedValue({ count: 1 });
  const transaction = {
    $queryRaw: completionLock,
    auditLog: { create: auditCreate },
    dialogueTranslation: { create: translationCreate, findMany: vi.fn().mockResolvedValue([]) },
    glossarySelection: { findMany: vi.fn().mockResolvedValue([]) },
    localizationSceneSelection: { findFirst: vi.fn().mockResolvedValue({ sceneId: ids.scene }) },
    outboxEvent: { create: outboxCreate },
    sourceDialogueSelection: {
      findMany: vi.fn().mockResolvedValue([
        {
          localizedDialogueId: ids.dialogue,
          selectedRevisionId: options.staleSource
            ? '01900000-0000-7000-8000-000000000499'
            : ids.sourceRevision,
        },
      ]),
    },
    translationGeneration: {
      findFirst: transactionGenerationFind,
      updateMany: transactionGenerationUpdate,
    },
    translationRevision: { create: revisionCreate },
    translationSelection: { create: selectionCreate, updateMany: vi.fn() },
  };
  const client = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: ids.generation }]),
    $transaction: vi.fn((callback: (value: typeof transaction) => unknown) =>
      callback(transaction),
    ),
    translationGeneration: {
      findFirst: vi.fn().mockResolvedValue({ ...claimed, attemptCount: 0, status: 'QUEUED' }),
      findMany: vi.fn().mockResolvedValue([]),
      findUniqueOrThrow: vi.fn().mockResolvedValue(claimed),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const database = { client } as unknown as DatabaseService;
  const values: Partial<Environment> = {
    REDIS_URL: 'redis://localhost:6379/15',
    TRANSLATION_CONCURRENCY: 1,
    TRANSLATION_ENABLED: true,
    TRANSLATION_GENERATION_LEASE_SECONDS: 300,
  };
  const config = {
    get: vi.fn((key: keyof Environment) => values[key]),
  } as unknown as ConfigService<Environment, true>;
  const translate = vi.fn().mockResolvedValue({
    executionId: claimed.executionId,
    generationId: ids.generation,
    model: snapshots().configurationSnapshot.expectedModel,
    producerVersion: 'translation-test',
    promptVersion: 'scene-translation-v1',
    schemaVersion: 'voiceverse.translation.v1',
    sourceLanguageTag: 'en-US',
    targetLanguageTag: 'hi-IN',
    translations: [
      {
        dialogueId: ids.dialogue,
        sourceRevisionId: ids.sourceRevision,
        targetText: 'Sensitive target line',
      },
    ],
  });
  const executor = {
    checkReadiness: vi.fn(),
    translate,
  } as unknown as TranslationExecutorPort;
  const readiness = {
    assert: vi.fn().mockResolvedValue(undefined),
  } as unknown as TranslationCapabilityReadinessService;
  const service = new TranslationGenerationWorkerService(database, config, executor, readiness);
  const job = {
    data: { generationId: ids.generation },
    name: EXECUTE_SCENE_TRANSLATION_JOB,
  } as Job;
  return {
    auditCreate,
    client,
    completionLock,
    job,
    outboxCreate,
    revisionCreate,
    selectionCreate,
    service,
    transactionGenerationUpdate,
    translate,
    translationCreate,
  };
}

describe('TranslationGenerationWorkerService', () => {
  it('persists immutable machine revisions and content-free audit metadata', async () => {
    const test = harness();

    await test.service.processTranslation(test.job);

    expect(test.translate).toHaveBeenCalledWith(
      expect.objectContaining({
        dialogues: [
          expect.not.objectContaining({
            translationId: expect.anything(),
            translationRevisionId: expect.anything(),
          }),
        ],
        generationId: ids.generation,
        glossaryRevisions: [],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const claimSql = (test.client.$queryRaw.mock.calls[0]?.[0] as string[]).join(' ');
    expect(claimSql).toContain('FOR UPDATE SKIP LOCKED');
    expect(test.translationCreate).toHaveBeenCalledOnce();
    expect(test.revisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        generationId: ids.generation,
        sourceDialogueRevisionId: ids.sourceRevision,
        translatedText: 'Sensitive target line',
      }),
    });
    expect(test.selectionCreate).toHaveBeenCalledOnce();
    const serializedAudit = JSON.stringify(test.auditCreate.mock.calls);
    expect(serializedAudit).not.toContain('Sensitive source');
    expect(serializedAudit).not.toContain('Sensitive target');
    expect(serializedAudit).not.toContain('Sensitive cultural');
    const leaseGuardSql = (test.completionLock.mock.calls[0]?.[0] as string[]).join(' ');
    expect(leaseGuardSql).toContain('leased_until > CURRENT_TIMESTAMP');
  });

  it('fails stale source input without writing or promoting a target revision', async () => {
    const test = harness({ staleSource: true });

    await test.service.processTranslation(test.job);

    expect(test.revisionCreate).not.toHaveBeenCalled();
    expect(test.transactionGenerationUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          errorCode: 'TRANSLATION_STALE_INPUT',
          status: TranslationGenerationStatus.FAILED,
        }),
      }),
    );
  });

  it('requeues retryable provider failures with a new durable outbox attempt', async () => {
    const test = harness();
    test.translate.mockRejectedValue(
      new TranslationExecutorError('TRANSLATION_EXECUTOR_SATURATED', true),
    );

    await test.service.processTranslation(test.job);

    expect(test.outboxCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        deduplicationKey: `translation-generation:${ids.generation}:attempt:2`,
        payload: { generationId: ids.generation },
      }),
    });
    expect(test.transactionGenerationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: TranslationGenerationStatus.QUEUED }),
        where: expect.objectContaining({ leasedUntil: { gt: expect.any(Date) } }),
      }),
    );
  });

  it('recovers only a lease that is still expired at compare-and-swap time', async () => {
    const test = harness();
    test.client.$queryRaw.mockResolvedValueOnce([]);
    test.client.translationGeneration.findMany.mockResolvedValue([
      { ...generation(), leasedUntil: new Date(Date.now() - 1_000) },
    ]);

    await expect(test.service.recoverExpiredGenerations()).resolves.toBe(1);

    expect(test.transactionGenerationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ leasedUntil: { lt: expect.any(Date) } }),
      }),
    );
  });

  it('treats terminal duplicate delivery as an idempotent no-op', async () => {
    const test = harness();
    test.client.translationGeneration.findFirst.mockResolvedValue(null);

    await test.service.processTranslation(test.job);

    expect(test.translate).not.toHaveBeenCalled();
    expect(test.revisionCreate).not.toHaveBeenCalled();
  });
});
