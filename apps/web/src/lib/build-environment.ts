type BuildEnvironment = Record<string, string | undefined>;

/** Fails a Vercel build before it can publish a browser bundle pointed at localhost. */
export function validateVercelBuildEnvironment(environment: BuildEnvironment = process.env) {
  if (!environment.VERCEL) return;

  const requiredPublicValues = [
    'NEXT_PUBLIC_API_BASE_URL',
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  ] as const;
  const missing = requiredPublicValues.filter((name) => !environment[name]);
  if (missing.length > 0) {
    throw new Error(`${missing.join(', ')} must be configured for Vercel deployments.`);
  }

  validatePublicHttpsUrl('NEXT_PUBLIC_API_BASE_URL', environment.NEXT_PUBLIC_API_BASE_URL!);
  const supabaseUrl = validatePublicHttpsUrl(
    'NEXT_PUBLIC_SUPABASE_URL',
    environment.NEXT_PUBLIC_SUPABASE_URL!,
  );
  if (supabaseUrl.pathname !== '/' || supabaseUrl.search || supabaseUrl.hash) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL must contain only the project origin.');
  }

  if (!environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.startsWith('sb_publishable_')) {
    throw new Error('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be a publishable Supabase key.');
  }

  if (
    environment.NEXT_PUBLIC_SUPABASE_SECRET_KEY ||
    environment.SUPABASE_SECRET_KEY ||
    environment.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY ||
    environment.SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw new Error('Supabase secret keys must not be configured in the Vercel web project.');
  }
}

function validatePublicHttpsUrl(name: string, value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL on Vercel.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(`${name} must be an HTTPS URL without embedded credentials on Vercel.`);
  }
  if (['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error(`${name} cannot target localhost on Vercel.`);
  }
  return parsed;
}
