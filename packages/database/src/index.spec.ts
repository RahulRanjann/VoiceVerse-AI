import { describe, expect, it } from 'vitest';

import { createDatabaseClient } from './index';

describe('createDatabaseClient', () => {
  it('rejects non-PostgreSQL connection strings before creating a pool', () => {
    expect(() =>
      createDatabaseClient({ connectionString: 'mysql://user:secret@localhost/database' }),
    ).toThrow('postgresql://');
  });

  it('creates a lifecycle-owned Prisma client', async () => {
    const client = createDatabaseClient({
      connectionString: 'postgresql://voiceverse:local@localhost:5432/voiceverse',
      maxConnections: 1,
    });

    expect(typeof client.$disconnect).toBe('function');
    await client.$disconnect();
  });
});
