'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Session } from '@supabase/supabase-js';

import { ApiError, apiRequest, apiRequestResult, type ApiResponse } from '@/lib/api';
import { createClient } from '@/lib/supabase/client';

export interface AuthPrincipal {
  user: {
    id: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  organization: {
    id: string;
    displayName: string;
    slug: string;
    role: 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER';
  };
}

interface AuthContextValue {
  principal: AuthPrincipal | null;
  status: 'loading' | 'authenticated' | 'anonymous' | 'forbidden' | 'unavailable';
  request<T>(path: string, init?: RequestInit): Promise<T>;
  requestResult<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const [status, setStatus] = useState<AuthContextValue['status']>('loading');
  const [principal, setPrincipal] = useState<AuthPrincipal | null>(null);
  const accessToken = useRef<string | null>(null);
  const sessionPromise = useRef<Promise<Session | null> | null>(null);

  const hydrate = useCallback(async (session: Session | null): Promise<void> => {
    if (!session) {
      accessToken.current = null;
      setPrincipal(null);
      setStatus('anonymous');
      return;
    }
    accessToken.current = session.access_token;
    try {
      const nextPrincipal = await apiRequest<AuthPrincipal>(
        '/auth/me',
        undefined,
        session.access_token,
      );
      setPrincipal(nextPrincipal);
      setStatus('authenticated');
    } catch (error) {
      setPrincipal(null);
      if (error instanceof ApiError && error.status === 401) {
        accessToken.current = null;
        setStatus('anonymous');
      } else if (error instanceof ApiError && error.status === 403) {
        setStatus('forbidden');
      } else {
        // A control-plane outage must not masquerade as a signed-out user.
        // AuthGate renders an explicit retry state without discarding the session.
        setStatus('unavailable');
      }
    }
  }, []);

  const getSession = useCallback(async (refresh = false): Promise<Session | null> => {
    if (sessionPromise.current) return sessionPromise.current;
    sessionPromise.current = (async () => {
      try {
        const result = refresh
          ? await createClient().auth.refreshSession()
          : await createClient().auth.getSession();
        if (result.error) return null;
        return result.data.session;
      } finally {
        sessionPromise.current = null;
      }
    })();
    return sessionPromise.current;
  }, []);

  useEffect(() => {
    const supabase = createClient();
    void getSession().then(hydrate, () => setStatus('unavailable'));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      // Leave the auth callback synchronously; nested client calls can deadlock.
      setTimeout(() => void hydrate(session), 0);
    });
    return () => data.subscription.unsubscribe();
  }, [getSession, hydrate]);

  const request = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      if (!accessToken.current) {
        const session = await getSession();
        if (!session) throw new ApiError(401, 'Authentication is required.');
        accessToken.current = session.access_token;
      }
      try {
        return await apiRequest<T>(path, init, accessToken.current ?? undefined);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
        const session = await getSession(true);
        if (!session) throw error;
        accessToken.current = session.access_token;
        return apiRequest<T>(path, init, session.access_token);
      }
    },
    [getSession],
  );

  const requestResult = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<ApiResponse<T>> => {
      if (!accessToken.current) {
        const session = await getSession();
        if (!session) throw new ApiError(401, 'Authentication is required.');
        accessToken.current = session.access_token;
      }
      try {
        return await apiRequestResult<T>(path, init, accessToken.current ?? undefined);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
        const session = await getSession(true);
        if (!session) throw error;
        accessToken.current = session.access_token;
        return apiRequestResult<T>(path, init, session.access_token);
      }
    },
    [getSession],
  );

  const logout = useCallback(async () => {
    try {
      await createClient().auth.signOut({ scope: 'local' });
    } catch {
      // Logout remains locally effective during an Auth outage. Supabase JWTs
      // are short-lived; server-side refresh revocation is best-effort here.
    } finally {
      accessToken.current = null;
      setPrincipal(null);
      setStatus('anonymous');
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ logout, principal, request, requestResult, status }),
    [logout, principal, request, requestResult, status],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider.');
  return value;
}
