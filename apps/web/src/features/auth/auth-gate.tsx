'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from './auth-provider';

export function AuthGate({ children }: Readonly<{ children: React.ReactNode }>) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
  }, [router, status]);

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
