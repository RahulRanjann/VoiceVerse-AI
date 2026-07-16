import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import type { DatabaseService } from '../../../infrastructure/database/database.service';
import type { QueuePublisherService } from '../infrastructure/queue-publisher.service';
import { OutboxRelayService } from './outbox-relay.service';

function createHarness() {
  const events = [
    {
      attemptCount: 0,
      deduplicationKey: 'media.scan.requested:video:1',
      eventType: 'media.scan.requested',
      id: '01900000-0000-7000-8000-000000000050',
      payload: { videoId: '01900000-0000-7000-8000-000000000020' },
    },
  ];
  const client = {
    $queryRaw: vi.fn().mockResolvedValue(events),
    outboxEvent: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const publish = vi.fn<QueuePublisherService['publish']>().mockResolvedValue(undefined);
  const publisher = { publish } as unknown as QueuePublisherService;
  const config = {
    get: vi.fn().mockReturnValue(30),
  } as unknown as ConfigService<Environment, true>;
  const service = new OutboxRelayService(
    { client } as unknown as DatabaseService,
    publisher,
    config,
  );
  return { client, events, publish, service };
}

describe('OutboxRelayService', () => {
  it('publishes leased events and marks them complete with the matching lease', async () => {
    const harness = createHarness();

    await expect(harness.service.relayBatch(10)).resolves.toBe(1);
    expect(harness.publish).toHaveBeenCalledWith(harness.events[0]);
    expect(harness.client.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PUBLISHED' }),
        where: expect.objectContaining({
          id: harness.events[0]?.id,
          status: 'PUBLISHING',
        }),
      }),
    );
  });

  it('releases a failed lease with bounded exponential backoff', async () => {
    const harness = createHarness();
    const publicationError = new Error('redis unavailable');
    publicationError.name = 'RedisUnavailable';
    harness.publish.mockRejectedValue(publicationError);

    await expect(harness.service.relayBatch()).resolves.toBe(1);
    expect(harness.client.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attemptCount: 1,
          lastError: 'RedisUnavailable',
          status: 'FAILED',
        }),
      }),
    );
  });

  it('returns immediately when no events can be leased', async () => {
    const harness = createHarness();
    harness.client.$queryRaw.mockResolvedValue([]);

    await expect(harness.service.relayBatch()).resolves.toBe(0);
    expect(harness.publish).not.toHaveBeenCalled();
  });
});
