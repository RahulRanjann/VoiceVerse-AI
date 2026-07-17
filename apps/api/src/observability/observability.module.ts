import { Module } from '@nestjs/common';

import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { TelemetryService } from './telemetry.service';

@Module({
  controllers: [MetricsController],
  exports: [MetricsService],
  providers: [MetricsService, TelemetryService],
})
export class ObservabilityModule {}
