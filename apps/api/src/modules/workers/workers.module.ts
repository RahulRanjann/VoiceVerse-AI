import { Module } from '@nestjs/common';

import { ObjectStorageModule } from '../media-ingest/object-storage.module';
import { MediaScanWorkerService } from './application/media-scan-worker.service';
import { OutboxRelayService } from './application/outbox-relay.service';
import { WorkerRuntimeService } from './application/worker-runtime.service';
import { MALWARE_SCANNER } from './domain/malware-scanner.port';
import { ClamdMalwareScannerAdapter } from './infrastructure/clamd-malware-scanner.adapter';
import { QueuePublisherService } from './infrastructure/queue-publisher.service';
import { WorkerHealthController } from './presentation/worker-health.controller';

@Module({
  controllers: [WorkerHealthController],
  exports: [WorkerRuntimeService],
  imports: [ObjectStorageModule],
  providers: [
    ClamdMalwareScannerAdapter,
    MediaScanWorkerService,
    OutboxRelayService,
    QueuePublisherService,
    WorkerRuntimeService,
    { provide: MALWARE_SCANNER, useExisting: ClamdMalwareScannerAdapter },
  ],
})
export class WorkersModule {}
