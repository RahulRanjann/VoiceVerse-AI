import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import type { TranslationExecutorPort } from '../domain/translation-executor.port';
import { TranslationCapabilityReadinessService } from './translation-capability-readiness.service';

function harness(enabled = true) {
  const values: Partial<Environment> = {
    TRANSLATION_ENABLED: enabled,
    TRANSLATION_MODEL_ID: 'model',
    TRANSLATION_MODEL_REVISION: 'sha-model',
    TRANSLATION_PROMPT_VERSION: 'prompt-v1',
    TRANSLATION_PROVIDER_NAME: 'provider',
    TRANSLATION_RUNTIME_VERSION: 'runtime',
  };
  const config = {
    get: vi.fn((key: keyof Environment) => values[key]),
  } as unknown as ConfigService<Environment, true>;
  const checkReadiness = vi.fn().mockResolvedValue({
    capability: 'SCENE_TRANSLATION',
    enabled: true,
    model: {
      modelId: 'model',
      modelRevision: 'sha-model',
      provider: 'provider',
      runtimeVersion: 'runtime',
    },
    ready: true,
    schemaVersion: 'voiceverse.translation-capability.v1',
  });
  const executor = { checkReadiness } as unknown as TranslationExecutorPort;
  return {
    checkReadiness,
    service: new TranslationCapabilityReadinessService(config, executor),
  };
}

describe('TranslationCapabilityReadinessService', () => {
  it('accepts only the pinned serving identity', async () => {
    await expect(harness().service.assert()).resolves.toBeUndefined();
  });

  it('does not contact the executor while translation is disabled', async () => {
    const test = harness(false);

    await expect(test.service.assert()).rejects.toThrow('TranslationCapabilityDisabled');
    expect(test.checkReadiness).not.toHaveBeenCalled();
  });

  it('rejects silent provider rollout drift', async () => {
    const test = harness();
    test.checkReadiness.mockResolvedValue({
      capability: 'SCENE_TRANSLATION',
      enabled: true,
      model: {
        modelId: 'model',
        modelRevision: 'unexpected',
        provider: 'provider',
        runtimeVersion: 'runtime',
      },
      ready: true,
      schemaVersion: 'voiceverse.translation-capability.v1',
    });

    await expect(test.service.assert()).rejects.toThrow('TranslationExecutorModelIdentityMismatch');
  });
});
