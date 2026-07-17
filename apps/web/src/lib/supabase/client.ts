import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getPublicSupabaseEnvironment } from './config';

let browserClient: SupabaseClient | undefined;

/** One browser client owns the tab's cookie-backed Supabase session. */
export function createClient(): SupabaseClient {
  if (browserClient) return browserClient;
  const { publishableKey, url } = getPublicSupabaseEnvironment();
  browserClient = createBrowserClient(url, publishableKey);
  return browserClient;
}
