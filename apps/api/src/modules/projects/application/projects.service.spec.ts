import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrganizationRole, ProjectStatus } from '@voiceverse/database';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService } from '../../../infrastructure/database/database.service';
import type { AccessContext } from '../../identity/domain/access-context';
import { ProjectsService } from './projects.service';

const sourceLanguageId = '01900000-0000-7000-8000-000000000010';
const targetLanguageId = '01900000-0000-7000-8000-000000000011';
const context: AccessContext = {
  organizationId: '01900000-0000-7000-8000-000000000002',
  role: OrganizationRole.EDITOR,
  sessionId: '01900000-0000-7000-8000-000000000003',
  userId: '01900000-0000-7000-8000-000000000001',
};

function projectFixture(id: string, updatedAt = new Date('2026-07-16T10:00:00Z')) {
  return {
    createdAt: new Date('2026-07-15T10:00:00Z'),
    id,
    name: `Project ${id.slice(-2)}`,
    sourceLanguage: { bcp47Tag: 'en', englishName: 'English', id: sourceLanguageId },
    status: ProjectStatus.DRAFT,
    targetLanguages: [
      {
        language: { bcp47Tag: 'hi', englishName: 'Hindi', id: targetLanguageId },
      },
    ],
    updatedAt,
    videos: [],
    workflowJobs: [],
  };
}

function createHarness() {
  const languageFindMany = vi.fn();
  const projectFindMany = vi.fn();
  const projectCreate = vi.fn();
  const auditCreate = vi.fn().mockResolvedValue({});
  const transactionClient = {
    auditLog: { create: auditCreate },
    project: { create: projectCreate },
  };
  const transaction = vi.fn(
    async (operation: (client: typeof transactionClient) => Promise<unknown>) =>
      operation(transactionClient),
  );
  const client = {
    $transaction: transaction,
    language: { findMany: languageFindMany },
    project: { findMany: projectFindMany },
  };
  const service = new ProjectsService({ client } as unknown as DatabaseService);
  return { auditCreate, languageFindMany, projectCreate, projectFindMany, service };
}

describe('ProjectsService', () => {
  it('returns only enabled languages in display order', async () => {
    const harness = createHarness();
    harness.languageFindMany.mockResolvedValue([{ englishName: 'English' }]);

    await expect(harness.service.languages()).resolves.toEqual([{ englishName: 'English' }]);
    expect(harness.languageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { englishName: 'asc' }, where: { enabled: true } }),
    );
  });

  it('creates a tenant-owned project and its audit record atomically', async () => {
    const harness = createHarness();
    const created = projectFixture('01900000-0000-7000-8000-000000000020');
    harness.languageFindMany.mockResolvedValue([
      { id: sourceLanguageId },
      { id: targetLanguageId },
    ]);
    harness.projectCreate.mockResolvedValue(created);

    const result = await harness.service.create(context, {
      name: '  Monsoon Letters  ',
      sourceLanguageId,
      targetLanguageIds: [targetLanguageId],
    });

    expect(result.name).toBe(created.name);
    expect(result.targetLanguages).toEqual([created.targetLanguages[0]?.language]);
    expect(harness.projectCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Monsoon Letters',
          organizationId: context.organizationId,
          status: ProjectStatus.DRAFT,
        }),
      }),
    );
    expect(harness.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'project.created' }) }),
    );
  });

  it('rejects viewers, blank names, source/target overlap, and unavailable languages', async () => {
    const viewer = { ...context, role: OrganizationRole.VIEWER };
    const input = { name: 'Film', sourceLanguageId, targetLanguageIds: [targetLanguageId] };

    await expect(createHarness().service.create(viewer, input)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      createHarness().service.create(context, { ...input, name: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      createHarness().service.create(context, {
        ...input,
        targetLanguageIds: [sourceLanguageId],
      }),
    ).rejects.toThrow(/differ/);

    const harness = createHarness();
    harness.languageFindMany.mockResolvedValue([{ id: sourceLanguageId }]);
    await expect(harness.service.create(context, input)).rejects.toThrow(/unavailable/);
  });

  it('uses stable keyset pagination and emits an opaque next cursor', async () => {
    const harness = createHarness();
    harness.projectFindMany.mockResolvedValue([
      projectFixture('01900000-0000-7000-8000-000000000023'),
      projectFixture('01900000-0000-7000-8000-000000000022'),
      projectFixture('01900000-0000-7000-8000-000000000021'),
    ]);

    const firstPage = await harness.service.list(context, { limit: 2 });
    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    harness.projectFindMany.mockResolvedValue([]);
    await harness.service.list(context, { cursor: firstPage.nextCursor ?? undefined, limit: 2 });
    expect(harness.projectFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        take: 3,
        where: expect.objectContaining({
          organizationId: context.organizationId,
          OR: expect.any(Array),
        }),
      }),
    );
  });

  it('rejects malformed pagination cursors', async () => {
    const harness = createHarness();

    await expect(harness.service.list(context, { cursor: 'not-json', limit: 25 })).rejects.toThrow(
      /cursor is invalid/,
    );
  });
});
