import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import { SupabaseAccessTokenVerifier } from './supabase-access-token.verifier';

const verifyCredentials = vi.hoisted(() => vi.fn());

vi.mock('@supabase/server/core', () => ({ verifyCredentials }));

const subject = '01900000-0000-7000-8000-000000000001';
const sessionId = '01900000-0000-7000-8000-000000000002';

function config(): ConfigService<Environment, true> {
  const values = {
    SUPABASE_JWKS_URL: 'https://project.supabase.co/auth/v1/.well-known/jwks.json',
    SUPABASE_JWT_AUDIENCE: 'authenticated',
    SUPABASE_URL: 'https://project.supabase.co',
  };
  return {
    get: (key: keyof typeof values) => values[key],
  } as ConfigService<Environment, true>;
}

function verifiedResult(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      authMode: 'user',
      jwtClaims: {
        app_metadata: { provider: 'google' },
        aud: 'authenticated',
        email: 'Creator@Example.com',
        exp: 2_000_000_000,
        iat: 1_900_000_000,
        iss: 'https://project.supabase.co/auth/v1',
        role: 'authenticated',
        session_id: sessionId,
        sub: subject,
        user_metadata: {
          avatar_url: 'https://images.example.com/avatar.png',
          full_name: '  Voice   Creator  ',
        },
        ...overrides,
      },
      token: 'token',
      userClaims: { id: subject },
    },
    error: null,
  };
}

describe('SupabaseAccessTokenVerifier', () => {
  beforeEach(() => verifyCredentials.mockReset());

  it('verifies and normalizes a Google Supabase identity without an admin key', async () => {
    verifyCredentials.mockResolvedValue(verifiedResult());
    const verifier = new SupabaseAccessTokenVerifier(config());

    await expect(verifier.verify('signed-token')).resolves.toEqual({
      avatarUrl: 'https://images.example.com/avatar.png',
      displayName: 'Voice Creator',
      email: 'creator@example.com',
      provider: 'google',
      sessionId,
      subject,
    });
    expect(verifyCredentials).toHaveBeenCalledWith(
      { apikey: null, token: 'signed-token' },
      expect.objectContaining({
        auth: 'user',
        env: expect.objectContaining({ publishableKeys: {}, secretKeys: {} }),
      }),
    );
  });

  it.each([
    [{ iss: 'https://attacker.test/auth/v1' }, 'issuer'],
    [{ aud: 'other-service' }, 'audience'],
    [{ app_metadata: { provider: 'email' } }, 'provider'],
    [{ is_anonymous: true }, 'Anonymous'],
    [{ session_id: 'not-a-uuid' }, 'claims'],
  ])('rejects untrusted claims %#', async (claims, message) => {
    verifyCredentials.mockResolvedValue(verifiedResult(claims));
    const verifier = new SupabaseAccessTokenVerifier(config());

    await expect(verifier.verify('signed-token')).rejects.toThrow(message);
  });

  it('fails closed when package verification fails', async () => {
    verifyCredentials.mockResolvedValue({ data: null, error: new Error('invalid signature') });
    const verifier = new SupabaseAccessTokenVerifier(config());

    await expect(verifier.verify('invalid-token')).rejects.toThrow(/verification failed/);
  });
});
