interface PublicSupabaseEnvironment {
  url: string;
  publishableKey: string;
}

/**
 * Returns only values intentionally exposed in the browser bundle. Supabase
 * secret/service-role keys are never accepted by this module.
 */
export function getPublicSupabaseEnvironment(): PublicSupabaseEnvironment {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) {
    throw new Error('Supabase browser configuration is incomplete.');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL must be an absolute URL.');
  }
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL must use HTTPS outside local development.');
  }
  if (
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL must contain only the project origin.');
  }
  if (!publishableKey.startsWith('sb_publishable_') && !isLoopback) {
    throw new Error('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is invalid.');
  }

  return { publishableKey, url: parsed.origin };
}
