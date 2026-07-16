import { describe, expect, it } from 'vitest';

import { uuidv7 } from './uuid';

describe('uuidv7', () => {
  it('generates RFC 9562 version and variant bits', () => {
    const value = uuidv7(1_700_000_000_000);

    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is unique and lexically monotonic for calls in the same process', () => {
    const values = Array.from({ length: 64 }, () => uuidv7(1_700_000_000_000));

    expect(new Set(values)).toHaveLength(values.length);
    expect([...values].sort()).toEqual(values);
  });

  it('does not move backwards when the supplied clock regresses', () => {
    const first = uuidv7(1_800_000_000_000);
    const second = uuidv7(1_700_000_000_000);

    expect(second > first).toBe(true);
  });
});
