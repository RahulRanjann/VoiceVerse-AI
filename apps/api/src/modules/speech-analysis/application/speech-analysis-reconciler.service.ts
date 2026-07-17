import { Injectable, Logger } from '@nestjs/common';
import { MediaArtifactKind, WorkflowJobKind, WorkflowJobStatus } from '@voiceverse/database';

import { DatabaseService } from '../../../infrastructure/database/database.service';
import { SPEECH_ANALYSIS_PIPELINE_VERSION } from '../domain/speech-analysis.constants';
import { SpeechAnalysisInitializerService } from './speech-analysis-initializer.service';

/**
 * Bounded repair path for source-preparation jobs that succeeded before the M5
 * feature flag was enabled or whose transaction committed before deployment.
 */
@Injectable()
export class SpeechAnalysisReconcilerService {
  private readonly logger = new Logger(SpeechAnalysisReconcilerService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly initializer: SpeechAnalysisInitializerService,
  ) {}

  async reconcileBatch(limit = 25): Promise<number> {
    if (!this.initializer.enabled) return 0;
    const sourceJobs = await this.database.client.workflowJob.findMany({
      orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
      select: {
        createdByUserId: true,
        id: true,
        organizationId: true,
        project: { select: { sourceLanguageId: true } },
        projectId: true,
        sourceVideoId: true,
      },
      take: limit,
      where: {
        AND: [
          {
            stages: {
              some: {
                attempts: {
                  some: {
                    artifacts: { some: { kind: MediaArtifactKind.ANALYSIS_AUDIO } },
                  },
                },
              },
            },
          },
          {
            stages: {
              some: {
                attempts: {
                  some: {
                    artifacts: { some: { kind: MediaArtifactKind.CANONICAL_AUDIO } },
                  },
                },
              },
            },
          },
        ],
        kind: WorkflowJobKind.SOURCE_PREPARATION,
        sourceVideo: {
          workflowJobs: {
            none: {
              kind: WorkflowJobKind.SPEECH_ANALYSIS,
              pipelineVersion: SPEECH_ANALYSIS_PIPELINE_VERSION,
            },
          },
        },
        status: WorkflowJobStatus.SUCCEEDED,
      },
    });
    if (sourceJobs.length === 0) return 0;

    const artifacts = await this.database.client.mediaArtifact.findMany({
      select: { id: true, kind: true, producerAttempt: { select: { stage: true } } },
      where: {
        kind: { in: [MediaArtifactKind.ANALYSIS_AUDIO, MediaArtifactKind.CANONICAL_AUDIO] },
        producerAttempt: { stage: { jobId: { in: sourceJobs.map(({ id }) => id) } } },
      },
    });
    const artifactsByJob = new Map<string, Map<MediaArtifactKind, string>>();
    for (const artifact of artifacts) {
      const jobArtifacts =
        artifactsByJob.get(artifact.producerAttempt.stage.jobId) ??
        new Map<MediaArtifactKind, string>();
      jobArtifacts.set(artifact.kind, artifact.id);
      artifactsByJob.set(artifact.producerAttempt.stage.jobId, jobArtifacts);
    }

    let reconciled = 0;
    for (const sourceJob of sourceJobs) {
      const jobArtifacts = artifactsByJob.get(sourceJob.id);
      const analysisArtifactId = jobArtifacts?.get(MediaArtifactKind.ANALYSIS_AUDIO);
      const canonicalArtifactId = jobArtifacts?.get(MediaArtifactKind.CANONICAL_AUDIO);
      if (!analysisArtifactId || !canonicalArtifactId) continue;
      await this.database.client.$transaction((transaction) =>
        this.initializer.initialize(transaction, {
          analysisArtifactId,
          canonicalArtifactId,
          createdByUserId: sourceJob.createdByUserId,
          organizationId: sourceJob.organizationId,
          projectId: sourceJob.projectId,
          sourceLanguageId: sourceJob.project.sourceLanguageId,
          sourceVideoId: sourceJob.sourceVideoId,
        }),
      );
      reconciled += 1;
    }
    if (reconciled > 0) {
      this.logger.log({ reconciled }, 'Eligible source media reconciled into speech analysis');
    }
    return reconciled;
  }
}
