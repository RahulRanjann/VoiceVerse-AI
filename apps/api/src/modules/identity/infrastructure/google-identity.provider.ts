import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { Environment } from '../../../config/environment';
import type {
  IdentityAuthorizationRequest,
  IdentityProviderPort,
  VerifiedExternalIdentity,
} from '../domain/identity-provider.port';

const tokenResponseSchema = z.object({
  id_token: z.string().min(1),
});

@Injectable()
export class GoogleIdentityProvider implements IdentityProviderPort {
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly redirectUri: string;

  constructor(config: ConfigService<Environment, true>) {
    this.clientId = config.get('GOOGLE_CLIENT_ID', { infer: true });
    this.clientSecret = config.get('GOOGLE_CLIENT_SECRET', { infer: true });
    this.redirectUri = config.get('GOOGLE_REDIRECT_URI', { infer: true });
  }

  authorizationUrl(request: IdentityAuthorizationRequest): string {
    const clientId = this.requireConfiguration();
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: clientId,
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
      nonce: request.nonce,
      prompt: 'select_account',
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: request.state,
    }).toString();
    return url.toString();
  }

  async exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
  ): Promise<VerifiedExternalIdentity> {
    const clientId = this.requireConfiguration();
    const response = await fetch('https://oauth2.googleapis.com/token', {
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: this.clientSecret ?? '',
        code,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: this.redirectUri,
      }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new UnauthorizedException('Google authorization code exchange failed.');
    }

    const parsed = tokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new UnauthorizedException('Google token response was invalid.');
    }

    const { createRemoteJWKSet, jwtVerify } = await import('jose');
    const keySet = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
    const { payload } = await jwtVerify(parsed.data.id_token, keySet, {
      algorithms: ['RS256'],
      audience: clientId,
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
    });
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.email !== 'string' ||
      typeof payload.email_verified !== 'boolean'
    ) {
      throw new UnauthorizedException('Google identity claims were incomplete.');
    }

    return {
      avatarUrl: typeof payload.picture === 'string' ? payload.picture : undefined,
      displayName: typeof payload.name === 'string' ? payload.name : undefined,
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified,
      nonce: typeof payload.nonce === 'string' ? payload.nonce : undefined,
      subject: payload.sub,
    };
  }

  private requireConfiguration(): string {
    if (!this.clientId || !this.clientSecret) {
      throw new ServiceUnavailableException('Google sign-in is not configured.');
    }
    return this.clientId;
  }
}
