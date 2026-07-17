import { Injectable } from '@nestjs/common';
import {
  CharacterOrigin,
  CharacterStatus,
  MediaArtifactKind,
  type Prisma,
} from '@voiceverse/database';

import { uuidv7 } from '../../../shared/uuid';
import type {
  SpeakerDiarizationResult,
  SpeechGeneratedArtifact,
  TranscriptionResult,
  VocalSeparationResult,
} from '../domain/speech-executor.port';
import type {
  DiarizationManifest,
  TranscriptManifest,
} from '../infrastructure/speech-manifest-reader.service';
import {
  averageLogProbabilityToBasisPoints,
  probabilityToBasisPoints,
} from '../infrastructure/speech-manifest-reader.service';
import type {
  MaterializedDialogueSegment,
  TimelineMaterialization,
} from './timeline-materializer.service';
import type { ClaimedSpeechAttempt } from './speech-workflow-coordinator.service';

const INSERT_BATCH_SIZE = 1_000;

export interface SeparationOutputKeys {
  ANALYSIS_ACCOMPANIMENT_STEM: string;
  ANALYSIS_VOCAL_STEM: string;
  ISOLATED_SPEECH_AUDIO: string;
  SEPARATION_MANIFEST: string;
}

export interface ManifestOutput {
  key: string;
  storageBucket: string;
}

export interface CharacterMaterializationContext {
  bodySize: number;
  diarizationManifestArtifactId: string;
  diarizationRunId: string;
  manifestKey: string;
  manifestSha256: string;
  storageBucket: string;
  transcriptionManifestArtifactId: string;
  transcriptionRunId: string;
}

/**
 * Owns normalized writes for executor manifests. All methods run inside the
 * coordinator's stage-completion transaction, so an attempt cannot become
 * successful without its artifacts and query model becoming visible together.
 */
@Injectable()
export class SpeechAnalysisPersistenceService {
  async persistSeparation(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedSpeechAttempt,
    result: VocalSeparationResult,
    storageBucket: string,
    keys: SeparationOutputKeys,
    inputArtifactId: string,
  ): Promise<void> {
    for (const artifact of result.artifacts) {
      const artifactId = await this.createArtifact(
        transaction,
        claimed,
        artifact,
        result.producerVersion,
        storageBucket,
        keys[artifact.kind as keyof SeparationOutputKeys],
      );
      await this.createLineage(transaction, claimed, artifactId, inputArtifactId, 'source_audio');
    }
  }

  async persistTranscription(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedSpeechAttempt,
    result: TranscriptionResult,
    manifest: TranscriptManifest,
    output: ManifestOutput,
    inputArtifactId: string,
  ): Promise<void> {
    const metadata = this.artifact(result.artifacts, 'TRANSCRIPT_MANIFEST');
    const manifestArtifactId = await this.createArtifact(
      transaction,
      claimed,
      metadata,
      result.producerVersion,
      output.storageBucket,
      output.key,
    );
    await this.createLineage(
      transaction,
      claimed,
      manifestArtifactId,
      inputArtifactId,
      'isolated_speech_audio',
    );

    const runId = uuidv7();
    await transaction.transcriptionRun.create({
      data: {
        contractVersion: 1,
        id: runId,
        inputArtifactId,
        manifestArtifactId,
        modelName: result.model.modelId,
        modelRevision: result.model.modelRevision,
        organizationId: claimed.organizationId,
        producerAttemptId: claimed.attemptId,
        projectId: claimed.projectId,
        providerName: result.model.provider,
        sourceLanguageId: claimed.sourceLanguageId,
        sourceVideoId: claimed.sourceVideoId,
        speechAnalysisId: claimed.speechAnalysisId,
      },
    });

    const segments = manifest.segments.map((segment) => ({
      confidenceBasisPoints: averageLogProbabilityToBasisPoints(segment.averageLogProbability),
      endTimeUs: BigInt(segment.endUs),
      id: uuidv7(),
      languageTag: manifest.language.detectedLanguage,
      noSpeechProbabilityBasisPoints: probabilityToBasisPoints(segment.noSpeechProbability),
      sequenceNumber: segment.ordinal,
      startTimeUs: BigInt(segment.startUs),
      text: segment.text,
      transcriptionRunId: runId,
    }));
    for (const batch of batches(segments)) {
      await transaction.transcriptSegment.createMany({ data: batch });
    }

    const words = manifest.segments.flatMap((segment, segmentIndex) =>
      segment.words.map((word) => ({
        confidenceBasisPoints: probabilityToBasisPoints(word.probability),
        endTimeUs: BigInt(word.endUs),
        id: uuidv7(),
        sequenceNumber: word.ordinal,
        startTimeUs: BigInt(word.startUs),
        text: word.text,
        transcriptSegmentId: segments[segmentIndex]!.id,
        transcriptionRunId: runId,
      })),
    );
    for (const batch of batches(words)) {
      await transaction.transcriptWord.createMany({ data: batch });
    }
  }

  async persistDiarization(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedSpeechAttempt,
    result: SpeakerDiarizationResult,
    manifest: DiarizationManifest,
    output: ManifestOutput,
    inputArtifactId: string,
  ): Promise<void> {
    const metadata = this.artifact(result.artifacts, 'DIARIZATION_MANIFEST');
    const manifestArtifactId = await this.createArtifact(
      transaction,
      claimed,
      metadata,
      result.producerVersion,
      output.storageBucket,
      output.key,
    );
    await this.createLineage(
      transaction,
      claimed,
      manifestArtifactId,
      inputArtifactId,
      'analysis_audio',
    );

    const runId = uuidv7();
    await transaction.diarizationRun.create({
      data: {
        contractVersion: 1,
        id: runId,
        inputArtifactId,
        manifestArtifactId,
        modelName: result.model.modelId,
        modelRevision: result.model.modelRevision,
        organizationId: claimed.organizationId,
        producerAttemptId: claimed.attemptId,
        projectId: claimed.projectId,
        providerName: result.model.provider,
        sourceVideoId: claimed.sourceVideoId,
        speechAnalysisId: claimed.speechAnalysisId,
      },
    });

    const clusterByKey = new Map<string, string>();
    const clusters = manifest.speakers.map((speaker, ordinal) => {
      const id = uuidv7();
      clusterByKey.set(speaker.localSpeakerKey, id);
      return {
        confidenceBasisPoints: null,
        diarizationRunId: runId,
        id,
        ordinal,
        providerLabel: speaker.providerLabel,
      };
    });
    for (const batch of batches(clusters)) {
      await transaction.speakerCluster.createMany({ data: batch });
    }

    const overlapFlags = overlappingTurnFlags(manifest.turns);
    const regularTurns = manifest.turns.map((turn, index) => ({
      confidenceBasisPoints: null,
      diarizationRunId: runId,
      endTimeUs: BigInt(turn.endUs),
      hasOverlap: overlapFlags[index] ?? false,
      id: uuidv7(),
      isExclusive: false,
      sequenceNumber: turn.ordinal,
      speakerClusterId: this.requiredCluster(clusterByKey, turn.speakerKey),
      startTimeUs: BigInt(turn.startUs),
    }));
    const exclusiveTurns = manifest.exclusiveTurns.map((turn) => ({
      confidenceBasisPoints: null,
      diarizationRunId: runId,
      endTimeUs: BigInt(turn.endUs),
      hasOverlap: false,
      id: uuidv7(),
      isExclusive: true,
      sequenceNumber: turn.ordinal,
      speakerClusterId: this.requiredCluster(clusterByKey, turn.speakerKey),
      startTimeUs: BigInt(turn.startUs),
    }));
    for (const batch of batches([...regularTurns, ...exclusiveTurns])) {
      await transaction.speakerTurn.createMany({ data: batch });
    }
  }

  async persistCharacters(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedSpeechAttempt,
    materialized: TimelineMaterialization,
    context: CharacterMaterializationContext,
  ): Promise<void> {
    const manifestArtifactId = uuidv7();
    await transaction.mediaArtifact.create({
      data: {
        byteSize: BigInt(context.bodySize),
        configurationHash: claimed.configurationHash,
        id: manifestArtifactId,
        kind: MediaArtifactKind.CHARACTER_IDENTIFICATION_MANIFEST,
        mediaType: 'application/json',
        organizationId: claimed.organizationId,
        producerAttemptId: claimed.attemptId,
        producerName: 'voiceverse-character-resolver',
        producerVersion: 'deterministic-timeline-v1',
        projectId: claimed.projectId,
        sha256: context.manifestSha256,
        sourceVideoId: claimed.sourceVideoId,
        storageBucket: context.storageBucket,
        storageKey: context.manifestKey,
      },
    });
    await this.createLineage(
      transaction,
      claimed,
      manifestArtifactId,
      context.transcriptionManifestArtifactId,
      'transcription_manifest',
    );
    await this.createLineage(
      transaction,
      claimed,
      manifestArtifactId,
      context.diarizationManifestArtifactId,
      'diarization_manifest',
    );

    const runId = uuidv7();
    await transaction.characterIdentificationRun.create({
      data: {
        contractVersion: 1,
        diarizationRunId: context.diarizationRunId,
        id: runId,
        manifestArtifactId,
        organizationId: claimed.organizationId,
        producerAttemptId: claimed.attemptId,
        projectId: claimed.projectId,
        resolverName: 'deterministic-timeline',
        resolverVersion: 'v1',
        sourceVideoId: claimed.sourceVideoId,
        speechAnalysisId: claimed.speechAnalysisId,
        transcriptionRunId: context.transcriptionRunId,
      },
    });

    const assignmentByCluster = new Map<string, string>();
    for (const character of materialized.characters) {
      const persistent = await transaction.character.upsert({
        create: {
          displayName: character.displayName,
          id: uuidv7(),
          organizationId: claimed.organizationId,
          origin: CharacterOrigin.DETECTED,
          projectId: claimed.projectId,
          stableKey: character.stableKey,
          status: CharacterStatus.ACTIVE,
        },
        update: {},
        where: {
          projectId_stableKey: { projectId: claimed.projectId, stableKey: character.stableKey },
        },
      });
      const assignmentId = uuidv7();
      assignmentByCluster.set(character.speakerClusterId, assignmentId);
      await transaction.speakerCharacterAssignment.create({
        data: {
          assignmentMethod: 'NEW_DETECTED_CHARACTER',
          characterId: persistent.id,
          characterIdentificationRunId: runId,
          confidenceBasisPoints: 10_000,
          diarizationRunId: context.diarizationRunId,
          firstAppearanceTimeUs: character.firstAppearanceTimeUs,
          id: assignmentId,
          organizationId: claimed.organizationId,
          projectId: claimed.projectId,
          segmentCount: character.segmentCount,
          speakerClusterId: character.speakerClusterId,
          speakingDurationUs: character.speakingDurationUs,
          wordCount: character.wordCount,
        },
      });
    }

    const dialogue = materialized.dialogueSegments.map((segment) =>
      this.dialogueRow(segment, runId, claimed.speechAnalysisId, context, assignmentByCluster),
    );
    for (const batch of batches(dialogue)) {
      await transaction.dialogueSegment.createMany({ data: batch });
    }
  }

  private dialogueRow(
    segment: MaterializedDialogueSegment,
    runId: string,
    speechAnalysisId: string,
    context: CharacterMaterializationContext,
    assignmentByCluster: Map<string, string>,
  ) {
    const speakerAssignmentId = segment.speakerClusterId
      ? assignmentByCluster.get(segment.speakerClusterId)
      : undefined;
    if (segment.speakerClusterId && !speakerAssignmentId) {
      throw new Error('CharacterAssignmentMissing');
    }
    return {
      assignmentConfidenceBasisPoints: segment.assignmentConfidenceBasisPoints,
      assignmentMethod: segment.assignmentMethod,
      characterIdentificationRunId: runId,
      diarizationRunId: context.diarizationRunId,
      endTimeUs: segment.endTimeUs,
      id: uuidv7(),
      isOverlapping: segment.isOverlapping,
      sequenceNumber: segment.sequenceNumber,
      sourceWordEndSequence: segment.sourceWordEndSequence,
      sourceWordStartSequence: segment.sourceWordStartSequence,
      speakerAssignmentId: speakerAssignmentId ?? null,
      speakerTurnId: segment.speakerTurnId,
      speakerTurnIsExclusive: segment.speakerTurnId ? true : null,
      speechAnalysisId,
      startTimeUs: segment.startTimeUs,
      text: segment.sourceText,
      transcriptSegmentId: segment.transcriptSegmentId,
      transcriptionConfidenceBasisPoints: segment.transcriptionConfidenceBasisPoints,
      transcriptionRunId: context.transcriptionRunId,
    };
  }

  private async createArtifact(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedSpeechAttempt,
    artifact: SpeechGeneratedArtifact,
    producerVersion: string,
    storageBucket: string,
    storageKey: string,
  ): Promise<string> {
    if (!storageKey) throw new Error(`SpeechArtifactStorageKeyMissing:${artifact.kind}`);
    const id = uuidv7();
    await transaction.mediaArtifact.create({
      data: {
        ...(artifact.mediaType === 'audio/flac'
          ? { audioMetadata: { create: this.audioMetadata(artifact) } }
          : {}),
        byteSize: BigInt(artifact.sizeBytes),
        configurationHash: claimed.configurationHash,
        id,
        kind: this.databaseArtifactKind(artifact.kind),
        mediaType: artifact.mediaType,
        organizationId: claimed.organizationId,
        producerAttemptId: claimed.attemptId,
        producerName: 'voiceverse-speech-executor',
        producerVersion,
        projectId: claimed.projectId,
        sha256: artifact.sha256,
        sourceVideoId: claimed.sourceVideoId,
        storageBucket,
        storageKey,
      },
    });
    return id;
  }

  private async createLineage(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedSpeechAttempt,
    outputArtifactId: string,
    inputArtifactId: string,
    role: string,
  ): Promise<void> {
    await transaction.artifactLineage.create({
      data: {
        id: uuidv7(),
        inputArtifactId,
        organizationId: claimed.organizationId,
        outputArtifactId,
        projectId: claimed.projectId,
        role,
        sourceVideoId: claimed.sourceVideoId,
      },
    });
  }

  private artifact(
    artifacts: SpeechGeneratedArtifact[],
    kind: SpeechGeneratedArtifact['kind'],
  ): SpeechGeneratedArtifact {
    const artifact = artifacts.find((candidate) => candidate.kind === kind);
    if (!artifact) throw new Error(`SpeechExecutorArtifactMissing:${kind}`);
    return artifact;
  }

  private audioMetadata(artifact: SpeechGeneratedArtifact) {
    if (
      !artifact.codecName ||
      !artifact.sampleRateHz ||
      !artifact.channels ||
      artifact.durationUs == null
    ) {
      throw new Error('SpeechAudioArtifactMetadataIncomplete');
    }
    return {
      channels: artifact.channels,
      codecName: artifact.codecName,
      durationMs: BigInt(Math.ceil(artifact.durationUs / 1_000)),
      durationUs: BigInt(artifact.durationUs),
      sampleRateHz: artifact.sampleRateHz,
    };
  }

  private databaseArtifactKind(kind: SpeechGeneratedArtifact['kind']): MediaArtifactKind {
    switch (kind) {
      case 'ANALYSIS_VOCAL_STEM':
        return MediaArtifactKind.VOCAL_STEM_AUDIO;
      case 'ANALYSIS_ACCOMPANIMENT_STEM':
        return MediaArtifactKind.ACCOMPANIMENT_STEM_AUDIO;
      case 'ISOLATED_SPEECH_AUDIO':
        return MediaArtifactKind.SPEECH_ANALYSIS_AUDIO;
      case 'SEPARATION_MANIFEST':
        return MediaArtifactKind.VOCAL_SEPARATION_MANIFEST;
      case 'TRANSCRIPT_MANIFEST':
        return MediaArtifactKind.TRANSCRIPTION_MANIFEST;
      case 'DIARIZATION_MANIFEST':
        return MediaArtifactKind.DIARIZATION_MANIFEST;
    }
  }

  private requiredCluster(clusterByKey: Map<string, string>, key: string): string {
    const id = clusterByKey.get(key);
    if (!id) throw new Error(`DiarizationSpeakerMissing:${key}`);
    return id;
  }
}

function batches<T>(values: T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += INSERT_BATCH_SIZE) {
    result.push(values.slice(index, index + INSERT_BATCH_SIZE));
  }
  return result;
}

export function overlappingTurnFlags(
  turns: Array<{ endUs: number; speakerKey: string; startUs: number }>,
): boolean[] {
  const flags = turns.map(() => false);
  let longest: SpeakerBoundary | undefined;
  let secondLongest: SpeakerBoundary | undefined;
  for (const [index, turn] of turns.entries()) {
    const other = longest?.speakerKey === turn.speakerKey ? secondLongest : longest;
    if (other && other.positionUs > turn.startUs) flags[index] = true;
    [longest, secondLongest] = updateMaximumBoundaries(
      longest,
      secondLongest,
      turn.speakerKey,
      turn.endUs,
    );
  }

  let earliest: SpeakerBoundary | undefined;
  let secondEarliest: SpeakerBoundary | undefined;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const other = earliest?.speakerKey === turn.speakerKey ? secondEarliest : earliest;
    if (other && other.positionUs < turn.endUs) flags[index] = true;
    [earliest, secondEarliest] = updateMinimumBoundaries(
      earliest,
      secondEarliest,
      turn.speakerKey,
      turn.startUs,
    );
  }
  return flags;
}

interface SpeakerBoundary {
  positionUs: number;
  speakerKey: string;
}

function updateMaximumBoundaries(
  first: SpeakerBoundary | undefined,
  second: SpeakerBoundary | undefined,
  speakerKey: string,
  positionUs: number,
): [SpeakerBoundary, SpeakerBoundary | undefined] {
  const candidate = { positionUs, speakerKey };
  if (!first) return [candidate, second];
  if (first.speakerKey === speakerKey) {
    return [positionUs > first.positionUs ? candidate : first, second];
  }
  if (second?.speakerKey === speakerKey) {
    const updated = positionUs > second.positionUs ? candidate : second;
    return updated.positionUs > first.positionUs ? [updated, first] : [first, updated];
  }
  if (positionUs > first.positionUs) return [candidate, first];
  if (!second || positionUs > second.positionUs) return [first, candidate];
  return [first, second];
}

function updateMinimumBoundaries(
  first: SpeakerBoundary | undefined,
  second: SpeakerBoundary | undefined,
  speakerKey: string,
  positionUs: number,
): [SpeakerBoundary, SpeakerBoundary | undefined] {
  const candidate = { positionUs, speakerKey };
  if (!first) return [candidate, second];
  if (first.speakerKey === speakerKey) {
    return [positionUs < first.positionUs ? candidate : first, second];
  }
  if (second?.speakerKey === speakerKey) {
    const updated = positionUs < second.positionUs ? candidate : second;
    return updated.positionUs < first.positionUs ? [updated, first] : [first, updated];
  }
  if (positionUs < first.positionUs) return [candidate, first];
  if (!second || positionUs < second.positionUs) return [first, candidate];
  return [first, second];
}
