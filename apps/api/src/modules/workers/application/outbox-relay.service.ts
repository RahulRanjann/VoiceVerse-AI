import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@voiceverse/database';

import type { Environment } from '../../../config/environment';
import { DatabaseService } from '../../../infrastructure/database/database.service';
import { uuidv7 } from '../../../shared/uuid';
import { QueuePublisherService } from '../infrastructure/queue-publisher.service';

interface LeasedOutboxEvent {
  id: string;
  eventType: string;
  deduplicationKey: string;
  payload: Prisma.JsonValue;
  attemptCount: number;
}

@Injectable()
export class OutboxRelayService {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly leaseSeconds: number;

  constructor(
    private readonly database: DatabaseService,
    private readonly publisher: QueuePublisherService,
    config: ConfigService<Environment, true>,
  ) {
    this.leaseSeconds = config.get('OUTBOX_LEASE_SECONDS', { infer: true });
  }

  async relayBatch(limit = 25): Promise<number> {
    const leaseId = uuidv7();
    const events = await this.database.client.$queryRaw<LeasedOutboxEvent[]>`
      WITH candidates AS (
        SELECT id
        FROM outbox_events
        WHERE (
          status IN ('pending', 'failed')
          AND available_at <= now()
        ) OR (
          status = 'publishing'
          AND leased_until < now()
        )
        ORDER BY available_at ASC, occurred_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_events AS event
      SET status = 'publishing',
          lease_id = ${leaseId}::uuid,
          leased_until = now() + (${this.leaseSeconds} * interval '1 second')
      FROM candidates
      WHERE event.id = candidates.id
      RETURNING event.id,
                event.event_type AS "eventType",
                event.deduplication_key AS "deduplicationKey",
                event.payload,
                event.attempt_count AS "attemptCount"
    `;

    for (const event of events) {
      try {
        await this.publisher.publish(event);
        await this.database.client.outboxEvent.updateMany({
          data: {
            lastError: null,
            leaseId: null,
            leasedUntil: null,
            publishedAt: new Date(),
            status: 'PUBLISHED',
          },
          where: { id: event.id, leaseId, status: 'PUBLISHING' },
        });
      } catch (error) {
        const attempt = event.attemptCount + 1;
        const delaySeconds = Math.min(300, 5 * 2 ** Math.min(attempt, 6));
        const errorCode = error instanceof Error ? error.name : 'UnknownError';
        await this.database.client.outboxEvent.updateMany({
          data: {
            attemptCount: attempt,
            availableAt: new Date(Date.now() + delaySeconds * 1_000),
            lastError: errorCode.slice(0, 200),
            leaseId: null,
            leasedUntil: null,
            status: 'FAILED',
          },
          where: { id: event.id, leaseId, status: 'PUBLISHING' },
        });
        this.logger.warn({ errorCode, eventId: event.id }, 'Outbox publication failed');
      }
    }
    return events.length;
  }
}
