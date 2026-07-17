import { describe, expect, it } from 'vitest';

import { overlappingTurnFlags } from './speech-analysis-persistence.service';

describe('overlappingTurnFlags', () => {
  it('marks both sides of cross-speaker overlaps without marking same-speaker overlap', () => {
    expect(
      overlappingTurnFlags([
        { endUs: 100, speakerKey: 'speaker-0001', startUs: 0 },
        { endUs: 80, speakerKey: 'speaker-0001', startUs: 10 },
        { endUs: 120, speakerKey: 'speaker-0002', startUs: 50 },
        { endUs: 200, speakerKey: 'speaker-0003', startUs: 150 },
      ]),
    ).toEqual([true, true, true, false]);
  });

  it('handles dense overlap in linear memory and time', () => {
    const turns = Array.from({ length: 50_000 }, (_, index) => ({
      endUs: 100_000,
      speakerKey: `speaker-${String(index % 32).padStart(4, '0')}`,
      startUs: index,
    }));

    const flags = overlappingTurnFlags(turns);

    expect(flags).toHaveLength(turns.length);
    expect(flags.every(Boolean)).toBe(true);
  });
});
