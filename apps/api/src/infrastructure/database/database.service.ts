import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDatabaseClient, type PrismaClient } from '@voiceverse/database';

import type { Environment } from '../../config/environment';

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly client: PrismaClient;

  constructor(config: ConfigService<Environment, true>) {
    this.client = createDatabaseClient({
      connectionString: config.get('DATABASE_URL', { infer: true }),
      maxConnections: config.get('DATABASE_POOL_MAX', { infer: true }),
    });
  }

  async ping(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.$disconnect();
  }
}
