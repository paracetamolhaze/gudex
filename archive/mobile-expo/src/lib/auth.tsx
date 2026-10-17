import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { AuthTokens } from '@gudex/shared';
import { currentLocale } from '../i18n';
import { request, session } from './api';
import { clearSecurity } from './security-store';

type Status = 'loading' | 'signedOut' | 'signedIn';

interface AuthContextValue {
  status: Status;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const queryClient = useQueryClient();

  useEffect(() => {
    session.setSignedOutHandler(() => {
      queryClient.clear();
      clearSecurity().finally(() => setStatus('signedOut'));
    });
    session.load().then((hasSession) => setStatus(hasSession ? 'signedIn' : 'signedOut'));
  }, [queryClient]);

  const signIn = useCallback(async (email: string, password: string) => {
    const tokens = await request<AuthTokens>('/v1/auth/login', { method: 'POST', body: { email, password }, auth: false });
    await session.save(tokens);
    setStatus('signedIn');
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    const tokens = await request<AuthTokens>('/v1/auth/register', {
      method: 'POST',
      body: { email, password, locale: currentLocale() },
      auth: false,
    });
    await session.save(tokens);
    setStatus('signedIn');
  }, []);

  const signOut = useCallback(async () => {
    const refreshToken = session.refreshToken();
    if (refreshToken) {
      await request('/v1/auth/logout', { method: 'POST', body: { refreshToken }, auth: false }).catch(() => {});
    }
    await session.clear();
    // Код-пароль и биометрия привязаны к аккаунту на этом телефоне — при выходе стираем.
    await clearSecurity();
    queryClient.clear();
    setStatus('signedOut');
  }, [queryClient]);

  const value = useMemo(() => ({ status, signIn, signUp, signOut }), [status, signIn, signUp, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
