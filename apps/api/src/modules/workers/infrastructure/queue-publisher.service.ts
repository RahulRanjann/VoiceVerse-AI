import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { z } from 'zod';

import type { Environment } from '../../../config/environment';
import {
  EXECUTE_SCENE_TRANSLATION_JOB,
  LOCALIZATION_TRANSLATION_EVENT,
  LOCALIZATION_TRANSLATION_QUEUE,
} from '../../localization/infrastructure/localization.queue';
import {
  MEDIA_PROCESSING_QUEUE,
  PREPARE_SOURCE_MEDIA_JOB,
} from '../../media-processing/infrastructure/media-processing.queue';
import { SPEECH_STAGE_EVENTS } from '../../speech-analysis/domain/speech-analysis.constants';
import {
  CHARACTER_IDENTIFICATION_QUEUE,
  DIARIZATION_QUEUE,
  EXECUTE_CHARACTER_IDENTIFICATION_JOB,
  EXECUTE_DIARIZATION_JOB,
  EXECUTE_TRANSCRIPTION_JOB,
  EXECUTE_VOCAL_SEPARATION_JOB,
  TRANSCRIPTION_QUEUE,
  VOCAL_SEPARATION_QUEUE,
} from '../../speech-analysis/infrastructure/speech-analysis.queue';
import { MEDIA_SECURITY_QUEUE, SCAN_VIDEO_JOB } from './media-security.queue';

const scanRequestSchema = z.object({
  attemptId: z.string().uuid(),
  bucket: z.string().min(1),
  key: z.string().min(1),
  organizationId: z.string().uuid(),
  videoId: z.string().uuid(),
});
const sourcePreparationRequestSchema = z.object({ attemptId: z.string().uuid() });
const translationRequestSchema = z.object({ generationId: z.string().uuid() }).strict();

@Injectable()
export class QueuePublisherService implements OnApplicationShutdown {
  private readonly connection: Redis;
  private readonly mediaProcessingQueue: Queue;
  private readonly mediaSecurityQueue: Queue;
  private readonly characterIdentificationQueue: Queue;
  private readonly diarizationQueue: Queue;
  private readonly transcriptionQueue: Queue;
  private readonly vocalSeparationQueue: Queue;
  private readonly localizationTranslationQueue: Queue;

  constructor(config: ConfigService<Environment, true>) {
    this.connection = new Redis(config.get('REDIS_URL', { infer: true }), {
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
    this.mediaSecurityQueue = new Queue(MEDIA_SECURITY_QUEUE, { connection: this.connection });
    this.mediaProcessingQueue = new Queue(MEDIA_PROCESSING_QUEUE, { connection: this.connection });
    this.vocalSeparationQueue = new Queue(VOCAL_SEPARATION_QUEUE, { connection: this.connection });
    this.transcriptionQueue = new Queue(TRANSCRIPTION_QUEUE, { connection: this.connection });
    this.diarizationQueue = new Queue(DIARIZATION_QUEUE, { connection: this.connection });
    this.characterIdentificationQueue = new Queue(CHARACTER_IDENTIFICATION_QUEUE, {
      connection: this.connection,
    });
    this.localizationTranslationQueue = new Queue(LOCALIZATION_TRANSLATION_QUEUE, {
      connection: this.connection,
    });
  }

  async ping(): Promise<void> {
    if (this.connection.status === 'wait') await this.connection.connect();
    const response = await this.connection.ping();
    if (response !== 'PONG') throw new Error('RedisUnexpectedPingResponse');
  }

  async publish(event: {
    eventType: string;
    deduplicationKey: string;
    payload: unknown;
  }): Promise<void> {
    const jobId = `outbox-${createHash('sha256').update(event.deduplicationKey).digest('hex')}`;
    if (event.eventType === 'media.scan.requested') {
      await this.removeTerminalDelivery(this.mediaSecurityQueue, jobId);
      await this.mediaSecurityQueue.add(SCAN_VIDEO_JOB, scanRequestSchema.parse(event.payload), {
        attempts: 5,
        backoff: { delay: 5_000, type: 'exponential' },
        jobId,
        removeOnComplete: true,
        removeOnFail: true,
      });
      return;
    }
    if (event.eventType === 'workflow.stage.execute') {
      await this.removeTerminalDelivery(this.mediaProcessingQueue, jobId);
      await this.mediaProcessingQueue.add(
        PREPARE_SOURCE_MEDIA_JOB,
        sourcePreparationRequestSchema.parse(event.payload),
        {
          attempts: 1,
          jobId,
          // PostgreSQL owns workflow history. Removing terminal transport rows
          // lets the durable outbox replay the same deterministic job ID after
          // Redis loss or a delivery-level failure.
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      return;
    }
    if (event.eventType === LOCALIZATION_TRANSLATION_EVENT) {
      await this.removeTerminalDelivery(this.localizationTranslationQueue, jobId);
      await this.localizationTranslationQueue.add(
        EXECUTE_SCENE_TRANSLATION_JOB,
        translationRequestSchema.parse(event.payload),
        {
          attempts: 1,
          jobId,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      return;
    }
    const speechDelivery = this.speechDelivery(event.eventType);
    if (speechDelivery) {
      await this.removeTerminalDelivery(speechDelivery.queue, jobId);
      await speechDelivery.queue.add(
        speechDelivery.jobName,
        sourcePreparationRequestSchema.parse(event.payload),
        {
          attempts: 1,
          jobId,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      return;
    }
    throw new Error('UnsupportedOutboxEvent');
  }

  private speechDelivery(eventType: string): { jobName: string; queue: Queue } | null {
    switch (eventType) {
      case SPEECH_STAGE_EVENTS.VOCAL_SEPARATION:
        return { jobName: EXECUTE_VOCAL_SEPARATION_JOB, queue: this.vocalSeparationQueue };
      case SPEECH_STAGE_EVENTS.SPEECH_RECOGNITION:
        return { jobName: EXECUTE_TRANSCRIPTION_JOB, queue: this.transcriptionQueue };
      case SPEECH_STAGE_EVENTS.SPEAKER_DIARIZATION:
        return { jobName: EXECUTE_DIARIZATION_JOB, queue: this.diarizationQueue };
      case SPEECH_STAGE_EVENTS.CHARACTER_IDENTIFICATION:
        return {
          jobName: EXECUTE_CHARACTER_IDENTIFICATION_JOB,
          queue: this.characterIdentificationQueue,
        };
      default:
        return null;
    }
  }

  private async removeTerminalDelivery(queue: Queue, jobId: string): Promise<void> {
    const existing = await queue.getJob(jobId);
    if (!existing) return;
    const state = await existing.getState();
    if (state === 'completed' || state === 'failed') await existing.remove();
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([
      this.mediaSecurityQueue.close(),
      this.mediaProcessingQueue.close(),
      this.vocalSeparationQueue.close(),
      this.transcriptionQueue.close(),
      this.diarizationQueue.close(),
      this.characterIdentificationQueue.close(),
      this.localizationTranslationQueue.close(),
    ]);
    if (this.connection.status !== 'end') await this.connection.quit();
  }
}
