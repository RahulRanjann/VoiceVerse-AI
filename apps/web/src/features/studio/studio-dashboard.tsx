'use client';

import {
  BellIcon,
  CircleHelpIcon,
  ClapperboardIcon,
  CloudUploadIcon,
  FolderIcon,
  LanguagesIcon,
  SearchIcon,
  SparklesIcon,
  UploadCloudIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuth } from '@/features/auth/auth-provider';
import { UploadDialog } from '@/features/uploads/upload-dialog';
import { cn } from '@/lib/utils';
import { listProjects } from './api';
import { StudioMobileNavigation, StudioShell } from './studio-shell';
import type { LanguageOption, LatestWorkflowJob, ProjectSummary } from './types';
import { isActiveWorkflowJob, workflowProgressPresentation } from './workflow-presentation';

type DashboardRequest = ReturnType<typeof useAuth>['request'];

async function fetchDashboardData(request: DashboardRequest) {
  const [languages, projectPage] = await Promise.all([
    request<LanguageOption[]>('/languages'),
    listProjects(request),
  ]);
  return { languages, projects: projectPage.data };
}

const ACTIVE_JOB_POLL_INTERVAL_MS = 5_000;

export function StudioDashboard() {
  const { principal, request } = useAuth();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [languages, setLanguages] = useState<LanguageOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);

  const reloadDashboard = useCallback(async () => {
    setLoadError(undefined);
    setLoading(true);
    try {
      const data = await fetchDashboardData(request);
      setLanguages(data.languages);
      setProjects(data.projects);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'The studio could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    let active = true;
    void fetchDashboardData(request)
      .then((data) => {
        if (!active) return;
        setLanguages(data.languages);
        setProjects(data.projects);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : 'The studio could not be loaded.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [request]);

  const hasActiveJob = projects.some((project) => isActiveWorkflowJob(project.latestJob));

  useEffect(() => {
    if (!hasActiveJob) return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const pollProjects = async () => {
      try {
        const page = await listProjects(request);
        if (disposed) return;
        setProjects(page.data);
        if (page.data.some((project) => isActiveWorkflowJob(project.latestJob))) {
          timer = setTimeout(() => void pollProjects(), ACTIVE_JOB_POLL_INTERVAL_MS);
        }
      } catch {
        // Preserve the last known durable state during transient control-plane
        // failures. The next bounded poll can recover without disrupting editing.
        if (!disposed) {
          timer = setTimeout(() => void pollProjects(), ACTIVE_JOB_POLL_INTERVAL_MS);
        }
      }
    };

    timer = setTimeout(() => void pollProjects(), ACTIVE_JOB_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [hasActiveJob, request]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);

  const visibleProjects = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((project) => {
      const languageText = [
        project.sourceLanguage.englishName,
        ...project.targetLanguages.map((language) => language.englishName),
      ].join(' ');
      return `${project.name} ${languageText}`.toLowerCase().includes(query);
    });
  }, [projects, search]);

  if (!principal) return null;

  return (
    <StudioShell onUpload={() => setUploadOpen(true)}>
      <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur-sm md:px-7">
        <StudioMobileNavigation onUpload={() => setUploadOpen(true)} />
        <div className="relative mx-auto w-full max-w-xl">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            ref={searchInput}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-10 bg-card pl-9 pr-14"
            placeholder="Search projects"
            aria-label="Search projects"
          />
          <Kbd className="absolute right-2.5 top-1/2 -translate-y-1/2">⌘ K</Kbd>
        </div>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon" aria-label="Help" />}>
            <CircleHelpIcon />
          </TooltipTrigger>
          <TooltipContent>Use ⌘ K to search projects.</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Notifications"
                className="hidden sm:inline-flex"
                onClick={() => toast('No new notifications.')}
              />
            }
          >
            <BellIcon />
          </TooltipTrigger>
          <TooltipContent>No new notifications</TooltipContent>
        </Tooltip>
        <Button className="hidden sm:inline-flex" onClick={() => setUploadOpen(true)}>
          <CloudUploadIcon data-icon="inline-start" />
          Upload movie
        </Button>
      </header>

      <main className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-7 sm:px-6 md:px-8 md:py-10">
        <section className="flex flex-col gap-2">
          <p className="text-sm font-medium text-primary">{principal.organization.displayName}</p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Your dubbing studio</h1>
          <p className="max-w-2xl text-base text-muted-foreground">
            Create natural, character-consistent versions of every story.
          </p>
        </section>

        <section className="flex flex-col gap-5 rounded-2xl border bg-card p-5 sm:flex-row sm:items-center sm:p-6">
          <div className="grid size-14 shrink-0 place-items-center rounded-xl border bg-primary/8 text-primary">
            <ClapperboardIcon aria-hidden="true" className="size-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold">Bring a new story to life</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Upload an MP4 to begin a secure, resumable dubbing project.
            </p>
          </div>
          <Button onClick={() => setUploadOpen(true)}>
            <UploadCloudIcon data-icon="inline-start" />
            Upload movie
          </Button>
        </section>

        <section id="recent-projects" className="flex scroll-mt-24 flex-col gap-4">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold tracking-tight">Recent projects</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Continue a translation, review a clean source, or resume an upload.
              </p>
            </div>
            {!loading && projects.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {projects.length} {projects.length === 1 ? 'project' : 'projects'}
              </span>
            )}
          </div>

          {loadError ? (
            <Alert variant="destructive">
              <AlertTitle>Studio data is unavailable</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                <span>{loadError}</span>
                <Button variant="outline" size="sm" onClick={() => void reloadDashboard()}>
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : loading ? (
            <ProjectListSkeleton />
          ) : visibleProjects.length === 0 ? (
            <Empty className="min-h-64 border bg-card">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderIcon />
                </EmptyMedia>
                <EmptyTitle>{search ? 'No matching projects' : 'No projects yet'}</EmptyTitle>
                <EmptyDescription>
                  {search
                    ? 'Try another project name or language.'
                    : 'Upload your first movie to create a secure dubbing project.'}
                </EmptyDescription>
              </EmptyHeader>
              {!search && (
                <EmptyContent>
                  <Button onClick={() => setUploadOpen(true)}>Upload movie</Button>
                </EmptyContent>
              )}
            </Empty>
          ) : (
            <ProjectList projects={visibleProjects} />
          )}
        </section>
      </main>
      <UploadDialog
        languages={languages}
        onCompleted={reloadDashboard}
        onOpenChange={setUploadOpen}
        open={uploadOpen}
      />
    </StudioShell>
  );
}

function ProjectList({ projects }: { projects: ProjectSummary[] }) {
  return (
    <>
      <div className="hidden overflow-hidden rounded-2xl border bg-card md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Project</TableHead>
              <TableHead>Languages</TableHead>
              <TableHead>Last updated</TableHead>
              <TableHead>Pipeline progress</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.map((project) => (
              <TableRow key={project.id}>
                <TableCell>
                  <Link
                    href={project.latestJob ? `/jobs/${project.latestJob.id}` : '/'}
                    className="flex items-center gap-3 rounded-md outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ProjectMark name={project.name} />
                    <span className="font-medium">{project.name}</span>
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">{languagePair(project)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {formatUpdatedAt(project.updatedAt)}
                </TableCell>
                <TableCell className="w-56">
                  <PreparationProgress job={project.latestJob} />
                </TableCell>
                <TableCell>
                  <ProjectStatusBadge project={project} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="grid gap-3 md:hidden">
        {projects.map((project) => (
          <article key={project.id} className="flex gap-3 rounded-xl border bg-card p-4">
            <ProjectMark name={project.name} />
            <div className="min-w-0 flex-1">
              <h3 className="truncate font-medium">
                <Link
                  href={project.latestJob ? `/jobs/${project.latestJob.id}` : '/'}
                  className="rounded-sm outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {project.name}
                </Link>
              </h3>
              <p className="mt-1 truncate text-sm text-muted-foreground">{languagePair(project)}</p>
              <div className="mt-3">
                <PreparationProgress job={project.latestJob} />
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <ProjectStatusBadge project={project} />
                <span className="text-xs text-muted-foreground">
                  {formatUpdatedAt(project.updatedAt)}
                </span>
              </div>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

function ProjectStatusBadge({ project }: { project: ProjectSummary }) {
  const security = project.latestVideo?.securityStatus;
  if (security === 'INFECTED') return <Badge variant="destructive">Quarantined</Badge>;
  if (security === 'ERROR') return <Badge variant="destructive">Scan needs attention</Badge>;
  if (security === 'SCANNING' || security === 'PENDING') {
    return <Badge variant="warning">Security scan</Badge>;
  }
  if (project.latestVideo?.ingestStatus === 'UPLOADING') {
    return <Badge variant="warning">Uploading</Badge>;
  }
  const states = {
    ARCHIVED: { label: 'Archived', variant: 'outline' as const },
    DRAFT: { label: 'Draft', variant: 'outline' as const },
    FAILED: { label: 'Needs attention', variant: 'destructive' as const },
    INGESTING: { label: 'Secure ingest', variant: 'warning' as const },
    PROCESSING: {
      label:
        project.latestJob?.kind === 'SPEECH_ANALYSIS' ? 'Analyzing dialogue' : 'Preparing media',
      variant: 'warning' as const,
    },
    READY: { label: 'Ready for review', variant: 'success' as const },
  };
  const state = states[project.status];
  return <Badge variant={state.variant}>{state.label}</Badge>;
}

function PreparationProgress({ job }: { job: LatestWorkflowJob | null }) {
  if (!job) {
    return <span className="text-xs text-muted-foreground">Not started</span>;
  }

  const state = workflowProgressPresentation(job);
  const toneClass = {
    destructive: 'text-destructive [&_[data-slot=progress-indicator]]:bg-destructive',
    muted: 'text-muted-foreground [&_[data-slot=progress-indicator]]:bg-muted-foreground',
    success: 'text-success [&_[data-slot=progress-indicator]]:bg-success',
    warning: 'text-warning [&_[data-slot=progress-indicator]]:bg-warning',
  }[state.tone];

  return (
    <div className="flex min-w-36 max-w-52 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className={cn('truncate font-medium', toneClass)}>{state.label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{state.percent}%</span>
      </div>
      <Progress
        aria-label={`${state.label}: ${state.percent}%`}
        className={cn('gap-0', toneClass)}
        value={state.percent}
      />
    </div>
  );
}

function ProjectListSkeleton() {
  return (
    <div
      className="flex flex-col gap-3 rounded-2xl border bg-card p-4"
      aria-label="Loading projects"
    >
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="flex items-center gap-4 py-2">
          <Skeleton className="size-12 rounded-lg" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="ml-auto h-5 w-24" />
        </div>
      ))}
    </div>
  );
}

function ProjectMark({ name }: { name: string }) {
  const motifs = [ClapperboardIcon, LanguagesIcon, SparklesIcon];
  const Icon = motifs[name.codePointAt(0)! % motifs.length] ?? ClapperboardIcon;
  return (
    <span className="grid size-12 shrink-0 place-items-center rounded-lg border bg-surface text-primary">
      <Icon aria-hidden="true" className="size-5" />
    </span>
  );
}

function languagePair(project: ProjectSummary): string {
  const targets = project.targetLanguages.map((language) => language.englishName).join(', ');
  return `${project.sourceLanguage.englishName} → ${targets}`;
}

function formatUpdatedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
}
