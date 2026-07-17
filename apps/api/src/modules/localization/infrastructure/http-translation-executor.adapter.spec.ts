import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import type { TranslationExecutionCommand } from '../domain/translation-executor.port';
import { HttpTranslationExecutorAdapter } from './http-translation-executor.adapter';

const generationId = '01900000-0000-7000-8000-000000000301';
const executionId = '01900000-0000-7000-8000-000000000302';
const sceneRevisionId = '01900000-0000-7000-8000-000000000303';
const dialogueId = '01900000-0000-7000-8000-000000000304';
const sourceRevisionId = '01900000-0000-7000-8000-000000000305';

function model() {
  return {
    modelId: 'translation-model',
    modelRevision: 'sha-1234',
    provider: 'provider',
    runtimeVersion: '1.0.0',
  };
}

function createAdapter(): HttpTranslationExecutorAdapter {
  const values: Partial<Environment> = {
    TRANSLATION_EXECUTOR_BASE_URL: 'http://translation.internal:8000',
    TRANSLATION_EXECUTOR_BEARER_TOKEN: 'test-translation-token-at-least-thirty-two-characters',
    TRANSLATION_EXECUTOR_TIMEOUT_MS: 20_000,
  };
  const config = {
    get: vi.fn((key: keyof Environment) => values[key]),
  } as unknown as ConfigService<Environment, true>;
  return new HttpTranslationExecutorAdapter(config);
}

function command(): TranslationExecutionCommand {
  return {
    dialogues: [
      {
        character: {
          characterId: '01900000-0000-7000-8000-000000000306',
          name: 'Ada',
        },
        dialogueId,
        endUs: 2_000_000,
        ordinal: 0,
        sourceRevisionId,
        sourceText: 'Sensitive source dialogue',
        startUs: 1_000_000,
      },
    ],
    executionId,
    expectedModel: model(),
    generationId,
    glossaryRevisions: [
      {
        caseSensitive: true,
        doNotTranslate: false,
        glossaryRevisionId: '01900000-0000-7000-8000-000000000307',
        notes: 'Use the approved term.',
        sourceTerm: 'Source term',
        targetTerm: 'Target term',
      },
    ],
    promptVersion: 'scene-translation-v1',
    sceneContext: {
      culturalNotes: 'Context',
      narrative: 'Narrative',
      sceneRevisionId,
      title: 'Opening',
    },
    schemaVersion: 'voiceverse.translation-command.v1',
    sourceLanguageTag: 'en-US',
    targetLanguageTag: 'hi-IN',
  };
}

function response() {
  return {
    executionId,
    generationId,
    model: model(),
    producerVersion: 'translation-executor-test',
    promptVersion: 'scene-translation-v1',
    schemaVersion: 'voiceverse.translation.v1',
    sourceLanguageTag: 'en-US',
    targetLanguageTag: 'hi-IN',
    translations: [{ dialogueId, sourceRevisionId, targetText: 'Translated dialogue' }],
  };
}

function respond(payload: unknown, status = 200, headers?: HeadersInit): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json', ...headers },
        status,
      }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('HttpTranslationExecutorAdapter', () => {
  it('authenticates readiness and returns the exact serving identity', async () => {
    respond({
      capability: 'SCENE_TRANSLATION',
      enabled: true,
      model: model(),
      ready: true,
      schemaVersion: 'voiceverse.translation-capability.v1',
    });

    await expect(createAdapter().checkReadiness()).resolves.toMatchObject({
      capability: 'SCENE_TRANSLATION',
      model: model(),
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      new URL('http://translation.internal:8000/internal/v1/translation-capability'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-translation-token-at-least-thirty-two-characters',
        }),
        method: 'GET',
      }),
    );
  });

  it('validates a complete versioned translation result without putting credentials in the body', async () => {
    respond(response());

    await expect(createAdapter().translate(command())).resolves.toEqual(response());
    const [, request] = vi.mocked(fetch).mock.calls[0] as [URL, RequestInit];
    expect(request.method).toBe('POST');
    expect(request.body).toContain('Sensitive source dialogue');
    expect(request.body).not.toContain('test-translation-token');
  });

  it.each([
    ['generationId', '01900000-0000-7000-8000-000000000399'],
    ['targetLanguageTag', 'fr-FR'],
    ['promptVersion', 'unexpected-prompt'],
  ])('rejects mismatched %s identity', async (field, value) => {
    respond({ ...response(), [field]: value });

    await expect(createAdapter().translate(command())).rejects.toMatchObject({
      code: 'TRANSLATION_EXECUTOR_IDENTITY_MISMATCH',
      retryable: false,
    });
  });

  it('rejects missing, duplicate, or injected dialogue output', async () => {
    const payload = response();
    const first = payload.translations[0];
    if (!first) throw new Error('Expected a translation fixture.');
    payload.translations.push(first);
    respond(payload);

    await expect(createAdapter().translate(command())).rejects.toMatchObject({
      code: 'TRANSLATION_EXECUTOR_CARDINALITY_MISMATCH',
      retryable: false,
    });
  });

  it('rejects unknown fields through the strict result contract', async () => {
    respond({ ...response(), providerTrace: 'sensitive-provider-detail' });

    await expect(createAdapter().translate(command())).rejects.toMatchObject({
      code: 'TRANSLATION_EXECUTOR_CONTRACT_INVALID',
      retryable: false,
    });
  });

  it('rejects blank output before it can reach the database', async () => {
    const payload = response();
    payload.translations[0]!.targetText = '   ';
    respond(payload);

    await expect(createAdapter().translate(command())).rejects.toMatchObject({
      code: 'TRANSLATION_EXECUTOR_CONTRACT_INVALID',
      retryable: false,
    });
  });

  it.each([
    [429, 'TRANSLATION_EXECUTOR_SATURATED', true],
    [503, 'PROVIDER_UNAVAILABLE', true],
    [400, 'PROVIDER_UNAVAILABLE', false],
  ])('classifies HTTP %i without exposing provider text', async (status, code, retryable) => {
    respond(
      { error: { code: 'PROVIDER_UNAVAILABLE', message: 'private provider failure detail' } },
      status,
    );

    const caught = await createAdapter()
      .translate(command())
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(caught).toMatchObject({ code, retryable });
    expect(caught instanceof Error ? caught.message : '').not.toContain('private provider');
  });

  it('does not persist an untrusted provider error code as audit-safe metadata', async () => {
    respond(
      { error: { code: 'private provider prompt fragment', message: 'private detail' } },
      400,
    );

    await expect(createAdapter().translate(command())).rejects.toMatchObject({
      code: 'TRANSLATION_EXECUTOR_HTTP_400',
      retryable: false,
    });
  });

  it('rejects a declared oversized response before parsing', async () => {
    respond(response(), 200, { 'Content-Length': '2000001' });

    await expect(createAdapter().translate(command())).rejects.toMatchObject({
      code: 'TRANSLATION_EXECUTOR_RESPONSE_TOO_LARGE',
      retryable: false,
    });
  });
});
