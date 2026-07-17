import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DatabaseService } from '../src/infrastructure/database/database.service';
import { OBJECT_STORAGE } from '../src/modules/media-ingest/domain/object-storage.port';
import { MALWARE_SCANNER } from '../src/modules/workers/domain/malware-scanner.port';
import { QueuePublisherService } from '../src/modules/workers/infrastructure/queue-publisher.service';
import { WorkerAppModule } from '../src/worker-app.module';

const resourceId = '01900000-0000-7000-8000-000000000001';

describe('worker HTTP route boundary', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(DatabaseService)
      .useValue({ ping: vi.fn().mockResolvedValue(undefined) })
      .overrideProvider(OBJECT_STORAGE)
      .useValue({ ping: vi.fn().mockResolvedValue(undefined) })
      .overrideProvider(MALWARE_SCANNER)
      .useValue({ ping: vi.fn().mockResolvedValue(undefined) })
      .overrideProvider(QueuePublisherService)
      .useValue({
        ping: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn().mockResolvedValue(undefined),
      })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('exposes worker health and observability endpoints', async () => {
    const [health, metrics] = await Promise.all([
      app.inject({ method: 'GET', url: '/health/live' }),
      app.inject({ method: 'GET', url: '/metrics' }),
    ]);

    expect(health.statusCode).toBe(200);
    expect(metrics.statusCode).toBe(200);
  });

  it.each([
    '/auth/me',
    `/jobs/${resourceId}`,
    `/jobs/${resourceId}/characters`,
    `/jobs/${resourceId}/dialogue-segments`,
    `/projects/${resourceId}/jobs`,
    `/v1/jobs/${resourceId}`,
    `/v1/jobs/${resourceId}/characters`,
  ])('does not register API route %s', async (url) => {
    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(404);
  });
});
