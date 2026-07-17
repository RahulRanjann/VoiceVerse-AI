import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import type {
  SpeakerDiarizationCommand,
  TranscriptionCommand,
  VocalSeparationCommand,
} from '../domain/speech-executor.port';
import { HttpSpeechExecutorAdapter } from './http-speech-executor.adapter';

const attemptId = '01900000-0000-7000-8000-000000000101';
const executionId = '01900000-0000-7000-8000-000000000102';
const inputArtifactId = '01900000-0000-7000-8000-000000000103';
const sha256 = 'a'.repeat(64);

function createAdapter(): HttpSpeechExecutorAdapter {
  const values: Partial<Environment> = {
    DIARIZATION_EXECUTOR_BASE_URL: 'http://diarization.internal:8000',
    DIARIZATION_EXECUTOR_TIMEOUT_MS: 15_000,
    SPEECH_EXECUTOR_BEARER_TOKEN: 'test-speech-executor-token-at-least-32-characters',
    TRANSCRIPTION_EXECUTOR_BASE_URL: 'http://transcription.internal:8000',
    TRANSCRIPTION_EXECUTOR_TIMEOUT_MS: 20_000,
    VOCAL_SEPARATION_EXECUTOR_BASE_URL: 'http://separation.internal:8000',
    VOCAL_SEPARATION_EXECUTOR_TIMEOUT_MS: 25_000,
  };
  const config = {
    get: vi.fn((key: keyof Environment) => values[key]),
  } as unknown as ConfigService<Environment, true>;
  return new HttpSpeechExecutorAdapter(config);
}

function inputArtifact(kind: 'ANALYSIS_AUDIO' | 'CANONICAL_AUDIO' | 'ISOLATED_SPEECH_AUDIO') {
  return {
    artifactId: inputArtifactId,
    byteSize: 4_096,
    channels: kind === 'CANONICAL_AUDIO' ? 2 : 1,
    durationUs: 10_000_000,
    kind,
    mediaType: 'audio/flac' as const,
    sampleRateHz: kind === 'CANONICAL_AUDIO' ? 48_000 : 16_000,
    sha256,
    storageKey: 'organizations/test/input.flac',
  };
}

function separationCommand(): VocalSeparationCommand {
  return {
    accompanimentStemKey: 'outputs/accompaniment.flac',
    attemptId,
    bucket: 'voiceverse-private',
    configurationHash: 'f'.repeat(64),
    executionId,
    expectedModel: model(),
    inputArtifact: inputArtifact('CANONICAL_AUDIO'),
    isolatedSpeechKey: 'outputs/isolated-speech.flac',
    manifestKey: 'outputs/separation.json',
    vocalStemKey: 'outputs/vocals.flac',
  };
}

function transcriptionCommand(): TranscriptionCommand {
  return {
    attemptId,
    bucket: 'voiceverse-private',
    configurationHash: 'f'.repeat(64),
    executionId,
    expectedModel: model(),
    inputArtifact: inputArtifact('ISOLATED_SPEECH_AUDIO'),
    manifestKey: 'outputs/transcript.json',
    sourceLanguageTag: 'en-US',
  };
}

function diarizationCommand(): SpeakerDiarizationCommand {
  return {
    attemptId,
    bucket: 'voiceverse-private',
    configurationHash: 'f'.repeat(64),
    executionId,
    expectedModel: model(),
    inputArtifact: inputArtifact('ANALYSIS_AUDIO'),
    manifestKey: 'outputs/diarization.json',
  };
}

function model() {
  return {
    modelId: 'test-model',
    modelRevision: 'sha-1234',
    provider: 'test-provider',
    runtimeVersion: '1.2.3',
  };
}

function artifact(
  kind:
    | 'ANALYSIS_ACCOMPANIMENT_STEM'
    | 'ANALYSIS_VOCAL_STEM'
    | 'DIARIZATION_MANIFEST'
    | 'ISOLATED_SPEECH_AUDIO'
    | 'SEPARATION_MANIFEST'
    | 'TRANSCRIPT_MANIFEST',
) {
  const manifest = kind.endsWith('_MANIFEST');
  return {
    ...(manifest
      ? {}
      : { channels: 1, codecName: 'flac', durationUs: 10_000_000, sampleRateHz: 16_000 }),
    kind,
    mediaType: manifest ? ('application/json' as const) : ('audio/flac' as const),
    sha256: kind.charCodeAt(0).toString(16).padStart(2, '0').repeat(32),
    sizeBytes: manifest ? 1_024 : 4_096,
  };
}

function separationResponse() {
  return {
    artifacts: [
      artifact('ANALYSIS_VOCAL_STEM'),
      artifact('ANALYSIS_ACCOMPANIMENT_STEM'),
      artifact('ISOLATED_SPEECH_AUDIO'),
      artifact('SEPARATION_MANIFEST'),
    ],
    attemptId,
    executionId,
    model: model(),
    producerVersion: 'speech-executor-test',
    schemaVersion: 'voiceverse.separation.v1',
  };
}

function transcriptionResponse() {
  return {
    artifacts: [artifact('TRANSCRIPT_MANIFEST')],
    attemptId,
    executionId,
    model: model(),
    producerVersion: 'speech-executor-test',
    schemaVersion: 'voiceverse.transcript.v1',
    summary: {
      detectedLanguage: 'en',
      languageProbability: 0.99,
      segmentCount: 0,
      wordCount: 0,
    },
  };
}

function diarizationResponse() {
  return {
    artifacts: [artifact('DIARIZATION_MANIFEST')],
    attemptId,
    executionId,
    model: model(),
    producerVersion: 'speech-executor-test',
    schemaVersion: 'voiceverse.diarization.v1',
    summary: { exclusiveTurnCount: 0, speakerCount: 0, turnCount: 0 },
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

describe('HttpSpeechExecutorAdapter', () => {
  it('authenticates capability readiness and returns the exact serving identity', async () => {
    respond({
      capability: 'TRANSCRIPTION',
      enabled: true,
      model: model(),
      ready: true,
      schemaVersion: 'voiceverse.speech-capability.v1',
    });

    await expect(createAdapter().checkReadiness('TRANSCRIPTION')).resolves.toEqual({
      capability: 'TRANSCRIPTION',
      enabled: true,
      model: model(),
      ready: true,
      schemaVersion: 'voiceverse.speech-capability.v1',
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      new URL('http://transcription.internal:8000/internal/v1/speech-capabilities/TRANSCRIPTION'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-speech-executor-token-at-least-32-characters',
        }),
        method: 'GET',
      }),
    );
  });

  it('rejects a readiness response for a different capability', async () => {
    respond({
      capability: 'SPEAKER_DIARIZATION',
      enabled: true,
      model: model(),
      ready: true,
      schemaVersion: 'voiceverse.speech-capability.v1',
    });

    await expect(createAdapter().checkReadiness('TRANSCRIPTION')).rejects.toMatchObject({
      code: 'SPEECH_EXECUTOR_CAPABILITY_MISMATCH',
      retryable: false,
    });
  });

  it('routes each capability to its isolated endpoint with authenticated JSON commands', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(separationResponse()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(transcriptionResponse()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(diarizationResponse()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createAdapter();

    await adapter.separate(separationCommand());
    await adapter.transcribe(transcriptionCommand());
    await adapter.diarize(diarizationCommand());

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => (url as URL).toString())).toEqual([
      'http://separation.internal:8000/internal/v1/vocal-separations',
      'http://transcription.internal:8000/internal/v1/transcriptions',
      'http://diarization.internal:8000/internal/v1/speaker-diarizations',
    ]);
    for (const [, request] of fetchMock.mock.calls as Array<[URL, RequestInit]>) {
      expect(request).toMatchObject({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-speech-executor-token-at-least-32-characters',
          'Content-Type': 'application/json',
        }),
        method: 'POST',
      });
      expect(request.body).not.toContain('test-speech-executor-token');
    }
  });

  it.each([
    [
      'attempt',
      { attemptId: '01900000-0000-7000-8000-000000000199' },
      'SPEECH_EXECUTOR_ATTEMPT_MISMATCH',
    ],
    [
      'execution',
      { executionId: '01900000-0000-7000-8000-000000000198' },
      'SPEECH_EXECUTOR_EXECUTION_MISMATCH',
    ],
  ])('rejects a mismatched %s identity as non-retryable', async (_name, override, code) => {
    respond({ ...transcriptionResponse(), ...override });

    await expect(createAdapter().transcribe(transcriptionCommand())).rejects.toMatchObject({
      code,
      retryable: false,
    });
  });

  it('requires the exact artifact set and rejects duplicate or injected artifacts', async () => {
    const response = separationResponse();
    response.artifacts[3] = artifact('ISOLATED_SPEECH_AUDIO');
    respond(response);

    await expect(createAdapter().separate(separationCommand())).rejects.toMatchObject({
      code: 'SPEECH_EXECUTOR_ARTIFACT_SET_INVALID',
      retryable: false,
    });
  });

  it('rejects unknown response fields through the strict versioned contract', async () => {
    respond({ ...diarizationResponse(), providerDebugPath: '/private/model/cache' });

    await expect(createAdapter().diarize(diarizationCommand())).rejects.toMatchObject({
      code: 'SPEECH_EXECUTOR_CONTRACT_INVALID',
      retryable: false,
    });
  });

  it.each([
    [
      'provider',
      (response: ReturnType<typeof transcriptionResponse>) => {
        response.model.provider = 'p'.repeat(101);
      },
    ],
    [
      'producer version',
      (response: ReturnType<typeof transcriptionResponse>) => {
        response.producerVersion = 'v'.repeat(101);
      },
    ],
  ])('rejects a %s that cannot fit the normalized database schema', async (_field, mutate) => {
    const response = transcriptionResponse();
    mutate(response);
    respond(response);

    await expect(createAdapter().transcribe(transcriptionCommand())).rejects.toMatchObject({
      code: 'SPEECH_EXECUTOR_CONTRACT_INVALID',
      retryable: false,
    });
  });

  it.each([
    [429, 'SPEECH_EXECUTOR_SATURATED', true],
    [503, 'CAPABILITY_SATURATED', true],
    [400, 'CAPABILITY_SATURATED', false],
  ])(
    'classifies HTTP %i retryability without exposing provider messages',
    async (status, expectedCode, retryable) => {
      respond(
        { error: { code: 'CAPABILITY_SATURATED', message: 'provider-internal-sensitive-detail' } },
        status,
      );

      const caught = await createAdapter()
        .transcribe(transcriptionCommand())
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(caught).toMatchObject({ code: expectedCode, retryable });
      expect(caught instanceof Error ? caught.message : '').not.toContain('provider-internal');
    },
  );

  it('rejects a declared oversized response before parsing it', async () => {
    respond(transcriptionResponse(), 200, { 'Content-Length': '1000001' });

    await expect(createAdapter().transcribe(transcriptionCommand())).rejects.toMatchObject({
      code: 'SPEECH_EXECUTOR_RESPONSE_TOO_LARGE',
      retryable: false,
    });
  });

  it('bounds chunked responses by UTF-8 bytes even when multibyte text has no content length', async () => {
    const chunkedBody = JSON.stringify({ padding: 'é'.repeat(600_000) });
    expect(Buffer.byteLength(chunkedBody, 'utf8')).toBeGreaterThan(1_000_000);
    expect(chunkedBody.length).toBeLessThan(1_000_000);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(chunkedBody, {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      ),
    );

    await expect(createAdapter().transcribe(transcriptionCommand())).rejects.toMatchObject({
      code: 'SPEECH_EXECUTOR_RESPONSE_TOO_LARGE',
      retryable: false,
    });
  });

  it('normalizes transport failures as retryable executor unavailability', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket contained sensitive URL')));

    await expect(createAdapter().diarize(diarizationCommand())).rejects.toMatchObject({
      code: 'SPEECH_EXECUTOR_UNAVAILABLE',
      retryable: true,
    });
  });

  it('propagates lease-loss cancellation without serializing control data', async () => {
    const controller = new AbortController();
    controller.abort(new Error('WorkflowAttemptLeaseLost'));
    const fetchMock = vi.fn((_url: URL, request: RequestInit) => {
      expect(request.signal?.aborted).toBe(true);
      expect(request.body).not.toContain('signal');
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createAdapter().diarize(diarizationCommand(), { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'SPEECH_EXECUTOR_ABORTED',
      retryable: true,
    });
  });
});
