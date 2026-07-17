import { Controller, Get, Header, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../../../config/environment';
import { DatabaseService } from '../../../infrastructure/database/database.service';
import {
  OBJECT_STORAGE,
  type ObjectStoragePort,
} from '../../media-ingest/domain/object-storage.port';
import { TranslationCapabilityReadinessService } from '../../localization/application/translation-capability-readiness.service';
import {
  REMOTE_SPEECH_CAPABILITIES,
  SpeechCapabilityReadinessService,
} from '../../speech-analysis/application/speech-capability-readiness.service';
import { MALWARE_SCANNER, type MalwareScannerPort } from '../domain/malware-scanner.port';
import { QueuePublisherService } from '../infrastructure/queue-publisher.service';

@Controller('health')
export class WorkerHealthController {
  private readonly bucket: string;
  private readonly speechAnalysisEnabled: boolean;
  private readonly translationEnabled: boolean;

  constructor(
    private readonly database: DatabaseService,
    private readonly queue: QueuePublisherService,
    config: ConfigService<Environment, true>,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStoragePort,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScannerPort,
    private readonly speechReadiness: SpeechCapabilityReadinessService,
    private readonly translationReadiness: TranslationCapabilityReadinessService,
  ) {
    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.speechAnalysisEnabled = config.get('SPEECH_ANALYSIS_ENABLED', { infer: true });
    this.translationEnabled = config.get('TRANSLATION_ENABLED', { infer: true });
  }

  @Get('live')
  @Header('cache-control', 'no-store')
  liveness() {
    return { service: 'voiceverse-worker', status: 'ok' as const };
  }

  @Get('ready')
  @Header('cache-control', 'no-store')
  async readiness() {
    const speechCapabilities = this.speechAnalysisEnabled ? REMOTE_SPEECH_CAPABILITIES : [];
    const translationCheckIndex = 4 + speechCapabilities.length;
    const checks = await Promise.allSettled([
      this.database.ping(),
      this.queue.ping(),
      this.storage.ping(this.bucket),
      this.scanner.ping(),
      ...speechCapabilities.map((capability) => this.speechReadiness.assert(capability)),
      ...(this.translationEnabled ? [this.translationReadiness.assert()] : []),
    ]);
    const result = {
      database: dependencyStatus(checks[0]),
      redis: dependencyStatus(checks[1]),
      scanner: dependencyStatus(checks[3]),
      speechAnalysis: this.speechAnalysisEnabled
        ? {
            diarization: dependencyStatus(checks[6]),
            transcription: dependencyStatus(checks[5]),
            vocalSeparation: dependencyStatus(checks[4]),
          }
        : { status: 'disabled' as const },
      storage: dependencyStatus(checks[2]),
      translation: this.translationEnabled
        ? dependencyStatus(checks[translationCheckIndex])
        : { status: 'disabled' as const },
    };
    if (checks.some((check) => check.status === 'rejected')) {
      throw new ServiceUnavailableException({ checks: result, status: 'unavailable' });
    }
    return { checks: result, status: 'ok' as const };
  }
}

function dependencyStatus(check: PromiseSettledResult<unknown> | undefined) {
  return { status: check?.status === 'fulfilled' ? ('up' as const) : ('down' as const) };
}
