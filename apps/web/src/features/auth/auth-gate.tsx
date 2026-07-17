'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from './auth-provider';

export function AuthGate({ children }: Readonly<{ children: React.ReactNode }>) {
  const { logout, status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
  }, [router, status]);

  if (status === 'unavailable') {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6">
        <section className="max-w-md rounded-xl border border-border bg-card p-8 text-center shadow-sm">
          <h1 className="text-xl font-semibold text-foreground">
            VoiceVerse is temporarily unavailable
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground" role="alert">
            Your session is still safe. We could not reach the control plane, so no account data was
            loaded.
          </p>
          <Button className="mt-6" onClick={() => window.location.reload()}>
            Try again
          </Button>
        </section>
      </main>
    );
  }

  if (status === 'forbidden') {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6">
        <section className="max-w-md rounded-xl border border-border bg-card p-8 text-center shadow-sm">
          <h1 className="text-xl font-semibold text-foreground">Account access needs review</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground" role="alert">
            Your Google identity is valid, but it is not linked to an active VoiceVerse workspace.
            Contact your workspace administrator or sign out to use another account.
          </p>
          <Button className="mt-6" onClick={() => void logout()} variant="outline">
            Sign out
          </Button>
        </section>
      </main>
    );
  }

  if (status !== 'authenticated') {
    return (
      <main className="grid min-h-screen grid-cols-[15rem_1fr] bg-background" aria-busy="true">
        <aside className="hidden border-r border-sidebar-border bg-sidebar p-5 md:block">
          <Skeleton className="h-8 w-36" />
        </aside>
        <section className="flex flex-col gap-6 p-6 md:p-10">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-80 w-full" />
        </section>
      </main>
    );
  }
  return children;
}
