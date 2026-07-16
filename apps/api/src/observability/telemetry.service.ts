import { Injectable, OnApplicationShutdown } from '@nestjs/common';

import { shutdownTelemetry } from './instrumentation';

@Injectable()
export class TelemetryService implements OnApplicationShutdown {
  onApplicationShutdown(): Promise<void> {
    return shutdownTelemetry();
  }
}
