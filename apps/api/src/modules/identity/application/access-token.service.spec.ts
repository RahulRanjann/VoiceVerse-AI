import type { ConfigService } from '@nestjs/config';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import type { AccessContext } from '../domain/access-context';
import { AccessTokenService } from './access-token.service';

const context: AccessContext = {
  organizationId: '01900000-0000-7000-8000-000000000002',
  role: 'OWNER',
  sessionId: '01900000-0000-7000-8000-000000000003',
  userId: '01900000-0000-7000-8000-000000000001',
};

function createService(overrides: Partial<Record<keyof Environment, unknown>> = {}) {
  const values: Partial<Record<keyof Environment, unknown>> = {
    AUTH_ACCESS_TOKEN_TTL_SECONDS: 900,
    AUTH_JWT_AUDIENCE: 'voiceverse-web',
    AUTH_JWT_ISSUER: 'voiceverse-api',
    ...overrides,
  };
  const config = {
    get: vi.fn((key: keyof Environment) => values[key]),
  } as unknown as ConfigService<Environment, true>;
  return new AccessTokenService(config);
}

describe('AccessTokenService', () => {
  it('issues and verifies short-lived tenant-scoped EdDSA tokens', async () => {
    const service = createService();
    const token = await service.issue(context);

    await expect(service.verify(token)).resolves.toEqual(context);
    expect(service.expiresInSeconds).toBe(900);
  });

  it('rejects a token signed by another key', async () => {
    const issuer = createService();
    const verifier = createService();

    await expect(verifier.verify(await issuer.issue(context))).rejects.toThrow();
  });

  it('loads configured PKCS8 and SPKI keys', async () => {
    const pair = generateKeyPairSync('ed25519');
    const service = createService({
      AUTH_JWT_PRIVATE_KEY_BASE64: pair.privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64'),
      AUTH_JWT_PUBLIC_KEY_BASE64: pair.publicKey
        .export({ format: 'der', type: 'spki' })
        .toString('base64'),
    });

    await expect(service.verify(await service.issue(context))).resolves.toEqual(context);
  });

  it('fails closed when configured keys cannot be parsed', () => {
    expect(() =>
      createService({
        AUTH_JWT_PRIVATE_KEY_BASE64: Buffer.from('invalid').toString('base64'),
        AUTH_JWT_PUBLIC_KEY_BASE64: Buffer.from('invalid').toString('base64'),
      }),
    ).toThrow(/JWT keys are invalid/);
  });
});
