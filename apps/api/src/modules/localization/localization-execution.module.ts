import { Module } from '@nestjs/common';

import { TRANSLATION_EXECUTOR } from './domain/translation-executor.port';
import { TranslationCapabilityReadinessService } from './application/translation-capability-readiness.service';
import { TranslationGenerationWorkerService } from './application/translation-generation-worker.service';
import { HttpTranslationExecutorAdapter } from './infrastructure/http-translation-executor.adapter';

/**
 * Worker-only translation execution dependencies. Public localization routes
 * stay in LocalizationModule so the private worker listener exposes no
 * editorial surface.
 */
@Module({
  exports: [
    TRANSLATION_EXECUTOR,
    TranslationCapabilityReadinessService,
    TranslationGenerationWorkerService,
  ],
  providers: [
    HttpTranslationExecutorAdapter,
    TranslationCapabilityReadinessService,
    TranslationGenerationWorkerService,
    { provide: TRANSLATION_EXECUTOR, useExisting: HttpTranslationExecutorAdapter },
  ],
})
export class LocalizationExecutionModule {}
