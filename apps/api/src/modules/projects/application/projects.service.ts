import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { OrganizationRole, ProjectStatus } from '@voiceverse/database';

import { DatabaseService } from '../../../infrastructure/database/database.service';
import { uuidv7 } from '../../../shared/uuid';
import type { AccessContext } from '../../identity/domain/access-context';
import type { CreateProjectDto, ListProjectsQueryDto } from '../presentation/project.dto';

interface ProjectCursor {
  id: string;
  updatedAt: Date;
}

@Injectable()
export class ProjectsService {
  constructor(private readonly database: DatabaseService) {}

  async languages() {
    return this.database.client.language.findMany({
      orderBy: { englishName: 'asc' },
      select: {
        bcp47Tag: true,
        englishName: true,
        id: true,
        nativeName: true,
      },
      where: { enabled: true },
    });
  }

  async create(context: AccessContext, input: CreateProjectDto) {
    this.assertCanEdit(context);
    const name = input.name.trim();
    if (!name) throw new BadRequestException('Project name cannot be blank.');
    if (input.targetLanguageIds.includes(input.sourceLanguageId)) {
      throw new BadRequestException('A target language must differ from the source language.');
    }

    const languageIds = [input.sourceLanguageId, ...input.targetLanguageIds];
    const languages = await this.database.client.language.findMany({
      select: { id: true },
      where: { enabled: true, id: { in: languageIds } },
    });
    if (languages.length !== languageIds.length) {
      throw new BadRequestException('One or more selected languages are unavailable.');
    }

    const projectId = uuidv7();
    return this.database.client.$transaction(async (transaction) => {
      const project = await transaction.project.create({
        data: {
          createdByUserId: context.userId,
          id: projectId,
          name,
          organizationId: context.organizationId,
          sourceLanguageId: input.sourceLanguageId,
          status: ProjectStatus.DRAFT,
          targetLanguages: {
            create: input.targetLanguageIds.map((languageId) => ({
              id: uuidv7(),
              languageId,
            })),
          },
        },
        include: this.projectIncludes(),
      });
      await transaction.auditLog.create({
        data: {
          action: 'project.created',
          actorUserId: context.userId,
          id: uuidv7(),
          organizationId: context.organizationId,
          resourceId: projectId,
          resourceType: 'project',
        },
      });
      return this.toProjectResponse(project);
    });
  }

  async list(context: AccessContext, query: ListProjectsQueryDto) {
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : undefined;
    const projects = await this.database.client.project.findMany({
      include: this.projectIncludes(),
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      where: {
        organizationId: context.organizationId,
        ...(cursor
          ? {
              OR: [
                { updatedAt: { lt: cursor.updatedAt } },
                { id: { lt: cursor.id }, updatedAt: cursor.updatedAt },
              ],
            }
          : {}),
      },
    });
    const hasMore = projects.length > query.limit;
    const page = projects.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map((project) => this.toProjectResponse(project)),
      nextCursor: hasMore && last ? this.encodeCursor(last.updatedAt, last.id) : null,
    };
  }

  private projectIncludes() {
    return {
      sourceLanguage: {
        select: { bcp47Tag: true, englishName: true, id: true },
      },
      targetLanguages: {
        include: {
          language: { select: { bcp47Tag: true, englishName: true, id: true } },
        },
        orderBy: { language: { englishName: 'asc' as const } },
      },
      videos: {
        orderBy: { createdAt: 'desc' as const },
        select: {
          id: true,
          ingestStatus: true,
          securityStatus: true,
        },
        take: 1,
      },
      workflowJobs: {
        orderBy: { createdAt: 'desc' as const },
        select: {
          completedAt: true,
          failureCode: true,
          id: true,
          kind: true,
          pipelineVersion: true,
          revision: true,
          stages: {
            orderBy: { ordinal: 'asc' as const },
            select: {
              progressBasisPoints: true,
              status: true,
              weightBasisPoints: true,
            },
          },
          startedAt: true,
          status: true,
          updatedAt: true,
        },
        take: 1,
      },
    } as const;
  }

  private toProjectResponse(project: {
    id: string;
    name: string;
    status: ProjectStatus;
    createdAt: Date;
    updatedAt: Date;
    sourceLanguage: { id: string; bcp47Tag: string; englishName: string };
    targetLanguages: Array<{
      language: { id: string; bcp47Tag: string; englishName: string };
    }>;
    videos: Array<{ id: string; ingestStatus: string; securityStatus: string }>;
    workflowJobs: Array<{
      completedAt: Date | null;
      failureCode: string | null;
      id: string;
      kind: string;
      pipelineVersion: string;
      revision: number;
      stages: Array<{
        progressBasisPoints: number;
        status: string;
        weightBasisPoints: number;
      }>;
      startedAt: Date | null;
      status: string;
      updatedAt: Date;
    }>;
  }) {
    const latestJob = project.workflowJobs[0];
    const totalWeight = latestJob?.stages.reduce(
      (total, stage) => total + stage.weightBasisPoints,
      0,
    );
    const weightedProgress = latestJob?.stages.reduce(
      (total, stage) => total + stage.weightBasisPoints * stage.progressBasisPoints,
      0,
    );
    return {
      createdAt: project.createdAt.toISOString(),
      id: project.id,
      latestVideo: project.videos[0] ?? null,
      latestJob: latestJob
        ? {
            completedAt: latestJob.completedAt?.toISOString() ?? null,
            failureCode: latestJob.failureCode,
            id: latestJob.id,
            kind: latestJob.kind,
            pipelineVersion: latestJob.pipelineVersion,
            progressBasisPoints:
              totalWeight && weightedProgress != null
                ? Math.round(weightedProgress / totalWeight)
                : 0,
            revision: latestJob.revision,
            startedAt: latestJob.startedAt?.toISOString() ?? null,
            status: latestJob.status,
            updatedAt: latestJob.updatedAt.toISOString(),
          }
        : null,
      name: project.name,
      sourceLanguage: project.sourceLanguage,
      status: project.status,
      targetLanguages: project.targetLanguages.map(({ language }) => language),
      updatedAt: project.updatedAt.toISOString(),
    };
  }

  private assertCanEdit(context: AccessContext): void {
    if (context.role === OrganizationRole.VIEWER) {
      throw new ForbiddenException('This organization role cannot create projects.');
    }
  }

  private encodeCursor(updatedAt: Date, id: string): string {
    return Buffer.from(JSON.stringify({ id, updatedAt: updatedAt.toISOString() })).toString(
      'base64url',
    );
  }

  private decodeCursor(value: string): ProjectCursor {
    try {
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
      const updatedAt = new Date(String(parsed.updatedAt));
      if (
        typeof parsed.id !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(parsed.id) ||
        Number.isNaN(updatedAt.getTime())
      ) {
        throw new Error('invalid cursor');
      }
      return { id: parsed.id, updatedAt };
    } catch {
      throw new BadRequestException('The project cursor is invalid.');
    }
  }
}
