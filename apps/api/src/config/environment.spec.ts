import { describe, expect, it } from 'vitest';

import { validateEnvironment, validateWorkerEnvironment } from './environment';

function validProductionEnvironment(): Record<string, string> {
  return {
    API_DOCS_ENABLED: 'false',
    APP_VERSION: '2026.07.17-m5',
    DATABASE_URL: 'postgresql://voiceverse:secret@database.test/voiceverse?sslmode=require',
    MEDIA_EXECUTOR_BASE_URL: 'https://media-executor.internal',
    MEDIA_EXECUTOR_BEARER_TOKEN: 'production-test-token-at-least-thirty-two-characters',
    NODE_ENV: 'production',
    OTEL_TRACES_EXPORTER: 'otlp',
    REDIS_URL: 'rediss://redis.test/0',
    S3_ACCESS_KEY: 'access',
    S3_BUCKET: 'voiceverse-production',
    S3_ENDPOINT: 'https://storage.test',
    S3_PUBLIC_ENDPOINT: 'https://media.test',
    S3_SECRET_KEY: 'secret',
    S3_SSE_ALGORITHM: 'AES256',
    SUPABASE_JWKS_URL: 'https://project.supabase.co/auth/v1/.well-known/jwks.json',
    SUPABASE_URL: 'https://project.supabase.co',
    WEB_ORIGIN: 'https://app.voiceverse.test',
  };
}

describe('validateEnvironment', () => {
  it('provides safe local development defaults', () => {
    const environment = validateEnvironment({ NODE_ENV: 'development' });

    expect(environment).toMatchObject({
      API_PORT: 3001,
      DATABASE_CONNECTION_TIMEOUT_MS: 5_000,
      DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: 30_000,
      DATABASE_IDLE_TIMEOUT_MS: 30_000,
      DATABASE_POOL_MAX: 10,
      DATABASE_STATEMENT_TIMEOUT_MS: 30_000,
      MEDIA_EXECUTOR_TIMEOUT_MS: 21_600_000,
      MEDIA_PROCESSING_CONCURRENCY: 1,
      MEDIA_SCAN_LEASE_SECONDS: 300,
      NODE_ENV: 'development',
      OTEL_TRACES_EXPORTER: 'none',
      S3_PART_SIZE_BYTES: 67_108_864,
      SPEECH_ANALYSIS_ENABLED: false,
      SPEECH_COMPLETION_TRANSACTION_TIMEOUT_MS: 300_000,
      SPEECH_MANIFEST_MAX_BYTES: 67_108_864,
      SPEECH_MANIFEST_MEMORY_BUDGET_BYTES: 67_108_864,
      SUPABASE_JWT_AUDIENCE: 'authenticated',
      SUPABASE_URL: 'http://localhost:54321',
      TRANSLATION_ENABLED: false,
      TRANSLATION_GENERATION_LEASE_SECONDS: 300,
      WORKFLOW_ATTEMPT_LEASE_SECONDS: 300,
    });
  });

  it('rejects an invalid NODE_ENV instead of falling back to development', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'prodution' })).toThrow(/NODE_ENV/);
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

  it('requires the process manifest memory budget to admit every allowed object', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'development',
        SPEECH_MANIFEST_MAX_BYTES: '2048',
        SPEECH_MANIFEST_MEMORY_BUDGET_BYTES: '1024',
      }),
    ).toThrow(/SPEECH_MANIFEST_MEMORY_BUDGET_BYTES must be greater than or equal/);

    expect(
      validateEnvironment({
        NODE_ENV: 'development',
        SPEECH_MANIFEST_MAX_BYTES: '2048',
        SPEECH_MANIFEST_MEMORY_BUDGET_BYTES: '4096',
      }),
    ).toMatchObject({
      SPEECH_MANIFEST_MAX_BYTES: 2_048,
      SPEECH_MANIFEST_MEMORY_BUDGET_BYTES: 4_096,
    });
  });

  it('requires infrastructure configuration in production', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'production' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('requires encrypted, observable, release-identifiable production infrastructure', () => {
    const valid = validProductionEnvironment();

    expect(validateEnvironment(valid)).toMatchObject({
      APP_VERSION: '2026.07.17-m5',
      NODE_ENV: 'production',
      OTEL_TRACES_EXPORTER: 'otlp',
      S3_SSE_ALGORITHM: 'AES256',
    });
    expect(validateWorkerEnvironment(valid)).toMatchObject({
      MEDIA_EXECUTOR_BASE_URL: 'https://media-executor.internal',
    });
    expect(() =>
      validateEnvironment({
        ...valid,
        DATABASE_URL: 'postgresql://voiceverse:secret@database.test/voiceverse',
      }),
    ).toThrow(/DATABASE_URL must require TLS/);
    expect(() => validateEnvironment({ ...valid, REDIS_URL: 'redis://redis.test/0' })).toThrow(
      /REDIS_URL must use rediss/,
    );
    expect(() => validateEnvironment({ ...valid, APP_VERSION: 'development' })).toThrow(
      /APP_VERSION/,
    );
    expect(() => validateEnvironment({ ...valid, OTEL_TRACES_EXPORTER: 'none' })).toThrow(
      /OTEL_TRACES_EXPORTER/,
    );
  });

  it('does not expose the media executor credential to the public API configuration', () => {
    const environment = validateEnvironment({
      MEDIA_EXECUTOR_BEARER_TOKEN: 'a-real-worker-secret-that-must-not-reach-the-api',
      NODE_ENV: 'development',
    });

    expect(environment.MEDIA_EXECUTOR_BEARER_TOKEN).toBe(
      'executor-credential-not-mounted-in-api-process',
    );
  });

  it('validates the real media executor credential for the worker runtime', () => {
    expect(() =>
      validateWorkerEnvironment({
        MEDIA_EXECUTOR_BEARER_TOKEN: 'short',
        NODE_ENV: 'development',
      }),
    ).toThrow(/MEDIA_EXECUTOR_BEARER_TOKEN/);
  });

  it('keeps speech executor credentials out of the API and requires them only for enabled workers', () => {
    const apiEnvironment = validateEnvironment({
      NODE_ENV: 'development',
      SPEECH_ANALYSIS_ENABLED: 'true',
      SPEECH_EXECUTOR_BEARER_TOKEN: 'a-real-speech-secret-that-must-not-reach-the-api',
    });
    expect(apiEnvironment.SPEECH_EXECUTOR_BEARER_TOKEN).toBe(
      'executor-credential-not-mounted-or-feature-disabled',
    );

    expect(() =>
      validateWorkerEnvironment({
        NODE_ENV: 'development',
        SPEECH_ANALYSIS_ENABLED: 'true',
        SPEECH_EXECUTOR_BEARER_TOKEN: 'short',
      }),
    ).toThrow(/SPEECH_EXECUTOR_BEARER_TOKEN/);
  });

  it('requires immutable provider and model identities before a speech worker can start', () => {
    expect(() =>
      validateWorkerEnvironment({
        NODE_ENV: 'development',
        SPEECH_ANALYSIS_ENABLED: 'true',
      }),
    ).toThrow(/VOCAL_SEPARATION_PROVIDER_NAME/);

    expect(() =>
      validateWorkerEnvironment({
        DIARIZATION_MODEL_ID: 'pyannote-community-1',
        DIARIZATION_MODEL_REVISION: 'sha-diarization',
        DIARIZATION_PROVIDER_NAME: 'pyannote',
        DIARIZATION_RUNTIME_VERSION: 'runtime-diarization',
        NODE_ENV: 'development',
        SPEECH_ANALYSIS_ENABLED: 'true',
        TRANSCRIPTION_MODEL_ID: 'large-v3',
        TRANSCRIPTION_MODEL_REVISION: 'sha-whisper',
        TRANSCRIPTION_PROVIDER_NAME: 'faster-whisper',
        TRANSCRIPTION_RUNTIME_VERSION: 'runtime-whisper',
        VOCAL_SEPARATION_MODEL_ID: 'mel-band-roformer',
        VOCAL_SEPARATION_MODEL_REVISION: 'activation-required',
        VOCAL_SEPARATION_PROVIDER_NAME: 'audio-separator',
        VOCAL_SEPARATION_RUNTIME_VERSION: 'runtime-separation',
      }),
    ).toThrow(/pinned provider and model identities/);

    expect(
      validateWorkerEnvironment({
        DIARIZATION_MODEL_ID: 'pyannote-community-1',
        DIARIZATION_MODEL_REVISION: 'sha-diarization',
        DIARIZATION_PROVIDER_NAME: 'pyannote',
        DIARIZATION_RUNTIME_VERSION: 'runtime-diarization',
        NODE_ENV: 'development',
        SPEECH_ANALYSIS_ENABLED: 'true',
        TRANSCRIPTION_MODEL_ID: 'large-v3',
        TRANSCRIPTION_MODEL_REVISION: 'sha-whisper',
        TRANSCRIPTION_PROVIDER_NAME: 'faster-whisper',
        TRANSCRIPTION_RUNTIME_VERSION: 'runtime-whisper',
        VOCAL_SEPARATION_MODEL_ID: 'mel-band-roformer',
        VOCAL_SEPARATION_MODEL_REVISION: 'sha-separation',
        VOCAL_SEPARATION_PROVIDER_NAME: 'audio-separator',
        VOCAL_SEPARATION_RUNTIME_VERSION: 'runtime-separation',
      }),
    ).toMatchObject({
      DIARIZATION_MODEL_REVISION: 'sha-diarization',
      TRANSCRIPTION_MODEL_REVISION: 'sha-whisper',
      VOCAL_SEPARATION_MODEL_REVISION: 'sha-separation',
    });
  });

  it('keeps translation credentials worker-only and pins every generation identity', () => {
    const identity = {
      TRANSLATION_MODEL_ID: 'approved-model',
      TRANSLATION_MODEL_REVISION: 'sha-model',
      TRANSLATION_PROMPT_VERSION: 'scene-translation-v1',
      TRANSLATION_PROVIDER_NAME: 'approved-provider',
      TRANSLATION_RUNTIME_VERSION: 'runtime-1',
    };
    const apiEnvironment = validateEnvironment({
      ...identity,
      NODE_ENV: 'development',
      TRANSLATION_ENABLED: 'true',
      TRANSLATION_EXECUTOR_BEARER_TOKEN: 'a-real-translation-secret-that-must-not-reach-the-api',
    });

    expect(apiEnvironment).toMatchObject({
      TRANSLATION_ENABLED: true,
      TRANSLATION_EXECUTOR_BASE_URL: 'http://127.0.0.1:1',
      TRANSLATION_EXECUTOR_BEARER_TOKEN: 'executor-credential-not-mounted-or-feature-disabled',
      TRANSLATION_MODEL_REVISION: 'sha-model',
      TRANSLATION_PROMPT_VERSION: 'scene-translation-v1',
    });
    expect(() =>
      validateWorkerEnvironment({
        ...identity,
        NODE_ENV: 'development',
        TRANSLATION_ENABLED: 'true',
        TRANSLATION_EXECUTOR_BEARER_TOKEN: 'short',
      }),
    ).toThrow(/TRANSLATION_EXECUTOR_BEARER_TOKEN/);
    expect(() =>
      validateEnvironment({
        ...identity,
        NODE_ENV: 'development',
        TRANSLATION_ENABLED: 'true',
        TRANSLATION_MODEL_REVISION: 'activation-required',
      }),
    ).toThrow(/enabled translation requires pinned/);
  });

  it('requires HTTPS for an enabled production translation executor', () => {
    const identity = {
      TRANSLATION_ENABLED: 'true',
      TRANSLATION_EXECUTOR_BEARER_TOKEN:
        'production-translation-token-at-least-thirty-two-characters',
      TRANSLATION_MODEL_ID: 'approved-model',
      TRANSLATION_MODEL_REVISION: 'sha-model',
      TRANSLATION_PROMPT_VERSION: 'scene-translation-v1',
      TRANSLATION_PROVIDER_NAME: 'approved-provider',
      TRANSLATION_RUNTIME_VERSION: 'runtime-1',
    };

    expect(() =>
      validateWorkerEnvironment({
        ...validProductionEnvironment(),
        ...identity,
        TRANSLATION_EXECUTOR_BASE_URL: 'http://translation.internal',
      }),
    ).toThrow(/TRANSLATION_EXECUTOR_BASE_URL must use HTTPS/);
    expect(
      validateWorkerEnvironment({
        ...validProductionEnvironment(),
        ...identity,
        TRANSLATION_EXECUTOR_BASE_URL: 'https://translation.internal',
      }),
    ).toMatchObject({ TRANSLATION_ENABLED: true });
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

  it('treats blank optional storage values from dotenv files as unset in development', () => {
    const environment = validateEnvironment({
      NODE_ENV: 'development',
      S3_KMS_KEY_ID: '',
    });

    expect(environment.S3_KMS_KEY_ID).toBeUndefined();
  });

  it('requires an HTTPS project-matched JWKS endpoint in production', () => {
    const base = {
      DATABASE_URL: 'postgresql://voiceverse:secret@database.test/voiceverse',
      MEDIA_EXECUTOR_BASE_URL: 'https://media-executor.internal',
      MEDIA_EXECUTOR_BEARER_TOKEN: 'production-test-token-at-least-thirty-two-characters',
      NODE_ENV: 'production',
      REDIS_URL: 'rediss://redis.test/0',
      S3_ACCESS_KEY: 'access',
      S3_BUCKET: 'voiceverse-production',
      S3_ENDPOINT: 'https://storage.test',
      S3_PUBLIC_ENDPOINT: 'https://media.test',
      S3_SECRET_KEY: 'secret',
      SUPABASE_URL: 'https://project.supabase.co',
      WEB_ORIGIN: 'https://app.voiceverse.test',
    };

    expect(() =>
      validateEnvironment({
        ...base,
        SUPABASE_JWKS_URL: 'https://attacker.test/auth/v1/.well-known/jwks.json',
      }),
    ).toThrow(/project Auth JWKS endpoint/);
    expect(() =>
      validateEnvironment({
        ...base,
        SUPABASE_JWKS_URL: 'http://project.supabase.co/auth/v1/.well-known/jwks.json',
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      validateEnvironment({
        ...base,
        SUPABASE_URL: 'https://project.supabase.co/auth/v1',
        SUPABASE_JWKS_URL: 'https://project.supabase.co/auth/v1/.well-known/jwks.json',
      }),
    ).toThrow(/project Auth JWKS endpoint/);
  });
});
