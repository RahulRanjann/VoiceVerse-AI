'use client';

import { ArrowRightIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/client';

export function GoogleSignInButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(): Promise<void> {
    setPending(true);
    setError(null);
    const redirectTo = `${window.location.origin}/auth/callback`;
    const { error: signInError } = await createClient().auth.signInWithOAuth({
      options: { redirectTo },
      provider: 'google',
    });
    if (signInError) {
      setError('Google sign-in could not be started. Please try again.');
      setPending(false);
    }
  }

  return (
    <div className="mt-7 grid gap-3">
      <Button className="w-full" disabled={pending} onClick={() => void signIn()} size="lg">
        {pending ? 'Opening Google…' : 'Continue with Google'}
        <ArrowRightIcon data-icon="inline-end" />
      </Button>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
