import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Buffer } from 'node:buffer';
import { z } from 'zod';

import type { Environment } from '../../../config/environment';
import {
  TranslationExecutorError,
  type TranslationCapabilityReadiness,
  type TranslationExecutionCommand,
  type TranslationExecutionOptions,
  type TranslationExecutionResult,
  type TranslationExecutorPort,
} from '../domain/translation-executor.port';

const MAX_RESPONSE_BYTES = 2_000_000;
const READINESS_TIMEOUT_MS = 5_000;
const generatedTargetTextSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => Array.from(value).length <= 10_000)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 65_536);
const modelSchema = z
  .object({
    modelId: z.string().min(1).max(128),
    modelRevision: z.string().min(1).max(128),
    provider: z.string().min(1).max(100),
    runtimeVersion: z.string().min(1).max(128),
  })
  .strict();
const readinessSchema = z
  .object({
    capability: z.literal('SCENE_TRANSLATION'),
    enabled: z.literal(true),
    model: modelSchema,
    ready: z.literal(true),
    schemaVersion: z.literal('voiceverse.translation-capability.v1'),
  })
  .strict();
const translationSchema = z
  .object({
    executionId: z.string().uuid(),
    generationId: z.string().uuid(),
    model: modelSchema,
    producerVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,99}$/),
    promptVersion: z.string().min(1).max(100),
    schemaVersion: z.literal('voiceverse.translation.v1'),
    sourceLanguageTag: z.string().min(2).max(35),
    targetLanguageTag: z.string().min(2).max(35),
    translations: z
      .array(
        z
          .object({
            dialogueId: z.string().uuid(),
            sourceRevisionId: z.string().uuid(),
            targetText: generatedTargetTextSchema,
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
const errorSchema = z
  .object({
    error: z
      .object({
        code: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/),
        message: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict();

@Injectable()
export class HttpTranslationExecutorAdapter implements TranslationExecutorPort {
  private readonly readinessEndpoint: URL;
  private readonly token: string;
  private readonly translationEndpoint: URL;
  private readonly translationTimeoutMs: number;

  constructor(config: ConfigService<Environment, true>) {
    const baseUrl = config.get('TRANSLATION_EXECUTOR_BASE_URL', { infer: true });
    this.readinessEndpoint = new URL('/internal/v1/translation-capability', baseUrl);
    this.translationEndpoint = new URL('/internal/v1/translations', baseUrl);
    this.token = config.get('TRANSLATION_EXECUTOR_BEARER_TOKEN', { infer: true });
    this.translationTimeoutMs = config.get('TRANSLATION_EXECUTOR_TIMEOUT_MS', { infer: true });
  }

  checkReadiness(): Promise<TranslationCapabilityReadiness> {
    return this.request(
      this.readinessEndpoint,
      {
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.token}` },
        method: 'GET',
      },
      READINESS_TIMEOUT_MS,
      readinessSchema,
    );
  }

  async translate(
    command: TranslationExecutionCommand,
    options?: TranslationExecutionOptions,
  ): Promise<TranslationExecutionResult> {
    const result = await this.request(
      this.translationEndpoint,
      {
        body: JSON.stringify(command),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      },
      this.translationTimeoutMs,
      translationSchema,
      options?.signal,
    );
    this.assertIdentity(result, command);
    this.assertCompleteResult(result, command);
    return result;
  }

  private assertIdentity(
    result: TranslationExecutionResult,
    command: TranslationExecutionCommand,
  ): void {
    if (
      result.executionId !== command.executionId ||
      result.generationId !== command.generationId ||
      result.promptVersion !== command.promptVersion ||
      result.sourceLanguageTag !== command.sourceLanguageTag ||
      result.targetLanguageTag !== command.targetLanguageTag ||
      result.model.modelId !== command.expectedModel.modelId ||
      result.model.modelRevision !== command.expectedModel.modelRevision ||
      result.model.provider !== command.expectedModel.provider ||
      result.model.runtimeVersion !== command.expectedModel.runtimeVersion
    ) {
      throw new TranslationExecutorError('TRANSLATION_EXECUTOR_IDENTITY_MISMATCH', false);
    }
  }

  private assertCompleteResult(
    result: TranslationExecutionResult,
    command: TranslationExecutionCommand,
  ): void {
    if (result.translations.length !== command.dialogues.length) {
      throw new TranslationExecutorError('TRANSLATION_EXECUTOR_CARDINALITY_MISMATCH', false);
    }
    const expected = new Map(
      command.dialogues.map((dialogue) => [dialogue.dialogueId, dialogue.sourceRevisionId]),
    );
    for (const translation of result.translations) {
      const sourceRevisionId = expected.get(translation.dialogueId);
      if (!sourceRevisionId || sourceRevisionId !== translation.sourceRevisionId) {
        throw new TranslationExecutorError('TRANSLATION_EXECUTOR_DIALOGUE_MISMATCH', false);
      }
      expected.delete(translation.dialogueId);
    }
    if (expected.size > 0) {
      throw new TranslationExecutorError('TRANSLATION_EXECUTOR_DIALOGUE_MISSING', false);
    }
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
      const code = externalSignal?.aborted
        ? 'TRANSLATION_EXECUTOR_ABORTED'
        : error instanceof Error && error.name === 'TimeoutError'
          ? 'TRANSLATION_EXECUTOR_TIMEOUT'
          : 'TRANSLATION_EXECUTOR_UNAVAILABLE';
      throw new TranslationExecutorError(code, true);
    }

    const body = await this.readJson(response);
    if (!response.ok) {
      const parsed = errorSchema.safeParse(body);
      const code =
        response.status === 429
          ? 'TRANSLATION_EXECUTOR_SATURATED'
          : parsed.success
            ? parsed.data.error.code
            : `TRANSLATION_EXECUTOR_HTTP_${response.status}`;
      throw new TranslationExecutorError(code, response.status === 429 || response.status >= 500);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new TranslationExecutorError('TRANSLATION_EXECUTOR_CONTRACT_INVALID', false);
    }
    return parsed.data;
  }

  private async readJson(response: Response): Promise<unknown> {
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_RESPONSE_BYTES) {
      throw new TranslationExecutorError('TRANSLATION_EXECUTOR_RESPONSE_TOO_LARGE', false);
    }
    if (!response.body) {
      throw new TranslationExecutorError(
        'TRANSLATION_EXECUTOR_RESPONSE_INVALID',
        response.status >= 500,
      );
    }

    try {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new TranslationExecutorError('TRANSLATION_EXECUTOR_RESPONSE_TOO_LARGE', false);
        }
        chunks.push(value);
      }
      const body = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
    } catch (error) {
      if (error instanceof TranslationExecutorError) throw error;
      throw new TranslationExecutorError(
        'TRANSLATION_EXECUTOR_RESPONSE_INVALID',
        response.status >= 500,
      );
    }
  }
}
