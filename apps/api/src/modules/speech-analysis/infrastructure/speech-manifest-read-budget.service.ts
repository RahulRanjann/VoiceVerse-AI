import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../../../config/environment';
import { SpeechExecutorError } from '../domain/speech-executor.port';

export interface SpeechManifestReadReservation {
  release(): void;
}

/**
 * Process-local admission control for manifest materialization. Nest providers
 * are singletons by default, so every speech reader in this worker shares one
 * byte budget. This bounds aggregate source bytes admitted for buffering while
 * retaining fail-fast behavior under temporary memory pressure.
 */
@Injectable()
export class SpeechManifestReadBudgetService {
  private admittedBytes = 0;
  private readonly capacityBytes: number;

  constructor(config: ConfigService<Environment, true>) {
    this.capacityBytes = config.get('SPEECH_MANIFEST_MEMORY_BUDGET_BYTES', { infer: true });
  }

  acquire(sizeBytes: number): SpeechManifestReadReservation {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      throw new SpeechExecutorError('SPEECH_MANIFEST_SIZE_INVALID', false);
    }
    if (this.admittedBytes > this.capacityBytes - sizeBytes) {
      throw new SpeechExecutorError(
        'SPEECH_MANIFEST_MEMORY_BUDGET_EXHAUSTED',
        true,
        'Speech manifest memory capacity is temporarily exhausted.',
      );
    }

    this.admittedBytes += sizeBytes;
    let released = false;

    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.admittedBytes -= sizeBytes;
      },
    };
  }
}
