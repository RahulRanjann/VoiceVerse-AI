import { Injectable } from '@nestjs/common';

const DEFAULT_NEAREST_TURN_TOLERANCE_US = 250_000n;
export const DETERMINISTIC_TIMELINE_RESOLVER = 'deterministic-timeline-v1' as const;

export interface TimelineWordInput {
  id: string;
  transcriptSegmentId: string;
  sequenceNumber: number;
  startTimeUs: bigint;
  endTimeUs: bigint;
  text: string;
  confidenceBasisPoints: number | null;
}

export interface TimelineTranscriptSegmentInput {
  id: string;
  sequenceNumber: number;
  startTimeUs: bigint;
  endTimeUs: bigint;
  text: string;
  confidenceBasisPoints: number | null;
  words: TimelineWordInput[];
}

export interface TimelineSpeakerClusterInput {
  id: string;
  ordinal: number;
}

export interface TimelineSpeakerTurnInput {
  id: string;
  speakerClusterId: string;
  sequenceNumber: number;
  startTimeUs: bigint;
  endTimeUs: bigint;
  isExclusive: boolean;
  isOverlapping: boolean;
}

export interface TimelineMaterializationInput {
  resolver: typeof DETERMINISTIC_TIMELINE_RESOLVER;
  speakerClusters: TimelineSpeakerClusterInput[];
  speakerTurns: TimelineSpeakerTurnInput[];
  transcriptSegments: TimelineTranscriptSegmentInput[];
  nearestTurnToleranceUs?: bigint;
}

export interface MaterializedCharacter {
  displayName: string;
  firstAppearanceTimeUs: bigint;
  segmentCount: number;
  speakerClusterId: string;
  speakingDurationUs: bigint;
  stableKey: string;
  wordCount: number;
}

export interface MaterializedDialogueSegment {
  assignmentConfidenceBasisPoints: number | null;
  assignmentMethod: 'MAXIMUM_OVERLAP' | 'NEAREST_TURN' | 'UNRESOLVED';
  endTimeUs: bigint;
  isOverlapping: boolean;
  sequenceNumber: number;
  sourceText: string;
  sourceWordEndSequence: number | null;
  sourceWordStartSequence: number | null;
  speakerClusterId: string | null;
  speakerTurnId: string | null;
  startTimeUs: bigint;
  transcriptSegmentId: string;
  transcriptionConfidenceBasisPoints: number | null;
}

export interface TimelineMaterialization {
  characters: MaterializedCharacter[];
  dialogueSegments: MaterializedDialogueSegment[];
  unresolvedSegmentCount: number;
}

interface TimedUnit {
  confidenceBasisPoints: number | null;
  endTimeUs: bigint;
  sequenceNumber: number;
  startTimeUs: bigint;
  text: string;
  wordEndSequence: number | null;
  wordStartSequence: number | null;
}

interface UnitAssignment {
  confidenceBasisPoints: number | null;
  method: MaterializedDialogueSegment['assignmentMethod'];
  speakerClusterId: string | null;
  speakerTurnId: string | null;
}

interface AssignedUnit extends TimedUnit {
  assignment: UnitAssignment;
}

/**
 * Resolves provider-local speaker turns into deterministic movie characters.
 *
 * The resolver is intentionally model-free: it consumes normalized, immutable
 * evidence and applies versionable half-open interval rules. This makes retries,
 * provider swaps, and golden-fixture tests reproducible without persisting voice
 * embeddings in PostgreSQL.
 */
@Injectable()
export class TimelineMaterializerService {
  materialize(input: TimelineMaterializationInput): TimelineMaterialization {
    this.assertInput(input);
    const tolerance = input.nearestTurnToleranceUs ?? DEFAULT_NEAREST_TURN_TOLERANCE_US;
    if (tolerance < 0n) throw new Error('TimelineNearestTurnToleranceInvalid');

    const exclusiveTurns = input.speakerTurns
      .filter((turn) => turn.isExclusive)
      .toSorted(compareInterval);
    const regularTurns = input.speakerTurns
      .filter((turn) => !turn.isExclusive)
      .toSorted(compareInterval);
    const clustersWithExclusiveTurns = new Set(
      exclusiveTurns.map(({ speakerClusterId }) => speakerClusterId),
    );
    const characterEvidenceTurns = [
      ...exclusiveTurns,
      ...regularTurns.filter(
        ({ speakerClusterId }) => !clustersWithExclusiveTurns.has(speakerClusterId),
      ),
    ].toSorted(compareInterval);
    const clusterStatistics = this.clusterStatistics(characterEvidenceTurns);
    const clusterOrder = this.canonicalClusterOrder(input.speakerClusters, clusterStatistics);
    const characterByCluster = new Map(
      clusterOrder.map((cluster, index) => [
        cluster.id,
        {
          displayName: `Character ${String(index + 1).padStart(2, '0')}`,
          firstAppearanceTimeUs: clusterStatistics.firstAppearanceByCluster.get(cluster.id) ?? 0n,
          segmentCount: 0,
          speakerClusterId: cluster.id,
          speakingDurationUs: 0n,
          stableKey: `character-${String(index + 1).padStart(4, '0')}`,
          wordCount: 0,
        } satisfies MaterializedCharacter,
      ]),
    );

    const dialogueSegments: MaterializedDialogueSegment[] = [];
    const assignmentCursor = new TurnAssignmentCursor(exclusiveTurns, tolerance);
    const overlapCursor = new IntervalOverlapCursor(regularTurns);

    for (const transcriptSegment of input.transcriptSegments.toSorted(compareInterval)) {
      const units = this.unitsForSegment(transcriptSegment);
      const assigned = units.map((unit) => ({
        ...unit,
        assignment: assignmentCursor.assign(unit.startTimeUs, unit.endTimeUs),
      }));
      for (const group of this.groupAssignedUnits(assigned)) {
        const sequenceNumber = dialogueSegments.length;
        const sourceText = group
          .map((unit) => unit.text)
          .join('')
          .trim();
        const speakerClusterId = group[0]?.assignment.speakerClusterId ?? null;
        const startTimeUs = group[0]?.startTimeUs ?? transcriptSegment.startTimeUs;
        const endTimeUs = group.at(-1)?.endTimeUs ?? transcriptSegment.endTimeUs;
        const character = speakerClusterId ? characterByCluster.get(speakerClusterId) : undefined;
        if (character) {
          character.segmentCount += 1;
          character.speakingDurationUs += endTimeUs - startTimeUs;
          character.wordCount += group.reduce(
            (count, unit) => count + (unit.wordStartSequence === null ? 0 : 1),
            0,
          );
        }
        dialogueSegments.push({
          assignmentConfidenceBasisPoints: minimumNullable(
            group.map((unit) => unit.assignment.confidenceBasisPoints),
          ),
          assignmentMethod: group[0]?.assignment.method ?? 'UNRESOLVED',
          endTimeUs,
          isOverlapping: overlapCursor.hasOverlap(startTimeUs, endTimeUs),
          sequenceNumber,
          sourceText: sourceText || transcriptSegment.text.trim(),
          sourceWordEndSequence: group.at(-1)?.wordEndSequence ?? null,
          sourceWordStartSequence: group[0]?.wordStartSequence ?? null,
          speakerClusterId,
          speakerTurnId: group[0]?.assignment.speakerTurnId ?? null,
          startTimeUs,
          transcriptSegmentId: transcriptSegment.id,
          transcriptionConfidenceBasisPoints: minimumNullable(
            group.map((unit) => unit.confidenceBasisPoints),
          ),
        });
      }
    }

    return {
      // A diarized speaker is durable evidence even when ASR produced no
      // alignable words. Keeping the zero-dialogue character prevents a later
      // retry or editor pass from changing every subsequent character key.
      characters: [...characterByCluster.values()],
      dialogueSegments,
      unresolvedSegmentCount: dialogueSegments.filter(
        ({ assignmentMethod }) => assignmentMethod === 'UNRESOLVED',
      ).length,
    };
  }

  private unitsForSegment(segment: TimelineTranscriptSegmentInput): TimedUnit[] {
    if (segment.words.length === 0) {
      return [
        {
          confidenceBasisPoints: segment.confidenceBasisPoints,
          endTimeUs: segment.endTimeUs,
          sequenceNumber: segment.sequenceNumber,
          startTimeUs: segment.startTimeUs,
          text: segment.text,
          wordEndSequence: null,
          wordStartSequence: null,
        },
      ];
    }
    return segment.words.toSorted(compareInterval).map((word) => ({
      confidenceBasisPoints: word.confidenceBasisPoints,
      endTimeUs: word.endTimeUs,
      sequenceNumber: word.sequenceNumber,
      startTimeUs: word.startTimeUs,
      text: word.text,
      wordEndSequence: word.sequenceNumber,
      wordStartSequence: word.sequenceNumber,
    }));
  }

  private groupAssignedUnits(units: AssignedUnit[]): AssignedUnit[][] {
    const groups: AssignedUnit[][] = [];
    for (const unit of units) {
      const current = groups.at(-1);
      if (
        current &&
        current[0]?.assignment.speakerClusterId === unit.assignment.speakerClusterId &&
        current[0]?.assignment.speakerTurnId === unit.assignment.speakerTurnId &&
        current[0]?.assignment.method === unit.assignment.method
      ) {
        current.push(unit);
      } else {
        groups.push([unit]);
      }
    }
    return groups;
  }

  private canonicalClusterOrder(
    clusters: TimelineSpeakerClusterInput[],
    statistics: {
      durationByCluster: Map<string, bigint>;
      firstAppearanceByCluster: Map<string, bigint>;
    },
  ): TimelineSpeakerClusterInput[] {
    const { durationByCluster, firstAppearanceByCluster } = statistics;
    return clusters.toSorted((left, right) => {
      const appearanceOrder = compareBigInt(
        firstAppearanceByCluster.get(left.id) ?? 0n,
        firstAppearanceByCluster.get(right.id) ?? 0n,
      );
      if (appearanceOrder !== 0) return appearanceOrder;
      const durationOrder = compareBigInt(
        durationByCluster.get(right.id) ?? 0n,
        durationByCluster.get(left.id) ?? 0n,
      );
      if (durationOrder !== 0) return durationOrder;
      return left.ordinal - right.ordinal || left.id.localeCompare(right.id);
    });
  }

  private clusterStatistics(turns: TimelineSpeakerTurnInput[]) {
    const durationByCluster = new Map<string, bigint>();
    const firstAppearanceByCluster = new Map<string, bigint>();
    for (const turn of turns) {
      durationByCluster.set(
        turn.speakerClusterId,
        (durationByCluster.get(turn.speakerClusterId) ?? 0n) + (turn.endTimeUs - turn.startTimeUs),
      );
      const firstAppearance = firstAppearanceByCluster.get(turn.speakerClusterId);
      if (firstAppearance === undefined || turn.startTimeUs < firstAppearance) {
        firstAppearanceByCluster.set(turn.speakerClusterId, turn.startTimeUs);
      }
    }
    return { durationByCluster, firstAppearanceByCluster };
  }

  private assertInput(input: TimelineMaterializationInput): void {
    if (input.resolver !== DETERMINISTIC_TIMELINE_RESOLVER) {
      throw new Error('TimelineResolverUnsupported');
    }
    const clusterIds = new Set(input.speakerClusters.map(({ id }) => id));
    if (clusterIds.size !== input.speakerClusters.length) {
      throw new Error('TimelineSpeakerClusterDuplicate');
    }
    for (const turn of input.speakerTurns) {
      assertInterval(turn.startTimeUs, turn.endTimeUs);
      if (!clusterIds.has(turn.speakerClusterId)) {
        throw new Error('TimelineSpeakerTurnClusterMissing');
      }
      if (turn.isExclusive && turn.isOverlapping) {
        throw new Error('TimelineSpeakerTurnClassificationInvalid');
      }
    }
    const clustersWithTurns = new Set(
      input.speakerTurns.map(({ speakerClusterId }) => speakerClusterId),
    );
    if (input.speakerClusters.some(({ id }) => !clustersWithTurns.has(id))) {
      throw new Error('TimelineSpeakerClusterTurnMissing');
    }
    const orderedSegments = input.transcriptSegments.toSorted(compareInterval);
    for (const [segmentIndex, segment] of orderedSegments.entries()) {
      assertInterval(segment.startTimeUs, segment.endTimeUs);
      assertBasisPoints(segment.confidenceBasisPoints);
      const previousSegment = orderedSegments[segmentIndex - 1];
      if (previousSegment && segment.startTimeUs < previousSegment.endTimeUs) {
        throw new Error('TimelineTranscriptSegmentsOverlap');
      }
      const orderedWords = segment.words.toSorted(compareInterval);
      for (const [wordIndex, word] of orderedWords.entries()) {
        assertInterval(word.startTimeUs, word.endTimeUs);
        assertBasisPoints(word.confidenceBasisPoints);
        const previousWord = orderedWords[wordIndex - 1];
        if (
          word.transcriptSegmentId !== segment.id ||
          word.startTimeUs < segment.startTimeUs ||
          word.endTimeUs > segment.endTimeUs
        ) {
          throw new Error('TimelineWordOutsideTranscriptSegment');
        }
        if (previousWord && word.startTimeUs < previousWord.endTimeUs) {
          throw new Error('TimelineTranscriptWordsOverlap');
        }
      }
    }
  }
}

/**
 * Linear sweep over ordered overlap annotations. Dialogue segments are
 * guaranteed to be monotonic by assertInput, so feature-length timelines do
 * not degrade to O(dialogue segments x diarization turns).
 */
class IntervalOverlapCursor {
  private readonly intervals: TimelineInterval[];
  private cursor = 0;

  constructor(turns: TimelineSpeakerTurnInput[]) {
    this.intervals = mergeMarkedOverlapIntervals(turns);
  }

  hasOverlap(startTimeUs: bigint, endTimeUs: bigint): boolean {
    while (
      this.cursor < this.intervals.length &&
      this.intervals[this.cursor]!.endTimeUs <= startTimeUs
    ) {
      this.cursor += 1;
    }
    const interval = this.intervals[this.cursor];
    return Boolean(
      interval && interval.startTimeUs < endTimeUs && interval.endTimeUs > startTimeUs,
    );
  }
}

interface TimelineInterval {
  endTimeUs: bigint;
  startTimeUs: bigint;
}

/**
 * Collapses marked overlap annotations into a disjoint union. Both this pass
 * and the cursor above advance monotonically, so dense feature-length
 * diarization remains O(turns + dialogue segments) rather than retaining and
 * rescanning every active speaker turn for every segment.
 */
export function mergeMarkedOverlapIntervals(turns: TimelineSpeakerTurnInput[]): TimelineInterval[] {
  const intervals: TimelineInterval[] = [];
  for (const turn of turns) {
    if (!turn.isOverlapping) continue;
    const current = intervals.at(-1);
    if (current && turn.startTimeUs <= current.endTimeUs) {
      if (turn.endTimeUs > current.endTimeUs) current.endTimeUs = turn.endTimeUs;
      continue;
    }
    intervals.push({ endTimeUs: turn.endTimeUs, startTimeUs: turn.startTimeUs });
  }
  return intervals;
}

class TurnAssignmentCursor {
  private active: TimelineSpeakerTurnInput[] = [];
  private cursor = 0;
  private latestEnded: TimelineSpeakerTurnInput | undefined;

  constructor(
    private readonly turns: TimelineSpeakerTurnInput[],
    private readonly toleranceUs: bigint,
  ) {}

  assign(startTimeUs: bigint, endTimeUs: bigint): UnitAssignment {
    while (this.cursor < this.turns.length && this.turns[this.cursor]!.startTimeUs < endTimeUs) {
      this.active.push(this.turns[this.cursor]!);
      this.cursor += 1;
    }
    this.active = this.active.filter((turn) => {
      if (turn.endTimeUs <= startTimeUs) {
        if (!this.latestEnded || turn.endTimeUs > this.latestEnded.endTimeUs) {
          this.latestEnded = turn;
        }
        return false;
      }
      return true;
    });

    const overlaps = this.active
      .map((turn) => ({
        overlap: overlapUs(startTimeUs, endTimeUs, turn.startTimeUs, turn.endTimeUs),
        turn,
      }))
      .filter(({ overlap }) => overlap > 0n)
      .toSorted(
        (left, right) =>
          compareBigInt(right.overlap, left.overlap) || compareInterval(left.turn, right.turn),
      );
    const best = overlaps[0];
    if (best) {
      const duration = endTimeUs - startTimeUs;
      return {
        confidenceBasisPoints: Number((best.overlap * 10_000n) / duration),
        method: 'MAXIMUM_OVERLAP',
        speakerClusterId: best.turn.speakerClusterId,
        speakerTurnId: best.turn.id,
      };
    }

    const next = this.turns[this.cursor];
    const nearest = [
      this.latestEnded
        ? { gap: startTimeUs - this.latestEnded.endTimeUs, turn: this.latestEnded }
        : undefined,
      next ? { gap: next.startTimeUs - endTimeUs, turn: next } : undefined,
    ]
      .filter((candidate): candidate is { gap: bigint; turn: TimelineSpeakerTurnInput } => {
        return candidate !== undefined && candidate.gap >= 0n && candidate.gap <= this.toleranceUs;
      })
      .toSorted((left, right) => compareBigInt(left.gap, right.gap))[0];
    if (nearest) {
      return {
        confidenceBasisPoints: null,
        method: 'NEAREST_TURN',
        speakerClusterId: nearest.turn.speakerClusterId,
        speakerTurnId: nearest.turn.id,
      };
    }
    return {
      confidenceBasisPoints: null,
      method: 'UNRESOLVED',
      speakerClusterId: null,
      speakerTurnId: null,
    };
  }
}

function assertInterval(startTimeUs: bigint, endTimeUs: bigint): void {
  if (startTimeUs < 0n || endTimeUs <= startTimeUs) {
    throw new Error('TimelineIntervalInvalid');
  }
}

function assertBasisPoints(value: number | null | undefined): void {
  if (
    value !== undefined &&
    value !== null &&
    (!Number.isInteger(value) || value < 0 || value > 10_000)
  ) {
    throw new Error('TimelineConfidenceBasisPointsInvalid');
  }
}

function overlapUs(
  leftStart: bigint,
  leftEnd: bigint,
  rightStart: bigint,
  rightEnd: bigint,
): bigint {
  const start = leftStart > rightStart ? leftStart : rightStart;
  const end = leftEnd < rightEnd ? leftEnd : rightEnd;
  return end > start ? end - start : 0n;
}

function compareInterval(
  left: { endTimeUs: bigint; sequenceNumber: number; startTimeUs: bigint },
  right: { endTimeUs: bigint; sequenceNumber: number; startTimeUs: bigint },
): number {
  return (
    compareBigInt(left.startTimeUs, right.startTimeUs) ||
    compareBigInt(left.endTimeUs, right.endTimeUs) ||
    left.sequenceNumber - right.sequenceNumber
  );
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function minimumNullable(values: Array<number | null>): number | null {
  const defined = values.filter((value): value is number => value !== null);
  return defined.length === 0 ? null : Math.min(...defined);
}
