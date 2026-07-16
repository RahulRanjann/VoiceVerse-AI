import type { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import { SecureValuesService } from './secure-values.service';

function serviceWithKey(key = Buffer.alloc(32, 7)): SecureValuesService {
  const config = {
    get: vi.fn().mockReturnValue(key.toString('base64')),
  } as unknown as ConfigService<Environment, true>;
  return new SecureValuesService(config);
}

describe('SecureValuesService', () => {
  it('round-trips authenticated ciphertext without exposing plaintext', () => {
    const service = serviceWithKey();
    const encrypted = service.encrypt('authorization-code-verifier');

    expect(encrypted).not.toContain('authorization-code-verifier');
    expect(service.decrypt(encrypted)).toBe('authorization-code-verifier');
  });

  it('rejects malformed and tampered ciphertext', () => {
    const service = serviceWithKey();
    const encrypted = service.encrypt('sensitive');
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('a') ? 'b' : 'a'}`;

    expect(() => service.decrypt('not-an-envelope')).toThrow(/malformed/);
    expect(() => service.decrypt(tampered)).toThrow(/failed authentication/);
  });

  it('produces SHA-256 hashes, PKCE challenges, and URL-safe random tokens', () => {
    const service = serviceWithKey();
    const verifier = 'voiceverse-verifier';

    expect(service.hash(verifier)).toBe(
      createHash('sha256').update(verifier, 'utf8').digest('hex'),
    );
    expect(service.pkceChallenge(verifier)).toBe(
      createHash('sha256').update(verifier, 'ascii').digest('base64url'),
    );
    expect(service.randomToken(24)).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('requires an exact 256-bit encryption key', () => {
    expect(() => serviceWithKey(Buffer.alloc(31))).toThrow(/32 bytes/);
  });
});
