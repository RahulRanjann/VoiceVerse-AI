import { describe, expect, it } from 'vitest';

import {
  LOCALIZATION_SCENE_MAX_DIALOGUES,
  partitionLocalizationScenes,
} from './localization-partitioner';

function segment(sequenceNumber: number, startTimeUs: bigint, endTimeUs: bigint) {
  return {
    endTimeUs,
    id: `00000000-0000-4000-8000-${String(sequenceNumber).padStart(12, '0')}`,
    sequenceNumber,
    startTimeUs,
    text: `line ${sequenceNumber}`,
  };
}

describe('partitionLocalizationScenes', () => {
  it('returns no scenes for an empty committed timeline', () => {
    expect(partitionLocalizationScenes([])).toEqual([]);
  });

  it('creates a boundary at exactly two seconds of silence and is input-order stable', () => {
    const first = segment(1, 0n, 1_000_000n);
    const second = segment(2, 3_000_000n, 4_000_000n);

    const scenes = partitionLocalizationScenes([second, first]);

    expect(scenes).toHaveLength(2);
    expect(scenes.map((scene) => scene.dialogues.map((dialogue) => dialogue.id))).toEqual([
      [first.id],
      [second.id],
    ]);
  });

  it('allows exactly sixty seconds but starts a scene before exceeding the limit', () => {
    const scenes = partitionLocalizationScenes([
      segment(1, 0n, 59_000_000n),
      segment(2, 59_000_000n, 60_000_000n),
      segment(3, 60_000_001n, 60_000_001n),
    ]);

    expect(scenes.map((scene) => scene.dialogues.length)).toEqual([2, 1]);
    expect(scenes.map((scene) => scene.ordinal)).toEqual([1, 2]);
  });

  it('caps each scene at 200 dialogues', () => {
    const input = Array.from({ length: LOCALIZATION_SCENE_MAX_DIALOGUES + 1 }, (_, index) =>
      segment(index + 1, BigInt(index * 1_000), BigInt(index * 1_000 + 500)),
    );

    expect(partitionLocalizationScenes(input).map((scene) => scene.dialogues.length)).toEqual([
      200, 1,
    ]);
  });
});
