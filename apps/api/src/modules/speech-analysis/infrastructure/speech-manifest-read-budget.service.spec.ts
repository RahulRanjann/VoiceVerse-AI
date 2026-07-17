import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { Environment } from '../../../config/environment';
import { SpeechManifestReadBudgetService } from './speech-manifest-read-budget.service';

function createBudget(capacityBytes: number): SpeechManifestReadBudgetService {
  const config = {
    get: () => capacityBytes,
  } as unknown as ConfigService<Environment, true>;
  return new SpeechManifestReadBudgetService(config);
}

describe('SpeechManifestReadBudgetService', () => {
  it('enforces aggregate admission and makes saturation retryable', () => {
    const budget = createBudget(1_024);
    const first = budget.acquire(600);
    const second = budget.acquire(424);

    expect(() => budget.acquire(1)).toThrow(
      expect.objectContaining({
        code: 'SPEECH_MANIFEST_MEMORY_BUDGET_EXHAUSTED',
        retryable: true,
      }),
    );

    first.release();
    const replacement = budget.acquire(600);
    second.release();
    replacement.release();
  });

  it('releases reservations idempotently without creating phantom capacity', () => {
    const budget = createBudget(1_024);
    const reservation = budget.acquire(700);
    reservation.release();
    reservation.release();

    const replacement = budget.acquire(700);
    expect(() => budget.acquire(325)).toThrow(
      expect.objectContaining({ code: 'SPEECH_MANIFEST_MEMORY_BUDGET_EXHAUSTED' }),
    );
    replacement.release();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    'rejects invalid reservation size %s as a permanent contract error',
    (sizeBytes) => {
      const budget = createBudget(1_024);

      expect(() => budget.acquire(sizeBytes)).toThrow(
        expect.objectContaining({ code: 'SPEECH_MANIFEST_SIZE_INVALID', retryable: false }),
      );
    },
  );
});
