import { describe, expect, it } from 'vitest';

import { validateVercelBuildEnvironment } from './build-environment';

describe('validateVercelBuildEnvironment', () => {
  it('does not require a hosted API for non-Vercel builds', () => {
    expect(() => validateVercelBuildEnvironment({})).not.toThrow();
  });

  it('requires an absolute secure API URL for Vercel builds', () => {
    expect(() => validateVercelBuildEnvironment({ VERCEL: '1' })).toThrow(
      /NEXT_PUBLIC_API_BASE_URL.*must be configured/,
    );
    expect(() =>
      validateVercelBuildEnvironment({
        VERCEL: '1',
        NEXT_PUBLIC_API_BASE_URL: '/v1',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
        NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
      }),
    ).toThrow(/absolute HTTPS URL/);
    expect(() =>
      validateVercelBuildEnvironment({
        VERCEL: '1',
        NEXT_PUBLIC_API_BASE_URL: 'http://api.voiceverse.test/v1',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
        NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
      }),
    ).toThrow(/HTTPS URL/);
    expect(() =>
      validateVercelBuildEnvironment({
        VERCEL: '1',
        NEXT_PUBLIC_API_BASE_URL: 'https://user:secret@api.voiceverse.test/v1',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
        NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
      }),
    ).toThrow(/embedded credentials/);
    expect(() =>
      validateVercelBuildEnvironment({
        VERCEL: '1',
        NEXT_PUBLIC_API_BASE_URL: 'https://localhost:3001/v1',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
        NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
      }),
    ).toThrow(/cannot target localhost/);
    expect(() =>
      validateVercelBuildEnvironment({
        VERCEL: '1',
        NEXT_PUBLIC_API_BASE_URL: 'https://api.voiceverse.test/v1',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
        NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co/auth/v1',
      }),
    ).toThrow(/project origin/);
  });

  it('accepts a credential-free HTTPS API URL', () => {
    expect(() =>
      validateVercelBuildEnvironment({
        VERCEL: '1',
        NEXT_PUBLIC_API_BASE_URL: 'https://api.voiceverse.test/v1',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
        NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
      }),
    ).not.toThrow();
  });

  it('requires a publishable key and rejects secret keys in the web project', () => {
    const valid = {
      NEXT_PUBLIC_API_BASE_URL: 'https://api.voiceverse.test/v1',
      NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
      VERCEL: '1',
    };

    expect(() =>
      validateVercelBuildEnvironment({
        ...valid,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'not-a-publishable-key',
      }),
    ).toThrow(/publishable Supabase key/);
    expect(() =>
      validateVercelBuildEnvironment({
        ...valid,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
        SUPABASE_SECRET_KEY: 'sb_secret_must_not_be_here',
      }),
    ).toThrow(/must not be configured/);
    expect(() =>
      validateVercelBuildEnvironment({
        ...valid,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
        SUPABASE_SERVICE_ROLE_KEY: 'legacy_service_role_must_not_be_here',
      }),
    ).toThrow(/must not be configured/);
  });
});
