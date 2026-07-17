import type { WorkflowJob } from '@/features/studio/types';
import type { TranslationGenerationStatus } from './types';

export function hasLocalizationOutput(job: WorkflowJob): boolean {
  return (
    job.kind === 'SPEECH_ANALYSIS' &&
    job.status === 'SUCCEEDED' &&
    job.resultSummary?.transcript.availability === 'AVAILABLE' &&
    job.resultSummary.characters.availability === 'AVAILABLE'
  );
}

export function generationPresentation(status: TranslationGenerationStatus): {
  active: boolean;
  description: string;
  label: string;
  tone: 'destructive' | 'success' | 'warning';
} {
  switch (status) {
    case 'QUEUED':
      return {
        active: true,
        description: 'The scene is waiting for an available translation worker.',
        label: 'Generation queued',
        tone: 'warning',
      };
    case 'RUNNING':
      return {
        active: true,
        description: 'The scene is being translated. Editorial selections remain available.',
        label: 'Generating scene',
        tone: 'warning',
      };
    case 'SUCCEEDED':
      return {
        active: false,
        description: 'Generated target lines are ready to review and edit.',
        label: 'Generation complete',
        tone: 'success',
      };
    case 'FAILED':
      return {
        active: false,
        description: 'This scene could not be generated. Your existing edits are unchanged.',
        label: 'Generation failed',
        tone: 'destructive',
      };
  }
}

export function validateRequiredText(
  value: string,
  label: string,
  maxLength = 10_000,
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return `${label} cannot be blank.`;
  if (value.length > maxLength)
    return `${label} must be ${maxLength.toLocaleString()} characters or fewer.`;
  return null;
}

export function validateOptionalText(
  value: string,
  label: string,
  maxLength: number,
): string | null {
  if (value.length > maxLength)
    return `${label} must be ${maxLength.toLocaleString()} characters or fewer.`;
  return null;
}
