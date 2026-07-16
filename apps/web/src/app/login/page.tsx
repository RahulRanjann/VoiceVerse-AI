import { ArrowRightIcon, LanguagesIcon, ShieldCheckIcon, SparklesIcon } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import { API_BASE_URL } from '@/lib/api';
import { cn } from '@/lib/utils';

export default function LoginPage() {
  const signInUrl = `${API_BASE_URL}/auth/google/start?redirectPath=%2F`;
  return (
    <main className="grid min-h-screen place-items-center bg-background px-5 py-12">
      <section className="w-full max-w-md" aria-labelledby="sign-in-title">
        <div className="mb-10 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
            <LanguagesIcon aria-hidden="true" className="size-5" />
          </div>
          <span className="text-lg font-semibold tracking-tight">VoiceVerse</span>
        </div>
        <div className="rounded-2xl border bg-card p-7 shadow-2xl shadow-black/20 sm:p-9">
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium text-primary">Studio access</p>
            <h1 id="sign-in-title" className="text-3xl font-semibold tracking-tight">
              Bring every story into every language.
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">
              Sign in to manage secure uploads, character-consistent dubbing projects, and
              review-ready exports.
            </p>
          </div>
          <a className={cn(buttonVariants({ size: 'lg' }), 'mt-7 w-full')} href={signInUrl}>
            Continue with Google
            <ArrowRightIcon data-icon="inline-end" />
          </a>
          <div className="mt-7 grid gap-3 border-t pt-6 text-sm text-muted-foreground">
            <p className="flex items-center gap-2">
              <ShieldCheckIcon aria-hidden="true" className="size-4 text-primary" />
              Source media remains private and quarantined during scanning.
            </p>
            <p className="flex items-center gap-2">
              <SparklesIcon aria-hidden="true" className="size-4 text-primary" />
              Voice, emotion, and character identity stay attached to the story.
            </p>
          </div>
        </div>
        <p className="mt-5 text-center text-xs leading-5 text-muted-foreground">
          By continuing, you agree to your studio&apos;s authorized use and voice-consent policies.
        </p>
      </section>
    </main>
  );
}
