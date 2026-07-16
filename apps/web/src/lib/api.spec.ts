import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiRequest } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiRequest', () => {
  it('sends JSON and bearer credentials without exposing refresh tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'project-1' }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      apiRequest<{ id: string }>(
        '/projects',
        { body: JSON.stringify({ name: 'Film' }), method: 'POST' },
        'access-token',
      ),
    ).resolves.toEqual({ id: 'project-1' });

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(request.headers);
    expect(request.credentials).toBe('include');
    expect(headers.get('authorization')).toBe('Bearer access-token');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('handles empty success responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(apiRequest<void>('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('normalizes string and array API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Project not found.' }), {
          headers: { 'content-type': 'application/json' },
          status: 404,
        }),
      ),
    );
    await expect(apiRequest('/projects/missing')).rejects.toEqual(
      new ApiError(404, 'Project not found.'),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: ['Name is required.', 'Choose a language.'] }), {
          headers: { 'content-type': 'application/json' },
          status: 400,
        }),
      ),
    );
    await expect(apiRequest('/projects')).rejects.toThrow('Name is required. Choose a language.');
  });

  it('uses a stable non-sensitive message for non-JSON failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('upstream exploded', { status: 502 })),
    );

    await expect(apiRequest('/projects')).rejects.toMatchObject({
      message: 'Request failed with status 502.',
      status: 502,
    });
  });
});
