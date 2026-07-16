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
  WEB_AUTH_SUCCESS_URL: z.string().url(),
  LOG_LEVEL: logLevelSchema,
  OTEL_TRACES_EXPORTER: z.enum(['none', 'otlp']),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url(),
  OTEL_SERVICE_NAMESPACE: z.string().min(1),
  OTEL_SERVICE_NAME: z.string().min(1),
  AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600),
  AUTH_REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90),
  AUTH_COOKIE_SECURE: booleanFromEnvironment,
  AUTH_JWT_ISSUER: z.string().min(1).max(200),
  AUTH_JWT_AUDIENCE: z.string().min(1).max(200),
  AUTH_JWT_PRIVATE_KEY_BASE64: z.string().min(1).optional(),
  AUTH_JWT_PUBLIC_KEY_BASE64: z.string().min(1).optional(),
  AUTH_TRANSACTION_ENCRYPTION_KEY_BASE64: z.string().min(1).optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REDIRECT_URI: z.string().url(),
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
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000),
  OUTBOX_LEASE_SECONDS: z.coerce.number().int().min(5).max(600),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64),
});

export type Environment = z.infer<typeof environmentSchema>;

/**
 * Validates and normalizes configuration once during bootstrap. Development
 * defaults are intentionally unusable outside localhost; production requires
 * every external connection value to be supplied explicitly.
 */
export function validateEnvironment(raw: Record<string, unknown>): Environment {
  const nodeEnvironment = nodeEnvironmentSchema.catch('development').parse(raw.NODE_ENV);
  const isProduction = nodeEnvironment === 'production';

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
    WEB_AUTH_SUCCESS_URL:
      raw.WEB_AUTH_SUCCESS_URL ?? (isProduction ? undefined : 'http://localhost:3000'),
    LOG_LEVEL: raw.LOG_LEVEL ?? 'info',
    OTEL_TRACES_EXPORTER: raw.OTEL_TRACES_EXPORTER ?? 'none',
    OTEL_EXPORTER_OTLP_ENDPOINT: raw.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',
    OTEL_SERVICE_NAMESPACE: raw.OTEL_SERVICE_NAMESPACE ?? 'voiceverse',
    OTEL_SERVICE_NAME: raw.OTEL_SERVICE_NAME ?? 'voiceverse-api',
    AUTH_ACCESS_TOKEN_TTL_SECONDS: raw.AUTH_ACCESS_TOKEN_TTL_SECONDS ?? '900',
    AUTH_REFRESH_TOKEN_TTL_DAYS: raw.AUTH_REFRESH_TOKEN_TTL_DAYS ?? '30',
    AUTH_COOKIE_SECURE: raw.AUTH_COOKIE_SECURE ?? (isProduction ? 'true' : 'false'),
    AUTH_JWT_ISSUER: raw.AUTH_JWT_ISSUER ?? 'voiceverse-api',
    AUTH_JWT_AUDIENCE: raw.AUTH_JWT_AUDIENCE ?? 'voiceverse-web',
    AUTH_JWT_PRIVATE_KEY_BASE64: optionalEnvironmentValue(raw.AUTH_JWT_PRIVATE_KEY_BASE64),
    AUTH_JWT_PUBLIC_KEY_BASE64: optionalEnvironmentValue(raw.AUTH_JWT_PUBLIC_KEY_BASE64),
    AUTH_TRANSACTION_ENCRYPTION_KEY_BASE64: optionalEnvironmentValue(
      raw.AUTH_TRANSACTION_ENCRYPTION_KEY_BASE64,
    ),
    GOOGLE_CLIENT_ID: optionalEnvironmentValue(raw.GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_SECRET: optionalEnvironmentValue(raw.GOOGLE_CLIENT_SECRET),
    GOOGLE_REDIRECT_URI:
      raw.GOOGLE_REDIRECT_URI ??
      (isProduction ? undefined : 'http://localhost:3001/v1/auth/google/callback'),
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
    OUTBOX_POLL_INTERVAL_MS: raw.OUTBOX_POLL_INTERVAL_MS ?? '1000',
    OUTBOX_LEASE_SECONDS: raw.OUTBOX_LEASE_SECONDS ?? '30',
    WORKER_CONCURRENCY: raw.WORKER_CONCURRENCY ?? '2',
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
  if (isProduction) {
    const productionSecrets: Array<keyof Environment> = [
      'AUTH_JWT_PRIVATE_KEY_BASE64',
      'AUTH_JWT_PUBLIC_KEY_BASE64',
      'AUTH_TRANSACTION_ENCRYPTION_KEY_BASE64',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
    ];
    const missing = productionSecrets.filter((key) => !environment[key]);
    if (missing.length > 0) {
      throw new Error(`Invalid environment configuration: missing ${missing.join(', ')}`);
    }
  }
  if (environment.S3_SSE_ALGORITHM === 'aws:kms' && !environment.S3_KMS_KEY_ID) {
    throw new Error(
      'Invalid environment configuration: S3_KMS_KEY_ID is required for aws:kms encryption',
    );
  }

  return environment;
}
