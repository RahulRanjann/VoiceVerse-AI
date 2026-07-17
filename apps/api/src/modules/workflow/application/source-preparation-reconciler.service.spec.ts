import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService } from '../../../infrastructure/database/database.service';
import type { SourcePreparationInitializerService } from './source-preparation-initializer.service';
import { SourcePreparationReconcilerService } from './source-preparation-reconciler.service';

const video = {
  createdByUserId: '01900000-0000-7000-8000-000000000001',
  id: '01900000-0000-7000-8000-000000000020',
  organizationId: '01900000-0000-7000-8000-000000000002',
  projectId: '01900000-0000-7000-8000-000000000003',
};

function createHarness(recheckedVideo: typeof video | null = video) {
  const transactionClient = {
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    video: { findFirst: vi.fn().mockResolvedValue(recheckedVideo) },
  };
  const client = {
    $transaction: vi.fn(
      async (operation: (transaction: typeof transactionClient) => Promise<unknown>) =>
        operation(transactionClient),
    ),
    video: { findMany: vi.fn().mockResolvedValue([video]) },
  };
  const initializer = {
    initialize: vi.fn().mockResolvedValue({ attemptId: 'attempt', jobId: 'job', stageId: 'stage' }),
  };
  const service = new SourcePreparationReconcilerService(
    { client } as unknown as DatabaseService,
    initializer as unknown as SourcePreparationInitializerService,
  );
  return { client, initializer, service, transactionClient };
}

describe('SourcePreparationReconcilerService', () => {
  it('backfills a clean uploaded video through the idempotent initializer', async () => {
    const harness = createHarness();

    await expect(harness.service.reconcileBatch()).resolves.toBe(1);

    expect(harness.initializer.initialize).toHaveBeenCalledWith(harness.transactionClient, video);
    expect(harness.transactionClient.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'workflow.source_preparation.reconciled' }),
      }),
    );
  });

  it('does not initialize a video that becomes ineligible before the transaction', async () => {
    const harness = createHarness(null);

    await expect(harness.service.reconcileBatch()).resolves.toBe(0);

    expect(harness.initializer.initialize).not.toHaveBeenCalled();
  });
});
