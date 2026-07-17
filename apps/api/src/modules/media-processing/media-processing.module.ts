import { Module } from '@nestjs/common';

import { ObservabilityModule } from '../../observability/observability.module';
import { ObjectStorageModule } from '../media-ingest/object-storage.module';
import { SpeechAnalysisExecutionModule } from '../speech-analysis/speech-analysis-execution.module';
import { MediaProcessingWorkerService } from './application/media-processing-worker.service';
import { MEDIA_EXECUTOR } from './domain/media-executor.port';
import { HttpMediaExecutorAdapter } from './infrastructure/http-media-executor.adapter';

@Module({
  exports: [MediaProcessingWorkerService],
  imports: [ObjectStorageModule, ObservabilityModule, SpeechAnalysisExecutionModule],
  providers: [
    HttpMediaExecutorAdapter,
    MediaProcessingWorkerService,
    { provide: MEDIA_EXECUTOR, useExisting: HttpMediaExecutorAdapter },
  ],
})
export class MediaProcessingModule {}
