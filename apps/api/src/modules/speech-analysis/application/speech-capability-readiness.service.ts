import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../../../config/environment';
import {
  SPEECH_EXECUTOR,
  type SpeechCapability,
  type SpeechExecutorPort,
  type SpeechModelDescriptor,
} from '../domain/speech-executor.port';

export const REMOTE_SPEECH_CAPABILITIES: readonly SpeechCapability[] = [
  'VOCAL_SEPARATION',
  'TRANSCRIPTION',
  'SPEAKER_DIARIZATION',
];

/**
 * Performs the exact serving-model handshake shared by worker startup,
 * per-delivery admission, and the readiness endpoint. Keeping this policy in
 * one service prevents health reporting from drifting away from execution.
 */
@Injectable()
export class SpeechCapabilityReadinessService {
  private readonly expectedModels: Record<
    SpeechCapability,
    Pick<SpeechModelDescriptor, 'modelId' | 'modelRevision' | 'provider' | 'runtimeVersion'>
  >;

  constructor(
    config: ConfigService<Environment, true>,
    @Inject(SPEECH_EXECUTOR) private readonly executor: SpeechExecutorPort,
  ) {
    this.expectedModels = {
      SPEAKER_DIARIZATION: {
        modelId: config.get('DIARIZATION_MODEL_ID', { infer: true }),
        modelRevision: config.get('DIARIZATION_MODEL_REVISION', { infer: true }),
        provider: config.get('DIARIZATION_PROVIDER_NAME', { infer: true }),
        runtimeVersion: config.get('DIARIZATION_RUNTIME_VERSION', { infer: true }),
      },
      TRANSCRIPTION: {
        modelId: config.get('TRANSCRIPTION_MODEL_ID', { infer: true }),
        modelRevision: config.get('TRANSCRIPTION_MODEL_REVISION', { infer: true }),
        provider: config.get('TRANSCRIPTION_PROVIDER_NAME', { infer: true }),
        runtimeVersion: config.get('TRANSCRIPTION_RUNTIME_VERSION', { infer: true }),
      },
      VOCAL_SEPARATION: {
        modelId: config.get('VOCAL_SEPARATION_MODEL_ID', { infer: true }),
        modelRevision: config.get('VOCAL_SEPARATION_MODEL_REVISION', { infer: true }),
        provider: config.get('VOCAL_SEPARATION_PROVIDER_NAME', { infer: true }),
        runtimeVersion: config.get('VOCAL_SEPARATION_RUNTIME_VERSION', { infer: true }),
      },
    };
  }

  async assertAll(): Promise<void> {
    await Promise.all(REMOTE_SPEECH_CAPABILITIES.map((capability) => this.assert(capability)));
  }

  async assert(capability: SpeechCapability): Promise<void> {
    const status = await this.executor.checkReadiness(capability);
    const expected = this.expectedModels[capability];
    if (
      status.capability !== capability ||
      status.model.provider !== expected.provider ||
      status.model.modelId !== expected.modelId ||
      status.model.modelRevision !== expected.modelRevision ||
      status.model.runtimeVersion !== expected.runtimeVersion
    ) {
      throw new Error('SpeechExecutorModelIdentityMismatch');
    }
  }
}
