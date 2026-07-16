import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/prisma/client';

export type { Prisma } from './generated/prisma/client';
export * from './generated/prisma/enums';

export interface DatabaseClientOptions {
  connectionString: string;
  maxConnections?: number;
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
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
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
