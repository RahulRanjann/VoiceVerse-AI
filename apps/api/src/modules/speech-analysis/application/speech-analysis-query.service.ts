import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { WorkflowJobKind, WorkflowJobStatus } from '@voiceverse/database';

import { DatabaseService } from '../../../infrastructure/database/database.service';
import type { AccessContext } from '../../identity/domain/access-context';
import {
  type CharacterResultPageDto,
  type DialogueSegmentResultPageDto,
  type ListSpeechAnalysisResultsQueryDto,
  SpeechAnalysisResultAvailability,
} from '../presentation/speech-analysis-query.dto';

type ResultResource = 'characters' | 'dialogue-segments';

interface ResultCursor {
  version: 1;
  resource: ResultResource;
  analysisId: string;
  runId: string;
  positionUs: bigint;
  rowId: string;
}

interface CommittedAnalysisScope {
  availability: SpeechAnalysisResultAvailability;
  analysisId: string | null;
  characterIdentificationRunId: string | null;
  jobRevision: number;
  sourceLanguageTag: string | null;
}

interface ResultPage<T> {
  availability: SpeechAnalysisResultAvailability;
  analysisId: string | null;
  jobRevision: number;
  data: T[];
  totalCount: number;
  nextCursor: string | null;
}

const terminalUnavailableStatuses = new Set<WorkflowJobStatus>([
  WorkflowJobStatus.CANCELED,
  WorkflowJobStatus.FAILED,
]);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

/**
 * Reads only the immutable character-identification run committed for this job.
 * Project selection may move independently; provider labels and partial output
 * never cross this boundary.
 */
@Injectable()
export class SpeechAnalysisQueryService {
  constructor(private readonly database: DatabaseService) {}

  async listCharacters(
    context: AccessContext,
    jobId: string,
    query: ListSpeechAnalysisResultsQueryDto,
  ): Promise<CharacterResultPageDto> {
    const scope = await this.resolveCommittedScope(context, jobId);
    if (scope.availability !== SpeechAnalysisResultAvailability.AVAILABLE) {
      this.assertNoStaleCursor(query.cursor);
      return this.emptyPage(scope);
    }

    const analysisId = this.required(scope.analysisId, 'SpeechAnalysisIdMissing');
    const runId = this.required(
      scope.characterIdentificationRunId,
      'CharacterIdentificationRunIdMissing',
    );
    const cursor = query.cursor
      ? this.decodeCursor(query.cursor, 'characters', analysisId, runId)
      : undefined;
    if (cursor) await this.assertCharacterCursorAnchor(cursor);

    const [rows, totalCount] = await Promise.all([
      this.database.client.speakerCharacterAssignment.findMany({
        orderBy: [{ firstAppearanceTimeUs: 'asc' }, { id: 'asc' }],
        select: {
          character: { select: { displayName: true, id: true } },
          confidenceBasisPoints: true,
          firstAppearanceTimeUs: true,
          id: true,
          segmentCount: true,
          speakerCluster: { select: { ordinal: true } },
          speakingDurationUs: true,
        },
        take: query.limit + 1,
        where: {
          characterIdentificationRunId: runId,
          ...(cursor
            ? {
                OR: [
                  { firstAppearanceTimeUs: { gt: cursor.positionUs } },
                  { firstAppearanceTimeUs: cursor.positionUs, id: { gt: cursor.rowId } },
                ],
              }
            : {}),
        },
      }),
      this.database.client.speakerCharacterAssignment.count({
        where: { characterIdentificationRunId: runId },
      }),
    ]);
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      availability: SpeechAnalysisResultAvailability.AVAILABLE,
      analysisId,
      data: page.map((row) => ({
        confidenceBasisPoints: this.publicBasisPoints(row.confidenceBasisPoints),
        displayName:
          row.character.displayName ??
          `Character ${String(row.speakerCluster.ordinal + 1).padStart(2, '0')}`,
        firstAppearanceMs: this.microsecondsToMilliseconds(row.firstAppearanceTimeUs),
        id: row.character.id,
        segmentCount: row.segmentCount,
        speakingDurationMs: this.microsecondsToMilliseconds(row.speakingDurationUs),
      })),
      jobRevision: scope.jobRevision,
      nextCursor:
        hasMore && last
          ? this.encodeCursor({
              analysisId,
              positionUs: last.firstAppearanceTimeUs,
              resource: 'characters',
              rowId: last.id,
              runId,
              version: 1,
            })
          : null,
      totalCount,
    };
  }

  async listDialogueSegments(
    context: AccessContext,
    jobId: string,
    query: ListSpeechAnalysisResultsQueryDto,
  ): Promise<DialogueSegmentResultPageDto> {
    const scope = await this.resolveCommittedScope(context, jobId);
    if (scope.availability !== SpeechAnalysisResultAvailability.AVAILABLE) {
      this.assertNoStaleCursor(query.cursor);
      return this.emptyPage(scope);
    }

    const analysisId = this.required(scope.analysisId, 'SpeechAnalysisIdMissing');
    const runId = this.required(
      scope.characterIdentificationRunId,
      'CharacterIdentificationRunIdMissing',
    );
    const sourceLanguageTag = this.required(scope.sourceLanguageTag, 'SourceLanguageTagMissing');
    const cursor = query.cursor
      ? this.decodeCursor(query.cursor, 'dialogue-segments', analysisId, runId)
      : undefined;
    if (cursor) await this.assertDialogueCursorAnchor(cursor);

    const [rows, totalCount] = await Promise.all([
      this.database.client.dialogueSegment.findMany({
        orderBy: [{ startTimeUs: 'asc' }, { id: 'asc' }],
        select: {
          assignmentConfidenceBasisPoints: true,
          endTimeUs: true,
          id: true,
          sequenceNumber: true,
          speakerAssignment: {
            select: { character: { select: { displayName: true, id: true } } },
          },
          startTimeUs: true,
          text: true,
          transcriptSegment: { select: { languageTag: true } },
          transcriptionConfidenceBasisPoints: true,
        },
        take: query.limit + 1,
        where: {
          characterIdentificationRunId: runId,
          ...(cursor
            ? {
                OR: [
                  { startTimeUs: { gt: cursor.positionUs } },
                  { startTimeUs: cursor.positionUs, id: { gt: cursor.rowId } },
                ],
              }
            : {}),
        },
      }),
      this.database.client.dialogueSegment.count({
        where: { characterIdentificationRunId: runId },
      }),
    ]);
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      availability: SpeechAnalysisResultAvailability.AVAILABLE,
      analysisId,
      data: page.map((row) => ({
        character: row.speakerAssignment
          ? {
              assignmentConfidenceBasisPoints: this.publicBasisPoints(
                row.assignmentConfidenceBasisPoints,
              ),
              displayName: row.speakerAssignment.character.displayName ?? 'Character',
              id: row.speakerAssignment.character.id,
            }
          : null,
        endMs: this.microsecondsToMilliseconds(row.endTimeUs),
        id: row.id,
        sequenceNumber: row.sequenceNumber,
        sourceLanguageTag: row.transcriptSegment.languageTag ?? sourceLanguageTag,
        sourceText: row.text,
        startMs: this.microsecondsToMilliseconds(row.startTimeUs),
        transcriptionConfidenceBasisPoints: this.publicBasisPoints(
          row.transcriptionConfidenceBasisPoints,
        ),
      })),
      jobRevision: scope.jobRevision,
      nextCursor:
        hasMore && last
          ? this.encodeCursor({
              analysisId,
              positionUs: last.startTimeUs,
              resource: 'dialogue-segments',
              rowId: last.id,
              runId,
              version: 1,
            })
          : null,
      totalCount,
    };
  }

  private async resolveCommittedScope(
    context: AccessContext,
    jobId: string,
  ): Promise<CommittedAnalysisScope> {
    const job = await this.database.client.workflowJob.findFirst({
      select: {
        revision: true,
        speechAnalysis: {
          select: {
            characterIdentificationRun: { select: { id: true } },
            id: true,
            sourceLanguage: { select: { bcp47Tag: true } },
          },
        },
        status: true,
      },
      where: {
        id: jobId,
        kind: WorkflowJobKind.SPEECH_ANALYSIS,
        organizationId: context.organizationId,
      },
    });
    if (!job) throw new NotFoundException('Speech-analysis job not found.');

    if (terminalUnavailableStatuses.has(job.status)) {
      return {
        analysisId: null,
        availability: SpeechAnalysisResultAvailability.UNAVAILABLE,
        characterIdentificationRunId: null,
        jobRevision: job.revision,
        sourceLanguageTag: null,
      };
    }

    // Publication is atomic with job success. Even if a transaction or fixture
    // exposes related rows early, active jobs must never leak partial output.
    if (job.status !== WorkflowJobStatus.SUCCEEDED) {
      return {
        analysisId: null,
        availability: SpeechAnalysisResultAvailability.PENDING,
        characterIdentificationRunId: null,
        jobRevision: job.revision,
        sourceLanguageTag: null,
      };
    }

    const analysis = job.speechAnalysis;
    if (!analysis?.characterIdentificationRun) {
      return {
        analysisId: null,
        availability: SpeechAnalysisResultAvailability.PENDING,
        characterIdentificationRunId: null,
        jobRevision: job.revision,
        sourceLanguageTag: null,
      };
    }

    return {
      analysisId: analysis.id,
      availability: SpeechAnalysisResultAvailability.AVAILABLE,
      characterIdentificationRunId: analysis.characterIdentificationRun.id,
      jobRevision: job.revision,
      sourceLanguageTag: analysis.sourceLanguage.bcp47Tag,
    };
  }

  private async assertCharacterCursorAnchor(cursor: ResultCursor): Promise<void> {
    const anchor = await this.database.client.speakerCharacterAssignment.findFirst({
      select: { id: true },
      where: {
        characterIdentificationRunId: cursor.runId,
        firstAppearanceTimeUs: cursor.positionUs,
        id: cursor.rowId,
      },
    });
    if (!anchor) throw this.invalidCursor();
  }

  private async assertDialogueCursorAnchor(cursor: ResultCursor): Promise<void> {
    const anchor = await this.database.client.dialogueSegment.findFirst({
      select: { id: true },
      where: {
        characterIdentificationRunId: cursor.runId,
        id: cursor.rowId,
        startTimeUs: cursor.positionUs,
      },
    });
    if (!anchor) throw this.invalidCursor();
  }

  private emptyPage<T>(scope: CommittedAnalysisScope): ResultPage<T> {
    return {
      analysisId: null,
      availability: scope.availability,
      data: [],
      jobRevision: scope.jobRevision,
      nextCursor: null,
      totalCount: 0,
    };
  }

  private assertNoStaleCursor(cursor: string | undefined): void {
    if (cursor) throw this.invalidCursor();
  }

  private encodeCursor(cursor: ResultCursor): string {
    return Buffer.from(
      JSON.stringify({
        analysisId: cursor.analysisId,
        positionUs: cursor.positionUs.toString(),
        resource: cursor.resource,
        rowId: cursor.rowId,
        runId: cursor.runId,
        version: cursor.version,
      }),
    ).toString('base64url');
  }

  private decodeCursor(
    value: string,
    resource: ResultResource,
    analysisId: string,
    runId: string,
  ): ResultCursor {
    try {
      if (!base64UrlPattern.test(value)) throw new Error('CursorEncodingInvalid');
      const json = Buffer.from(value, 'base64url').toString('utf8');
      if (Buffer.from(json).toString('base64url') !== value) {
        throw new Error('CursorEncodingNonCanonical');
      }
      const decoded = JSON.parse(json) as Record<string, unknown>;
      const keys = Object.keys(decoded).toSorted().join(',');
      if (
        keys !== 'analysisId,positionUs,resource,rowId,runId,version' ||
        decoded.version !== 1 ||
        decoded.resource !== resource ||
        decoded.analysisId !== analysisId ||
        decoded.runId !== runId ||
        typeof decoded.rowId !== 'string' ||
        !uuidPattern.test(decoded.rowId) ||
        typeof decoded.positionUs !== 'string' ||
        !/^\d{1,20}$/.test(decoded.positionUs)
      ) {
        throw new Error('CursorShapeInvalid');
      }
      return {
        analysisId,
        positionUs: BigInt(decoded.positionUs),
        resource,
        rowId: decoded.rowId,
        runId,
        version: 1,
      };
    } catch {
      throw this.invalidCursor();
    }
  }

  private invalidCursor(): BadRequestException {
    return new BadRequestException('The speech-analysis cursor is invalid or stale.');
  }

  private microsecondsToMilliseconds(value: bigint): number {
    if (value < 0n) throw this.invalidPersistedResult();
    const milliseconds = value / 1_000n;
    if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) throw this.invalidPersistedResult();
    return Number(milliseconds);
  }

  private publicBasisPoints(value: number | null): number {
    if (value === null) return 0;
    if (!Number.isInteger(value) || value < 0 || value > 10_000) {
      throw this.invalidPersistedResult();
    }
    return value;
  }

  private invalidPersistedResult(): InternalServerErrorException {
    return new InternalServerErrorException('Speech-analysis result is outside supported bounds.');
  }

  private required<T>(value: T | null, code: string): T {
    if (value === null) throw new Error(code);
    return value;
  }
}
