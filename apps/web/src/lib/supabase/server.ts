import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { getPublicSupabaseEnvironment } from './config';

/** Creates a request-scoped client; server clients must never be shared. */
export async function createClient() {
  const cookieStore = await cookies();
  const { publishableKey, url } = getPublicSupabaseEnvironment();

  return createServerClient(url, publishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, options, value } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot mutate cookies. The request proxy performs
          // authoritative refresh and writes cache-safe response headers.
        }
      },
    },
  });
}
