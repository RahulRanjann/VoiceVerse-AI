import { describe, expect, it } from 'vitest';

import { validateEnvironment } from './environment';

describe('validateEnvironment', () => {
  it('provides safe local development defaults', () => {
    const environment = validateEnvironment({ NODE_ENV: 'development' });

    expect(environment).toMatchObject({
      API_PORT: 3001,
      NODE_ENV: 'development',
      OTEL_TRACES_EXPORTER: 'none',
    });
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
});
