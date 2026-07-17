import { describe, expect, it } from 'vitest';

import type { WorkflowJob } from '@/features/studio/types';
import {
  generationPresentation,
  hasLocalizationOutput,
  validateOptionalText,
  validateRequiredText,
} from './presentation';

describe('localization presentation', () => {
  it('only opens after a successful, available speech-analysis result', () => {
    const job = {
      kind: 'SPEECH_ANALYSIS',
      status: 'SUCCEEDED',
      resultSummary: {
        transcript: { availability: 'AVAILABLE' },
        characters: { availability: 'AVAILABLE' },
      },
    } as WorkflowJob;

    expect(hasLocalizationOutput(job)).toBe(true);
    expect(hasLocalizationOutput({ ...job, status: 'RUNNING' })).toBe(false);
    expect(
      hasLocalizationOutput({
        ...job,
        resultSummary: {
          ...job.resultSummary!,
          transcript: { ...job.resultSummary!.transcript, availability: 'PENDING' },
        },
      }),
    ).toBe(false);
  });

  it('presents generation failures without exposing provider error codes', () => {
    const presentation = generationPresentation('FAILED');

    expect(presentation).toMatchObject({ active: false, label: 'Generation failed' });
    expect(JSON.stringify(presentation)).not.toContain('errorCode');
  });

  it('validates required and bounded editorial text', () => {
    expect(validateRequiredText('  ', 'Target text')).toBe('Target text cannot be blank.');
    expect(validateRequiredText('Ready', 'Target text')).toBeNull();
    expect(validateOptionalText('12345', 'Title', 4)).toContain('4 characters');
  });
});
