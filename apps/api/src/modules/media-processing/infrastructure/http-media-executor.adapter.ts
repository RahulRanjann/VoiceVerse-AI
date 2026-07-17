import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { Environment } from '../../../config/environment';
import {
  MediaExecutorError,
  type MediaExecutorPort,
  type MediaPreparationCommand,
  type MediaPreparationResult,
} from '../domain/media-executor.port';

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const rationalSchema = z.object({
  denominator: z.number().int().positive(),
  numerator: z.number().int(),
});
const commonStreamSchema = z.object({
  bitRate: z.number().int().nonnegative().nullish(),
  codecName: z.string().min(1).max(80),
  durationMs: z.number().int().nonnegative().nullish(),
  isDefault: z.boolean(),
  languageTag: z.string().min(1).max(35).nullish(),
  profile: z.string().min(1).max(100).nullish(),
  startTimeMs: z.number().int().nullish(),
  streamIndex: z.number().int().nonnegative(),
  timeBase: rationalSchema.nullish(),
});
const audioStreamSchema = commonStreamSchema.extend({
  channelLayout: z.string().min(1).max(80).nullish(),
  channels: z.number().int().positive(),
  sampleRateHz: z.number().int().positive(),
});
const videoStreamSchema = commonStreamSchema.extend({
  frameRate: rationalSchema.nullish(),
  height: z.number().int().positive(),
  width: z.number().int().positive(),
});
const artifactSchema = z.object({
  channels: z.number().int().positive().nullish(),
  codecName: z.string().min(1).max(80).nullish(),
  durationMs: z.number().int().nonnegative().nullish(),
  kind: z.enum(['ANALYSIS_AUDIO', 'CANONICAL_AUDIO', 'PROBE_MANIFEST']),
  mediaType: z.string().min(1).max(127),
  sampleRateHz: z.number().int().positive().nullish(),
  sha256: sha256Schema,
  sizeBytes: z.number().int().positive(),
});
const responseSchema = z.object({
  artifacts: z.array(artifactSchema).length(3),
  attemptId: z.string().uuid(),
  executionId: z.string().uuid(),
  producerVersion: z.string().min(1).max(100),
  schemaVersion: z.literal('voiceverse.media-probe.v1'),
  source: z.object({
    audioStreams: z.array(audioStreamSchema).min(1),
    audioSelectionMethod: z.string().min(1).max(100),
    audioSelectionReason: z.string().min(1).max(200),
    bitRate: z.number().int().nonnegative().nullish(),
    containerFormats: z.array(z.string().min(1).max(80)).min(1),
    durationMs: z.number().int().nonnegative(),
    selectedAudio: audioStreamSchema,
    sha256: sha256Schema,
    sizeBytes: z.number().int().positive(),
    videoStreams: z.array(videoStreamSchema).min(1),
  }),
  tools: z.object({ ffmpeg: z.string().min(1).max(100), ffprobe: z.string().min(1).max(100) }),
});

const errorSchema = z.object({
  error: z.object({ code: z.string().min(1).max(100), message: z.string().min(1).max(500) }),
});

@Injectable()
export class HttpMediaExecutorAdapter implements MediaExecutorPort {
  private readonly endpoint: URL;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService<Environment, true>) {
    this.endpoint = new URL(
      '/internal/v1/media-preparations',
      config.get('MEDIA_EXECUTOR_BASE_URL', { infer: true }),
    );
    this.token = config.get('MEDIA_EXECUTOR_BEARER_TOKEN', { infer: true });
    this.timeoutMs = config.get('MEDIA_EXECUTOR_TIMEOUT_MS', { infer: true });
  }

  async prepare(command: MediaPreparationCommand): Promise<MediaPreparationResult> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        body: JSON.stringify(command),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const code =
        error instanceof Error && error.name === 'TimeoutError'
          ? 'MEDIA_EXECUTOR_TIMEOUT'
          : 'MEDIA_EXECUTOR_UNAVAILABLE';
      throw new MediaExecutorError(code, true);
    }

    const body = await this.readJson(response);
    if (!response.ok) {
      const parsed = errorSchema.safeParse(body);
      const code = parsed.success
        ? parsed.data.error.code
        : `MEDIA_EXECUTOR_HTTP_${response.status}`;
      throw new MediaExecutorError(code, response.status === 429 || response.status >= 500);
    }

    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) throw new MediaExecutorError('MEDIA_EXECUTOR_CONTRACT_INVALID', false);
    const result = parsed.data;
    this.assertInvariant(result.attemptId === command.attemptId, 'MEDIA_EXECUTOR_ATTEMPT_MISMATCH');
    this.assertInvariant(
      result.executionId === command.executionId,
      'MEDIA_EXECUTOR_EXECUTION_MISMATCH',
    );
    this.assertInvariant(
      result.source.sha256 === command.expectedSourceSha256,
      'MEDIA_EXECUTOR_SOURCE_CHECKSUM_MISMATCH',
    );
    this.assertInvariant(
      result.source.sizeBytes === command.expectedSourceSizeBytes,
      'MEDIA_EXECUTOR_SOURCE_SIZE_MISMATCH',
    );
    this.assertInvariant(
      result.source.containerFormats.includes('mp4'),
      'MEDIA_EXECUTOR_CONTAINER_UNSUPPORTED',
    );
    const kinds = new Set(result.artifacts.map(({ kind }) => kind));
    this.assertInvariant(kinds.size === 3, 'MEDIA_EXECUTOR_ARTIFACT_SET_INVALID');
    return result;
  }

  private async readJson(response: Response): Promise<unknown> {
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > 2_000_000)
      throw new MediaExecutorError('MEDIA_EXECUTOR_RESPONSE_TOO_LARGE', false);
    try {
      const text = await response.text();
      if (text.length > 2_000_000)
        throw new MediaExecutorError('MEDIA_EXECUTOR_RESPONSE_TOO_LARGE', false);
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof MediaExecutorError) throw error;
      throw new MediaExecutorError('MEDIA_EXECUTOR_RESPONSE_INVALID', response.status >= 500);
    }
  }

  private assertInvariant(condition: boolean, code: string): asserts condition {
    if (!condition) throw new MediaExecutorError(code, false);
  }
}
