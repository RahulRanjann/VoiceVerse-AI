import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../../../config/environment';
import { MediaScanWorkerService } from './media-scan-worker.service';
import { OutboxRelayService } from './outbox-relay.service';

@Injectable()
export class WorkerRuntimeService implements OnApplicationShutdown {
  private readonly logger = new Logger(WorkerRuntimeService.name);
  private readonly pollInterval: number;
  private stopped = false;
  private relayLoop?: Promise<void>;

  constructor(
    private readonly relay: OutboxRelayService,
    private readonly mediaScanWorker: MediaScanWorkerService,
    config: ConfigService<Environment, true>,
  ) {
    this.pollInterval = config.get('OUTBOX_POLL_INTERVAL_MS', { infer: true });
  }

  start(): void {
    if (this.relayLoop) return;
    this.mediaScanWorker.start();
    this.relayLoop = this.runRelayLoop();
    this.logger.log('VoiceVerse worker runtime started');
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    await this.relayLoop;
  }

  private async runRelayLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const count = await this.relay.relayBatch();
        if (count > 0) continue;
      } catch (error) {
        const errorCode = error instanceof Error ? error.name : 'UnknownError';
        this.logger.warn({ errorCode }, 'Outbox relay iteration failed');
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
    }
  }
}
