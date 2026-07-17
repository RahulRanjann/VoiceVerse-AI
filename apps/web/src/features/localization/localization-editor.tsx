'use client';

import {
  AlertCircleIcon,
  BookOpenIcon,
  CheckCircle2Icon,
  LanguagesIcon,
  RefreshCwIcon,
  SparklesIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useSWRConfig } from 'swr';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-provider';
import type { WorkflowJob } from '@/features/studio/types';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { createLocalizationTrack, createSceneGeneration } from './api';
import { GlossarySheet } from './glossary-sheet';
import { generationPresentation, hasLocalizationOutput } from './presentation';
import { SceneEditor } from './scene-editor';
import type { LocalizationScene, LocalizationTrack } from './types';
import {
  localizationGenerationKey,
  useLocalizationScenes,
  useLocalizationTracks,
  useTranslationGeneration,
} from './use-localization';

export function LocalizationEditor({ job }: { job: WorkflowJob }) {
  if (!hasLocalizationOutput(job) || !job.project) return null;
  return <ReadyLocalizationEditor key={job.id} job={job} project={job.project} />;
}

function ReadyLocalizationEditor({
  job,
  project,
}: {
  job: WorkflowJob;
  project: NonNullable<WorkflowJob['project']>;
}) {
  const { principal, request } = useAuth();
  const tracks = useLocalizationTracks(project.id);
  const [selectedTargetId, setSelectedTargetId] = useState(
    () => project.targetLanguages[0]?.id ?? '',
  );
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchConflict, setLaunchConflict] = useState(false);
  const canWrite = principal?.organization.role !== 'VIEWER';
  const trackByTarget = useMemo(
    () => new Map((tracks.data?.data ?? []).map((track) => [track.targetLanguage.id, track])),
    [tracks.data?.data],
  );
  const activeTrack = trackByTarget.get(selectedTargetId) ?? null;
  const selectedTarget = project.targetLanguages.find(({ id }) => id === selectedTargetId) ?? null;
  const targetItems = project.targetLanguages.map((language) => ({
    label: `${language.englishName}${trackByTarget.has(language.id) ? ' · Ready' : ' · Not opened'}`,
    value: language.id,
  }));

  async function launchTrack() {
    if (!canWrite || !selectedTarget) return;
    setLaunching(true);
    setLaunchError(null);
    setLaunchConflict(false);
    try {
      const track = await createLocalizationTrack(request, project.id, {
        speechAnalysisJobId: job.id,
        targetLanguageId: selectedTarget.id,
      });
      await tracks.mutate(
        (current) => ({
          data: [...(current?.data.filter((candidate) => candidate.id !== track.id) ?? []), track],
        }),
        { revalidate: false },
      );
      void tracks.mutate();
      toast.success(`${track.targetLanguage.englishName} editor opened.`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setLaunchConflict(true);
      else setLaunchError(error instanceof Error ? error.message : 'Could not open this language.');
    } finally {
      setLaunching(false);
    }
  }

  return (
    <section aria-labelledby="localization-title" className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle id="localization-title">Scene-aware translation</CardTitle>
          <CardDescription>
            Translate one bounded scene at a time while preserving timing and character identity.
          </CardDescription>
          {activeTrack ? (
            <CardAction>
              <Badge variant="success">Track ready</Badge>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {project.targetLanguages.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <LanguagesIcon />
                </EmptyMedia>
                <EmptyTitle>No target languages configured</EmptyTitle>
                <EmptyDescription>
                  Add a project target language before opening the translation editor.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <Field className="sm:max-w-sm">
                <FieldLabel htmlFor="localization-target">Target language</FieldLabel>
                <Select
                  items={targetItems}
                  value={selectedTargetId}
                  onValueChange={(value) => {
                    if (value) setSelectedTargetId(value);
                    setLaunchError(null);
                    setLaunchConflict(false);
                  }}
                >
                  <SelectTrigger id="localization-target" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {targetItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {!activeTrack ? (
                <Button disabled={!canWrite || launching} onClick={() => void launchTrack()}>
                  {launching ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <LanguagesIcon data-icon="inline-start" />
                  )}
                  Open language editor
                </Button>
              ) : null}
            </div>
          )}

          {tracks.isLoading && !tracks.data ? (
            <Skeleton className="h-10 w-full" />
          ) : tracks.error && !tracks.data ? (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>Translation tracks are unavailable</AlertTitle>
              <AlertDescription>
                Try loading the project tracks again.
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  onClick={() => void tracks.mutate()}
                >
                  <RefreshCwIcon data-icon="inline-start" />
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          {!activeTrack && selectedTarget && !tracks.isLoading && !tracks.error ? (
            <Alert>
              <AlertTitle>
                {canWrite ? `${selectedTarget.englishName} is ready to open` : 'No existing track'}
              </AlertTitle>
              <AlertDescription>
                {canWrite
                  ? 'Opening the editor creates stable scene boundaries from this committed analysis.'
                  : 'A viewer cannot create a language track. Ask an editor to open this target first.'}
              </AlertDescription>
            </Alert>
          ) : null}

          {launchConflict ? (
            <Alert variant="destructive">
              <AlertTitle>The localization workspace changed</AlertTitle>
              <AlertDescription>
                Reload the latest tracks before opening this language again.
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setLaunchConflict(false);
                    void tracks.mutate();
                  }}
                >
                  Reload latest
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {launchError ? (
            <Alert variant="destructive">
              <AlertTitle>Language editor could not be opened</AlertTitle>
              <AlertDescription>{launchError}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      {activeTrack ? (
        <LocalizationWorkspace
          key={activeTrack.id}
          canWrite={canWrite}
          projectId={project.id}
          track={activeTrack}
        />
      ) : null}
    </section>
  );
}

function LocalizationWorkspace({
  canWrite,
  projectId,
  track,
}: {
  canWrite: boolean;
  projectId: string;
  track: LocalizationTrack;
}) {
  const { request } = useAuth();
  const { mutate: mutateCache } = useSWRConfig();
  const scenes = useLocalizationScenes(projectId, track.id);
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [generationPending, setGenerationPending] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [generationConflict, setGenerationConflict] = useState(false);
  const finalizedGeneration = useRef<string | null>(null);
  const generationRequestKeys = useRef(new Map<string, string>());
  const generation = useTranslationGeneration(projectId, track.id, generationId);
  const activeScene =
    scenes.scenes.find((scene) => scene.id === selectedSceneId) ?? scenes.scenes[0] ?? null;
  const sceneItems = scenes.scenes.map((scene) => ({
    label: sceneLabel(scene),
    value: scene.id,
  }));
  const generationView = generation.data ? generationPresentation(generation.data.status) : null;
  const refreshScenes = scenes.mutate;
  const generationIsActive = generationView?.active ?? false;

  useEffect(() => {
    const value = generation.data;
    if (!value || generationIsActive || finalizedGeneration.current === value.id) return;
    finalizedGeneration.current = value.id;
    if (value.status === 'SUCCEEDED') {
      void refreshScenes();
      toast.success('Scene translation is ready to review.');
    } else {
      toast.error('Scene translation could not be generated.');
    }
  }, [generation.data, generationIsActive, refreshScenes]);

  async function generateScene() {
    if (!canWrite || !track.generationEnabled || !activeScene || generationView?.active) return;
    const requestKey = `${track.id}:${activeScene.id}`;
    let idempotencyKey = generationRequestKeys.current.get(requestKey);
    if (!idempotencyKey) {
      idempotencyKey = `web-${crypto.randomUUID()}`;
      generationRequestKeys.current.set(requestKey, idempotencyKey);
    }
    setGenerationPending(true);
    setGenerationError(null);
    setGenerationConflict(false);
    try {
      const created = await createSceneGeneration(
        request,
        projectId,
        track.id,
        activeScene.id,
        idempotencyKey,
      );
      generationRequestKeys.current.delete(requestKey);
      await mutateCache(localizationGenerationKey(projectId, track.id, created.id), created, {
        revalidate: false,
      });
      finalizedGeneration.current = null;
      setGenerationId(created.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setGenerationConflict(true);
      else {
        setGenerationError(
          error instanceof Error ? error.message : 'Could not start scene translation.',
        );
      }
    } finally {
      setGenerationPending(false);
    }
  }

  if (scenes.isLoading && scenes.scenes.length === 0) {
    return (
      <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]" aria-label="Loading scenes">
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-[36rem] w-full" />
      </div>
    );
  }

  if (scenes.error && scenes.scenes.length === 0) {
    return (
      <Alert variant="destructive">
        <AlertCircleIcon />
        <AlertTitle>Scenes are unavailable</AlertTitle>
        <AlertDescription>
          The language track is safe, but its scene page could not be loaded.
          <Button className="mt-3" size="sm" variant="outline" onClick={() => void scenes.mutate()}>
            <RefreshCwIcon data-icon="inline-start" />
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!activeScene) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LanguagesIcon />
          </EmptyMedia>
          <EmptyTitle>No scenes in this track</EmptyTitle>
          <EmptyDescription>
            The committed speech analysis did not produce editable dialogue scenes.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>{track.targetLanguage.englishName} translation</CardTitle>
          <CardDescription>
            {track.sourceLanguage.englishName} → {track.targetLanguage.englishName} · {scenes.total}{' '}
            {scenes.total === 1 ? 'scene' : 'scenes'}
          </CardDescription>
          <CardAction className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setGlossaryOpen(true)}>
              <BookOpenIcon data-icon="inline-start" />
              Glossary
            </Button>
            <Button
              size="sm"
              disabled={
                !canWrite ||
                !track.generationEnabled ||
                generationPending ||
                Boolean(generationView?.active)
              }
              onClick={() => void generateScene()}
            >
              {generationPending || generationView?.active ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <SparklesIcon data-icon="inline-start" />
              )}
              Generate scene
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!track.generationEnabled ? (
            <Alert>
              <AlertTitle>Automatic translation is disabled</AlertTitle>
              <AlertDescription>
                Manual source, target, scene, and glossary editing remain available. Generation is
                fail-closed until a translation provider is enabled.
              </AlertDescription>
            </Alert>
          ) : null}
          {generationView && generation.data?.sceneId === activeScene.id ? (
            <Alert variant={generationView.tone === 'destructive' ? 'destructive' : 'default'}>
              {generation.data.status === 'SUCCEEDED' ? <CheckCircle2Icon /> : <SparklesIcon />}
              <AlertTitle>{generationView.label}</AlertTitle>
              <AlertDescription>
                {generationView.description}
                {generation.data.status === 'FAILED' ? (
                  <Button
                    className="mt-3"
                    size="sm"
                    variant="outline"
                    disabled={!canWrite}
                    onClick={() => void generateScene()}
                  >
                    Retry generation
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
          {generationView && generation.data?.sceneId !== activeScene.id && generationIsActive ? (
            <Alert>
              <SparklesIcon />
              <AlertTitle>Another scene is generating</AlertTitle>
              <AlertDescription>
                Wait for the active generation to finish, or return to that scene to follow its
                status.
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  onClick={() => setSelectedSceneId(generation.data!.sceneId)}
                >
                  View generating scene
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {generation.error ? (
            <Alert variant="destructive">
              <AlertTitle>Generation status is unavailable</AlertTitle>
              <AlertDescription>
                The request may still be processing. Retry the status check before starting another
                generation.
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  onClick={() => void generation.mutate()}
                >
                  Check status again
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {generationConflict ? (
            <Alert variant="destructive">
              <AlertTitle>Generation could not start</AlertTitle>
              <AlertDescription>
                The provider may be disabled or the scene selection changed. Reload the latest
                scene, then try again.
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    generationRequestKeys.current.delete(`${track.id}:${activeScene.id}`);
                    setGenerationConflict(false);
                    void scenes.mutate();
                  }}
                >
                  Reload latest
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {generationError ? (
            <Alert variant="destructive">
              <AlertTitle>Generation request failed</AlertTitle>
              <AlertDescription>
                {generationError}
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  disabled={!canWrite || generationPending}
                  onClick={() => void generateScene()}
                >
                  {generationPending ? <Spinner data-icon="inline-start" /> : null}
                  Retry request
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <div className="lg:hidden">
        <div className="flex flex-col gap-2">
          <Field>
            <FieldLabel htmlFor="mobile-scene-selector">Scene</FieldLabel>
            <Select
              items={sceneItems}
              value={activeScene.id}
              onValueChange={(value) => value && setSelectedSceneId(value)}
            >
              <SelectTrigger id="mobile-scene-selector" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {sceneItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          {scenes.hasMore ? (
            <Button
              size="sm"
              variant="outline"
              disabled={scenes.isLoadingMore}
              onClick={() => void scenes.loadMore()}
            >
              {scenes.isLoadingMore ? <Spinner data-icon="inline-start" /> : null}
              Load more scenes
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <Card className="sticky top-20 hidden max-h-[calc(100vh-6rem)] lg:flex">
          <CardHeader>
            <CardTitle>Scenes</CardTitle>
            <CardDescription>
              {scenes.scenes.length} of {scenes.total} loaded
            </CardDescription>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-col gap-1 overflow-y-auto">
            <nav aria-label="Translation scenes" className="flex flex-col gap-1">
              {scenes.scenes.map((scene) => (
                <button
                  key={scene.id}
                  type="button"
                  aria-current={scene.id === activeScene.id ? 'page' : undefined}
                  className={cn(
                    'rounded-lg px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                    scene.id === activeScene.id
                      ? 'bg-primary text-primary-foreground'
                      : 'hover:bg-muted',
                  )}
                  onClick={() => setSelectedSceneId(scene.id)}
                >
                  <span className="block truncate font-medium">{sceneLabel(scene)}</span>
                  <span
                    className={cn(
                      'mt-0.5 block text-xs',
                      scene.id === activeScene.id
                        ? 'text-primary-foreground/75'
                        : 'text-muted-foreground',
                    )}
                  >
                    {scene.dialogues.length} {scene.dialogues.length === 1 ? 'line' : 'lines'}
                  </span>
                </button>
              ))}
            </nav>
            {scenes.hasMore ? (
              <Button
                className="mt-2"
                size="sm"
                variant="outline"
                disabled={scenes.isLoadingMore}
                onClick={() => void scenes.loadMore()}
              >
                {scenes.isLoadingMore ? <Spinner data-icon="inline-start" /> : null}
                Load more scenes
              </Button>
            ) : null}
          </CardContent>
        </Card>

        <SceneEditor
          key={activeScene.id}
          canWrite={canWrite}
          onRefresh={refreshScenes}
          projectId={projectId}
          scene={activeScene}
          track={track}
        />
      </div>

      <GlossarySheet
        canWrite={canWrite}
        onOpenChange={setGlossaryOpen}
        open={glossaryOpen}
        projectId={projectId}
        trackId={track.id}
      />
    </div>
  );
}

function sceneLabel(scene: LocalizationScene): string {
  return scene.revision.title?.trim() || `Scene ${scene.ordinal}`;
}
