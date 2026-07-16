import { Module } from '@nestjs/common';

import { OBJECT_STORAGE } from './domain/object-storage.port';
import { S3ObjectStorageAdapter } from './infrastructure/s3-object-storage.adapter';

@Module({
  exports: [OBJECT_STORAGE],
  providers: [
    S3ObjectStorageAdapter,
    { provide: OBJECT_STORAGE, useExisting: S3ObjectStorageAdapter },
  ],
})
export class ObjectStorageModule {}
