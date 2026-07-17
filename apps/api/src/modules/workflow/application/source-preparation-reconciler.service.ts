import { Injectable, Logger } from '@nestjs/common';
import { MediaSecurityStatus, VideoIngestStatus, WorkflowJobKind } from '@voiceverse/database';

import { DatabaseService } from '../../../infrastructure/database/database.service';
import { uuidv7 } from '../../../shared/uuid';
import { SOURCE_PREPARATION_PIPELINE_VERSION } from '../domain/source-preparation.constants';
import { SourcePreparationInitializerService } from './source-preparation-initializer.service';

const DEFAULT_RECONCILIATION_BATCH_SIZE = 25;

/**
 * Repairs the durable invariant introduced by Milestone 4 for media that was
 * already clean before the workflow tables existed. Keeping this as a bounded
 * worker loop also heals a future transaction or deployment interruption
 * without putting data-migration policy into the public API process.
 */
@Injectable()
export class SourcePreparationReconcilerService {
  private readonly logger = new Logger(SourcePreparationReconcilerService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly initializer: SourcePreparationInitializerService,
  ) {}

  async reconcileBatch(limit = DEFAULT_RECONCILIATION_BATCH_SIZE): Promise<number> {
    const candidates = await this.database.client.video.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        createdByUserId: true,
        id: true,
        organizationId: true,
        projectId: true,
      },
      take: limit,
      where: {
        ingestStatus: VideoIngestStatus.UPLOADED,
        securityStatus: MediaSecurityStatus.CLEAN,
        sha256: { not: null },
        workflowJobs: {
          none: {
            kind: WorkflowJobKind.SOURCE_PREPARATION,
            pipelineVersion: SOURCE_PREPARATION_PIPELINE_VERSION,
          },
        },
      },
    });

    let reconciled = 0;
    for (const candidate of candidates) {
      const initialized = await this.database.client.$transaction(async (transaction) => {
        // Re-check every eligibility predicate inside the write transaction.
        // Concurrent workers remain safe because initializer business keys are unique.
        const video = await transaction.video.findFirst({
          select: {
            createdByUserId: true,
            id: true,
            organizationId: true,
            projectId: true,
          },
          where: {
            id: candidate.id,
            ingestStatus: VideoIngestStatus.UPLOADED,
            securityStatus: MediaSecurityStatus.CLEAN,
            sha256: { not: null },
            workflowJobs: {
              none: {
                kind: WorkflowJobKind.SOURCE_PREPARATION,
                pipelineVersion: SOURCE_PREPARATION_PIPELINE_VERSION,
              },
            },
          },
        });
        if (!video) return false;

        const workflow = await this.initializer.initialize(transaction, video);
        await transaction.auditLog.create({
          data: {
            action: 'workflow.source_preparation.reconciled',
            id: uuidv7(),
            metadata: { pipelineVersion: SOURCE_PREPARATION_PIPELINE_VERSION },
            organizationId: video.organizationId,
            resourceId: workflow.jobId,
            resourceType: 'workflow_job',
          },
        });
        return true;
      });
      if (initialized) reconciled += 1;
    }

    if (reconciled > 0) {
      this.logger.log({ reconciled }, 'Eligible clean videos reconciled into durable workflow');
    }
    return reconciled;
  }
}
