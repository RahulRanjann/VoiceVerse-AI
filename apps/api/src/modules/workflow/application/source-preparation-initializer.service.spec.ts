import {
  WorkflowAttemptStatus,
  WorkflowJobKind,
  WorkflowJobStatus,
  WorkflowStageKind,
  WorkflowStageStatus,
} from '@voiceverse/database';
import { describe, expect, it, vi } from 'vitest';

import { SOURCE_PREPARATION_CONFIGURATION_HASH } from '../domain/source-preparation.constants';
import { SourcePreparationInitializerService } from './source-preparation-initializer.service';

const organizationId = '01900000-0000-7000-8000-000000000002';
const projectId = '01900000-0000-7000-8000-000000000003';
const userId = '01900000-0000-7000-8000-000000000001';
const videoId = '01900000-0000-7000-8000-000000000020';
const jobId = '01900000-0000-7000-8000-000000000030';
const stageId = '01900000-0000-7000-8000-000000000031';
const attemptId = '01900000-0000-7000-8000-000000000032';

function createTransaction() {
  return {
    outboxEvent: { upsert: vi.fn().mockResolvedValue({}) },
    project: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    workflowJob: { upsert: vi.fn().mockResolvedValue({ id: jobId }) },
    workflowStage: { upsert: vi.fn().mockResolvedValue({ id: stageId }) },
    workflowStageAttempt: {
      upsert: vi.fn().mockResolvedValue({
        commandIdempotencyKey: `workflow-attempt:${stageId}:1`,
        id: attemptId,
      }),
    },
    workflowStateTransition: { upsert: vi.fn().mockResolvedValue({}) },
  };
}

describe('SourcePreparationInitializerService', () => {
  it('creates one versioned job, stage, database attempt, and outbox command', async () => {
    const transaction = createTransaction();
    const result = await new SourcePreparationInitializerService().initialize(
      transaction as never,
      { createdByUserId: userId, id: videoId, organizationId, projectId },
    );

    expect(result).toEqual({ attemptId, jobId, stageId });
    expect(transaction.workflowJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: WorkflowJobKind.SOURCE_PREPARATION,
          status: WorkflowJobStatus.QUEUED,
        }),
      }),
    );
    expect(transaction.workflowStage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: WorkflowStageKind.SOURCE_MEDIA_PREPARATION,
          status: WorkflowStageStatus.QUEUED,
          weightBasisPoints: 10_000,
        }),
      }),
    );
    expect(transaction.workflowStageAttempt.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          configurationHash: SOURCE_PREPARATION_CONFIGURATION_HASH,
          status: WorkflowAttemptStatus.QUEUED,
        }),
      }),
    );
    expect(transaction.outboxEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          eventType: 'workflow.stage.execute',
          payload: { attemptId },
        }),
      }),
    );
    expect(transaction.workflowStateTransition.upsert).toHaveBeenCalledTimes(3);
  });
});
