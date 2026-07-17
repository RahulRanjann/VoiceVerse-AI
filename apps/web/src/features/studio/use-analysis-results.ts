'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';

import { useAuth } from '@/features/auth/auth-provider';
import type {
  AnalysisResultPage,
  CharacterSummary,
  DialogueSegment,
} from '@/features/studio/types';
import { listDialogueSegments, listJobCharacters } from './api';

const CHARACTER_PREVIEW_LIMIT = 6;
const DIALOGUE_PAGE_LIMIT = 25;

export function useCharacterResults(jobId: string) {
  const { request } = useAuth();
  return useSWR<AnalysisResultPage<CharacterSummary>, Error>(
    jobId ? ['analysis-characters', jobId] : null,
    () => listJobCharacters(request, jobId, { limit: CHARACTER_PREVIEW_LIMIT }),
    {
      keepPreviousData: true,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );
}

export function useDialogueResults(jobId: string) {
  const { request } = useAuth();
  const swr = useSWRInfinite<AnalysisResultPage<DialogueSegment>, Error>(
    (pageIndex, previousPage) => {
      if (!jobId || (pageIndex > 0 && !previousPage?.nextCursor)) return null;
      return [
        'analysis-dialogue',
        jobId,
        pageIndex === 0 ? null : previousPage?.nextCursor,
      ] as const;
    },
    ([, , cursor]) =>
      listDialogueSegments(request, jobId, {
        cursor: typeof cursor === 'string' ? cursor : undefined,
        limit: DIALOGUE_PAGE_LIMIT,
      }),
    {
      revalidateFirstPage: false,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );

  const segments = useMemo(() => {
    const unique = new Map<string, DialogueSegment>();
    for (const page of swr.data ?? []) {
      for (const segment of page.data) unique.set(segment.id, segment);
    }
    return [...unique.values()].sort((left, right) => left.sequenceNumber - right.sequenceNumber);
  }, [swr.data]);
  const lastPage = swr.data?.at(-1);
  const isLoadingMore = Boolean(
    swr.isLoading || (swr.size > 0 && swr.data && typeof swr.data[swr.size - 1] === 'undefined'),
  );

  return {
    ...swr,
    availability: swr.data?.[0]?.availability,
    hasMore: Boolean(lastPage?.nextCursor),
    isLoadingMore,
    loadMore: () => swr.setSize((size) => size + 1),
    segments,
    totalCount: swr.data?.[0]?.totalCount ?? 0,
  };
}
