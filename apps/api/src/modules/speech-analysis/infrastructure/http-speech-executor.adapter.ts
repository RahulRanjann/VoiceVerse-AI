import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { Environment } from '../../../config/environment';
import {
  SpeechExecutorError,
  type SpeechCapability,
  type SpeechCapabilityReadiness,
  type SpeakerDiarizationCommand,
  type SpeakerDiarizationResult,
  type SpeechExecutorPort,
  type SpeechExecutionOptions,
  type TranscriptionCommand,
  type TranscriptionResult,
  type VocalSeparationCommand,
  type VocalSeparationResult,
} from '../domain/speech-executor.port';

const MAX_RESPONSE_BYTES = 1_000_000;
const READINESS_TIMEOUT_MS = 5_000;
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const modelSchema = z
  .object({
    modelId: z.string().min(1).max(128),
    modelRevision: z.string().min(1).max(128),
    provider: z.string().min(1).max(100),
    runtimeVersion: z.string().min(1).max(128),
  })
  .strict();
const artifactSchema = z
  .object({
    channels: z.number().int().positive().max(32).nullish(),
    codecName: z.string().min(1).max(40).nullish(),
    durationUs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullish(),
    kind: z.enum([
      'ANALYSIS_VOCAL_STEM',
      'ANALYSIS_ACCOMPANIMENT_STEM',
      'ISOLATED_SPEECH_AUDIO',
      'SEPARATION_MANIFEST',
      'TRANSCRIPT_MANIFEST',
      'DIARIZATION_MANIFEST',
    ]),
    mediaType: z.enum(['application/json', 'audio/flac']),
    sampleRateHz: z.number().int().positive().max(384_000).nullish(),
    sha256: sha256Schema,
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const baseResultShape = {
  artifacts: z.array(artifactSchema).min(1).max(4),
  attemptId: z.string().uuid(),
  executionId: z.string().uuid(),
  model: modelSchema,
  producerVersion: z.string().min(1).max(100),
};
const separationResultSchema = z
  .object({ ...baseResultShape, schemaVersion: z.literal('voiceverse.separation.v1') })
  .strict();
const transcriptionResultSchema = z
  .object({
    ...baseResultShape,
    schemaVersion: z.literal('voiceverse.transcript.v1'),
    summary: z
      .object({
        detectedLanguage: z.string().min(2).max(35),
        languageProbability: z.number().min(0).max(1).nullish(),
        segmentCount: z.number().int().nonnegative(),
        wordCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
const diarizationResultSchema = z
  .object({
    ...baseResultShape,
    schemaVersion: z.literal('voiceverse.diarization.v1'),
    summary: z
      .object({
        exclusiveTurnCount: z.number().int().nonnegative(),
        speakerCount: z.number().int().nonnegative(),
        turnCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
const errorSchema = z
  .object({
    error: z
      .object({ code: z.string().min(1).max(100), message: z.string().min(1).max(500) })
      .strict(),
  })
  .strict();
const capabilityReadinessSchema = z
  .object({
    capability: z.enum(['VOCAL_SEPARATION', 'TRANSCRIPTION', 'SPEAKER_DIARIZATION']),
    enabled: z.literal(true),
    model: modelSchema,
    ready: z.literal(true),
    schemaVersion: z.literal('voiceverse.speech-capability.v1'),
  })
  .strict();

@Injectable()
export class HttpSpeechExecutorAdapter implements SpeechExecutorPort {
  private readonly capabilityEndpoints: Record<SpeechCapability, URL>;
  private readonly diarizationEndpoint: URL;
  private readonly diarizationTimeoutMs: number;
  private readonly separationEndpoint: URL;
  private readonly separationTimeoutMs: number;
  private readonly token: string;
  private readonly transcriptionEndpoint: URL;
  private readonly transcriptionTimeoutMs: number;

  constructor(config: ConfigService<Environment, true>) {
    const separationBaseUrl = config.get('VOCAL_SEPARATION_EXECUTOR_BASE_URL', { infer: true });
    const transcriptionBaseUrl = config.get('TRANSCRIPTION_EXECUTOR_BASE_URL', { infer: true });
    const diarizationBaseUrl = config.get('DIARIZATION_EXECUTOR_BASE_URL', { infer: true });
    this.separationEndpoint = new URL('/internal/v1/vocal-separations', separationBaseUrl);
    this.transcriptionEndpoint = new URL('/internal/v1/transcriptions', transcriptionBaseUrl);
    this.diarizationEndpoint = new URL('/internal/v1/speaker-diarizations', diarizationBaseUrl);
    this.capabilityEndpoints = {
      SPEAKER_DIARIZATION: new URL(
        '/internal/v1/speech-capabilities/SPEAKER_DIARIZATION',
        diarizationBaseUrl,
      ),
      TRANSCRIPTION: new URL(
        '/internal/v1/speech-capabilities/TRANSCRIPTION',
        transcriptionBaseUrl,
      ),
      VOCAL_SEPARATION: new URL(
        '/internal/v1/speech-capabilities/VOCAL_SEPARATION',
        separationBaseUrl,
      ),
    };
    this.token = config.get('SPEECH_EXECUTOR_BEARER_TOKEN', { infer: true });
    this.separationTimeoutMs = config.get('VOCAL_SEPARATION_EXECUTOR_TIMEOUT_MS', {
      infer: true,
    });
    this.transcriptionTimeoutMs = config.get('TRANSCRIPTION_EXECUTOR_TIMEOUT_MS', {
      infer: true,
    });
    this.diarizationTimeoutMs = config.get('DIARIZATION_EXECUTOR_TIMEOUT_MS', { infer: true });
  }

  async checkReadiness(capability: SpeechCapability): Promise<SpeechCapabilityReadiness> {
    const result = await this.request(
      this.capabilityEndpoints[capability],
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        method: 'GET',
      },
      READINESS_TIMEOUT_MS,
      capabilityReadinessSchema,
    );
    if (result.capability !== capability) {
      throw new SpeechExecutorError('SPEECH_EXECUTOR_CAPABILITY_MISMATCH', false);
    }
    return result;
  }

  async separate(
    command: VocalSeparationCommand,
    options?: SpeechExecutionOptions,
  ): Promise<VocalSeparationResult> {
    const result = await this.execute(
      this.separationEndpoint,
      command,
      this.separationTimeoutMs,
      separationResultSchema,
      options?.signal,
    );
    this.assertIdentity(result, command);
    this.assertArtifactSet(result.artifacts, [
      'ANALYSIS_VOCAL_STEM',
      'ANALYSIS_ACCOMPANIMENT_STEM',
      'ISOLATED_SPEECH_AUDIO',
      'SEPARATION_MANIFEST',
    ]);
    return result;
  }

  async transcribe(
    command: TranscriptionCommand,
    options?: SpeechExecutionOptions,
  ): Promise<TranscriptionResult> {
    const result = await this.execute(
      this.transcriptionEndpoint,
      command,
      this.transcriptionTimeoutMs,
      transcriptionResultSchema,
      options?.signal,
    );
    this.assertIdentity(result, command);
    this.assertArtifactSet(result.artifacts, ['TRANSCRIPT_MANIFEST']);
    return result;
  }

  async diarize(
    command: SpeakerDiarizationCommand,
    options?: SpeechExecutionOptions,
  ): Promise<SpeakerDiarizationResult> {
    const result = await this.execute(
      this.diarizationEndpoint,
      command,
      this.diarizationTimeoutMs,
      diarizationResultSchema,
      options?.signal,
    );
    this.assertIdentity(result, command);
    this.assertArtifactSet(result.artifacts, ['DIARIZATION_MANIFEST']);
    return result;
  }

  private async execute<T>(
    endpoint: URL,
    command: object,
    timeoutMs: number,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.request(
      endpoint,
      {
        body: JSON.stringify(command),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      },
      timeoutMs,
      schema,
      signal,
    );
  }

  private async request<T>(
    endpoint: URL,
    request: RequestInit,
    timeoutMs: number,
    schema: z.ZodType<T>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        ...request,
        signal: externalSignal
          ? AbortSignal.any([AbortSignal.timeout(timeoutMs), externalSignal])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const code =
        externalSignal?.aborted
          ? 'SPEECH_EXECUTOR_ABORTED'
          : error instanceof Error && error.name === 'TimeoutError'
          ? 'SPEECH_EXECUTOR_TIMEOUT'
          : 'SPEECH_EXECUTOR_UNAVAILABLE';
      throw new SpeechExecutorError(code, true);
    }

    const body = await this.readJson(response);
    if (!response.ok) {
      const parsed = errorSchema.safeParse(body);
      // HTTP 429 is a trusted pre-execution capacity signal regardless of a
      // provider's error vocabulary. The coordinator can therefore defer it
      // without spending a semantic model attempt.
      const code =
        response.status === 429
          ? 'SPEECH_EXECUTOR_SATURATED'
          : parsed.success
            ? parsed.data.error.code
            : `SPEECH_EXECUTOR_HTTP_${response.status}`;
      throw new SpeechExecutorError(code, response.status === 429 || response.status >= 500);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new SpeechExecutorError('SPEECH_EXECUTOR_CONTRACT_INVALID', false);
    }
    return parsed.data;
  }

  private async readJson(response: Response): Promise<unknown> {
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_RESPONSE_BYTES) {
      throw new SpeechExecutorError('SPEECH_EXECUTOR_RESPONSE_TOO_LARGE', false);
    }
    try {
      if (!response.body) {
        throw new SpeechExecutorError('SPEECH_EXECUTOR_RESPONSE_INVALID', response.status >= 500);
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new SpeechExecutorError('SPEECH_EXECUTOR_RESPONSE_TOO_LARGE', false);
        }
        chunks.push(value);
      }

      const body = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof SpeechExecutorError) throw error;
      throw new SpeechExecutorError('SPEECH_EXECUTOR_RESPONSE_INVALID', response.status >= 500);
    }
  }

  private assertIdentity(
    result: { attemptId: string; executionId: string },
    command: { attemptId: string; executionId: string },
  ): void {
    if (result.attemptId !== command.attemptId) {
      throw new SpeechExecutorError('SPEECH_EXECUTOR_ATTEMPT_MISMATCH', false);
    }
    if (result.executionId !== command.executionId) {
      throw new SpeechExecutorError('SPEECH_EXECUTOR_EXECUTION_MISMATCH', false);
    }
  }

  private assertArtifactSet(artifacts: Array<{ kind: string }>, expectedKinds: string[]): void {
    const actual = artifacts.map(({ kind }) => kind).toSorted();
    const expected = expectedKinds.toSorted();
    if (
      actual.length !== expected.length ||
      actual.some((kind, index) => kind !== expected[index])
    ) {
      throw new SpeechExecutorError('SPEECH_EXECUTOR_ARTIFACT_SET_INVALID', false);
    }
  }
}
