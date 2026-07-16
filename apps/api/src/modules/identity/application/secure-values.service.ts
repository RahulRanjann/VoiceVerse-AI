import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import type { Environment } from '../../../config/environment';

const ENCRYPTION_VERSION = 'v1';

@Injectable()
export class SecureValuesService {
  private readonly encryptionKey: Buffer;

  constructor(config: ConfigService<Environment, true>) {
    const configured = config.get('AUTH_TRANSACTION_ENCRYPTION_KEY_BASE64', { infer: true });
    this.encryptionKey = configured ? Buffer.from(configured, 'base64') : randomBytes(32);
    if (this.encryptionKey.length !== 32) {
      throw new Error('AUTH_TRANSACTION_ENCRYPTION_KEY_BASE64 must decode to 32 bytes.');
    }
  }

  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  pkceChallenge(verifier: string): string {
    return createHash('sha256').update(verifier, 'ascii').digest('base64url');
  }

  encrypt(plaintext: string): string {
    const initializationVector = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, initializationVector);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      ENCRYPTION_VERSION,
      initializationVector.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(envelope: string): string {
    const [version, encodedIv, encodedTag, encodedCiphertext, extra] = envelope.split('.');
    if (
      version !== ENCRYPTION_VERSION ||
      !encodedIv ||
      !encodedTag ||
      !encodedCiphertext ||
      extra
    ) {
      throw new Error('Encrypted authorization transaction is malformed.');
    }

    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey,
        Buffer.from(encodedIv, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('Encrypted authorization transaction failed authentication.');
    }
  }
}
