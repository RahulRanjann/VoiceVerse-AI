import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { WorkflowQueryService } from './application/workflow-query.service';
import { JobsController, ProjectJobsController } from './presentation/workflow.controller';

@Module({
  controllers: [JobsController, ProjectJobsController],
  imports: [IdentityModule],
  providers: [WorkflowQueryService],
})
export class WorkflowModule {}
