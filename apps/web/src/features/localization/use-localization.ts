'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';

import { useAuth } from '@/features/auth/auth-provider';
import {
  getSceneGeneration,
  listGlossary,
  listGlossaryRevisions,
  listLocalizationScenes,
  listLocalizationTracks,
  listSceneRevisions,
  listSourceRevisions,
  listTranslationRevisions,
} from './api';
import type {
  GlossaryPage,
  GlossaryRevision,
  LocalizationHistoryPage,
  LocalizationScene,
  LocalizationScenePage,
  LocalizationTrackPage,
  SceneRevision,
  SourceDialogueRevision,
  TranslationGeneration,
  TranslationRevision,
} from './types';

const SCENE_PAGE_LIMIT = 8;
const HISTORY_PAGE_LIMIT = 25;

export function useLocalizationTracks(projectId: string) {
  const { request } = useAuth();
  return useSWR<LocalizationTrackPage, Error>(
    projectId ? ['localization-tracks', projectId] : null,
    () => listLocalizationTracks(request, projectId),
    {
      dedupingInterval: 2_000,
      keepPreviousData: true,
      revalidateOnFocus: true,
      shouldRetryOnError: false,
    },
  );
}

export function useLocalizationScenes(projectId: string, trackId: string | null) {
  const { request } = useAuth();
  const swr = useSWRInfinite<LocalizationScenePage, Error>(
    (pageIndex, previousPage) => {
      if (!projectId || !trackId || (pageIndex > 0 && !previousPage?.nextCursor)) return null;
      return [
        'localization-scenes',
        projectId,
        trackId,
        pageIndex === 0 ? null : previousPage?.nextCursor,
      ] as const;
    },
    ([, , , cursor]) =>
      listLocalizationScenes(request, projectId, trackId!, {
        cursor: typeof cursor === 'string' ? cursor : undefined,
        limit: SCENE_PAGE_LIMIT,
      }),
    {
      revalidateFirstPage: true,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );

  const scenes = useMemo(() => {
    const unique = new Map<string, LocalizationScene>();
    for (const page of swr.data ?? []) {
      for (const scene of page.data) unique.set(scene.id, scene);
    }
    return [...unique.values()].sort(
      (left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id),
    );
  }, [swr.data]);
  const lastPage = swr.data?.at(-1);
  const isLoadingMore = Boolean(
    swr.isLoading || (swr.size > 0 && swr.data && typeof swr.data[swr.size - 1] === 'undefined'),
  );

  return {
    ...swr,
    hasMore: Boolean(lastPage?.nextCursor),
    isLoadingMore,
    loadMore: () => swr.setSize((size) => size + 1),
    scenes,
    total: swr.data?.[0]?.total ?? 0,
  };
}

export function useLocalizationGlossary(
  projectId: string,
  trackId: string | null,
  enabled: boolean,
) {
  const { request } = useAuth();
  return useSWR<GlossaryPage, Error>(
    enabled && projectId && trackId ? ['localization-glossary', projectId, trackId] : null,
    () => listGlossary(request, projectId, trackId!),
    {
      dedupingInterval: 2_000,
      keepPreviousData: true,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );
}

export type HistoryResource =
  | { kind: 'scene'; id: string }
  | { kind: 'source'; id: string }
  | { kind: 'translation'; id: string }
  | { kind: 'glossary'; id: string };

export type LocalizationRevision =
  SceneRevision | SourceDialogueRevision | TranslationRevision | GlossaryRevision;

export function useLocalizationHistory(
  projectId: string,
  trackId: string | null,
  resource: HistoryResource | null,
) {
  const { request } = useAuth();
  const swr = useSWRInfinite<LocalizationHistoryPage<LocalizationRevision>, Error>(
    (pageIndex, previousPage) => {
      if (!projectId || !trackId || !resource || (pageIndex > 0 && !previousPage?.nextCursor)) {
        return null;
      }
      return [
        'localization-history',
        projectId,
        trackId,
        resource.kind,
        resource.id,
        pageIndex === 0 ? null : previousPage?.nextCursor,
      ] as const;
    },
    async ([, , , , , cursor]) => {
      if (!trackId || !resource) throw new Error('Revision history requires a resource.');
      const options = {
        cursor: typeof cursor === 'string' ? cursor : undefined,
        limit: HISTORY_PAGE_LIMIT,
      };
      switch (resource.kind) {
        case 'scene':
          return listSceneRevisions(request, projectId, trackId, resource.id, options);
        case 'source':
          return listSourceRevisions(request, projectId, trackId, resource.id, options);
        case 'translation':
          return listTranslationRevisions(request, projectId, trackId, resource.id, options);
        case 'glossary':
          return listGlossaryRevisions(request, projectId, trackId, resource.id, options);
      }
    },
    {
      revalidateFirstPage: true,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );

  const revisions = useMemo(() => {
    const unique = new Map<string, LocalizationRevision>();
    for (const page of swr.data ?? []) {
      for (const revision of page.data) unique.set(revision.id, revision);
    }
    return [...unique.values()].sort(
      (left, right) =>
        right.revisionNumber - left.revisionNumber || right.id.localeCompare(left.id),
    );
  }, [swr.data]);
  const lastPage = swr.data?.at(-1);

  return {
    ...swr,
    hasMore: Boolean(lastPage?.nextCursor),
    loadMore: () => swr.setSize((size) => size + 1),
    revisions,
    selectedRevisionId: swr.data?.[0]?.selectedRevisionId ?? null,
    selectionRevision: swr.data?.[0]?.selectionRevision ?? 0,
  };
}

export function localizationGenerationKey(
  projectId: string,
  trackId: string,
  generationId: string,
) {
  return ['localization-generation', projectId, trackId, generationId] as const;
}

export function useTranslationGeneration(
  projectId: string,
  trackId: string | null,
  generationId: string | null,
) {
  const { request } = useAuth();
  return useSWR<TranslationGeneration, Error>(
    projectId && trackId && generationId
      ? localizationGenerationKey(projectId, trackId, generationId)
      : null,
    () => getSceneGeneration(request, projectId, trackId!, generationId!),
    {
      dedupingInterval: 1_000,
      refreshInterval: (generation) =>
        generation && ['QUEUED', 'RUNNING'].includes(generation.status) ? 2_000 : 0,
      refreshWhenHidden: false,
      revalidateOnFocus: true,
      shouldRetryOnError: false,
    },
  );
}
