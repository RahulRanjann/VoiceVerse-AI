import { createServerClient } from '@supabase/ssr';
import { type NextRequest, NextResponse } from 'next/server';

import { getPublicSupabaseEnvironment } from '@/lib/supabase/config';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get('code');
  const next = normalizeRedirectPath(request.nextUrl.searchParams.get('next'));
  const successResponse = NextResponse.redirect(new URL(next, request.url));
  successResponse.headers.set('Cache-Control', 'private, no-store');

  if (!code) return oauthFailure(request);

  const { publishableKey, url } = getPublicSupabaseEnvironment();
  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        for (const { name, options, value } of cookiesToSet) {
          successResponse.cookies.set(name, value, options);
        }
        for (const [name, value] of Object.entries(headers)) {
          successResponse.headers.set(name, value);
        }
      },
    },
  });

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  return error ? oauthFailure(request) : successResponse;
}

function oauthFailure(request: NextRequest): NextResponse {
  const response = NextResponse.redirect(
    new URL('/login?error=oauth_callback_failed', request.url),
  );
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

function normalizeRedirectPath(value: string | null): string {
  if (
    !value ||
    value.length > 512 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    return '/';
  }
  return value;
}
