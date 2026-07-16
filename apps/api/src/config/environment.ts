import { z } from 'zod';

const nodeEnvironmentSchema = z.enum(['development', 'test', 'production']);
const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const booleanFromEnvironment = z.enum(['true', 'false']).transform((value) => value === 'true');

const environmentSchema = z.object({
  NODE_ENV: nodeEnvironmentSchema,
  API_HOST: z.string().min(1),
  API_PORT: z.coerce.number().int().min(1).max(65_535),
  API_DOCS_ENABLED: booleanFromEnvironment,
  APP_VERSION: z.string().min(1),
  DATABASE_URL: z.string().refine((value) => value.startsWith('postgresql://'), {
    message: 'must use the postgresql:// scheme',
  }),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100),
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
    API_DOCS_ENABLED: raw.API_DOCS_ENABLED ?? (isProduction ? 'false' : 'true'),
    APP_VERSION: raw.APP_VERSION ?? 'development',
    DATABASE_URL:
      raw.DATABASE_URL ??
      (isProduction
        ? undefined
        : 'postgresql://voiceverse:voiceverse_local_only@localhost:5432/voiceverse'),
    DATABASE_POOL_MAX: raw.DATABASE_POOL_MAX ?? '10',
    REDIS_URL: raw.REDIS_URL ?? (isProduction ? undefined : 'redis://localhost:6379/0'),
    WEB_ORIGIN: raw.WEB_ORIGIN ?? (isProduction ? undefined : 'http://localhost:3000'),
    LOG_LEVEL: raw.LOG_LEVEL ?? 'info',
    OTEL_TRACES_EXPORTER: raw.OTEL_TRACES_EXPORTER ?? 'none',
    OTEL_EXPORTER_OTLP_ENDPOINT: raw.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',
    OTEL_SERVICE_NAMESPACE: raw.OTEL_SERVICE_NAMESPACE ?? 'voiceverse',
  };

  const result = environmentSchema.safeParse(candidate);
  if (!result.success) {
    // Zod issue messages contain paths and constraints, not secret values.
    const summary = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${summary}`);
  }

  return result.data;
}
