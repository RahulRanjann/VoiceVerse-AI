import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AccessContext } from '../../identity/domain/access-context';
import { AccessTokenGuard } from '../../identity/presentation/access-token.guard';
import { CurrentAuth } from '../../identity/presentation/current-auth.decorator';
import { ProjectsService } from '../application/projects.service';
import { CreateProjectDto, ListProjectsQueryDto } from './project.dto';

@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller({ path: 'projects', version: '1' })
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @ApiOperation({ summary: 'List projects in the active organization.' })
  list(@CurrentAuth() context: AccessContext, @Query() query: ListProjectsQueryDto) {
    return this.projects.list(context, query);
  }

  @Post()
  @ApiOperation({ summary: 'Create a project in the active organization.' })
  create(@CurrentAuth() context: AccessContext, @Body() input: CreateProjectDto) {
    return this.projects.create(context, input);
  }
}

@ApiTags('Languages')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller({ path: 'languages', version: '1' })
export class LanguagesController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @ApiOperation({ summary: 'List enabled source and target languages.' })
  list() {
    return this.projects.languages();
  }
}
