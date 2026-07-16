import { Module } from '@nestjs/common';

import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { TelemetryService } from './telemetry.service';

@Module({
  controllers: [MetricsController],
  providers: [MetricsService, TelemetryService],
})
export class ObservabilityModule {}
