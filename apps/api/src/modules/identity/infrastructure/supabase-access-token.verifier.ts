import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verifyCredentials } from '@supabase/server/core';
import { z } from 'zod';

import type { Environment } from '../../../config/environment';
import type {
  ExternalAccessTokenVerifierPort,
  VerifiedExternalAccessToken,
} from '../domain/external-access-token-verifier.port';

const verifiedClaimsSchema = z
  .object({
    app_metadata: z.record(z.string(), z.unknown()),
    aud: z.union([z.string(), z.array(z.string())]),
    email: z.string().email().max(320),
    exp: z.number().int().positive(),
    iat: z.number().int().positive(),
    is_anonymous: z.boolean().optional(),
    iss: z.string().url(),
    role: z.literal('authenticated'),
    session_id: z.string().uuid(),
    sub: z.string().uuid(),
    user_metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

@Injectable()
export class SupabaseAccessTokenVerifier implements ExternalAccessTokenVerifierPort {
  private readonly audience: string;
  private readonly issuer: string;
  private readonly projectUrl: string;
  private readonly jwksUrl: URL;

  constructor(config: ConfigService<Environment, true>) {
    this.projectUrl = new URL(config.get('SUPABASE_URL', { infer: true })).origin;
    this.jwksUrl = new URL(config.get('SUPABASE_JWKS_URL', { infer: true }));
    this.audience = config.get('SUPABASE_JWT_AUDIENCE', { infer: true });
    this.issuer = `${this.projectUrl}/auth/v1`;
  }

  async verify(token: string): Promise<VerifiedExternalAccessToken> {
    const verified = await verifyCredentials(
      { apikey: null, token },
      {
        auth: 'user',
        env: {
          jwks: this.jwksUrl,
          publishableKeys: {},
          secretKeys: {},
          url: this.projectUrl,
        },
      },
    );
    if (verified.error || !verified.data.jwtClaims) {
      throw new Error('Supabase access token verification failed.');
    }

    const parsed = verifiedClaimsSchema.safeParse(verified.data.jwtClaims);
    if (!parsed.success) throw new Error('Supabase access token claims are invalid.');
    const claims = parsed.data;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== this.issuer || !audiences.includes(this.audience)) {
      throw new Error('Supabase access token issuer or audience is invalid.');
    }
    if (claims.is_anonymous) throw new Error('Anonymous Supabase identities are not accepted.');

    // app_metadata is issuer-controlled; user_metadata is not. Authorization
    // never comes from either, and the provider restriction prevents unsafe
    // email-based migration links from unverified password identities.
    const provider = claims.app_metadata.provider;
    if (provider !== 'google') {
      throw new Error('The Supabase identity provider is not enabled for VoiceVerse.');
    }

    return {
      avatarUrl: normalizedAvatarUrl(claims.user_metadata),
      displayName: normalizedDisplayName(claims.user_metadata),
      email: claims.email.toLowerCase(),
      provider,
      sessionId: claims.session_id,
      subject: claims.sub,
    };
  }
}

function normalizedDisplayName(metadata: Record<string, unknown> | undefined): string | null {
  const candidate = metadata?.full_name ?? metadata?.name;
  if (typeof candidate !== 'string') return null;
  const normalized = candidate.trim().replace(/\s+/g, ' ').slice(0, 160);
  return normalized || null;
}

function normalizedAvatarUrl(metadata: Record<string, unknown> | undefined): string | null {
  const candidate = metadata?.avatar_url ?? metadata?.picture;
  if (typeof candidate !== 'string' || candidate.length > 2_048) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
