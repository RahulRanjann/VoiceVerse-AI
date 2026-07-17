'use client';

import { HistoryIcon, RotateCcwIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/features/auth/auth-provider';
import {
  selectGlossaryRevision,
  selectSceneRevision,
  selectSourceRevision,
  selectTranslationRevision,
} from './api';
import type { HistoryResource, LocalizationRevision } from './use-localization';
import { useLocalizationHistory } from './use-localization';

interface RevisionHistoryDialogProps {
  canWrite: boolean;
  onOpenChange(open: boolean): void;
  onRestored(): Promise<unknown> | unknown;
  open: boolean;
  projectId: string;
  resource: HistoryResource | null;
  trackId: string;
}

export function RevisionHistoryDialog({
  canWrite,
  onOpenChange,
  onRestored,
  open,
  projectId,
  resource,
  trackId,
}: RevisionHistoryDialogProps) {
  const { request } = useAuth();
  const history = useLocalizationHistory(projectId, trackId, open ? resource : null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function restore(revision: LocalizationRevision) {
    if (!resource || !canWrite || revision.id === history.selectedRevisionId) return;
    setRestoringId(revision.id);
    setConflict(false);
    setErrorMessage(null);
    const input = {
      expectedRevision: history.selectionRevision,
      revisionId: revision.id,
    };
    try {
      switch (resource.kind) {
        case 'scene':
          await selectSceneRevision(request, projectId, trackId, resource.id, input);
          break;
        case 'source':
          await selectSourceRevision(request, projectId, trackId, resource.id, input);
          break;
        case 'translation':
          await selectTranslationRevision(request, projectId, trackId, resource.id, input);
          break;
        case 'glossary':
          await selectGlossaryRevision(request, projectId, trackId, resource.id, input);
          break;
      }
      await Promise.all([history.mutate(), onRestored()]);
      toast.success('Older revision restored.');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
      } else {
        setErrorMessage(
          error instanceof Error ? error.message : 'Could not restore this revision.',
        );
      }
    } finally {
      setRestoringId(null);
    }
  }

  const title = resource ? historyTitle(resource.kind) : 'Revision history';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(48rem,calc(100vh-2rem))] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Revisions are immutable. Restoring one moves the active selection without deleting newer
            work.
          </DialogDescription>
        </DialogHeader>

        {!canWrite ? (
          <Alert>
            <AlertTitle>Read-only history</AlertTitle>
            <AlertDescription>
              Viewers can inspect revisions, but only editors can change the active selection.
            </AlertDescription>
          </Alert>
        ) : null}

        {conflict ? (
          <Alert variant="destructive">
            <AlertTitle>Another edit changed the active revision</AlertTitle>
            <AlertDescription>
              Reload the latest history before choosing a revision again.
              <Button
                className="mt-3"
                size="sm"
                variant="outline"
                onClick={() => {
                  setConflict(false);
                  void history.mutate();
                  void onRestored();
                }}
              >
                Reload latest
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>Revision could not be restored</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        {history.isLoading && history.revisions.length === 0 ? (
          <div className="flex flex-col gap-3" aria-label="Loading revision history">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : history.error && history.revisions.length === 0 ? (
          <Alert variant="destructive">
            <AlertTitle>History is unavailable</AlertTitle>
            <AlertDescription>
              Try loading the revision history again.
              <Button
                className="mt-3"
                size="sm"
                variant="outline"
                onClick={() => void history.mutate()}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : history.revisions.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HistoryIcon />
              </EmptyMedia>
              <EmptyTitle>No revisions yet</EmptyTitle>
              <EmptyDescription>The first saved revision will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ol className="flex flex-col gap-3">
            {history.revisions.map((revision) => {
              const selected = revision.id === history.selectedRevisionId;
              return (
                <li key={revision.id} className="rounded-xl border bg-card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">Revision {revision.revisionNumber}</span>
                        {selected ? <Badge variant="secondary">Active</Badge> : null}
                      </div>
                      {revision.createdAt ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {formatRevisionDate(revision.createdAt)}
                        </p>
                      ) : null}
                    </div>
                    {!selected ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canWrite || restoringId !== null}
                        onClick={() => void restore(revision)}
                      >
                        {restoringId === revision.id ? (
                          <Spinner data-icon="inline-start" />
                        ) : (
                          <RotateCcwIcon data-icon="inline-start" />
                        )}
                        Restore
                      </Button>
                    ) : null}
                  </div>
                  <Separator className="my-3" />
                  <RevisionPreview resource={resource} revision={revision} />
                </li>
              );
            })}
          </ol>
        )}

        {history.hasMore ? (
          <Button
            variant="outline"
            disabled={history.isValidating}
            onClick={() => void history.loadMore()}
          >
            {history.isValidating ? <Spinner data-icon="inline-start" /> : null}
            Load older revisions
          </Button>
        ) : null}

        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

function RevisionPreview({
  resource,
  revision,
}: {
  resource: HistoryResource | null;
  revision: LocalizationRevision;
}) {
  if (!resource) return null;
  switch (resource.kind) {
    case 'scene': {
      const scene = revision as Extract<LocalizationRevision, { sceneId?: string }>;
      const value = scene as import('./types').SceneRevision;
      return (
        <div className="flex flex-col gap-1 text-sm">
          <p className="font-medium">{value.title || 'Untitled scene'}</p>
          <p className="line-clamp-3 text-muted-foreground">
            {value.narrative || 'No narrative context.'}
          </p>
          {value.culturalNotes ? (
            <p className="line-clamp-2 text-muted-foreground">{value.culturalNotes}</p>
          ) : null}
        </div>
      );
    }
    case 'source':
      return (
        <p className="line-clamp-4 whitespace-pre-wrap">
          {(revision as import('./types').SourceDialogueRevision).sourceText}
        </p>
      );
    case 'translation':
      return (
        <p className="line-clamp-4 whitespace-pre-wrap">
          {(revision as import('./types').TranslationRevision).targetText}
        </p>
      );
    case 'glossary': {
      const entry = revision as import('./types').GlossaryRevision;
      return (
        <div className="flex flex-col gap-1 text-sm">
          <p className="font-medium">
            {entry.sourceTerm} → {entry.doNotTranslate ? 'Do not translate' : entry.targetTerm}
          </p>
          {entry.notes ? <p className="text-muted-foreground">{entry.notes}</p> : null}
        </div>
      );
    }
  }
}

function historyTitle(kind: HistoryResource['kind']): string {
  return {
    glossary: 'Glossary history',
    scene: 'Scene history',
    source: 'Source dialogue history',
    translation: 'Translation history',
  }[kind];
}

function formatRevisionDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Saved revision';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}
