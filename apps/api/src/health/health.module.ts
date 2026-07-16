import { Module } from '@nestjs/common';

import { ObjectStorageModule } from '../modules/media-ingest/object-storage.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  controllers: [HealthController],
  imports: [ObjectStorageModule],
  providers: [HealthService],
})
export class HealthModule {}
