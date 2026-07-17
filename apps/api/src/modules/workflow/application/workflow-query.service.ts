import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { type Prisma, WorkflowJobKind, WorkflowJobStatus } from '@voiceverse/database';

import { DatabaseService } from '../../../infrastructure/database/database.service';
import type { AccessContext } from '../../identity/domain/access-context';
import type { ListProjectJobsQueryDto } from '../presentation/workflow.dto';

interface JobCursor {
  createdAt: Date;
  id: string;
}

const workflowJobIncludes = {
  project: {
    select: {
      id: true,
      name: true,
      sourceLanguage: true,
      targetLanguages: {
        orderBy: { createdAt: 'asc' as const },
        select: { language: true },
      },
    },
  },
  sourceVideo: {
    select: {
      id: true,
      ingestStatus: true,
      mediaProbes: {
        orderBy: { createdAt: 'desc' as const },
        select: {
          bitRate: true,
          durationMs: true,
          formatName: true,
          selections: {
            select: {
              role: true,
              selectionMethod: true,
              stream: {
                select: {
                  audio: true,
                  codecName: true,
                  languageTag: true,
                  streamIndex: true,
                },
              },
            },
          },
          streams: {
            select: {
              codecName: true,
              kind: true,
              streamIndex: true,
              video: true,
            },
          },
        },
        take: 1,
      },
      securityStatus: true,
    },
  },
  stages: {
    include: {
      attempts: {
        orderBy: { attemptNumber: 'desc' as const },
        select: {
          attemptNumber: true,
          completedAt: true,
          errorCode: true,
          id: true,
          progressBasisPoints: true,
          startedAt: true,
          status: true,
        },
      },
    },
    orderBy: { ordinal: 'asc' as const },
  },
} as const;

type WorkflowJobQueryResult = Prisma.WorkflowJobGetPayload<{
  include: typeof workflowJobIncludes;
}>;

@Injectable()
export class WorkflowQueryService {
  constructor(private readonly database: DatabaseService) {}

  async listProjectJobs(context: AccessContext, projectId: string, query: ListProjectJobsQueryDto) {
    await this.assertOwnedProject(context, projectId);
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : undefined;
    const jobs = await this.database.client.workflowJob.findMany({
      include: workflowJobIncludes,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      where: {
        organizationId: context.organizationId,
        projectId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
    });
    const hasMore = jobs.length > query.limit;
    const page = jobs.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map((job) => this.toResponse(job)),
      nextCursor: hasMore && last ? this.encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async get(context: AccessContext, jobId: string) {
    const job = await this.database.client.workflowJob.findFirst({
      include: workflowJobIncludes,
      where: { id: jobId, organizationId: context.organizationId },
    });
    if (!job) throw new NotFoundException('Workflow job not found.');
    const resultSummary = await this.resultSummary(job);
    return this.toResponse(job, resultSummary);
  }

  etag(job: { id: string; revision: number }): string {
    return `W/"job-${job.id}-${job.revision}"`;
  }

  private toResponse(
    job: WorkflowJobQueryResult,
    resultSummary: Awaited<ReturnType<WorkflowQueryService['resultSummary']>> = null,
  ) {
    const totalWeight = job.stages.reduce((total, stage) => total + stage.weightBasisPoints, 0);
    const weightedProgress = job.stages.reduce(
      (total, stage) => total + stage.weightBasisPoints * stage.progressBasisPoints,
      0,
    );
    const mediaProbe = job.sourceVideo.mediaProbes[0];
    const primaryAudio = mediaProbe?.selections.find(({ role }) => role === 'PRIMARY_AUDIO');
    const primaryVideo = mediaProbe?.streams.find(({ kind }) => kind === 'VIDEO');
    return {
      completedAt: job.completedAt?.toISOString() ?? null,
      createdAt: job.createdAt.toISOString(),
      failureCode: job.failureCode,
      id: job.id,
      kind: job.kind,
      media: mediaProbe
        ? {
            audio: primaryAudio
              ? {
                  channelLayout: primaryAudio.stream.audio?.channelLayout ?? null,
                  channels: primaryAudio.stream.audio?.channels ?? null,
                  codec: primaryAudio.stream.codecName,
                  languageTag: primaryAudio.stream.languageTag,
                  sampleRateHz: primaryAudio.stream.audio?.sampleRateHz ?? null,
                  selectionMethod: primaryAudio.selectionMethod,
                  streamIndex: primaryAudio.stream.streamIndex,
                }
              : null,
            bitRate: this.bigIntToNumber(mediaProbe.bitRate),
            container: mediaProbe.formatName,
            durationMs: this.bigIntToNumber(mediaProbe.durationMs),
            video: primaryVideo
              ? {
                  codec: primaryVideo.codecName,
                  height: primaryVideo.video?.height ?? null,
                  streamIndex: primaryVideo.streamIndex,
                  width: primaryVideo.video?.width ?? null,
                }
              : null,
          }
        : null,
      pipelineVersion: job.pipelineVersion,
      project: {
        id: job.project.id,
        name: job.project.name,
        sourceLanguage: job.project.sourceLanguage,
        targetLanguages: job.project.targetLanguages.map(({ language }) => language),
      },
      progressBasisPoints: totalWeight === 0 ? 0 : Math.round(weightedProgress / totalWeight),
      projectId: job.projectId,
      resultSummary,
      revision: job.revision,
      sourceVideo: {
        id: job.sourceVideo.id,
        ingestStatus: job.sourceVideo.ingestStatus,
        securityStatus: job.sourceVideo.securityStatus,
      },
      stages: job.stages.map((stage) => ({
        attemptCount: stage.attempts.length,
        completedAt: stage.completedAt?.toISOString() ?? null,
        currentAttempt: stage.attempts[0]
          ? {
              attemptNumber: stage.attempts[0].attemptNumber,
              completedAt: stage.attempts[0].completedAt?.toISOString() ?? null,
              errorCode: stage.attempts[0].errorCode,
              id: stage.attempts[0].id,
              progressBasisPoints: stage.attempts[0].progressBasisPoints,
              startedAt: stage.attempts[0].startedAt?.toISOString() ?? null,
              status: stage.attempts[0].status,
            }
          : null,
        id: stage.id,
        key: stage.key,
        kind: stage.kind,
        progressBasisPoints: stage.progressBasisPoints,
        status: stage.status,
      })),
      startedAt: job.startedAt?.toISOString() ?? null,
      status: job.status,
      updatedAt: job.updatedAt.toISOString(),
    };
  }

  private async resultSummary(job: WorkflowJobQueryResult) {
    if (job.kind !== WorkflowJobKind.SPEECH_ANALYSIS) return null;
    // Active and terminal-failed jobs intentionally expose no partial result.
    // Avoid repeatedly scanning a feature-length transcript merely to discard
    // the aggregate values as PENDING/UNAVAILABLE during polling.
    if (job.status !== WorkflowJobStatus.SUCCEEDED) {
      const availability =
        job.status === WorkflowJobStatus.FAILED || job.status === WorkflowJobStatus.CANCELED
          ? ('UNAVAILABLE' as const)
          : ('PENDING' as const);
      return {
        characters: { availability, count: 0 },
        transcript: { availability, segmentCount: 0, transcribedDurationMs: 0 },
      };
    }
    const [summary] = await this.database.client.$queryRaw<
      Array<{
        characterCount: bigint;
        hasCharacters: boolean;
        hasTranscript: boolean;
        segmentCount: bigint;
        transcribedDurationUs: bigint;
      }>
    >`
      SELECT
        EXISTS (
          SELECT 1
          FROM transcription_runs AS transcription
          INNER JOIN speech_analyses AS analysis
            ON analysis.id = transcription.speech_analysis_id
          WHERE analysis.workflow_job_id = ${job.id}::uuid
        ) AS "hasTranscript",
        EXISTS (
          SELECT 1
          FROM character_identification_runs AS identification
          INNER JOIN speech_analyses AS analysis
            ON analysis.id = identification.speech_analysis_id
          WHERE analysis.workflow_job_id = ${job.id}::uuid
        ) AS "hasCharacters",
        COALESCE((
          SELECT COUNT(*)
          FROM transcript_segments AS segment
          INNER JOIN transcription_runs AS transcription
            ON transcription.id = segment.transcription_run_id
          INNER JOIN speech_analyses AS analysis
            ON analysis.id = transcription.speech_analysis_id
          WHERE analysis.workflow_job_id = ${job.id}::uuid
        ), 0)::bigint AS "segmentCount",
        COALESCE((
          SELECT SUM(segment.end_time_us - segment.start_time_us)
          FROM transcript_segments AS segment
          INNER JOIN transcription_runs AS transcription
            ON transcription.id = segment.transcription_run_id
          INNER JOIN speech_analyses AS analysis
            ON analysis.id = transcription.speech_analysis_id
          WHERE analysis.workflow_job_id = ${job.id}::uuid
        ), 0)::bigint AS "transcribedDurationUs",
        COALESCE((
          SELECT COUNT(*)
          FROM speaker_character_assignments AS assignment
          INNER JOIN character_identification_runs AS identification
            ON identification.id = assignment.character_identification_run_id
          INNER JOIN speech_analyses AS analysis
            ON analysis.id = identification.speech_analysis_id
          WHERE analysis.workflow_job_id = ${job.id}::uuid
        ), 0)::bigint AS "characterCount"
    `;
    if (!summary) throw new Error('SpeechAnalysisSummaryMissing');
    const transcriptAvailability = this.resultAvailability(job.status, summary.hasTranscript);
    const characterAvailability = this.resultAvailability(job.status, summary.hasCharacters);
    return {
      characters: {
        availability: characterAvailability,
        count:
          characterAvailability === 'AVAILABLE'
            ? this.bigIntToRequiredNumber(summary.characterCount)
            : 0,
      },
      transcript: {
        availability: transcriptAvailability,
        segmentCount:
          transcriptAvailability === 'AVAILABLE'
            ? this.bigIntToRequiredNumber(summary.segmentCount)
            : 0,
        transcribedDurationMs:
          transcriptAvailability === 'AVAILABLE'
            ? this.bigIntToRequiredNumber(summary.transcribedDurationUs / 1_000n)
            : 0,
      },
    };
  }

  private resultAvailability(
    status: WorkflowJobStatus,
    hasCommittedResult: boolean,
  ): 'AVAILABLE' | 'PENDING' | 'UNAVAILABLE' {
    if (status === WorkflowJobStatus.SUCCEEDED && hasCommittedResult) return 'AVAILABLE';
    if (status === WorkflowJobStatus.FAILED || status === WorkflowJobStatus.CANCELED) {
      return 'UNAVAILABLE';
    }
    return 'PENDING';
  }

  private bigIntToRequiredNumber(value: bigint): number {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('WorkflowSummaryOutsideSupportedBounds');
    }
    return Number(value);
  }

  private async assertOwnedProject(context: AccessContext, projectId: string): Promise<void> {
    const project = await this.database.client.project.findFirst({
      select: { id: true },
      where: { id: projectId, organizationId: context.organizationId },
    });
    if (!project) throw new NotFoundException('Project not found.');
  }

  private bigIntToNumber(value: bigint | null | undefined): number | null {
    if (value == null) return null;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
  }

  private encodeCursor(createdAt: Date, id: string): string {
    return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id })).toString(
      'base64url',
    );
  }

  private decodeCursor(value: string): JobCursor {
    try {
      const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
      const createdAt = new Date(String(decoded.createdAt));
      if (
        typeof decoded.id !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(decoded.id) ||
        Number.isNaN(createdAt.getTime())
      ) {
        throw new Error('invalid cursor');
      }
      return { createdAt, id: decoded.id };
    } catch {
      throw new BadRequestException('The workflow cursor is invalid.');
    }
  }
}
