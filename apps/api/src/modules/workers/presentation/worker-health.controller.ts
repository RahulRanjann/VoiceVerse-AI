import { Controller, Get, Header, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../../../config/environment';
import { DatabaseService } from '../../../infrastructure/database/database.service';
import {
  OBJECT_STORAGE,
  type ObjectStoragePort,
} from '../../media-ingest/domain/object-storage.port';
import { MALWARE_SCANNER, type MalwareScannerPort } from '../domain/malware-scanner.port';
import { QueuePublisherService } from '../infrastructure/queue-publisher.service';

@Controller('health')
export class WorkerHealthController {
  private readonly bucket: string;

  constructor(
    private readonly database: DatabaseService,
    private readonly queue: QueuePublisherService,
    config: ConfigService<Environment, true>,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStoragePort,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScannerPort,
  ) {
    this.bucket = config.get('S3_BUCKET', { infer: true });
  }

  @Get('live')
  @Header('cache-control', 'no-store')
  liveness() {
    return { service: 'voiceverse-worker', status: 'ok' as const };
  }

  @Get('ready')
  @Header('cache-control', 'no-store')
  async readiness() {
    const checks = await Promise.allSettled([
      this.database.ping(),
      this.queue.ping(),
      this.storage.ping(this.bucket),
      this.scanner.ping(),
    ]);
    const result = {
      database: dependencyStatus(checks[0]),
      redis: dependencyStatus(checks[1]),
      scanner: dependencyStatus(checks[3]),
      storage: dependencyStatus(checks[2]),
    };
    if (checks.some((check) => check.status === 'rejected')) {
      throw new ServiceUnavailableException({ checks: result, status: 'unavailable' });
    }
    return { checks: result, status: 'ok' as const };
  }
}

function dependencyStatus(check: PromiseSettledResult<unknown> | undefined) {
  return { status: check?.status === 'fulfilled' ? ('up' as const) : ('down' as const) };
}
