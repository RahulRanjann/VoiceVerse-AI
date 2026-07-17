import { describe, expect, it } from 'vitest';

import { glossaryComparisonKey, normalizeGlossarySourceTerm } from './localization-values';

describe('glossary normalization', () => {
  it('normalizes Unicode and internal whitespace before comparison', () => {
    expect(normalizeGlossarySourceTerm('  Cafe\u0301   au   lait  ')).toBe('Café au lait');
  });

  it('matches Unicode lowercase sentinels used by the database constraint', () => {
    expect(glossaryComparisonKey('İ', false)).toBe('i\u0307');
    expect(glossaryComparisonKey('ẞ', false)).toBe('ß');
    expect(glossaryComparisonKey('İ', true)).toBe('İ');
    expect(glossaryComparisonKey('ẞ', true)).toBe('ẞ');
  });
});
