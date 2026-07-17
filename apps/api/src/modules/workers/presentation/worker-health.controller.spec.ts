import type { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import type { DatabaseService } from '../../../infrastructure/database/database.service';
import type { ObjectStoragePort } from '../../media-ingest/domain/object-storage.port';
import { TranslationCapabilityReadinessService } from '../../localization/application/translation-capability-readiness.service';
import type { TranslationExecutorPort } from '../../localization/domain/translation-executor.port';
import { SpeechCapabilityReadinessService } from '../../speech-analysis/application/speech-capability-readiness.service';
import type {
  SpeechCapability,
  SpeechExecutorPort,
} from '../../speech-analysis/domain/speech-executor.port';
import type { MalwareScannerPort } from '../domain/malware-scanner.port';
import type { QueuePublisherService } from '../infrastructure/queue-publisher.service';
import { WorkerHealthController } from './worker-health.controller';

const identities = {
  SPEAKER_DIARIZATION: {
    modelId: 'community-1',
    modelRevision: 'diarization-sha',
    provider: 'pyannote',
    runtimeVersion: 'runtime-diarization',
  },
  TRANSCRIPTION: {
    modelId: 'large-v3',
    modelRevision: 'transcription-sha',
    provider: 'faster-whisper',
    runtimeVersion: 'runtime-whisper',
  },
  VOCAL_SEPARATION: {
    modelId: 'mel-band-roformer',
    modelRevision: 'separation-sha',
    provider: 'audio-separator',
    runtimeVersion: 'runtime-separation',
  },
} as const;

function harness(enabled: boolean, translationEnabled = false) {
  const values: Partial<Environment> = {
    DIARIZATION_MODEL_ID: identities.SPEAKER_DIARIZATION.modelId,
    DIARIZATION_MODEL_REVISION: identities.SPEAKER_DIARIZATION.modelRevision,
    DIARIZATION_PROVIDER_NAME: identities.SPEAKER_DIARIZATION.provider,
    DIARIZATION_RUNTIME_VERSION: identities.SPEAKER_DIARIZATION.runtimeVersion,
    S3_BUCKET: 'voiceverse-private',
    SPEECH_ANALYSIS_ENABLED: enabled,
    TRANSLATION_ENABLED: translationEnabled,
    TRANSLATION_MODEL_ID: 'translation-model',
    TRANSLATION_MODEL_REVISION: 'translation-sha',
    TRANSLATION_PROMPT_VERSION: 'prompt-v1',
    TRANSLATION_PROVIDER_NAME: 'translation-provider',
    TRANSLATION_RUNTIME_VERSION: 'translation-runtime',
    TRANSCRIPTION_MODEL_ID: identities.TRANSCRIPTION.modelId,
    TRANSCRIPTION_MODEL_REVISION: identities.TRANSCRIPTION.modelRevision,
    TRANSCRIPTION_PROVIDER_NAME: identities.TRANSCRIPTION.provider,
    TRANSCRIPTION_RUNTIME_VERSION: identities.TRANSCRIPTION.runtimeVersion,
    VOCAL_SEPARATION_MODEL_ID: identities.VOCAL_SEPARATION.modelId,
    VOCAL_SEPARATION_MODEL_REVISION: identities.VOCAL_SEPARATION.modelRevision,
    VOCAL_SEPARATION_PROVIDER_NAME: identities.VOCAL_SEPARATION.provider,
    VOCAL_SEPARATION_RUNTIME_VERSION: identities.VOCAL_SEPARATION.runtimeVersion,
  };
  const checkReadiness = vi.fn<SpeechExecutorPort['checkReadiness']>((capability) =>
    Promise.resolve({
      capability,
      enabled: true,
      model: identities[capability],
      ready: true,
      schemaVersion: 'voiceverse.speech-capability.v1',
    }),
  );
  const config = {
    get: vi.fn((key: keyof Environment) => values[key]),
  } as unknown as ConfigService<Environment, true>;
  const readiness = new SpeechCapabilityReadinessService(config, {
    checkReadiness,
  } as unknown as SpeechExecutorPort);
  const translationCheckReadiness = vi.fn().mockResolvedValue({
    capability: 'SCENE_TRANSLATION',
    enabled: true,
    model: {
      modelId: 'translation-model',
      modelRevision: 'translation-sha',
      provider: 'translation-provider',
      runtimeVersion: 'translation-runtime',
    },
    ready: true,
    schemaVersion: 'voiceverse.translation-capability.v1',
  });
  const translationReadiness = new TranslationCapabilityReadinessService(config, {
    checkReadiness: translationCheckReadiness,
  } as unknown as TranslationExecutorPort);
  const controller = new WorkerHealthController(
    { ping: vi.fn().mockResolvedValue(undefined) } as unknown as DatabaseService,
    { ping: vi.fn().mockResolvedValue(undefined) } as unknown as QueuePublisherService,
    config,
    { ping: vi.fn().mockResolvedValue(undefined) } as unknown as ObjectStoragePort,
    { ping: vi.fn().mockResolvedValue(undefined) } as unknown as MalwareScannerPort,
    readiness,
    translationReadiness,
  );
  return { checkReadiness, controller, translationCheckReadiness };
}

describe('WorkerHealthController', () => {
  it('does not contact speech executors while the milestone is disabled', async () => {
    const { checkReadiness, controller } = harness(false);

    await expect(controller.readiness()).resolves.toMatchObject({
      checks: { speechAnalysis: { status: 'disabled' } },
      status: 'ok',
    });
    expect(checkReadiness).not.toHaveBeenCalled();
  });

  it('reports translation as disabled without contacting its executor', async () => {
    const { controller, translationCheckReadiness } = harness(false);

    await expect(controller.readiness()).resolves.toMatchObject({
      checks: { translation: { status: 'disabled' } },
      status: 'ok',
    });
    expect(translationCheckReadiness).not.toHaveBeenCalled();
  });

  it('requires the enabled translation executor to serve its pinned model', async () => {
    const { controller, translationCheckReadiness } = harness(false, true);

    await expect(controller.readiness()).resolves.toMatchObject({
      checks: { translation: { status: 'up' } },
      status: 'ok',
    });
    expect(translationCheckReadiness).toHaveBeenCalledOnce();
  });

  it('requires all enabled capabilities to serve the pinned model identities', async () => {
    const { checkReadiness, controller } = harness(true);

    await expect(controller.readiness()).resolves.toMatchObject({
      checks: {
        speechAnalysis: {
          diarization: { status: 'up' },
          transcription: { status: 'up' },
          vocalSeparation: { status: 'up' },
        },
      },
      status: 'ok',
    });
    expect(checkReadiness.mock.calls.map(([capability]) => capability)).toEqual([
      'VOCAL_SEPARATION',
      'TRANSCRIPTION',
      'SPEAKER_DIARIZATION',
    ] satisfies SpeechCapability[]);
  });

  it('fails readiness when the AI deployment disables a required capability', async () => {
    const { checkReadiness, controller } = harness(true);
    checkReadiness.mockImplementation((capability) => {
      if (capability === 'TRANSCRIPTION') {
        return Promise.reject(new Error('SPEECH_CAPABILITY_DISABLED'));
      }
      return Promise.resolve({
        capability,
        enabled: true,
        model: identities[capability],
        ready: true,
        schemaVersion: 'voiceverse.speech-capability.v1',
      });
    });

    const caught = await controller.readiness().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    expect((caught as ServiceUnavailableException).getResponse()).toMatchObject({
      checks: { speechAnalysis: { transcription: { status: 'down' } } },
      status: 'unavailable',
    });
  });

  it('fails readiness when a rollout serves a different model revision', async () => {
    const { checkReadiness, controller } = harness(true);
    checkReadiness.mockImplementation((capability) =>
      Promise.resolve({
        capability,
        enabled: true,
        model: {
          ...identities[capability],
          modelRevision:
            capability === 'SPEAKER_DIARIZATION'
              ? 'unexpected-rollout'
              : identities[capability].modelRevision,
        },
        ready: true,
        schemaVersion: 'voiceverse.speech-capability.v1',
      }),
    );

    await expect(controller.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
