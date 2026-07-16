import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDatabaseClient, type PrismaClient } from '@voiceverse/database';

import type { Environment } from '../../config/environment';

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly client: PrismaClient;

  constructor(config: ConfigService<Environment, true>) {
    this.client = createDatabaseClient({
      connectionTimeoutMs: config.get('DATABASE_CONNECTION_TIMEOUT_MS', { infer: true }),
      connectionString: config.get('DATABASE_URL', { infer: true }),
      idleInTransactionTimeoutMs: config.get('DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS', {
        infer: true,
      }),
      idleTimeoutMs: config.get('DATABASE_IDLE_TIMEOUT_MS', { infer: true }),
      maxConnections: config.get('DATABASE_POOL_MAX', { infer: true }),
      statementTimeoutMs: config.get('DATABASE_STATEMENT_TIMEOUT_MS', { infer: true }),
    });
  }

  async ping(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.$disconnect();
  }
}
