import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { ProjectsService } from './application/projects.service';
import { LanguagesController, ProjectsController } from './presentation/projects.controller';

@Module({
  controllers: [LanguagesController, ProjectsController],
  exports: [ProjectsService],
  imports: [IdentityModule],
  providers: [ProjectsService],
})
export class ProjectsModule {}
