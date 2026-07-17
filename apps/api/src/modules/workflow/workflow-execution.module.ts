import { Module } from '@nestjs/common';

import { SourcePreparationInitializerService } from './application/source-preparation-initializer.service';
import { SourcePreparationReconcilerService } from './application/source-preparation-reconciler.service';

/**
 * Worker-safe workflow providers. This module deliberately owns no controllers
 * or identity dependencies so importing it cannot expand the worker HTTP
 * surface.
 */
@Module({
  exports: [SourcePreparationInitializerService, SourcePreparationReconcilerService],
  providers: [SourcePreparationInitializerService, SourcePreparationReconcilerService],
})
export class WorkflowExecutionModule {}
