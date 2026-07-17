import type { PublicWorkflowFailure, WorkflowStageStatus } from '@/features/studio/types';

export interface StagePresentation {
  label: string;
  statusLabel: string;
  tone: 'muted' | 'warning' | 'success' | 'destructive';
}

const STAGE_LABELS: Readonly<Record<string, string>> = {
  'audio.vocals.separate': 'Separate vocals',
  'characters.resolve': 'Identify characters',
  'speech.diarize': 'Detect speakers',
  'speech.transcribe': 'Transcribe dialogue',
};

export function stagePresentation(key: string, status: WorkflowStageStatus): StagePresentation {
  const label = STAGE_LABELS[key] ?? 'Additional analysis';
  switch (status) {
    case 'QUEUED':
      return { label, statusLabel: 'Waiting', tone: 'muted' };
    case 'RUNNING':
      return { label, statusLabel: 'In progress', tone: 'warning' };
    case 'RETRY_WAIT':
      return { label, statusLabel: 'Retrying soon', tone: 'warning' };
    case 'BLOCKED':
      return { label, statusLabel: 'Waiting on earlier step', tone: 'muted' };
    case 'SUCCEEDED':
      return { label, statusLabel: 'Complete', tone: 'success' };
    case 'FAILED':
      return { label, statusLabel: 'Needs attention', tone: 'destructive' };
    case 'CANCELED':
      return { label, statusLabel: 'Canceled', tone: 'muted' };
    default:
      return { label, statusLabel: 'Status unavailable', tone: 'muted' };
  }
}

export function failurePresentation(failure?: PublicWorkflowFailure | null): {
  title: string;
  description: string;
} {
  if (!failure) {
    return {
      title: 'Analysis needs attention',
      description: 'This analysis could not finish. Try again when the source is ready.',
    };
  }

  switch (failure.category) {
    case 'INPUT':
      return {
        title: 'Source needs attention',
        description: 'We could not analyze this source. Review the uploaded media before retrying.',
      };
    case 'DEPENDENCY':
      return {
        title: 'Analysis service is unavailable',
        description: 'A processing service is temporarily unavailable. Please try again shortly.',
      };
    case 'CAPACITY':
      return {
        title: 'Analysis is delayed',
        description: 'Processing capacity is temporarily limited. Please try again shortly.',
      };
    case 'INTERNAL':
      return {
        title: 'Analysis needs attention',
        description: 'We could not finish this analysis. Please try again or contact support.',
      };
    default:
      return {
        title: 'Analysis needs attention',
        description: 'We could not finish this analysis. Please try again or contact support.',
      };
  }
}

export function formatTimecode(milliseconds: number): string {
  const safeMilliseconds = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(safeMilliseconds / 3_600_000);
  const minutes = Math.floor((safeMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMilliseconds % 60_000) / 1_000);
  const remainder = safeMilliseconds % 1_000;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':')
    .concat(`.${String(remainder).padStart(3, '0')}`);
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}
