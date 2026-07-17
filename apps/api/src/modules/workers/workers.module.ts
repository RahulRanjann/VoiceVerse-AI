import { Module } from '@nestjs/common';

import { ObjectStorageModule } from '../media-ingest/object-storage.module';
import { LocalizationExecutionModule } from '../localization/localization-execution.module';
import { MediaProcessingModule } from '../media-processing/media-processing.module';
import { SpeechAnalysisExecutionModule } from '../speech-analysis/speech-analysis-execution.module';
import { WorkflowExecutionModule } from '../workflow/workflow-execution.module';
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
  imports: [
    MediaProcessingModule,
    LocalizationExecutionModule,
    ObjectStorageModule,
    SpeechAnalysisExecutionModule,
    WorkflowExecutionModule,
  ],
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
