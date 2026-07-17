import { Module } from '@nestjs/common';

import { ObservabilityModule } from '../../observability/observability.module';
import { ObjectStorageModule } from '../media-ingest/object-storage.module';
import { SpeechAnalysisInitializerService } from './application/speech-analysis-initializer.service';
import { SpeechAnalysisPersistenceService } from './application/speech-analysis-persistence.service';
import { SpeechAnalysisReconcilerService } from './application/speech-analysis-reconciler.service';
import { SpeechCapabilityReadinessService } from './application/speech-capability-readiness.service';
import { SpeechProcessingWorkerService } from './application/speech-processing-worker.service';
import { SpeechWorkflowCoordinatorService } from './application/speech-workflow-coordinator.service';
import { TimelineMaterializerService } from './application/timeline-materializer.service';
import { SPEECH_EXECUTOR } from './domain/speech-executor.port';
import { HttpSpeechExecutorAdapter } from './infrastructure/http-speech-executor.adapter';
import { SpeechManifestReadBudgetService } from './infrastructure/speech-manifest-read-budget.service';
import { SpeechManifestReaderService } from './infrastructure/speech-manifest-reader.service';

/**
 * Worker-safe speech orchestration and executor adapters. API presentation is
 * intentionally kept in SpeechAnalysisModule so the private worker listener
 * exposes only operational endpoints.
 */
@Module({
  exports: [
    SPEECH_EXECUTOR,
    SpeechAnalysisInitializerService,
    SpeechAnalysisReconcilerService,
    SpeechCapabilityReadinessService,
    SpeechProcessingWorkerService,
  ],
  imports: [ObjectStorageModule, ObservabilityModule],
  providers: [
    HttpSpeechExecutorAdapter,
    SpeechAnalysisInitializerService,
    SpeechAnalysisPersistenceService,
    SpeechAnalysisReconcilerService,
    SpeechCapabilityReadinessService,
    SpeechManifestReadBudgetService,
    SpeechManifestReaderService,
    SpeechProcessingWorkerService,
    SpeechWorkflowCoordinatorService,
    TimelineMaterializerService,
    { provide: SPEECH_EXECUTOR, useExisting: HttpSpeechExecutorAdapter },
  ],
})
export class SpeechAnalysisExecutionModule {}
