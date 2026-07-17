import {
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import type { AccessContext } from '../../identity/domain/access-context';
import { AccessTokenGuard } from '../../identity/presentation/access-token.guard';
import { CurrentAuth } from '../../identity/presentation/current-auth.decorator';
import { WorkflowQueryService } from '../application/workflow-query.service';
import { ListProjectJobsQueryDto } from './workflow.dto';

@ApiTags('Workflow')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller({ path: 'projects/:projectId/jobs', version: '1' })
export class ProjectJobsController {
  constructor(private readonly workflows: WorkflowQueryService) {}

  @Get()
  @ApiOperation({ summary: 'List authoritative workflow jobs for a project.' })
  list(
    @CurrentAuth() context: AccessContext,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query() query: ListProjectJobsQueryDto,
  ) {
    return this.workflows.listProjectJobs(context, projectId, query);
  }
}

@ApiTags('Workflow')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller({ path: 'jobs', version: '1' })
export class JobsController {
  constructor(private readonly workflows: WorkflowQueryService) {}

  @Get(':jobId')
  @ApiOperation({ summary: 'Get authoritative workflow progress and prepared-media metadata.' })
  async get(
    @CurrentAuth() context: AccessContext,
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const job = await this.workflows.get(context, jobId);
    const etag = this.workflows.etag(job);
    reply.header('Cache-Control', 'private, no-cache');
    reply.header('ETag', etag);
    if (ifNoneMatch === etag) return reply.status(304).send();
    return reply.send(job);
  }
}
