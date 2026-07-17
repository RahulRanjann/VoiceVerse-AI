'use client';

import {
  ChevronDownIcon,
  ClapperboardIcon,
  FolderIcon,
  HomeIcon,
  LogOutIcon,
  MenuIcon,
  Mic2Icon,
  UploadCloudIcon,
  UsersIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuth } from '@/features/auth/auth-provider';
import { cn } from '@/lib/utils';

interface StudioShellProps {
  children: React.ReactNode;
  onUpload?(): void;
}

export function StudioShell({ children, onUpload }: StudioShellProps) {
  const { logout, principal } = useAuth();
  if (!principal) return null;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <DesktopSidebar
        avatarUrl={principal.user.avatarUrl}
        displayName={principal.user.displayName ?? principal.user.email}
        email={principal.user.email}
        onLogout={() => void logout()}
        onUpload={onUpload}
        organizationName={principal.organization.displayName}
        role={principal.organization.role}
      />
      <div className="md:pl-60">{children}</div>
    </div>
  );
}

export function StudioMobileNavigation({ onUpload }: { onUpload?(): void }) {
  const { logout, principal } = useAuth();
  if (!principal) return null;

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
          <SheetDescription>{principal.organization.displayName}</SheetDescription>
        </SheetHeader>
        <NavigationItems onUpload={onUpload} />
        <div className="mt-auto flex flex-col gap-3 border-t p-4">
          <p className="truncate text-sm font-medium">
            {principal.user.displayName ?? principal.user.email}
          </p>
          <Button variant="outline" onClick={() => void logout()}>
            <LogOutIcon data-icon="inline-start" />
            Sign out
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DesktopSidebar({
  avatarUrl,
  displayName,
  email,
  onLogout,
  onUpload,
  organizationName,
  role,
}: {
  avatarUrl: string | null;
  displayName: string;
  email: string;
  onLogout(): void;
  onUpload?(): void;
  organizationName: string;
  role: string;
}) {
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-sidebar-border bg-sidebar md:flex">
      <Link href="/" className="flex h-16 items-center gap-3 px-5">
        <BrandMark />
        <span className="text-lg font-semibold tracking-tight">VoiceVerse</span>
      </Link>
      <NavigationItems onUpload={onUpload} />
      <div className="mt-auto flex flex-col gap-3 p-3">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" className="h-auto w-full justify-between px-3 py-2.5" />
            }
          >
            <span className="flex min-w-0 items-center gap-2">
              <ClapperboardIcon />
              <span className="truncate">{organizationName}</span>
            </span>
            <ChevronDownIcon data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Active workspace</DropdownMenuLabel>
              <DropdownMenuItem>
                <ClapperboardIcon />
                {organizationName}
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
                {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
                <AvatarFallback>{initials(displayName)}</AvatarFallback>
              </Avatar>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{displayName}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {titleCase(role)}
                </span>
              </span>
            </span>
            <ChevronDownIcon data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-60">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="truncate">{email}</DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onLogout}>
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

function NavigationItems({ onUpload }: { onUpload?(): void }) {
  const pathname = usePathname();
  const baseClass =
    'flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors [&_svg]:size-4';
  const active = pathname === '/';

  return (
    <nav aria-label="Studio navigation" className="flex flex-col gap-1 px-3 py-3">
      <Link
        href="/"
        aria-current={active ? 'page' : undefined}
        className={cn(
          baseClass,
          active
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-sidebar-foreground/70 hover:bg-sidebar-accent',
        )}
      >
        <HomeIcon aria-hidden="true" />
        Home
      </Link>
      <Link
        href="/#recent-projects"
        className={cn(baseClass, 'text-sidebar-foreground/70 hover:bg-sidebar-accent')}
      >
        <FolderIcon aria-hidden="true" />
        Projects
      </Link>
      {onUpload ? (
        <button
          type="button"
          className={cn(baseClass, 'text-sidebar-foreground/70 hover:bg-sidebar-accent')}
          onClick={onUpload}
        >
          <UploadCloudIcon aria-hidden="true" />
          Uploads
        </button>
      ) : (
        <Link
          href="/"
          className={cn(baseClass, 'text-sidebar-foreground/70 hover:bg-sidebar-accent')}
        >
          <UploadCloudIcon aria-hidden="true" />
          Uploads
        </Link>
      )}
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
