export const LOCALIZATION_SCENE_MAX_DURATION_US = 60_000_000n;
export const LOCALIZATION_SCENE_MAX_DIALOGUES = 200;
export const LOCALIZATION_SCENE_SILENCE_BOUNDARY_US = 2_000_000n;

export interface LocalizationBootstrapSegment {
  id: string;
  sequenceNumber: number;
  startTimeUs: bigint;
  endTimeUs: bigint;
  text: string;
}

export interface LocalizationScenePartition<T extends LocalizationBootstrapSegment> {
  ordinal: number;
  startTimeUs: bigint;
  endTimeUs: bigint;
  dialogues: T[];
}

/**
 * Materializes the M5 dialogue timeline into stable, bounded editorial scenes.
 * The source rows are never changed and input ordering does not affect the result.
 */
export function partitionLocalizationScenes<T extends LocalizationBootstrapSegment>(
  input: readonly T[],
): Array<LocalizationScenePartition<T>> {
  const ordered = [...input].sort(
    (left, right) =>
      left.sequenceNumber - right.sequenceNumber ||
      compareBigInt(left.startTimeUs, right.startTimeUs) ||
      left.id.localeCompare(right.id),
  );
  const scenes: Array<LocalizationScenePartition<T>> = [];

  for (const dialogue of ordered) {
    const current = scenes.at(-1);
    const previousDialogue = current?.dialogues.at(-1);
    const beginsAtSilenceBoundary =
      previousDialogue !== undefined &&
      dialogue.startTimeUs - previousDialogue.endTimeUs >= LOCALIZATION_SCENE_SILENCE_BOUNDARY_US;
    const exceedsDuration =
      current !== undefined &&
      dialogue.endTimeUs - current.startTimeUs > LOCALIZATION_SCENE_MAX_DURATION_US;
    const exceedsDialogueCount =
      current !== undefined && current.dialogues.length >= LOCALIZATION_SCENE_MAX_DIALOGUES;

    if (!current || beginsAtSilenceBoundary || exceedsDuration || exceedsDialogueCount) {
      scenes.push({
        dialogues: [dialogue],
        endTimeUs: dialogue.endTimeUs,
        ordinal: scenes.length + 1,
        startTimeUs: dialogue.startTimeUs,
      });
      continue;
    }

    current.dialogues.push(dialogue);
    if (dialogue.endTimeUs > current.endTimeUs) current.endTimeUs = dialogue.endTimeUs;
  }

  return scenes;
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
