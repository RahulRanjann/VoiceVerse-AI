import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { collectDefaultMetrics, Gauge, Registry } from 'prom-client';

import type { Environment } from '../config/environment';

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();

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
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
