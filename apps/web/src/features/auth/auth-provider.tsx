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

import { ApiError, apiRequest } from '@/lib/api';

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

interface SessionResponse extends AuthPrincipal {
  accessToken: string;
  expiresInSeconds: number;
}

interface AuthContextValue {
  principal: AuthPrincipal | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  request<T>(path: string, init?: RequestInit): Promise<T>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const [status, setStatus] = useState<AuthContextValue['status']>('loading');
  const [principal, setPrincipal] = useState<AuthPrincipal | null>(null);
  const accessToken = useRef<string | null>(null);
  const refreshPromise = useRef<Promise<SessionResponse | null> | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async (): Promise<SessionResponse | null> => {
    if (refreshPromise.current) return refreshPromise.current;
    refreshPromise.current = (async () => {
      try {
        const session = await apiRequest<SessionResponse>('/auth/refresh', { method: 'POST' });
        accessToken.current = session.accessToken;
        setPrincipal({ organization: session.organization, user: session.user });
        setStatus('authenticated');
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(
          () => {
            accessToken.current = null;
          },
          Math.max(30, session.expiresInSeconds - 60) * 1_000,
        );
        return session;
      } catch (error) {
        accessToken.current = null;
        setPrincipal(null);
        setStatus('anonymous');
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          return null;
        }
        throw error;
      } finally {
        refreshPromise.current = null;
      }
    })();
    return refreshPromise.current;
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refresh]);

  const request = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      if (!accessToken.current) {
        const session = await refresh();
        if (!session) throw new ApiError(401, 'Authentication is required.');
      }
      try {
        return await apiRequest<T>(path, init, accessToken.current ?? undefined);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
        const session = await refresh();
        if (!session) throw error;
        return apiRequest<T>(path, init, session.accessToken);
      }
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    try {
      await apiRequest<void>('/auth/logout', { method: 'POST' });
    } finally {
      accessToken.current = null;
      setPrincipal(null);
      setStatus('anonymous');
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ logout, principal, request, status }),
    [logout, principal, request, status],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider.');
  return value;
}
