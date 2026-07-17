import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import { HttpMediaExecutorAdapter } from './http-media-executor.adapter';

const attemptId = '01900000-0000-7000-8000-000000000040';
const executionId = '01900000-0000-7000-8000-000000000041';
const sourceSha256 = 'a'.repeat(64);

function createAdapter() {
  const values: Partial<Environment> = {
    MEDIA_EXECUTOR_BASE_URL: 'http://media-executor.internal:8000',
    MEDIA_EXECUTOR_BEARER_TOKEN: 'test-media-executor-token-at-least-32-characters',
    MEDIA_EXECUTOR_TIMEOUT_MS: 5_000,
  };
  const config = {
    get: vi.fn((key: keyof Environment) => values[key]),
  } as unknown as ConfigService<Environment, true>;
  return new HttpMediaExecutorAdapter(config);
}

function command() {
  return {
    analysisAudioKey: 'artifacts/analysis.flac',
    attemptId,
    bucket: 'voiceverse-test',
    canonicalAudioKey: 'artifacts/canonical.flac',
    configurationHash: 'f'.repeat(64),
    executionId,
    expectedSourceSha256: sourceSha256,
    expectedSourceSizeBytes: 5,
    preferredAudioLanguageTag: 'en',
    probeManifestKey: 'artifacts/probe.json',
    sourceKey: 'source/movie.mp4',
  };
}

function successfulResponse() {
  const selectedAudio = {
    bitRate: 128_000,
    channelLayout: 'stereo',
    channels: 2,
    codecName: 'aac',
    durationMs: 1_000,
    isDefault: true,
    languageTag: 'en',
    profile: 'LC',
    sampleRateHz: 48_000,
    startTimeMs: 0,
    streamIndex: 1,
    timeBase: { denominator: 48_000, numerator: 1 },
  };
  return {
    artifacts: [
      {
        channels: 2,
        codecName: 'flac',
        durationMs: 1_000,
        kind: 'CANONICAL_AUDIO',
        mediaType: 'audio/flac',
        sampleRateHz: 48_000,
        sha256: 'b'.repeat(64),
        sizeBytes: 200,
      },
      {
        channels: 1,
        codecName: 'flac',
        durationMs: 1_000,
        kind: 'ANALYSIS_AUDIO',
        mediaType: 'audio/flac',
        sampleRateHz: 16_000,
        sha256: 'c'.repeat(64),
        sizeBytes: 100,
      },
      {
        kind: 'PROBE_MANIFEST',
        mediaType: 'application/json',
        sha256: 'd'.repeat(64),
        sizeBytes: 500,
      },
    ],
    attemptId,
    executionId,
    producerVersion: 'test-executor-version',
    schemaVersion: 'voiceverse.media-probe.v1',
    source: {
      audioSelectionMethod: 'DEFAULT_THEN_LANGUAGE_THEN_LOWEST_INDEX',
      audioSelectionReason: 'DEFAULT_DISPOSITION',
      audioStreams: [selectedAudio],
      bitRate: 2_000_000,
      containerFormats: ['mov', 'mp4'],
      durationMs: 1_000,
      selectedAudio,
      sha256: sourceSha256,
      sizeBytes: 5,
      videoStreams: [
        {
          codecName: 'h264',
          durationMs: 1_000,
          frameRate: { denominator: 1, numerator: 24 },
          height: 1_080,
          isDefault: true,
          streamIndex: 0,
          width: 1_920,
        },
      ],
    },
    tools: { ffmpeg: '8.0', ffprobe: '8.0' },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('HttpMediaExecutorAdapter', () => {
  it('validates the versioned result and authenticates without exposing the token in the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(successfulResponse()), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(createAdapter().prepare(command())).resolves.toMatchObject({ attemptId });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/internal/v1/media-preparations');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer test-media-executor-token-at-least-32-characters',
    });
    expect(typeof init.body).toBe('string');
    if (typeof init.body !== 'string') throw new Error('Expected a serialized JSON request body.');
    expect(init.body).not.toContain('test-media-executor-token');
  });

  it('maps dependency failures to retryable stable errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'OBJECT_STORAGE_UNAVAILABLE', message: 'Unavailable.' },
          }),
          { status: 503 },
        ),
      ),
    );

    await expect(createAdapter().prepare(command())).rejects.toMatchObject({
      code: 'OBJECT_STORAGE_UNAVAILABLE',
      retryable: true,
    });
  });

  it('rejects mismatched execution identity as a non-retryable contract violation', async () => {
    const payload = { ...successfulResponse(), attemptId: '01900000-0000-7000-8000-000000000099' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })),
    );

    await expect(createAdapter().prepare(command())).rejects.toMatchObject({
      code: 'MEDIA_EXECUTOR_ATTEMPT_MISMATCH',
      retryable: false,
    });
  });

  it('independently rejects a non-MP4 result from the compute plane', async () => {
    const response = successfulResponse();
    response.source.containerFormats = ['matroska', 'webm'];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 })),
    );

    await expect(createAdapter().prepare(command())).rejects.toMatchObject({
      code: 'MEDIA_EXECUTOR_CONTAINER_UNSUPPORTED',
      retryable: false,
    });
  });

  it('rejects an audio-only result contract from the compute plane', async () => {
    const response = successfulResponse();
    response.source.videoStreams = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 })),
    );

    await expect(createAdapter().prepare(command())).rejects.toMatchObject({
      code: 'MEDIA_EXECUTOR_CONTRACT_INVALID',
      retryable: false,
    });
  });
});
