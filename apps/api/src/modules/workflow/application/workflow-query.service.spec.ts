import {
  MediaSecurityStatus,
  OrganizationRole,
  VideoIngestStatus,
  WorkflowJobKind,
  WorkflowJobStatus,
} from '@voiceverse/database';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService } from '../../../infrastructure/database/database.service';
import { WorkflowQueryService } from './workflow-query.service';

const jobId = '01900000-0000-7000-8000-000000000030';
const organizationId = '01900000-0000-7000-8000-000000000002';
const context = {
  organizationId,
  role: OrganizationRole.OWNER,
  sessionId: '01900000-0000-7000-8000-000000000010',
  userId: '01900000-0000-7000-8000-000000000001',
};

function workflowJob(kind: WorkflowJobKind) {
  const now = new Date('2026-07-17T00:00:00.000Z');
  return {
    completedAt: kind === WorkflowJobKind.SPEECH_ANALYSIS ? now : null,
    createdAt: now,
    failureCode: null,
    id: jobId,
    kind,
    pipelineVersion: 'v1',
    project: {
      id: '01900000-0000-7000-8000-000000000003',
      name: 'Feature film',
      sourceLanguage: {
        bcp47Tag: 'en',
        createdAt: now,
        enabled: true,
        englishName: 'English',
        id: '01900000-0000-7000-8000-000000000004',
        nativeName: 'English',
      },
      targetLanguages: [],
    },
    projectId: '01900000-0000-7000-8000-000000000003',
    revision: 7,
    sourceVideo: {
      id: '01900000-0000-7000-8000-000000000020',
      ingestStatus: VideoIngestStatus.UPLOADED,
      mediaProbes: [],
      securityStatus: MediaSecurityStatus.CLEAN,
    },
    stages: [],
    startedAt: now,
    status: WorkflowJobStatus.SUCCEEDED,
    updatedAt: now,
  };
}

function activeSpeechJob() {
  return {
    ...workflowJob(WorkflowJobKind.SPEECH_ANALYSIS),
    completedAt: null,
    status: WorkflowJobStatus.RUNNING,
  };
}

describe('WorkflowQueryService speech-analysis detail', () => {
  it('returns project context and a bounded committed-result summary', async () => {
    const client = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          characterCount: 3n,
          hasCharacters: true,
          hasTranscript: true,
          segmentCount: 12n,
          transcribedDurationUs: 8_765_432n,
        },
      ]),
      workflowJob: {
        findFirst: vi.fn().mockResolvedValue(workflowJob(WorkflowJobKind.SPEECH_ANALYSIS)),
      },
    };
    const service = new WorkflowQueryService({ client } as unknown as DatabaseService);

    const result = await service.get(context, jobId);

    expect(result).toMatchObject({
      project: { name: 'Feature film', sourceLanguage: { bcp47Tag: 'en' } },
      resultSummary: {
        characters: { availability: 'AVAILABLE', count: 3 },
        transcript: {
          availability: 'AVAILABLE',
          segmentCount: 12,
          transcribedDurationMs: 8_765,
        },
      },
    });
  });

  it('does not run speech aggregates for source-preparation jobs', async () => {
    const client = {
      $queryRaw: vi.fn(),
      workflowJob: {
        findFirst: vi.fn().mockResolvedValue(workflowJob(WorkflowJobKind.SOURCE_PREPARATION)),
      },
    };
    const service = new WorkflowQueryService({ client } as unknown as DatabaseService);

    const result = await service.get(context, jobId);

    expect(result.resultSummary).toBeNull();
    expect(client.$queryRaw).not.toHaveBeenCalled();
  });

  it('does not scan partial transcript results while an analysis job is active', async () => {
    const client = {
      $queryRaw: vi.fn(),
      workflowJob: { findFirst: vi.fn().mockResolvedValue(activeSpeechJob()) },
    };
    const service = new WorkflowQueryService({ client } as unknown as DatabaseService);

    const result = await service.get(context, jobId);

    expect(result.resultSummary).toEqual({
      characters: { availability: 'PENDING', count: 0 },
      transcript: { availability: 'PENDING', segmentCount: 0, transcribedDurationMs: 0 },
    });
    expect(client.$queryRaw).not.toHaveBeenCalled();
  });
});
