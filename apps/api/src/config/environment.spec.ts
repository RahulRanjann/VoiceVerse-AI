import { describe, expect, it } from 'vitest';

import { validateEnvironment } from './environment';

describe('validateEnvironment', () => {
  it('provides safe local development defaults', () => {
    const environment = validateEnvironment({ NODE_ENV: 'development' });

    expect(environment).toMatchObject({
      API_PORT: 3001,
      AUTH_ACCESS_TOKEN_TTL_SECONDS: 900,
      DATABASE_CONNECTION_TIMEOUT_MS: 5_000,
      DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: 30_000,
      DATABASE_IDLE_TIMEOUT_MS: 30_000,
      DATABASE_POOL_MAX: 10,
      DATABASE_STATEMENT_TIMEOUT_MS: 30_000,
      NODE_ENV: 'development',
      OTEL_TRACES_EXPORTER: 'none',
      S3_PART_SIZE_BYTES: 67_108_864,
    });
  });

  it('rejects unsafe database pool and timeout limits', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'development', DATABASE_POOL_MAX: '0' })).toThrow(
      /DATABASE_POOL_MAX/,
    );
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'development',
        DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '0',
      }),
    ).toThrow(/DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS/);
  });

  it('requires infrastructure configuration in production', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'production' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('does not expose a rejected database URL in the error', () => {
    const secretUrl = 'mysql://super-secret-password@database.example.com/voiceverse';

    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        DATABASE_URL: secretUrl,
      }),
    ).toThrow(/DATABASE_URL: must use the postgresql:\/\/ scheme/);

    try {
      validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: secretUrl });
    } catch (error) {
      expect(String(error)).not.toContain('super-secret-password');
    }
  });

  it('requires a KMS key when KMS encryption is selected', () => {
    expect(() =>
      validateEnvironment({ NODE_ENV: 'development', S3_SSE_ALGORITHM: 'aws:kms' }),
    ).toThrow(/S3_KMS_KEY_ID/);
  });

  it('treats blank optional values from dotenv files as unset in development', () => {
    const environment = validateEnvironment({
      AUTH_JWT_PRIVATE_KEY_BASE64: '',
      AUTH_JWT_PUBLIC_KEY_BASE64: '   ',
      AUTH_TRANSACTION_ENCRYPTION_KEY_BASE64: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      NODE_ENV: 'development',
      S3_KMS_KEY_ID: '',
    });

    expect(environment.AUTH_JWT_PRIVATE_KEY_BASE64).toBeUndefined();
    expect(environment.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(environment.S3_KMS_KEY_ID).toBeUndefined();
  });
});
