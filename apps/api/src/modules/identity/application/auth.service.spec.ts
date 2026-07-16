import type { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { OrganizationRole, OrganizationStatus, UserStatus } from '@voiceverse/database';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import type { DatabaseService } from '../../../infrastructure/database/database.service';
import type { AccessContext } from '../domain/access-context';
import type { AccessTokenService } from './access-token.service';
import { AuthService } from './auth.service';
import { SecureValuesService } from './secure-values.service';

const userId = '01900000-0000-7000-8000-000000000001';
const organizationId = '01900000-0000-7000-8000-000000000002';
const sessionId = '01900000-0000-7000-8000-000000000003';
const familyId = '01900000-0000-7000-8000-000000000004';

function createHarness() {
  const user = {
    avatarUrl: 'https://images.example.test/avatar.png',
    displayName: 'Asha Rao',
    email: 'asha@example.test',
    id: userId,
    status: UserStatus.ACTIVE,
  };
  const organization = {
    displayName: 'Asha Studio',
    id: organizationId,
    slug: 'asha-studio',
    status: OrganizationStatus.ACTIVE,
  };
  const membership = {
    organization,
    organizationId,
    role: OrganizationRole.OWNER,
    user,
    userId,
  };
  const transactionClient = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    authSession: {
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    externalIdentity: {
      upsert: vi.fn().mockResolvedValue({ userId }),
    },
    organization: {
      create: vi.fn().mockResolvedValue(organization),
    },
    organizationMembership: {
      create: vi.fn().mockResolvedValue({
        id: '01900000-0000-7000-8000-000000000005',
        organizationId,
        role: OrganizationRole.OWNER,
        userId,
      }),
      findFirst: vi.fn().mockResolvedValue(membership),
    },
    user: {
      findUniqueOrThrow: vi.fn().mockResolvedValue(user),
      upsert: vi.fn().mockResolvedValue(user),
    },
  };

  const client = {
    $transaction: vi.fn(async (operation: unknown) => {
      if (typeof operation === 'function') {
        return (operation as (client: typeof transactionClient) => Promise<unknown>)(
          transactionClient,
        );
      }
      return Promise.all(operation as Promise<unknown>[]);
    }),
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    authSession: {
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    oAuthAuthorization: {
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    organizationMembership: {
      findUnique: vi.fn().mockResolvedValue(membership),
    },
  };

  const securityConfig = {
    get: vi.fn().mockReturnValue(Buffer.alloc(32, 4).toString('base64')),
  } as unknown as ConfigService<Environment, true>;
  const secureValues = new SecureValuesService(securityConfig);
  const accessTokens = {
    expiresInSeconds: 900,
    issue: vi.fn().mockResolvedValue('access-token'),
  } as unknown as AccessTokenService;
  const google = {
    authorizationUrl: vi.fn().mockReturnValue('https://accounts.google.test/authorize'),
    exchangeAuthorizationCode: vi.fn(),
  };
  const config = {
    get: vi.fn().mockReturnValue(30),
  } as unknown as ConfigService<Environment, true>;
  const service = new AuthService(
    { client } as unknown as DatabaseService,
    secureValues,
    accessTokens,
    config,
    google,
  );
  return {
    accessTokens,
    client,
    google,
    membership,
    organization,
    secureValues,
    service,
    transactionClient,
    user,
  };
}

function activeSession(harness: ReturnType<typeof createHarness>) {
  return {
    expiresAt: new Date(Date.now() + 86_400_000),
    familyId,
    id: sessionId,
    organization: harness.organization,
    organizationId,
    revokedAt: null,
    rotatedAt: null,
    user: harness.user,
    userId,
  };
}

describe('AuthService', () => {
  it('persists a one-time PKCE transaction and normalizes unsafe redirect paths', async () => {
    const harness = createHarness();

    await expect(harness.service.beginGoogleAuthorization('//attacker.test')).resolves.toBe(
      'https://accounts.google.test/authorize',
    );
    expect(harness.client.oAuthAuthorization.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        redirectPath: '/',
        stateHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    });
    expect(harness.google.authorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({ codeChallenge: expect.any(String), nonce: expect.any(String) }),
    );
  });

  it('completes verified Google authorization and creates a tenant-bound session', async () => {
    const harness = createHarness();
    const nonce = 'verified-nonce';
    harness.client.oAuthAuthorization.findUnique.mockResolvedValue({
      codeVerifierCiphertext: harness.secureValues.encrypt('pkce-verifier'),
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      id: '01900000-0000-7000-8000-000000000030',
      nonceHash: harness.secureValues.hash(nonce),
      redirectPath: '/studio',
    });
    harness.google.exchangeAuthorizationCode.mockResolvedValue({
      avatarUrl: harness.user.avatarUrl,
      displayName: harness.user.displayName,
      email: harness.user.email,
      emailVerified: true,
      nonce,
      subject: 'google-subject',
    });

    const result = await harness.service.completeGoogleAuthorization('code', 'state', {
      ipAddress: '127.0.0.1',
      userAgent: 'VoiceVerse Test',
    });

    expect(result).toMatchObject({
      accessToken: 'access-token',
      organization: { id: organizationId, role: OrganizationRole.OWNER },
      redirectPath: '/studio',
      user: { id: userId },
    });
    expect(harness.transactionClient.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'auth.google.signed_in' }),
      }),
    );
    expect(harness.client.authSession.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ organizationId, userId }) }),
    );
  });

  it('creates a personal organization on first sign-in', async () => {
    const harness = createHarness();
    const nonce = 'first-login-nonce';
    harness.transactionClient.organizationMembership.findFirst.mockResolvedValue(null);
    harness.client.oAuthAuthorization.findUnique.mockResolvedValue({
      codeVerifierCiphertext: harness.secureValues.encrypt('pkce-verifier'),
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      id: '01900000-0000-7000-8000-000000000031',
      nonceHash: harness.secureValues.hash(nonce),
      redirectPath: '/',
    });
    harness.google.exchangeAuthorizationCode.mockResolvedValue({
      email: harness.user.email,
      emailVerified: true,
      nonce,
      subject: 'new-google-subject',
    });

    await harness.service.completeGoogleAuthorization('code', 'state', {});

    expect(harness.transactionClient.organization.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ displayName: 'Asha Rao Studio' }),
      }),
    );
    expect(harness.transactionClient.organizationMembership.create).toHaveBeenCalled();
  });

  it('rejects expired, reused, and nonce-mismatched authorization transactions', async () => {
    const expired = createHarness();
    expired.client.oAuthAuthorization.findUnique.mockResolvedValue(null);
    await expect(
      expired.service.completeGoogleAuthorization('code', 'state', {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const reused = createHarness();
    reused.client.oAuthAuthorization.findUnique.mockResolvedValue({
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      id: '01900000-0000-7000-8000-000000000032',
    });
    reused.client.oAuthAuthorization.updateMany.mockResolvedValue({ count: 0 });
    await expect(reused.service.completeGoogleAuthorization('code', 'state', {})).rejects.toThrow(
      /already consumed/,
    );

    const mismatch = createHarness();
    mismatch.client.oAuthAuthorization.findUnique.mockResolvedValue({
      codeVerifierCiphertext: mismatch.secureValues.encrypt('verifier'),
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      id: '01900000-0000-7000-8000-000000000033',
      nonceHash: mismatch.secureValues.hash('expected'),
    });
    mismatch.google.exchangeAuthorizationCode.mockResolvedValue({
      email: 'asha@example.test',
      emailVerified: true,
      nonce: 'wrong',
      subject: 'subject',
    });
    await expect(mismatch.service.completeGoogleAuthorization('code', 'state', {})).rejects.toThrow(
      /could not be verified/,
    );
  });

  it('rotates a valid refresh token once and preserves tenant context', async () => {
    const harness = createHarness();
    harness.client.authSession.findUnique.mockResolvedValue(activeSession(harness));

    const result = await harness.service.refresh('refresh-token', {
      ipAddress: '127.0.0.1',
      userAgent: 'VoiceVerse Test',
    });

    expect(result).toMatchObject({
      accessToken: 'access-token',
      organization: { id: organizationId },
      user: { id: userId },
    });
    expect(result.refreshToken).not.toBe('refresh-token');
    expect(harness.transactionClient.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ rotatedAt: null }) }),
    );
  });

  it('revokes the full token family on reuse, expiry, or a rotation race', async () => {
    const reused = createHarness();
    reused.client.authSession.findUnique.mockResolvedValue({
      ...activeSession(reused),
      rotatedAt: new Date(),
    });
    await expect(reused.service.refresh('reused', {})).rejects.toThrow(/revoked/);
    expect(reused.client.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { familyId, revokedAt: null } }),
    );

    const expired = createHarness();
    expired.client.authSession.findUnique.mockResolvedValue({
      ...activeSession(expired),
      expiresAt: new Date(Date.now() - 1_000),
    });
    await expect(expired.service.refresh('expired', {})).rejects.toThrow(/expired/);

    const raced = createHarness();
    raced.client.authSession.findUnique.mockResolvedValue(activeSession(raced));
    raced.transactionClient.authSession.updateMany.mockResolvedValue({ count: 0 });
    await expect(raced.service.refresh('raced', {})).rejects.toThrow(/could not be rotated/);
    expect(raced.client.authSession.updateMany).toHaveBeenCalled();
  });

  it('fails refresh when the token or active membership is unavailable', async () => {
    const missing = createHarness();
    missing.client.authSession.findUnique.mockResolvedValue(null);
    await expect(missing.service.refresh('missing', {})).rejects.toThrow(/invalid/);

    const noMembership = createHarness();
    noMembership.client.authSession.findUnique.mockResolvedValue(activeSession(noMembership));
    noMembership.client.organizationMembership.findUnique.mockResolvedValue(null);
    await expect(noMembership.service.refresh('token', {})).rejects.toThrow(/membership/);
  });

  it('returns current account data only for an active membership', async () => {
    const harness = createHarness();
    const context: AccessContext = {
      organizationId,
      role: OrganizationRole.OWNER,
      sessionId,
      userId,
    };

    await expect(harness.service.me(context)).resolves.toMatchObject({
      organization: { id: organizationId },
      user: { id: userId },
    });
    harness.client.organizationMembership.findUnique.mockResolvedValue(null);
    await expect(harness.service.me(context)).rejects.toThrow(/inactive/);
  });

  it('revokes a known session family on logout and ignores an absent cookie', async () => {
    const harness = createHarness();
    await harness.service.logout(undefined);
    expect(harness.client.authSession.findUnique).not.toHaveBeenCalled();

    harness.client.authSession.findUnique.mockResolvedValue({ familyId, userId });
    await harness.service.logout('refresh-token');
    expect(harness.client.authSession.updateMany).toHaveBeenCalled();

    harness.client.authSession.findUnique.mockResolvedValue(null);
    await expect(harness.service.logout('unknown-token')).resolves.toBeUndefined();
  });
});
