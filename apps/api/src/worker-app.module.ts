import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { join } from 'node:path';
import { LoggerModule } from 'nestjs-pino';

import { validateWorkerEnvironment } from './config/environment';
import { createLoggerOptions } from './config/logger';
import { DatabaseModule } from './infrastructure/database/database.module';
import { WorkersModule } from './modules/workers/workers.module';
import { ObservabilityModule } from './observability/observability.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      envFilePath: [join(process.cwd(), '../../.env'), join(process.cwd(), '.env')],
      isGlobal: true,
      validate: validateWorkerEnvironment,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: createLoggerOptions,
    }),
    DatabaseModule,
    ObservabilityModule,
    WorkersModule,
  ],
})
export class WorkerAppModule {}
