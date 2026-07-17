'use client';

import { AlertCircleIcon, ArrowLeftIcon, RefreshCwIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { LocalizationEditor } from '@/features/localization/localization-editor';
import { CharacterSummary } from './character-summary';
import { DialogueSegmentPreview } from './dialogue-segment-preview';
import { failurePresentation, formatDuration } from './speech-analysis-presentation';
import { StudioMobileNavigation, StudioShell } from './studio-shell';
import { useCharacterResults, useDialogueResults } from './use-analysis-results';
import { useWorkflowJob } from './use-workflow-job';
import { WorkflowStageList } from './workflow-stage-list';
import { workflowProgressPresentation } from './workflow-presentation';

export function SpeechAnalysisOverview({ jobId }: { jobId: string }) {
  // These resources begin independently. The job-scoped result routes carry a
  // revision so the UI can preserve a coherent snapshot without a waterfall.
  const jobState = useWorkflowJob(jobId);
  const characterState = useCharacterResults(jobId);
  const dialogueState = useDialogueResults(jobId);
  const resultSignature = useRef<string | undefined>(undefined);

  const job = jobState.data;
  const summary = job?.resultSummary;

  useEffect(() => {
    if (!summary) return;
    const signature = [
      summary.characters.availability,
      summary.transcript.availability,
      job?.revision,
    ].join(':');
    if (!resultSignature.current) {
      resultSignature.current = signature;
      return;
    }
    if (resultSignature.current === signature) return;
    resultSignature.current = signature;
    void characterState.mutate();
    void dialogueState.mutate();
  }, [characterState, dialogueState, job?.revision, summary]);

  return (
    <StudioShell>
      <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur-sm md:px-7">
        <StudioMobileNavigation />
        <Button nativeButton={false} variant="ghost" size="sm" render={<Link href="/" />}>
          <ArrowLeftIcon data-icon="inline-start" />
          Back to projects
        </Button>
      </header>

      <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-7 sm:px-6 md:px-8 md:py-10">
        {!job && jobState.isLoading ? (
          <OverviewSkeleton />
        ) : !job ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>Analysis is unavailable</AlertTitle>
            <AlertDescription>
              We could not load this workflow. Check the project and try again.
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void jobState.mutate()}
              >
                <RefreshCwIcon data-icon="inline-start" />
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <AnalysisContent
            job={job}
            isRefreshing={jobState.isValidating}
            hasRefreshError={Boolean(jobState.error)}
            characterState={characterState}
            dialogueState={dialogueState}
          />
        )}
      </main>
    </StudioShell>
  );
}

interface AnalysisContentProps {
  job: NonNullable<ReturnType<typeof useWorkflowJob>['data']>;
  isRefreshing: boolean;
  hasRefreshError: boolean;
  characterState: ReturnType<typeof useCharacterResults>;
  dialogueState: ReturnType<typeof useDialogueResults>;
}

function AnalysisContent({
  characterState,
  dialogueState,
  hasRefreshError,
  isRefreshing,
  job,
}: AnalysisContentProps) {
  const progress = workflowProgressPresentation(job);
  const failure = failurePresentation(job.failure);
  const projectName = job.project?.name ?? 'Movie workflow';
  const sourceLanguage = job.project?.sourceLanguage.englishName;
  const targets = job.project?.targetLanguages.map(({ englishName }) => englishName).join(', ');
  const heading = job.kind === 'SPEECH_ANALYSIS' ? 'Speech analysis' : 'Workflow progress';
  const badgeVariant = {
    destructive: 'destructive' as const,
    muted: 'outline' as const,
    success: 'success' as const,
    warning: 'warning' as const,
  }[progress.tone];
  const toneClass = {
    destructive: '[&_[data-slot=progress-indicator]]:bg-destructive',
    muted: '[&_[data-slot=progress-indicator]]:bg-muted-foreground',
    success: '[&_[data-slot=progress-indicator]]:bg-success',
    warning: '[&_[data-slot=progress-indicator]]:bg-warning',
  }[progress.tone];

  return (
    <>
      <section className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-primary">{heading}</p>
          <h1 className="mt-1 truncate text-3xl font-semibold tracking-tight sm:text-4xl">
            {projectName}
          </h1>
          {sourceLanguage && (
            <p className="mt-2 text-sm text-muted-foreground">
              {sourceLanguage}
              {targets ? ` → ${targets}` : ''}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2" aria-live="polite">
          {isRefreshing && <span className="sr-only">Refreshing workflow progress</span>}
          <Badge variant={badgeVariant}>{progress.label}</Badge>
        </div>
      </section>

      {hasRefreshError && (
        <Alert>
          <AlertTitle>Showing the last known progress</AlertTitle>
          <AlertDescription>
            Live updates are temporarily unavailable. Your saved workflow data is unchanged.
          </AlertDescription>
        </Alert>
      )}

      {job.status === 'FAILED' && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription>{failure.description}</AlertDescription>
        </Alert>
      )}

      <section
        aria-labelledby="overall-progress-title"
        className="rounded-2xl border bg-card p-5 sm:p-6"
      >
        <Progress
          value={progress.percent}
          className={cn('gap-x-4 gap-y-3', toneClass)}
          aria-label={`${progress.label}: ${progress.percent}%`}
        >
          <ProgressLabel id="overall-progress-title">Overall progress</ProgressLabel>
          <ProgressValue>
            {(_formattedValue, value) => `${value ?? progress.percent}%`}
          </ProgressValue>
        </Progress>
        {job.resultSummary && (
          <dl className="mt-6 grid grid-cols-2 gap-4 border-t pt-5 sm:max-w-xl sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Dialogue lines</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums">
                {job.resultSummary.transcript.segmentCount}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Characters</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums">
                {job.resultSummary.characters.count}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Transcribed</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums">
                {formatDuration(job.resultSummary.transcript.transcribedDurationMs)}
              </dd>
            </div>
          </dl>
        )}
      </section>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(19rem,0.75fr)]">
        <WorkflowStageList stages={job.stages} />
        <CharacterSummary
          availability={job.resultSummary?.characters.availability}
          error={characterState.error}
          isLoading={characterState.isLoading}
          page={characterState.data}
        />
      </div>

      <DialogueSegmentPreview
        availability={dialogueState.availability ?? job.resultSummary?.transcript.availability}
        error={dialogueState.error}
        hasMore={dialogueState.hasMore}
        isLoading={dialogueState.isLoading}
        isLoadingMore={dialogueState.isLoadingMore}
        loadMore={() => void dialogueState.loadMore()}
        segments={dialogueState.segments}
        totalCount={dialogueState.totalCount}
      />

      <LocalizationEditor job={job} />
    </>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6" aria-label="Loading analysis overview">
      <div className="space-y-3">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-10 w-72 max-w-full" />
        <Skeleton className="h-4 w-48" />
      </div>
      <Skeleton className="h-36 w-full rounded-2xl" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-96 w-full rounded-2xl" />
        <Skeleton className="h-96 w-full rounded-2xl" />
      </div>
    </div>
  );
}
