import { afterEach, describe, expect, it, vi } from 'vitest';

import { getPublicSupabaseEnvironment } from './config';

describe('getPublicSupabaseEnvironment', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns only validated public Supabase configuration', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_browser');

    expect(getPublicSupabaseEnvironment()).toEqual({
      publishableKey: 'sb_publishable_browser',
      url: 'https://project.supabase.co',
    });
  });

  it('fails closed for missing, insecure, or non-publishable hosted configuration', () => {
    expect(() => getPublicSupabaseEnvironment()).toThrow(/incomplete/);

    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://project.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_browser');
    expect(() => getPublicSupabaseEnvironment()).toThrow(/HTTPS/);

    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_secret_not_allowed');
    expect(() => getPublicSupabaseEnvironment()).toThrow(/invalid/);

    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co/auth/v1');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_browser');
    expect(() => getPublicSupabaseEnvironment()).toThrow(/project origin/);
  });
});
