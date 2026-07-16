import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { trace } from '@opentelemetry/api';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { LoggerModule } from 'nestjs-pino';

import { type Environment, validateEnvironment } from './config/environment';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { ObservabilityModule } from './observability/observability.module';
import { SystemController } from './system.controller';

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      envFilePath: [join(process.cwd(), '../../.env'), join(process.cwd(), '.env')],
      isGlobal: true,
      validate: validateEnvironment,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          redact: {
            censor: '[REDACTED]',
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers.set-cookie',
              '*.accessToken',
              '*.refreshToken',
              '*.password',
              '*.secret',
              '*.signedUrl',
            ],
          },
          genReqId(request) {
            const suppliedId = request.headers['x-request-id'];
            return typeof suppliedId === 'string' && requestIdPattern.test(suppliedId)
              ? suppliedId
              : randomUUID();
          },
          customProps() {
            const spanContext = trace.getActiveSpan()?.spanContext();
            return spanContext ? { traceId: spanContext.traceId, spanId: spanContext.spanId } : {};
          },
        },
      }),
    }),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 120,
      },
    ]),
    DatabaseModule,
    RedisModule,
    ObservabilityModule,
    HealthModule,
  ],
  controllers: [SystemController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
