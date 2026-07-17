import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../../../config/environment';
import {
  TRANSLATION_EXECUTOR,
  type TranslationExecutorPort,
  type TranslationModelDescriptor,
} from '../domain/translation-executor.port';

@Injectable()
export class TranslationCapabilityReadinessService {
  readonly enabled: boolean;
  readonly expectedModel: TranslationModelDescriptor;
  readonly promptVersion: string;

  constructor(
    config: ConfigService<Environment, true>,
    @Inject(TRANSLATION_EXECUTOR) private readonly executor: TranslationExecutorPort,
  ) {
    this.enabled = config.get('TRANSLATION_ENABLED', { infer: true });
    this.expectedModel = {
      modelId: config.get('TRANSLATION_MODEL_ID', { infer: true }),
      modelRevision: config.get('TRANSLATION_MODEL_REVISION', { infer: true }),
      provider: config.get('TRANSLATION_PROVIDER_NAME', { infer: true }),
      runtimeVersion: config.get('TRANSLATION_RUNTIME_VERSION', { infer: true }),
    };
    this.promptVersion = config.get('TRANSLATION_PROMPT_VERSION', { infer: true });
  }

  async assert(): Promise<void> {
    if (!this.enabled) throw new Error('TranslationCapabilityDisabled');
    const status = await this.executor.checkReadiness();
    const expected = this.expectedModel;
    if (
      status.capability !== 'SCENE_TRANSLATION' ||
      status.model.provider !== expected.provider ||
      status.model.modelId !== expected.modelId ||
      status.model.modelRevision !== expected.modelRevision ||
      status.model.runtimeVersion !== expected.runtimeVersion
    ) {
      throw new Error('TranslationExecutorModelIdentityMismatch');
    }
  }
}
