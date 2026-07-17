import { MediaArtifactKind, WorkflowJobKind, WorkflowJobStatus } from '@voiceverse/database';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService } from '../../../infrastructure/database/database.service';
import { SPEECH_ANALYSIS_PIPELINE_VERSION } from '../domain/speech-analysis.constants';
import type { SpeechAnalysisInitializerService } from './speech-analysis-initializer.service';
import { SpeechAnalysisReconcilerService } from './speech-analysis-reconciler.service';

const sourceJob = {
  createdByUserId: '01900000-0000-7000-8000-000000000001',
  id: '01900000-0000-7000-8000-000000000020',
  organizationId: '01900000-0000-7000-8000-000000000002',
  project: { sourceLanguageId: '01900000-0000-7000-8000-000000000004' },
  projectId: '01900000-0000-7000-8000-000000000003',
  sourceVideoId: '01900000-0000-7000-8000-000000000005',
};

function createHarness(options: { enabled?: boolean; sourceJobs?: (typeof sourceJob)[] } = {}) {
  const transactionClient = {};
  const client = {
    $transaction: vi.fn(
      async (operation: (transaction: typeof transactionClient) => Promise<unknown>) =>
        operation(transactionClient),
    ),
    mediaArtifact: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: '01900000-0000-7000-8000-000000000101',
          kind: MediaArtifactKind.ANALYSIS_AUDIO,
          producerAttempt: { stage: { jobId: sourceJob.id } },
        },
        {
          id: '01900000-0000-7000-8000-000000000102',
          kind: MediaArtifactKind.CANONICAL_AUDIO,
          producerAttempt: { stage: { jobId: sourceJob.id } },
        },
      ]),
    },
    workflowJob: {
      findMany: vi.fn().mockResolvedValue(options.sourceJobs ?? [sourceJob]),
    },
  };
  const initializer = {
    enabled: options.enabled ?? true,
    initialize: vi.fn().mockResolvedValue({ jobId: 'speech-job' }),
  };
  const service = new SpeechAnalysisReconcilerService(
    { client } as unknown as DatabaseService,
    initializer as unknown as SpeechAnalysisInitializerService,
  );

  return { client, initializer, service, transactionClient };
}

describe('SpeechAnalysisReconcilerService', () => {
  it('applies both required source-artifact predicates before bounding the candidate page', async () => {
    const harness = createHarness();

    await expect(harness.service.reconcileBatch(1)).resolves.toBe(1);

    expect(harness.client.workflowJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 1,
        where: expect.objectContaining({
          AND: [
            {
              stages: {
                some: {
                  attempts: {
                    some: {
                      artifacts: { some: { kind: MediaArtifactKind.ANALYSIS_AUDIO } },
                    },
                  },
                },
              },
            },
            {
              stages: {
                some: {
                  attempts: {
                    some: {
                      artifacts: { some: { kind: MediaArtifactKind.CANONICAL_AUDIO } },
                    },
                  },
                },
              },
            },
          ],
          kind: WorkflowJobKind.SOURCE_PREPARATION,
          sourceVideo: {
            workflowJobs: {
              none: {
                kind: WorkflowJobKind.SPEECH_ANALYSIS,
                pipelineVersion: SPEECH_ANALYSIS_PIPELINE_VERSION,
              },
            },
          },
          status: WorkflowJobStatus.SUCCEEDED,
        }),
      }),
    );
    expect(harness.initializer.initialize).toHaveBeenCalledWith(harness.transactionClient, {
      analysisArtifactId: '01900000-0000-7000-8000-000000000101',
      canonicalArtifactId: '01900000-0000-7000-8000-000000000102',
      createdByUserId: sourceJob.createdByUserId,
      organizationId: sourceJob.organizationId,
      projectId: sourceJob.projectId,
      sourceLanguageId: sourceJob.project.sourceLanguageId,
      sourceVideoId: sourceJob.sourceVideoId,
    });
  });

  it('does not query for candidates while speech analysis is disabled', async () => {
    const harness = createHarness({ enabled: false });

    await expect(harness.service.reconcileBatch()).resolves.toBe(0);

    expect(harness.client.workflowJob.findMany).not.toHaveBeenCalled();
    expect(harness.client.mediaArtifact.findMany).not.toHaveBeenCalled();
    expect(harness.initializer.initialize).not.toHaveBeenCalled();
  });

  it('does not query artifacts when no eligible source job exists', async () => {
    const harness = createHarness({ sourceJobs: [] });

    await expect(harness.service.reconcileBatch()).resolves.toBe(0);

    expect(harness.client.mediaArtifact.findMany).not.toHaveBeenCalled();
    expect(harness.initializer.initialize).not.toHaveBeenCalled();
  });
});
