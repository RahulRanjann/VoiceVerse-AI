import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { join } from 'node:path';
import { LoggerModule } from 'nestjs-pino';

import { validateApiEnvironment } from './config/environment';
import { createLoggerOptions } from './config/logger';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { ObservabilityModule } from './observability/observability.module';
import { IdentityModule } from './modules/identity/identity.module';
import { LocalizationModule } from './modules/localization/localization.module';
import { MediaIngestModule } from './modules/media-ingest/media-ingest.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { SpeechAnalysisModule } from './modules/speech-analysis/speech-analysis.module';
import { SystemController } from './system.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      envFilePath: [join(process.cwd(), '../../.env'), join(process.cwd(), '.env')],
      isGlobal: true,
      validate: validateApiEnvironment,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: createLoggerOptions,
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
    IdentityModule,
    LocalizationModule,
    MediaIngestModule,
    ProjectsModule,
    SpeechAnalysisModule,
    WorkflowModule,
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
