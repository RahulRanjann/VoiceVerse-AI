import { describe, expect, it } from 'vitest';

import {
  mergeMarkedOverlapIntervals,
  TimelineMaterializerService,
  type TimelineMaterializationInput,
} from './timeline-materializer.service';

const segmentId = '01910000-0000-7000-8000-000000000001';
const speakerA = '01910000-0000-7000-8000-000000000010';
const speakerB = '01910000-0000-7000-8000-000000000011';

function fixture(): TimelineMaterializationInput {
  return {
    resolver: 'deterministic-timeline-v1',
    speakerClusters: [
      { id: speakerA, ordinal: 8 },
      { id: speakerB, ordinal: 2 },
    ],
    speakerTurns: [
      {
        endTimeUs: 1_000_000n,
        id: '01910000-0000-7000-8000-000000000020',
        isExclusive: true,
        isOverlapping: false,
        sequenceNumber: 0,
        speakerClusterId: speakerA,
        startTimeUs: 0n,
      },
      {
        endTimeUs: 2_000_000n,
        id: '01910000-0000-7000-8000-000000000021',
        isExclusive: true,
        isOverlapping: false,
        sequenceNumber: 1,
        speakerClusterId: speakerB,
        startTimeUs: 1_000_000n,
      },
      {
        endTimeUs: 1_200_000n,
        id: '01910000-0000-7000-8000-000000000022',
        isExclusive: false,
        isOverlapping: true,
        sequenceNumber: 2,
        speakerClusterId: speakerA,
        startTimeUs: 800_000n,
      },
    ],
    transcriptSegments: [
      {
        confidenceBasisPoints: 9_000,
        endTimeUs: 1_800_000n,
        id: segmentId,
        sequenceNumber: 0,
        startTimeUs: 100_000n,
        text: 'Hello there friend',
        words: [
          word(0, 100_000n, 500_000n, ' Hello'),
          word(1, 500_000n, 900_000n, ' there'),
          word(2, 1_100_000n, 1_800_000n, ' friend'),
        ],
      },
    ],
  };
}

function word(sequenceNumber: number, startTimeUs: bigint, endTimeUs: bigint, text: string) {
  return {
    confidenceBasisPoints: 9_500,
    endTimeUs,
    id: `01910000-0000-7000-8000-${String(sequenceNumber).padStart(12, '0')}`,
    sequenceNumber,
    startTimeUs,
    text,
    transcriptSegmentId: segmentId,
  };
}

describe('TimelineMaterializerService', () => {
  it('collapses dense marked overlap turns into a disjoint linear-time interval union', () => {
    const denseTurns = Array.from({ length: 20_000 }, (_, index) => ({
      endTimeUs: 1_000_000n + BigInt(index),
      id: `turn-${index}`,
      isExclusive: false,
      isOverlapping: true,
      sequenceNumber: index,
      speakerClusterId: index % 2 === 0 ? speakerA : speakerB,
      startTimeUs: BigInt(index),
    }));
    denseTurns.push({
      endTimeUs: 3_000_000n,
      id: 'unmarked-gap',
      isExclusive: false,
      isOverlapping: false,
      sequenceNumber: denseTurns.length,
      speakerClusterId: speakerA,
      startTimeUs: 2_000_000n,
    });
    denseTurns.push({
      endTimeUs: 4_000_000n,
      id: 'marked-disjoint',
      isExclusive: false,
      isOverlapping: true,
      sequenceNumber: denseTurns.length,
      speakerClusterId: speakerB,
      startTimeUs: 3_000_000n,
    });

    expect(mergeMarkedOverlapIntervals(denseTurns)).toEqual([
      { endTimeUs: 1_019_999n, startTimeUs: 0n },
      { endTimeUs: 4_000_000n, startTimeUs: 3_000_000n },
    ]);
  });

  it('splits dialogue on speaker changes and assigns stable first-appearance characters', () => {
    const result = new TimelineMaterializerService().materialize(fixture());

    expect(result.characters).toEqual([
      expect.objectContaining({
        displayName: 'Character 01',
        segmentCount: 1,
        speakerClusterId: speakerA,
        stableKey: 'character-0001',
        wordCount: 2,
      }),
      expect.objectContaining({
        displayName: 'Character 02',
        segmentCount: 1,
        speakerClusterId: speakerB,
        stableKey: 'character-0002',
        wordCount: 1,
      }),
    ]);
    expect(result.dialogueSegments).toEqual([
      expect.objectContaining({
        assignmentMethod: 'MAXIMUM_OVERLAP',
        isOverlapping: true,
        sourceText: 'Hello there',
        speakerClusterId: speakerA,
      }),
      expect.objectContaining({
        assignmentMethod: 'MAXIMUM_OVERLAP',
        isOverlapping: true,
        sourceText: 'friend',
        speakerClusterId: speakerB,
      }),
    ]);
    expect(result.unresolvedSegmentCount).toBe(0);
  });

  it('uses a bounded nearest-turn fallback and otherwise preserves unresolved dialogue', () => {
    const input = fixture();
    input.transcriptSegments = [
      {
        confidenceBasisPoints: null,
        endTimeUs: 2_200_000n,
        id: segmentId,
        sequenceNumber: 0,
        startTimeUs: 2_050_000n,
        text: 'nearby',
        words: [],
      },
      {
        confidenceBasisPoints: null,
        endTimeUs: 3_100_000n,
        id: '01910000-0000-7000-8000-000000000002',
        sequenceNumber: 1,
        startTimeUs: 3_000_000n,
        text: 'unresolved',
        words: [],
      },
    ];

    const result = new TimelineMaterializerService().materialize(input);

    expect(result.dialogueSegments[0]).toEqual(
      expect.objectContaining({ assignmentMethod: 'NEAREST_TURN', speakerClusterId: speakerB }),
    );
    expect(result.dialogueSegments[1]).toEqual(
      expect.objectContaining({ assignmentMethod: 'UNRESOLVED', speakerClusterId: null }),
    );
    expect(result.unresolvedSegmentCount).toBe(1);
  });

  it('does not merge dialogue assigned to distinct turns from the same speaker', () => {
    const firstTurnId = '01910000-0000-7000-8000-000000000030';
    const secondTurnId = '01910000-0000-7000-8000-000000000031';
    const input: TimelineMaterializationInput = {
      resolver: 'deterministic-timeline-v1',
      speakerClusters: [{ id: speakerA, ordinal: 0 }],
      speakerTurns: [
        {
          endTimeUs: 400_000n,
          id: firstTurnId,
          isExclusive: true,
          isOverlapping: false,
          sequenceNumber: 0,
          speakerClusterId: speakerA,
          startTimeUs: 0n,
        },
        {
          endTimeUs: 1_000_000n,
          id: secondTurnId,
          isExclusive: true,
          isOverlapping: false,
          sequenceNumber: 1,
          speakerClusterId: speakerA,
          startTimeUs: 600_000n,
        },
      ],
      transcriptSegments: [
        {
          confidenceBasisPoints: 9_000,
          endTimeUs: 1_000_000n,
          id: segmentId,
          sequenceNumber: 0,
          startTimeUs: 0n,
          text: 'One two',
          words: [word(0, 0n, 400_000n, 'One'), word(1, 600_000n, 1_000_000n, ' two')],
        },
      ],
    };

    const result = new TimelineMaterializerService().materialize(input);

    expect(result.dialogueSegments).toEqual([
      expect.objectContaining({
        endTimeUs: 400_000n,
        sourceText: 'One',
        speakerTurnId: firstTurnId,
        startTimeUs: 0n,
      }),
      expect.objectContaining({
        endTimeUs: 1_000_000n,
        sourceText: 'two',
        speakerTurnId: secondTurnId,
        startTimeUs: 600_000n,
      }),
    ]);
    expect(result.characters[0]).toEqual(
      expect.objectContaining({ segmentCount: 2, speakingDurationUs: 800_000n }),
    );
  });

  it('advances through merged overlap intervals without carrying state across gaps', () => {
    const input: TimelineMaterializationInput = {
      resolver: 'deterministic-timeline-v1',
      speakerClusters: [{ id: speakerA, ordinal: 0 }],
      speakerTurns: [
        {
          endTimeUs: 3_000_000n,
          id: 'exclusive-speaker-a',
          isExclusive: true,
          isOverlapping: false,
          sequenceNumber: 0,
          speakerClusterId: speakerA,
          startTimeUs: 0n,
        },
        {
          endTimeUs: 500_000n,
          id: 'overlap-one',
          isExclusive: false,
          isOverlapping: true,
          sequenceNumber: 0,
          speakerClusterId: speakerA,
          startTimeUs: 200_000n,
        },
        {
          endTimeUs: 700_000n,
          id: 'overlap-two',
          isExclusive: false,
          isOverlapping: true,
          sequenceNumber: 1,
          speakerClusterId: speakerA,
          startTimeUs: 400_000n,
        },
        {
          endTimeUs: 2_200_000n,
          id: 'overlap-three',
          isExclusive: false,
          isOverlapping: true,
          sequenceNumber: 2,
          speakerClusterId: speakerA,
          startTimeUs: 2_000_000n,
        },
      ],
      transcriptSegments: [
        {
          confidenceBasisPoints: null,
          endTimeUs: 300_000n,
          id: 'segment-overlap-one',
          sequenceNumber: 0,
          startTimeUs: 100_000n,
          text: 'overlap',
          words: [],
        },
        {
          confidenceBasisPoints: null,
          endTimeUs: 1_200_000n,
          id: 'segment-gap',
          sequenceNumber: 1,
          startTimeUs: 1_000_000n,
          text: 'gap',
          words: [],
        },
        {
          confidenceBasisPoints: null,
          endTimeUs: 2_300_000n,
          id: 'segment-overlap-two',
          sequenceNumber: 2,
          startTimeUs: 2_100_000n,
          text: 'overlap again',
          words: [],
        },
      ],
    };

    const result = new TimelineMaterializerService().materialize(input);

    expect(result.dialogueSegments.map(({ isOverlapping }) => isOverlapping)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('rejects invalid intervals, cross-segment words, and unknown clusters', () => {
    const service = new TimelineMaterializerService();
    const invalidInterval = fixture();
    invalidInterval.transcriptSegments[0]!.endTimeUs = 0n;
    expect(() => service.materialize(invalidInterval)).toThrow('TimelineIntervalInvalid');

    const crossSegment = fixture();
    crossSegment.transcriptSegments[0]!.words[0]!.transcriptSegmentId = 'wrong';
    expect(() => service.materialize(crossSegment)).toThrow('TimelineWordOutsideTranscriptSegment');

    const missingCluster = fixture();
    missingCluster.speakerTurns[0]!.speakerClusterId = 'missing';
    expect(() => service.materialize(missingCluster)).toThrow('TimelineSpeakerTurnClusterMissing');
  });

  it('returns a valid empty analysis when no speech is detected', () => {
    const result = new TimelineMaterializerService().materialize({
      resolver: 'deterministic-timeline-v1',
      speakerClusters: [],
      speakerTurns: [],
      transcriptSegments: [],
    });

    expect(result).toEqual({
      characters: [],
      dialogueSegments: [],
      unresolvedSegmentCount: 0,
    });
  });

  it('keeps a detected speaker even when no transcript word aligns to it', () => {
    const input = fixture();
    input.transcriptSegments = [];

    const result = new TimelineMaterializerService().materialize(input);

    expect(result.characters).toEqual([
      expect.objectContaining({
        segmentCount: 0,
        speakerClusterId: speakerA,
        stableKey: 'character-0001',
      }),
      expect.objectContaining({
        segmentCount: 0,
        speakerClusterId: speakerB,
        stableKey: 'character-0002',
      }),
    ]);
    expect(result.dialogueSegments).toEqual([]);
  });

  it('orders an overlap-only speaker by its real regular-turn appearance', () => {
    const input = fixture();
    input.speakerTurns = [
      {
        endTimeUs: 2_000_000n,
        id: '01910000-0000-7000-8000-000000000041',
        isExclusive: true,
        isOverlapping: false,
        sequenceNumber: 0,
        speakerClusterId: speakerA,
        startTimeUs: 1_000_000n,
      },
      {
        endTimeUs: 3_000_000n,
        id: '01910000-0000-7000-8000-000000000042',
        isExclusive: false,
        isOverlapping: true,
        sequenceNumber: 0,
        speakerClusterId: speakerB,
        startTimeUs: 2_000_000n,
      },
    ];
    input.transcriptSegments = [];

    const result = new TimelineMaterializerService().materialize(input);

    expect(result.characters).toEqual([
      expect.objectContaining({
        firstAppearanceTimeUs: 1_000_000n,
        speakerClusterId: speakerA,
        stableKey: 'character-0001',
      }),
      expect.objectContaining({
        firstAppearanceTimeUs: 2_000_000n,
        speakerClusterId: speakerB,
        stableKey: 'character-0002',
      }),
    ]);
  });

  it('rejects a detected cluster with no supporting turn evidence', () => {
    const input = fixture();
    input.speakerTurns = input.speakerTurns.filter(
      ({ speakerClusterId }) => speakerClusterId !== speakerB,
    );

    expect(() => new TimelineMaterializerService().materialize(input)).toThrow(
      'TimelineSpeakerClusterTurnMissing',
    );
  });

  it('rejects overlapping ASR segments because sweep-line assignment requires monotonic input', () => {
    const input = fixture();
    input.transcriptSegments.push({
      confidenceBasisPoints: null,
      endTimeUs: 1_900_000n,
      id: '01910000-0000-7000-8000-000000000002',
      sequenceNumber: 1,
      startTimeUs: 1_700_000n,
      text: 'overlap',
      words: [],
    });

    expect(() => new TimelineMaterializerService().materialize(input)).toThrow(
      'TimelineTranscriptSegmentsOverlap',
    );
  });
});
