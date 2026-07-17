import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

import type { Environment } from '../config/environment';

type WorkflowStageMetric =
  | 'source_media_preparation'
  | 'vocal_separation'
  | 'speech_recognition'
  | 'speaker_diarization'
  | 'character_identification';

type WorkflowArtifactMetric =
  | 'analysis_audio'
  | 'canonical_audio'
  | 'probe_manifest'
  | 'vocal_stem_audio'
  | 'accompaniment_stem_audio'
  | 'speech_analysis_audio'
  | 'vocal_separation_manifest'
  | 'transcription_manifest'
  | 'diarization_manifest'
  | 'character_identification_manifest';

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  private readonly workflowActiveAttempts: Gauge<'stage'>;
  private readonly workflowAttemptDuration: Histogram<'outcome' | 'stage'>;
  private readonly workflowAttempts: Counter<'outcome' | 'stage'>;
  private readonly workflowOutputBytes: Counter<'kind'>;

  constructor(config: ConfigService<Environment, true>) {
    const serviceName = config.get('OTEL_SERVICE_NAME', { infer: true });
    this.registry.setDefaultLabels({
      service: serviceName,
      version: config.get('APP_VERSION', { infer: true }),
    });

    collectDefaultMetrics({
      prefix: 'voiceverse_api_',
      register: this.registry,
    });

    const serviceInfo = new Gauge({
      name: 'voiceverse_service_info',
      help: 'Static service build information.',
      labelNames: ['version'] as const,
      registers: [this.registry],
    });
    serviceInfo.set({ version: config.get('APP_VERSION', { infer: true }) }, 1);

    this.workflowActiveAttempts = new Gauge({
      name: 'voiceverse_workflow_active_attempts',
      help: 'Workflow attempts currently owned by this worker process.',
      labelNames: ['stage'] as const,
      registers: [this.registry],
    });
    this.workflowAttemptDuration = new Histogram({
      name: 'voiceverse_workflow_attempt_duration_seconds',
      help: 'End-to-end duration of workflow attempts by stable outcome.',
      labelNames: ['stage', 'outcome'] as const,
      buckets: [1, 5, 15, 60, 300, 900, 3_600, 10_800, 21_600],
      registers: [this.registry],
    });
    this.workflowAttempts = new Counter({
      name: 'voiceverse_workflow_attempts_total',
      help: 'Completed workflow attempts by stable outcome.',
      labelNames: ['stage', 'outcome'] as const,
      registers: [this.registry],
    });
    this.workflowOutputBytes = new Counter({
      name: 'voiceverse_workflow_output_bytes_total',
      help: 'Bytes registered as immutable workflow output artifacts.',
      labelNames: ['kind'] as const,
      registers: [this.registry],
    });
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  workflowAttemptStarted(stage: WorkflowStageMetric): void {
    this.workflowActiveAttempts.inc({ stage });
  }

  workflowAttemptCompleted(
    stage: WorkflowStageMetric,
    outcome: 'failed' | 'succeeded',
    durationSeconds: number,
  ): void {
    this.workflowActiveAttempts.dec({ stage });
    this.workflowAttempts.inc({ outcome, stage });
    this.workflowAttemptDuration.observe({ outcome, stage }, durationSeconds);
  }

  workflowArtifactRegistered(kind: WorkflowArtifactMetric, bytes: number): void {
    this.workflowOutputBytes.inc({ kind }, bytes);
  }
}
