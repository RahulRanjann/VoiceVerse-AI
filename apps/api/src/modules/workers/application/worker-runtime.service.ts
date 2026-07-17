import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../../../config/environment';
import { TranslationGenerationWorkerService } from '../../localization/application/translation-generation-worker.service';
import { MediaProcessingWorkerService } from '../../media-processing/application/media-processing-worker.service';
import { SourcePreparationReconcilerService } from '../../workflow/application/source-preparation-reconciler.service';
import { SpeechAnalysisReconcilerService } from '../../speech-analysis/application/speech-analysis-reconciler.service';
import { SpeechProcessingWorkerService } from '../../speech-analysis/application/speech-processing-worker.service';
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
    private readonly mediaProcessingWorker: MediaProcessingWorkerService,
    private readonly sourcePreparationReconciler: SourcePreparationReconcilerService,
    private readonly speechAnalysisReconciler: SpeechAnalysisReconcilerService,
    private readonly speechProcessingWorker: SpeechProcessingWorkerService,
    private readonly translationGenerationWorker: TranslationGenerationWorkerService,
    config: ConfigService<Environment, true>,
  ) {
    this.pollInterval = config.get('OUTBOX_POLL_INTERVAL_MS', { infer: true });
  }

  start(): void {
    if (this.relayLoop) return;
    this.mediaScanWorker.start();
    this.mediaProcessingWorker.start();
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
        const speechReady = await this.speechProcessingWorker.ensureStarted();
        const translationReady = await this.translationGenerationWorker.ensureStarted();
        const reconciled = await this.sourcePreparationReconciler.reconcileBatch();
        const speechReconciled = speechReady
          ? await this.speechAnalysisReconciler.reconcileBatch()
          : 0;
        const recoveredScans = await this.mediaScanWorker.recoverExpiredAttempts();
        const recovered = await this.mediaProcessingWorker.recoverExpiredAttempts();
        const recoveredSpeech = speechReady
          ? await this.speechProcessingWorker.recoverExpiredAttempts()
          : 0;
        const recoveredTranslations = translationReady
          ? await this.translationGenerationWorker.recoverExpiredGenerations()
          : 0;
        const count = await this.relay.relayBatch();
        if (
          count > 0 ||
          reconciled > 0 ||
          speechReconciled > 0 ||
          recovered > 0 ||
          recoveredSpeech > 0 ||
          recoveredTranslations > 0 ||
          recoveredScans > 0
        )
          continue;
      } catch (error) {
        const errorCode = error instanceof Error ? error.name : 'UnknownError';
        this.logger.warn({ errorCode }, 'Outbox relay iteration failed');
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
    }
  }
}
