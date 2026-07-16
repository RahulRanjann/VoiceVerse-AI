import './observability/instrumentation';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';

import type { Environment } from './config/environment';
import { WorkerRuntimeService } from './modules/workers/application/worker-runtime.service';
import { WorkerAppModule } from './worker-app.module';

async function bootstrap(): Promise<void> {
  const application = await NestFactory.create<NestFastifyApplication>(
    WorkerAppModule,
    new FastifyAdapter({ bodyLimit: 65_536, trustProxy: 1 }),
    { bufferLogs: true },
  );
  application.useLogger(application.get(Logger));
  application.enableShutdownHooks();
  application.get(WorkerRuntimeService).start();
  const config = application.get(ConfigService<Environment, true>);
  await application.listen(
    config.get('WORKER_PORT', { infer: true }),
    config.get('WORKER_HOST', { infer: true }),
  );
}

void bootstrap().catch((error: unknown) => {
  const safeMessage = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', service: 'voiceverse-worker', message: safeMessage })}\n`,
  );
  process.exitCode = 1;
});
