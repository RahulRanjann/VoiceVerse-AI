import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const exchangeCodeForSession = vi.hoisted(() => vi.fn());

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { exchangeCodeForSession } }),
}));

vi.mock('@/lib/supabase/config', () => ({
  getPublicSupabaseEnvironment: () => ({
    publishableKey: 'sb_publishable_test',
    url: 'https://project.supabase.co',
  }),
}));

import { GET } from './route';

describe('Supabase OAuth callback', () => {
  beforeEach(() => exchangeCodeForSession.mockReset());

  it('exchanges the one-time code and permits only relative redirect paths', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });

    const response = await GET(
      new NextRequest('https://app.voiceverse.test/auth/callback?code=one-time&next=%2Fprojects'),
    );

    expect(exchangeCodeForSession).toHaveBeenCalledWith('one-time');
    expect(response.headers.get('location')).toBe('https://app.voiceverse.test/projects');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('rejects missing codes and open redirects with a cache-safe failure', async () => {
    const missingCode = await GET(
      new NextRequest('https://app.voiceverse.test/auth/callback?next=https://attacker.test'),
    );
    expect(missingCode.headers.get('location')).toBe(
      'https://app.voiceverse.test/login?error=oauth_callback_failed',
    );
    expect(missingCode.headers.get('cache-control')).toBe('private, no-store');
    expect(exchangeCodeForSession).not.toHaveBeenCalled();

    exchangeCodeForSession.mockResolvedValue({ error: null });
    const unsafeNext = await GET(
      new NextRequest(
        'https://app.voiceverse.test/auth/callback?code=one-time&next=%2F%2Fevil.test',
      ),
    );
    expect(unsafeNext.headers.get('location')).toBe('https://app.voiceverse.test/');

    const controlCharacterNext = await GET(
      new NextRequest(
        'https://app.voiceverse.test/auth/callback?code=one-time&next=%2Fprojects%0Aevil',
      ),
    );
    expect(controlCharacterNext.headers.get('location')).toBe('https://app.voiceverse.test/');
  });
});
