import { z } from 'zod';

const nodeEnvironmentSchema = z.enum(['development', 'test', 'production']);
const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const booleanFromEnvironment = z.enum(['true', 'false']).transform((value) => value === 'true');

function optionalEnvironmentValue(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

const environmentSchema = z.object({
  NODE_ENV: nodeEnvironmentSchema,
  API_HOST: z.string().min(1),
  API_PORT: z.coerce.number().int().min(1).max(65_535),
  WORKER_HOST: z.string().min(1),
  WORKER_PORT: z.coerce.number().int().min(1).max(65_535),
  API_DOCS_ENABLED: booleanFromEnvironment,
  APP_VERSION: z.string().min(1),
  DATABASE_URL: z.string().refine((value) => value.startsWith('postgresql://'), {
    message: 'must use the postgresql:// scheme',
  }),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000),
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000),
  REDIS_URL: z
    .string()
    .refine((value) => value.startsWith('redis://') || value.startsWith('rediss://'), {
      message: 'must use the redis:// or rediss:// scheme',
    }),
  WEB_ORIGIN: z.string().url(),
  LOG_LEVEL: logLevelSchema,
  OTEL_TRACES_EXPORTER: z.enum(['none', 'otlp']),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url(),
  OTEL_SERVICE_NAMESPACE: z.string().min(1),
  OTEL_SERVICE_NAME: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_JWKS_URL: z.string().url(),
  SUPABASE_JWT_AUDIENCE: z.string().min(1).max(200),
  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(3).max(255),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: booleanFromEnvironment,
  S3_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600),
  S3_MULTIPART_EXPIRY_HOURS: z.coerce.number().int().min(1).max(168),
  S3_PART_SIZE_BYTES: z.coerce.number().int().min(5_242_880).max(2_147_483_647),
  S3_SSE_ALGORITHM: z.enum(['none', 'AES256', 'aws:kms']),
  S3_KMS_KEY_ID: z.string().min(1).optional(),
  UPLOAD_MAX_BYTES: z.coerce.number().int().min(5_242_880).max(5_497_558_138_880),
  CLAMAV_HOST: z.string().min(1),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65_535),
  CLAMAV_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000),
  CLAMAV_SCAN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000),
  CLAMAV_CHUNK_BYTES: z.coerce.number().int().min(4_096).max(4_194_304),
  MEDIA_SCAN_LEASE_SECONDS: z.coerce.number().int().min(30).max(3_600),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000),
  OUTBOX_LEASE_SECONDS: z.coerce.number().int().min(5).max(600),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64),
  MEDIA_PROCESSING_CONCURRENCY: z.coerce.number().int().min(1).max(16),
  MEDIA_EXECUTOR_BASE_URL: z.string().url(),
  MEDIA_EXECUTOR_BEARER_TOKEN: z.string().min(32).max(512),
  MEDIA_EXECUTOR_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(86_400_000),
  SPEECH_ANALYSIS_ENABLED: booleanFromEnvironment,
  VOCAL_SEPARATION_EXECUTOR_BASE_URL: z.string().url(),
  TRANSCRIPTION_EXECUTOR_BASE_URL: z.string().url(),
  DIARIZATION_EXECUTOR_BASE_URL: z.string().url(),
  SPEECH_EXECUTOR_BEARER_TOKEN: z.string().min(32).max(512),
  VOCAL_SEPARATION_PROVIDER_NAME: z.string().min(1).max(100),
  VOCAL_SEPARATION_MODEL_ID: z.string().min(1).max(128),
  VOCAL_SEPARATION_MODEL_REVISION: z.string().min(1).max(128),
  VOCAL_SEPARATION_RUNTIME_VERSION: z.string().min(1).max(128),
  TRANSCRIPTION_PROVIDER_NAME: z.string().min(1).max(100),
  TRANSCRIPTION_MODEL_ID: z.string().min(1).max(128),
  TRANSCRIPTION_MODEL_REVISION: z.string().min(1).max(128),
  TRANSCRIPTION_RUNTIME_VERSION: z.string().min(1).max(128),
  DIARIZATION_PROVIDER_NAME: z.string().min(1).max(100),
  DIARIZATION_MODEL_ID: z.string().min(1).max(128),
  DIARIZATION_MODEL_REVISION: z.string().min(1).max(128),
  DIARIZATION_RUNTIME_VERSION: z.string().min(1).max(128),
  VOCAL_SEPARATION_EXECUTOR_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(86_400_000),
  TRANSCRIPTION_EXECUTOR_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(86_400_000),
  DIARIZATION_EXECUTOR_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(86_400_000),
  VOCAL_SEPARATION_CONCURRENCY: z.coerce.number().int().min(1).max(16),
  TRANSCRIPTION_CONCURRENCY: z.coerce.number().int().min(1).max(16),
  DIARIZATION_CONCURRENCY: z.coerce.number().int().min(1).max(16),
  CHARACTER_IDENTIFICATION_CONCURRENCY: z.coerce.number().int().min(1).max(32),
  SPEECH_MANIFEST_MAX_BYTES: z.coerce.number().int().min(1_024).max(268_435_456),
  SPEECH_MANIFEST_MEMORY_BUDGET_BYTES: z.coerce.number().int().min(1_024).max(536_870_912),
  SPEECH_COMPLETION_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(900_000),
  WORKFLOW_ATTEMPT_LEASE_SECONDS: z.coerce.number().int().min(30).max(3_600),
  TRANSLATION_ENABLED: booleanFromEnvironment,
  TRANSLATION_EXECUTOR_BASE_URL: z.string().url(),
  TRANSLATION_EXECUTOR_BEARER_TOKEN: z.string().min(32).max(512),
  TRANSLATION_PROVIDER_NAME: z.string().min(1).max(100),
  TRANSLATION_MODEL_ID: z.string().min(1).max(128),
  TRANSLATION_MODEL_REVISION: z.string().min(1).max(128),
  TRANSLATION_RUNTIME_VERSION: z.string().min(1).max(128),
  TRANSLATION_PROMPT_VERSION: z.string().min(1).max(100),
  TRANSLATION_EXECUTOR_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000),
  TRANSLATION_CONCURRENCY: z.coerce.number().int().min(1).max(32),
  TRANSLATION_GENERATION_LEASE_SECONDS: z.coerce.number().int().min(30).max(3_600),
});

export type Environment = z.infer<typeof environmentSchema>;
type ServiceRole = 'api' | 'worker';

/**
 * Validates and normalizes configuration once during bootstrap. Development
 * defaults are intentionally unusable outside localhost; production requires
 * every external connection value to be supplied explicitly.
 */
function validateEnvironmentForRole(
  raw: Record<string, unknown>,
  serviceRole: ServiceRole,
): Environment {
  const parsedNodeEnvironment = nodeEnvironmentSchema.safeParse(raw.NODE_ENV ?? 'development');
  if (!parsedNodeEnvironment.success) {
    throw new Error(
      'Invalid environment configuration: NODE_ENV must be development, test, or production',
    );
  }
  const nodeEnvironment = parsedNodeEnvironment.data;
  const isProduction = nodeEnvironment === 'production';
  const speechAnalysisEnabled = raw.SPEECH_ANALYSIS_ENABLED === 'true';
  const speechExecutorRequired = serviceRole === 'worker' && speechAnalysisEnabled;
  const translationEnabled = raw.TRANSLATION_ENABLED === 'true';
  const translationExecutorRequired = serviceRole === 'worker' && translationEnabled;

  const candidate = {
    ...raw,
    NODE_ENV: nodeEnvironment,
    API_HOST: raw.API_HOST ?? '0.0.0.0',
    API_PORT: raw.API_PORT ?? '3001',
    WORKER_HOST: raw.WORKER_HOST ?? '0.0.0.0',
    WORKER_PORT: raw.WORKER_PORT ?? '3002',
    API_DOCS_ENABLED: raw.API_DOCS_ENABLED ?? (isProduction ? 'false' : 'true'),
    APP_VERSION: raw.APP_VERSION ?? 'development',
    DATABASE_URL:
      raw.DATABASE_URL ??
      (isProduction
        ? undefined
        : 'postgresql://voiceverse:voiceverse_local_only@localhost:5432/voiceverse'),
    DATABASE_POOL_MAX: raw.DATABASE_POOL_MAX ?? '10',
    DATABASE_CONNECTION_TIMEOUT_MS: raw.DATABASE_CONNECTION_TIMEOUT_MS ?? '5000',
    DATABASE_IDLE_TIMEOUT_MS: raw.DATABASE_IDLE_TIMEOUT_MS ?? '30000',
    DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: raw.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS ?? '30000',
    DATABASE_STATEMENT_TIMEOUT_MS: raw.DATABASE_STATEMENT_TIMEOUT_MS ?? '30000',
    REDIS_URL: raw.REDIS_URL ?? (isProduction ? undefined : 'redis://localhost:6379/0'),
    WEB_ORIGIN: raw.WEB_ORIGIN ?? (isProduction ? undefined : 'http://localhost:3000'),
    LOG_LEVEL: raw.LOG_LEVEL ?? 'info',
    OTEL_TRACES_EXPORTER: raw.OTEL_TRACES_EXPORTER ?? 'none',
    OTEL_EXPORTER_OTLP_ENDPOINT: raw.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',
    OTEL_SERVICE_NAMESPACE: raw.OTEL_SERVICE_NAMESPACE ?? 'voiceverse',
    OTEL_SERVICE_NAME: raw.OTEL_SERVICE_NAME ?? 'voiceverse-api',
    SUPABASE_URL: raw.SUPABASE_URL ?? (isProduction ? undefined : 'http://localhost:54321'),
    SUPABASE_JWKS_URL:
      raw.SUPABASE_JWKS_URL ??
      (isProduction ? undefined : 'http://localhost:54321/auth/v1/.well-known/jwks.json'),
    SUPABASE_JWT_AUDIENCE: raw.SUPABASE_JWT_AUDIENCE ?? 'authenticated',
    S3_ENDPOINT: raw.S3_ENDPOINT ?? (isProduction ? undefined : 'http://localhost:9000'),
    S3_PUBLIC_ENDPOINT:
      raw.S3_PUBLIC_ENDPOINT ?? (isProduction ? undefined : 'http://localhost:9000'),
    S3_REGION: raw.S3_REGION ?? 'us-east-1',
    S3_BUCKET: raw.S3_BUCKET ?? (isProduction ? undefined : 'voiceverse-local'),
    S3_ACCESS_KEY: raw.S3_ACCESS_KEY ?? (isProduction ? undefined : 'voiceverse_local'),
    S3_SECRET_KEY: raw.S3_SECRET_KEY ?? (isProduction ? undefined : 'voiceverse_local_only'),
    S3_FORCE_PATH_STYLE: raw.S3_FORCE_PATH_STYLE ?? (isProduction ? 'false' : 'true'),
    S3_SIGNED_URL_TTL_SECONDS: raw.S3_SIGNED_URL_TTL_SECONDS ?? '900',
    S3_MULTIPART_EXPIRY_HOURS: raw.S3_MULTIPART_EXPIRY_HOURS ?? '24',
    S3_PART_SIZE_BYTES: raw.S3_PART_SIZE_BYTES ?? '67108864',
    S3_SSE_ALGORITHM: raw.S3_SSE_ALGORITHM ?? (isProduction ? 'AES256' : 'none'),
    S3_KMS_KEY_ID: optionalEnvironmentValue(raw.S3_KMS_KEY_ID),
    UPLOAD_MAX_BYTES: raw.UPLOAD_MAX_BYTES ?? '21474836480',
    CLAMAV_HOST: raw.CLAMAV_HOST ?? 'localhost',
    CLAMAV_PORT: raw.CLAMAV_PORT ?? '3310',
    CLAMAV_CONNECT_TIMEOUT_MS: raw.CLAMAV_CONNECT_TIMEOUT_MS ?? '5000',
    CLAMAV_SCAN_TIMEOUT_MS: raw.CLAMAV_SCAN_TIMEOUT_MS ?? '1800000',
    CLAMAV_CHUNK_BYTES: raw.CLAMAV_CHUNK_BYTES ?? '1048576',
    MEDIA_SCAN_LEASE_SECONDS: raw.MEDIA_SCAN_LEASE_SECONDS ?? '300',
    OUTBOX_POLL_INTERVAL_MS: raw.OUTBOX_POLL_INTERVAL_MS ?? '1000',
    OUTBOX_LEASE_SECONDS: raw.OUTBOX_LEASE_SECONDS ?? '30',
    WORKER_CONCURRENCY: raw.WORKER_CONCURRENCY ?? '2',
    MEDIA_PROCESSING_CONCURRENCY: raw.MEDIA_PROCESSING_CONCURRENCY ?? '1',
    MEDIA_EXECUTOR_BASE_URL:
      serviceRole === 'worker'
        ? (raw.MEDIA_EXECUTOR_BASE_URL ?? (isProduction ? undefined : 'http://localhost:8000'))
        : 'http://127.0.0.1:1',
    MEDIA_EXECUTOR_BEARER_TOKEN:
      serviceRole === 'worker'
        ? (raw.MEDIA_EXECUTOR_BEARER_TOKEN ??
          (isProduction ? undefined : 'voiceverse-local-media-executor-token'))
        : 'executor-credential-not-mounted-in-api-process',
    MEDIA_EXECUTOR_TIMEOUT_MS: raw.MEDIA_EXECUTOR_TIMEOUT_MS ?? '21600000',
    SPEECH_ANALYSIS_ENABLED: raw.SPEECH_ANALYSIS_ENABLED ?? 'false',
    VOCAL_SEPARATION_EXECUTOR_BASE_URL: speechExecutorRequired
      ? (raw.VOCAL_SEPARATION_EXECUTOR_BASE_URL ??
        (isProduction ? undefined : 'http://localhost:8000'))
      : 'http://127.0.0.1:1',
    TRANSCRIPTION_EXECUTOR_BASE_URL: speechExecutorRequired
      ? (raw.TRANSCRIPTION_EXECUTOR_BASE_URL ??
        (isProduction ? undefined : 'http://localhost:8000'))
      : 'http://127.0.0.1:1',
    DIARIZATION_EXECUTOR_BASE_URL: speechExecutorRequired
      ? (raw.DIARIZATION_EXECUTOR_BASE_URL ?? (isProduction ? undefined : 'http://localhost:8000'))
      : 'http://127.0.0.1:1',
    SPEECH_EXECUTOR_BEARER_TOKEN: speechExecutorRequired
      ? (raw.SPEECH_EXECUTOR_BEARER_TOKEN ??
        (isProduction ? undefined : 'voiceverse-local-media-executor-token'))
      : 'executor-credential-not-mounted-or-feature-disabled',
    VOCAL_SEPARATION_PROVIDER_NAME: speechExecutorRequired
      ? raw.VOCAL_SEPARATION_PROVIDER_NAME
      : 'feature-disabled',
    VOCAL_SEPARATION_MODEL_ID: speechExecutorRequired
      ? raw.VOCAL_SEPARATION_MODEL_ID
      : 'feature-disabled',
    VOCAL_SEPARATION_MODEL_REVISION: speechExecutorRequired
      ? raw.VOCAL_SEPARATION_MODEL_REVISION
      : 'feature-disabled',
    VOCAL_SEPARATION_RUNTIME_VERSION: speechExecutorRequired
      ? raw.VOCAL_SEPARATION_RUNTIME_VERSION
      : 'feature-disabled',
    TRANSCRIPTION_PROVIDER_NAME: speechExecutorRequired
      ? raw.TRANSCRIPTION_PROVIDER_NAME
      : 'feature-disabled',
    TRANSCRIPTION_MODEL_ID: speechExecutorRequired
      ? raw.TRANSCRIPTION_MODEL_ID
      : 'feature-disabled',
    TRANSCRIPTION_MODEL_REVISION: speechExecutorRequired
      ? raw.TRANSCRIPTION_MODEL_REVISION
      : 'feature-disabled',
    TRANSCRIPTION_RUNTIME_VERSION: speechExecutorRequired
      ? raw.TRANSCRIPTION_RUNTIME_VERSION
      : 'feature-disabled',
    DIARIZATION_PROVIDER_NAME: speechExecutorRequired
      ? raw.DIARIZATION_PROVIDER_NAME
      : 'feature-disabled',
    DIARIZATION_MODEL_ID: speechExecutorRequired ? raw.DIARIZATION_MODEL_ID : 'feature-disabled',
    DIARIZATION_MODEL_REVISION: speechExecutorRequired
      ? raw.DIARIZATION_MODEL_REVISION
      : 'feature-disabled',
    DIARIZATION_RUNTIME_VERSION: speechExecutorRequired
      ? raw.DIARIZATION_RUNTIME_VERSION
      : 'feature-disabled',
    VOCAL_SEPARATION_EXECUTOR_TIMEOUT_MS: raw.VOCAL_SEPARATION_EXECUTOR_TIMEOUT_MS ?? '21600000',
    TRANSCRIPTION_EXECUTOR_TIMEOUT_MS: raw.TRANSCRIPTION_EXECUTOR_TIMEOUT_MS ?? '21600000',
    DIARIZATION_EXECUTOR_TIMEOUT_MS: raw.DIARIZATION_EXECUTOR_TIMEOUT_MS ?? '21600000',
    VOCAL_SEPARATION_CONCURRENCY: raw.VOCAL_SEPARATION_CONCURRENCY ?? '1',
    TRANSCRIPTION_CONCURRENCY: raw.TRANSCRIPTION_CONCURRENCY ?? '1',
    DIARIZATION_CONCURRENCY: raw.DIARIZATION_CONCURRENCY ?? '1',
    CHARACTER_IDENTIFICATION_CONCURRENCY: raw.CHARACTER_IDENTIFICATION_CONCURRENCY ?? '2',
    SPEECH_MANIFEST_MAX_BYTES: raw.SPEECH_MANIFEST_MAX_BYTES ?? '67108864',
    SPEECH_MANIFEST_MEMORY_BUDGET_BYTES: raw.SPEECH_MANIFEST_MEMORY_BUDGET_BYTES ?? '67108864',
    SPEECH_COMPLETION_TRANSACTION_TIMEOUT_MS:
      raw.SPEECH_COMPLETION_TRANSACTION_TIMEOUT_MS ?? '300000',
    WORKFLOW_ATTEMPT_LEASE_SECONDS: raw.WORKFLOW_ATTEMPT_LEASE_SECONDS ?? '300',
    TRANSLATION_ENABLED: raw.TRANSLATION_ENABLED ?? 'false',
    TRANSLATION_EXECUTOR_BASE_URL: translationExecutorRequired
      ? (raw.TRANSLATION_EXECUTOR_BASE_URL ?? (isProduction ? undefined : 'http://localhost:8000'))
      : 'http://127.0.0.1:1',
    TRANSLATION_EXECUTOR_BEARER_TOKEN: translationExecutorRequired
      ? (raw.TRANSLATION_EXECUTOR_BEARER_TOKEN ??
        (isProduction ? undefined : 'voiceverse-local-media-executor-token'))
      : 'executor-credential-not-mounted-or-feature-disabled',
    TRANSLATION_PROVIDER_NAME: translationEnabled
      ? raw.TRANSLATION_PROVIDER_NAME
      : 'feature-disabled',
    TRANSLATION_MODEL_ID: translationEnabled ? raw.TRANSLATION_MODEL_ID : 'feature-disabled',
    TRANSLATION_MODEL_REVISION: translationEnabled
      ? raw.TRANSLATION_MODEL_REVISION
      : 'feature-disabled',
    TRANSLATION_RUNTIME_VERSION: translationEnabled
      ? raw.TRANSLATION_RUNTIME_VERSION
      : 'feature-disabled',
    TRANSLATION_PROMPT_VERSION: translationEnabled
      ? raw.TRANSLATION_PROMPT_VERSION
      : 'feature-disabled',
    TRANSLATION_EXECUTOR_TIMEOUT_MS: raw.TRANSLATION_EXECUTOR_TIMEOUT_MS ?? '300000',
    TRANSLATION_CONCURRENCY: raw.TRANSLATION_CONCURRENCY ?? '2',
    TRANSLATION_GENERATION_LEASE_SECONDS: raw.TRANSLATION_GENERATION_LEASE_SECONDS ?? '300',
  };

  const result = environmentSchema.safeParse(candidate);
  if (!result.success) {
    // Zod issue messages contain paths and constraints, not secret values.
    const summary = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${summary}`);
  }

  const environment = result.data;
  if (environment.SPEECH_MANIFEST_MEMORY_BUDGET_BYTES < environment.SPEECH_MANIFEST_MAX_BYTES) {
    throw new Error(
      'Invalid environment configuration: SPEECH_MANIFEST_MEMORY_BUDGET_BYTES must be greater than or equal to SPEECH_MANIFEST_MAX_BYTES',
    );
  }
  if (isProduction) {
    const supabaseUrl = new URL(environment.SUPABASE_URL);
    const jwksUrl = new URL(environment.SUPABASE_JWKS_URL);
    if (supabaseUrl.protocol !== 'https:' || jwksUrl.protocol !== 'https:') {
      throw new Error('Invalid environment configuration: Supabase endpoints must use HTTPS');
    }
  }

  const supabaseUrl = new URL(environment.SUPABASE_URL);
  const jwksUrl = new URL(environment.SUPABASE_JWKS_URL);
  if (
    supabaseUrl.pathname !== '/' ||
    supabaseUrl.search ||
    supabaseUrl.hash ||
    supabaseUrl.username ||
    supabaseUrl.password ||
    supabaseUrl.origin !== jwksUrl.origin ||
    jwksUrl.pathname !== '/auth/v1/.well-known/jwks.json' ||
    jwksUrl.search ||
    jwksUrl.hash ||
    jwksUrl.username ||
    jwksUrl.password
  ) {
    throw new Error(
      'Invalid environment configuration: SUPABASE_JWKS_URL must be the project Auth JWKS endpoint',
    );
  }
  if (environment.S3_SSE_ALGORITHM === 'aws:kms' && !environment.S3_KMS_KEY_ID) {
    throw new Error(
      'Invalid environment configuration: S3_KMS_KEY_ID is required for aws:kms encryption',
    );
  }
  if (isProduction) {
    const databaseUrl = new URL(environment.DATABASE_URL);
    const sslMode = databaseUrl.searchParams.get('sslmode');
    if (!sslMode || !['require', 'verify-ca', 'verify-full'].includes(sslMode)) {
      throw new Error(
        'Invalid environment configuration: DATABASE_URL must require TLS in production',
      );
    }
    if (environment.REDIS_URL.startsWith('redis://')) {
      throw new Error(
        'Invalid environment configuration: REDIS_URL must use rediss:// in production',
      );
    }
    for (const [name, value] of [
      ['WEB_ORIGIN', environment.WEB_ORIGIN],
      ['S3_ENDPOINT', environment.S3_ENDPOINT],
      ['S3_PUBLIC_ENDPOINT', environment.S3_PUBLIC_ENDPOINT],
    ] as const) {
      if (new URL(value).protocol !== 'https:') {
        throw new Error(`Invalid environment configuration: ${name} must use HTTPS in production`);
      }
    }
    if (environment.APP_VERSION === 'development') {
      throw new Error(
        'Invalid environment configuration: APP_VERSION must identify the production release',
      );
    }
    if (environment.API_DOCS_ENABLED) {
      throw new Error(
        'Invalid environment configuration: API_DOCS_ENABLED must be false in production',
      );
    }
    if (environment.OTEL_TRACES_EXPORTER !== 'otlp') {
      throw new Error(
        'Invalid environment configuration: OTEL_TRACES_EXPORTER must be otlp in production',
      );
    }
    if (environment.S3_SSE_ALGORITHM === 'none') {
      throw new Error(
        'Invalid environment configuration: S3 server-side encryption is required in production',
      );
    }
    if (serviceRole === 'worker') {
      const executorUrls = [
        ['MEDIA_EXECUTOR_BASE_URL', environment.MEDIA_EXECUTOR_BASE_URL],
        ...(speechExecutorRequired
          ? ([
              [
                'VOCAL_SEPARATION_EXECUTOR_BASE_URL',
                environment.VOCAL_SEPARATION_EXECUTOR_BASE_URL,
              ],
              ['TRANSCRIPTION_EXECUTOR_BASE_URL', environment.TRANSCRIPTION_EXECUTOR_BASE_URL],
              ['DIARIZATION_EXECUTOR_BASE_URL', environment.DIARIZATION_EXECUTOR_BASE_URL],
            ] as const)
          : []),
        ...(translationExecutorRequired
          ? ([
              ['TRANSLATION_EXECUTOR_BASE_URL', environment.TRANSLATION_EXECUTOR_BASE_URL],
            ] as const)
          : []),
      ] as const;
      for (const [name, value] of executorUrls) {
        if (new URL(value).protocol !== 'https:') {
          throw new Error(
            `Invalid environment configuration: ${name} must use HTTPS in production`,
          );
        }
      }
    }
  }
  if (
    speechExecutorRequired &&
    [
      environment.VOCAL_SEPARATION_PROVIDER_NAME,
      environment.VOCAL_SEPARATION_MODEL_ID,
      environment.VOCAL_SEPARATION_MODEL_REVISION,
      environment.VOCAL_SEPARATION_RUNTIME_VERSION,
      environment.TRANSCRIPTION_PROVIDER_NAME,
      environment.TRANSCRIPTION_MODEL_ID,
      environment.TRANSCRIPTION_MODEL_REVISION,
      environment.TRANSCRIPTION_RUNTIME_VERSION,
      environment.DIARIZATION_PROVIDER_NAME,
      environment.DIARIZATION_MODEL_ID,
      environment.DIARIZATION_MODEL_REVISION,
      environment.DIARIZATION_RUNTIME_VERSION,
    ].some((value) => value === 'activation-required' || value === 'feature-disabled')
  ) {
    throw new Error(
      'Invalid environment configuration: enabled speech capabilities require pinned provider and model identities',
    );
  }
  if (
    translationEnabled &&
    [
      environment.TRANSLATION_PROVIDER_NAME,
      environment.TRANSLATION_MODEL_ID,
      environment.TRANSLATION_MODEL_REVISION,
      environment.TRANSLATION_RUNTIME_VERSION,
      environment.TRANSLATION_PROMPT_VERSION,
    ].some((value) => value === 'activation-required' || value === 'feature-disabled')
  ) {
    throw new Error(
      'Invalid environment configuration: enabled translation requires pinned provider, model, runtime, and prompt identities',
    );
  }

  return environment;
}

export function validateApiEnvironment(raw: Record<string, unknown>): Environment {
  return validateEnvironmentForRole(raw, 'api');
}

export function validateWorkerEnvironment(raw: Record<string, unknown>): Environment {
  return validateEnvironmentForRole(raw, 'worker');
}

/** Backward-compatible API validator used by configuration unit tests and tooling. */
export function validateEnvironment(raw: Record<string, unknown>): Environment {
  return validateApiEnvironment(raw);
}
