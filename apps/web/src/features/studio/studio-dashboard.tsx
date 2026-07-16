'use client';

import {
  BellIcon,
  ChevronDownIcon,
  CircleHelpIcon,
  ClapperboardIcon,
  CloudUploadIcon,
  FolderIcon,
  HomeIcon,
  LanguagesIcon,
  LogOutIcon,
  MenuIcon,
  Mic2Icon,
  SearchIcon,
  SparklesIcon,
  UploadCloudIcon,
  UsersIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
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
import type { LanguageOption, ProjectPage, ProjectSummary } from './types';

type DashboardRequest = ReturnType<typeof useAuth>['request'];

async function fetchDashboardData(request: DashboardRequest) {
  const [languages, projectPage] = await Promise.all([
    request<LanguageOption[]>('/languages'),
    request<ProjectPage>('/projects?limit=25'),
  ]);
  return { languages, projects: projectPage.data };
}

export function StudioDashboard() {
  const { logout, principal, request } = useAuth();
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
    <div className="min-h-screen bg-background text-foreground">
      <DesktopSidebar
        displayName={principal.user.displayName ?? principal.user.email}
        email={principal.user.email}
        organizationName={principal.organization.displayName}
        role={principal.organization.role}
        avatarUrl={principal.user.avatarUrl}
        onLogout={() => void logout()}
        onUpload={() => setUploadOpen(true)}
      />

      <div className="md:pl-60">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur-sm md:px-7">
          <MobileNavigation
            displayName={principal.user.displayName ?? principal.user.email}
            organizationName={principal.organization.displayName}
            onLogout={() => void logout()}
            onUpload={() => setUploadOpen(true)}
          />
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
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Your dubbing studio
            </h1>
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
      </div>

      <UploadDialog
        languages={languages}
        onCompleted={reloadDashboard}
        onOpenChange={setUploadOpen}
        open={uploadOpen}
      />
    </div>
  );
}

interface NavigationProps {
  displayName: string;
  organizationName: string;
  onLogout(): void;
  onUpload(): void;
}

function DesktopSidebar(
  props: NavigationProps & {
    avatarUrl: string | null;
    email: string;
    role: string;
  },
) {
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-sidebar-border bg-sidebar md:flex">
      <div className="flex h-16 items-center gap-3 px-5">
        <BrandMark />
        <span className="text-lg font-semibold tracking-tight">VoiceVerse</span>
      </div>
      <NavigationItems onUpload={props.onUpload} />
      <div className="mt-auto flex flex-col gap-3 p-3">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" className="h-auto w-full justify-between px-3 py-2.5" />
            }
          >
            <span className="flex min-w-0 items-center gap-2">
              <ClapperboardIcon />
              <span className="truncate">{props.organizationName}</span>
            </span>
            <ChevronDownIcon data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-56">
            <DropdownMenuLabel>Active workspace</DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuItem>
                <ClapperboardIcon />
                {props.organizationName}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Separator />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" className="h-auto w-full justify-between px-2 py-2" />}
          >
            <span className="flex min-w-0 items-center gap-2.5 text-left">
              <Avatar>
                {props.avatarUrl && <AvatarImage src={props.avatarUrl} alt="" />}
                <AvatarFallback>{initials(props.displayName)}</AvatarFallback>
              </Avatar>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{props.displayName}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {titleCase(props.role)}
                </span>
              </span>
            </span>
            <ChevronDownIcon data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-60">
            <DropdownMenuLabel className="truncate">{props.email}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={props.onLogout}>
                <LogOutIcon />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}

function NavigationItems({ onUpload }: Pick<NavigationProps, 'onUpload'>) {
  const baseClass =
    'flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors [&_svg]:size-4';
  return (
    <nav aria-label="Studio navigation" className="flex flex-col gap-1 px-3 py-3">
      <a
        href="#"
        aria-current="page"
        className={cn(baseClass, 'bg-sidebar-accent text-sidebar-accent-foreground')}
      >
        <HomeIcon aria-hidden="true" />
        Home
      </a>
      <a
        href="#recent-projects"
        className={cn(baseClass, 'text-sidebar-foreground/70 hover:bg-sidebar-accent')}
      >
        <FolderIcon aria-hidden="true" />
        Projects
      </a>
      <button
        type="button"
        className={cn(baseClass, 'text-sidebar-foreground/70 hover:bg-sidebar-accent')}
        onClick={onUpload}
      >
        <UploadCloudIcon aria-hidden="true" />
        Uploads
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-disabled="true"
              className={cn(baseClass, 'cursor-not-allowed text-sidebar-foreground/35')}
            />
          }
        >
          <UsersIcon aria-hidden="true" />
          Characters
        </TooltipTrigger>
        <TooltipContent side="right">Available with character memory.</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-disabled="true"
              className={cn(baseClass, 'cursor-not-allowed text-sidebar-foreground/35')}
            />
          }
        >
          <Mic2Icon aria-hidden="true" />
          Voices
        </TooltipTrigger>
        <TooltipContent side="right">Available with the voice engine.</TooltipContent>
      </Tooltip>
    </nav>
  );
}

function MobileNavigation(props: NavigationProps) {
  return (
    <Sheet>
      <SheetTrigger render={<Button variant="ghost" size="icon" className="md:hidden" />}>
        <MenuIcon />
        <span className="sr-only">Open navigation</span>
      </SheetTrigger>
      <SheetContent side="left" className="w-72">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-3">
            <BrandMark /> VoiceVerse
          </SheetTitle>
          <SheetDescription>{props.organizationName}</SheetDescription>
        </SheetHeader>
        <NavigationItems onUpload={props.onUpload} />
        <div className="mt-auto flex flex-col gap-3 border-t p-4">
          <p className="truncate text-sm font-medium">{props.displayName}</p>
          <Button variant="outline" onClick={props.onLogout}>
            <LogOutIcon data-icon="inline-start" />
            Sign out
          </Button>
        </div>
      </SheetContent>
    </Sheet>
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
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.map((project) => (
              <TableRow key={project.id}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <ProjectMark name={project.name} />
                    <span className="font-medium">{project.name}</span>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{languagePair(project)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {formatUpdatedAt(project.updatedAt)}
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
              <h3 className="truncate font-medium">{project.name}</h3>
              <p className="mt-1 truncate text-sm text-muted-foreground">{languagePair(project)}</p>
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
    INGESTING: { label: 'Preparing', variant: 'warning' as const },
    PROCESSING: { label: 'Translating', variant: 'warning' as const },
    READY: { label: 'Ready for review', variant: 'success' as const },
  };
  const state = states[project.status];
  return <Badge variant={state.variant}>{state.label}</Badge>;
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

function BrandMark() {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
      <svg viewBox="0 0 32 32" aria-hidden="true" className="size-5" fill="none">
        <path
          d="M5 18.4c3.1-8.2 6.2-8.2 11 0s7.9 8.2 11 0M5 13.6c3.1 8.2 6.2 8.2 11 0s7.9-8.2 11 0"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
      </svg>
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

function initials(value: string): string {
  return value
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}
