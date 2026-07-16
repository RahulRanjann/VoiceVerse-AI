import { describe, expect, it } from 'vitest';

import { GET } from './route';

describe('GET /api/health', () => {
  it('returns an uncached liveness response', async () => {
    const response = GET();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toMatchObject({
      service: 'voiceverse-web',
      status: 'ok',
    });
    expect(body.timestamp).toEqual(expect.any(String));
  });
});
