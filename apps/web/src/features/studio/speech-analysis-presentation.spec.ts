import { describe, expect, it } from 'vitest';

import {
  failurePresentation,
  formatDuration,
  formatTimecode,
  stagePresentation,
} from './speech-analysis-presentation';

describe('speech analysis presentation', () => {
  it.each([
    ['audio.vocals.separate', 'Separate vocals'],
    ['speech.transcribe', 'Transcribe dialogue'],
    ['speech.diarize', 'Detect speakers'],
    ['characters.resolve', 'Identify characters'],
  ])('maps the public stage key %s', (key, label) => {
    expect(stagePresentation(key, 'RUNNING')).toMatchObject({
      label,
      statusLabel: 'In progress',
    });
  });

  it('renders unknown stages and blocked work safely', () => {
    expect(stagePresentation('provider.private.step', 'BLOCKED')).toEqual({
      label: 'Additional analysis',
      statusLabel: 'Waiting on earlier step',
      tone: 'muted',
    });
  });

  it('never exposes internal failure codes or details', () => {
    const failure = failurePresentation({
      category: 'INTERNAL',
      code: 'PYANNOTE_GPU_WORKER_TRACE_998',
      retryable: true,
    });
    expect(JSON.stringify(failure)).not.toContain('PYANNOTE');
    expect(failure.title).toBe('Analysis needs attention');
  });

  it('formats backend milliseconds as accessible timeline values', () => {
    expect(formatTimecode(3_723_045)).toBe('01:02:03.045');
    expect(formatTimecode(-42)).toBe('00:00:00.000');
    expect(formatDuration(125_000)).toBe('2m 5s');
  });
});
