import { describe, expect, it } from 'vitest';

import type { LatestWorkflowJob, WorkflowJobStatus } from './types';
import { isActiveWorkflowJob, workflowProgressPresentation } from './workflow-presentation';

describe('workflow progress presentation', () => {
  it.each<WorkflowJobStatus>(['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'])(
    'polls while a workflow job is %s',
    (status) => {
      expect(isActiveWorkflowJob(job(status))).toBe(true);
    },
  );

  it.each<WorkflowJobStatus>(['SUCCEEDED', 'FAILED', 'CANCELED'])(
    'stops polling when a workflow job is %s',
    (status) => {
      expect(isActiveWorkflowJob(job(status))).toBe(false);
    },
  );

  it('clamps untrusted progress and gives succeeded jobs a complete bar', () => {
    expect(workflowProgressPresentation(job('RUNNING', -10)).percent).toBe(0);
    expect(workflowProgressPresentation(job('RUNNING', 15_000)).percent).toBe(100);
    expect(workflowProgressPresentation(job('SUCCEEDED', 4_200))).toMatchObject({
      label: 'Media prepared',
      percent: 100,
      tone: 'success',
    });
  });

  it('uses preparation language for running jobs', () => {
    expect(workflowProgressPresentation(job('RUNNING', 4_200))).toMatchObject({
      label: 'Preparing media',
      percent: 42,
    });
  });

  it('uses speech-analysis language without leaking workflow identifiers', () => {
    expect(
      workflowProgressPresentation({ ...job('RUNNING', 6_700), kind: 'SPEECH_ANALYSIS' }),
    ).toMatchObject({ label: 'Analyzing dialogue', percent: 67 });
  });

  it('uses a safe generic label for a newer job kind', () => {
    expect(
      workflowProgressPresentation({ ...job('RUNNING'), kind: 'FUTURE_PROVIDER_JOB' }),
    ).toEqual({
      label: 'Processing',
      percent: 25,
      tone: 'warning',
    });
  });
});

function job(status: WorkflowJobStatus, progressBasisPoints = 2_500): LatestWorkflowJob {
  return {
    completedAt: null,
    failureCode: null,
    id: 'job-1',
    kind: 'SOURCE_PREPARATION',
    pipelineVersion: 'source-preparation-v1',
    progressBasisPoints,
    revision: 1,
    startedAt: null,
    status,
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}
