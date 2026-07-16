import './observability/instrumentation';

import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import type { Environment } from './config/environment';

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    bodyLimit: 1_048_576,
    trustProxy: 1,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });

  const config = app.get(ConfigService<Environment, true>);
  const logger = app.get(Logger);
  app.useLogger(logger);

  await app.register(helmet, {
    // Swagger UI is development-only and requires inline assets. Public product
    // surfaces define a nonce-based CSP in the web application.
    contentSecurityPolicy: false,
  });
  await app.register(compress, { encodings: ['gzip', 'deflate'] });
  await app.register(cookie);

  app.enableCors({
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    origin: [config.get('WEB_ORIGIN', { infer: true })],
  });
  app.enableShutdownHooks();
  app.enableVersioning({
    defaultVersion: '1',
    type: VersioningType.URI,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      stopAtFirstError: false,
      transform: true,
      whitelist: true,
    }),
  );

  const openApiConfig = new DocumentBuilder()
    .setTitle('VoiceVerse AI Control Plane')
    .setDescription('Tenant-aware control-plane APIs for VoiceVerse AI.')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  const openApiDocument = SwaggerModule.createDocument(app, openApiConfig);
  SwaggerModule.setup('docs', app, openApiDocument, {
    jsonDocumentUrl: 'openapi.json',
    raw: ['json'],
    ui: config.get('API_DOCS_ENABLED', { infer: true }),
  });

  const host = config.get('API_HOST', { infer: true });
  const port = config.get('API_PORT', { infer: true });
  await app.listen(port, host);

  logger.log(`VoiceVerse API listening on ${host}:${port}`, 'Bootstrap');
}

void bootstrap().catch((error: unknown) => {
  const safeMessage = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', service: 'voiceverse-api', message: safeMessage })}\n`,
  );
  process.exitCode = 1;
});
