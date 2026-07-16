import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/prisma/client';

export type { Prisma } from './generated/prisma/client';
export * from './generated/prisma/enums';

export interface DatabaseClientOptions {
  connectionTimeoutMs?: number;
  connectionString: string;
  idleInTransactionTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxConnections?: number;
  statementTimeoutMs?: number;
}

/**
 * Creates one process-scoped Prisma client backed by the native PostgreSQL
 * driver. Lifecycle ownership remains with the calling application so tests and
 * workers can shut pools down deterministically.
 */
export function createDatabaseClient(options: DatabaseClientOptions): PrismaClient {
  if (!options.connectionString.startsWith('postgresql://')) {
    throw new Error('Database connection string must use the postgresql:// scheme.');
  }

  const adapter = new PrismaPg({
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    connectionString: options.connectionString,
    idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs ?? 30_000,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    max: options.maxConnections ?? 10,
    statement_timeout: options.statementTimeoutMs ?? 30_000,
    // Prisma's driver adapter serializes Date values without a zone suffix.
    // A UTC session prevents the database server's local timezone from shifting
    // security-sensitive expiry, rotation, lease, and audit timestamps.
    options: '-c timezone=UTC',
  });

  return new PrismaClient({
    adapter,
    log: [
      { emit: 'stdout', level: 'warn' },
      { emit: 'stdout', level: 'error' },
    ],
  });
}

export { PrismaClient } from './generated/prisma/client';
