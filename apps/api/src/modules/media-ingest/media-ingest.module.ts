import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { MediaIngestService } from './application/media-ingest.service';
import { ObjectStorageModule } from './object-storage.module';
import { MediaIngestController } from './presentation/media-ingest.controller';

@Module({
  controllers: [MediaIngestController],
  imports: [IdentityModule, ObjectStorageModule],
  providers: [MediaIngestService],
})
export class MediaIngestModule {}
