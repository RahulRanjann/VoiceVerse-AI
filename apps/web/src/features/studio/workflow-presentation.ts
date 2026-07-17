import type { LatestWorkflowJob, WorkflowJobStatus } from './types';

const ACTIVE_JOB_STATUSES = new Set<WorkflowJobStatus>(['QUEUED', 'RUNNING', 'CANCEL_REQUESTED']);

export interface WorkflowProgressPresentation {
  label: string;
  percent: number;
  tone: 'muted' | 'warning' | 'success' | 'destructive';
}

export function isActiveWorkflowJob(job: LatestWorkflowJob | null): boolean {
  return job !== null && ACTIVE_JOB_STATUSES.has(job.status);
}

export function workflowProgressPresentation(job: LatestWorkflowJob): WorkflowProgressPresentation {
  const percent = Math.round(Math.min(10_000, Math.max(0, job.progressBasisPoints)) / 100);
  if (job.kind === 'SPEECH_ANALYSIS') {
    return speechAnalysisProgress(job.status, percent);
  }
  if (job.kind !== 'SOURCE_PREPARATION') {
    return genericProgress(job.status, percent);
  }

  switch (job.status) {
    case 'QUEUED':
      return { label: 'Waiting to prepare', percent, tone: 'warning' };
    case 'RUNNING':
      return { label: 'Preparing media', percent, tone: 'warning' };
    case 'SUCCEEDED':
      return { label: 'Media prepared', percent: 100, tone: 'success' };
    case 'FAILED':
      return { label: 'Preparation failed', percent, tone: 'destructive' };
    case 'CANCEL_REQUESTED':
      return { label: 'Canceling preparation', percent, tone: 'warning' };
    case 'CANCELED':
      return { label: 'Preparation canceled', percent, tone: 'muted' };
  }
}

function speechAnalysisProgress(
  status: WorkflowJobStatus,
  percent: number,
): WorkflowProgressPresentation {
  switch (status) {
    case 'QUEUED':
      return { label: 'Waiting to analyze', percent, tone: 'warning' };
    case 'RUNNING':
      return { label: 'Analyzing dialogue', percent, tone: 'warning' };
    case 'SUCCEEDED':
      return { label: 'Dialogue analyzed', percent: 100, tone: 'success' };
    case 'FAILED':
      return { label: 'Analysis needs attention', percent, tone: 'destructive' };
    case 'CANCEL_REQUESTED':
      return { label: 'Canceling analysis', percent, tone: 'warning' };
    case 'CANCELED':
      return { label: 'Analysis canceled', percent, tone: 'muted' };
  }
}

function genericProgress(status: WorkflowJobStatus, percent: number): WorkflowProgressPresentation {
  switch (status) {
    case 'QUEUED':
      return { label: 'Waiting to process', percent, tone: 'warning' };
    case 'RUNNING':
      return { label: 'Processing', percent, tone: 'warning' };
    case 'SUCCEEDED':
      return { label: 'Processing complete', percent: 100, tone: 'success' };
    case 'FAILED':
      return { label: 'Processing needs attention', percent, tone: 'destructive' };
    case 'CANCEL_REQUESTED':
      return { label: 'Canceling', percent, tone: 'warning' };
    case 'CANCELED':
      return { label: 'Processing canceled', percent, tone: 'muted' };
  }
}
