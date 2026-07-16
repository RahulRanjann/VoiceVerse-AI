import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';

import type { Environment } from '../../../config/environment';
import type { AccessContext } from '../domain/access-context';

const allowedRoles = new Set(['OWNER', 'ADMIN', 'EDITOR', 'VIEWER']);

@Injectable()
export class AccessTokenService {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly ttlSeconds: number;

  constructor(config: ConfigService<Environment, true>) {
    this.issuer = config.get('AUTH_JWT_ISSUER', { infer: true });
    this.audience = config.get('AUTH_JWT_AUDIENCE', { infer: true });
    this.ttlSeconds = config.get('AUTH_ACCESS_TOKEN_TTL_SECONDS', { infer: true });

    const privateKeyBase64 = config.get('AUTH_JWT_PRIVATE_KEY_BASE64', { infer: true });
    const publicKeyBase64 = config.get('AUTH_JWT_PUBLIC_KEY_BASE64', { infer: true });
    if (privateKeyBase64 && publicKeyBase64) {
      try {
        const privateKey = Buffer.from(privateKeyBase64, 'base64');
        const publicKey = Buffer.from(publicKeyBase64, 'base64');
        this.privateKey = privateKey.includes('-----BEGIN')
          ? createPrivateKey(privateKey)
          : createPrivateKey({ format: 'der', key: privateKey, type: 'pkcs8' });
        this.publicKey = publicKey.includes('-----BEGIN')
          ? createPublicKey(publicKey)
          : createPublicKey({ format: 'der', key: publicKey, type: 'spki' });
      } catch {
        throw new Error('Configured JWT keys are invalid.');
      }
      return;
    }

    const pair = generateKeyPairSync('ed25519');
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  get expiresInSeconds(): number {
    return this.ttlSeconds;
  }

  async issue(context: AccessContext): Promise<string> {
    const { SignJWT } = await import('jose');
    return new SignJWT({
      org: context.organizationId,
      role: context.role,
      sid: context.sessionId,
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setSubject(context.userId)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.privateKey);
  }

  async verify(token: string): Promise<AccessContext> {
    const { jwtVerify } = await import('jose');
    const { payload } = await jwtVerify(token, this.publicKey, {
      algorithms: ['EdDSA'],
      audience: this.audience,
      clockTolerance: 5,
      issuer: this.issuer,
    });

    if (
      typeof payload.sub !== 'string' ||
      typeof payload.org !== 'string' ||
      typeof payload.sid !== 'string' ||
      typeof payload.role !== 'string' ||
      !allowedRoles.has(payload.role)
    ) {
      throw new Error('Access token claims are invalid.');
    }

    return {
      organizationId: payload.org,
      role: payload.role as AccessContext['role'],
      sessionId: payload.sid,
      userId: payload.sub,
    };
  }
}
