import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { BiometricTokenDto, ConfirmationDto, SessionDto } from '@gudex/shared';
import { request, session as apiSession } from './api';
import { type BiometryKind, biometrics, initData, inTelegram } from './telegram';

// Состояние входа: Telegram → (создание кода) → блокировка → приложение.
type Stage = 'loading' | 'outside' | 'error' | 'onboarding' | 'locked' | 'ready';

// Свёрнутое дольше этого времени приложение снова просит код.
const RELOCK_AFTER_MS = 30_000;
const DEV_USER_KEY = 'gudex.devTelegramId';

interface SessionContextValue {
  stage: Stage;
  biometry: BiometryKind | null;
  biometricsEnabled: boolean;
  setPin(pin: string, currentPin?: string): Promise<void>;
  unlockWithPin(pin: string): Promise<void>;
  unlockWithBiometrics(reason: string): Promise<boolean>;
  enableBiometrics(reason: string, pin: string): Promise<boolean>;
  disableBiometrics(): Promise<void>;
  // Подтверждение для реквизитов карты: возвращает токен или null, если пользователь отменил.
  confirm(credential: { pin: string } | { biometricReason: string }): Promise<string | null>;
  finishOnboarding(): void;
  retry(): void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

async function login(): Promise<SessionDto> {
  if (inTelegram) return request<SessionDto>('/v1/auth/telegram', { method: 'POST', body: { initData } });
  // Вне Telegram — только локальная разработка: вход тестовым пользователем.
  let id = Number(localStorage.getItem(DEV_USER_KEY));
  if (!id) {
    id = 700_000_000 + Math.floor(Math.random() * 1_000_000);
    localStorage.setItem(DEV_USER_KEY, String(id));
  }
  return request<SessionDto>('/v1/auth/dev', { method: 'POST', body: { telegramId: id, firstName: 'Dev' } });
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<Stage>('loading');
  const [biometry, setBiometry] = useState<BiometryKind | null>(null);
  const [biometricsEnabled, setBiometricsEnabled] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const hiddenAt = useRef<number | null>(null);

  const apply = useCallback((s: SessionDto) => {
    apiSession.set(s.accessToken);
    setStage(s.unlocked ? 'ready' : s.hasPin ? 'locked' : 'onboarding');
  }, []);

  // Вход при открытии: подписанные данные Telegram → заблокированная сессия.
  const start = useCallback(async () => {
    setStage('loading');
    if (!inTelegram && !import.meta.env.DEV) return setStage('outside');
    try {
      const [s, bio] = await Promise.all([login(), biometrics.init()]);
      setBiometry(bio.kind);
      setBiometricsEnabled(bio.tokenSaved);
      queryClient.clear();
      apply(s);
    } catch {
      setStage('error');
    }
  }, [apply, queryClient]);

  useEffect(() => {
    start();
  }, [start, attempt]);

  useEffect(() => {
    apiSession.onLost((code) => (code === 'unlock_required' ? setStage('locked') : start()));
  }, [start]);

  // Вернулись в приложение после долгого перерыва — заново входим и просим код.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) hiddenAt.current = Date.now();
      else if (hiddenAt.current && Date.now() - hiddenAt.current > RELOCK_AFTER_MS) {
        hiddenAt.current = null;
        start();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [start]);

  const value = useMemo<SessionContextValue>(
    () => ({
      stage,
      biometry,
      biometricsEnabled,
      async setPin(pin, currentPin) {
        const s = await request<SessionDto>('/v1/security/pin', { method: 'POST', body: { pin, currentPin } });
        apiSession.set(s.accessToken);
        // Новый код отзывает старый биометрический токен на сервере.
        if (biometricsEnabled) {
          await biometrics.clear();
          setBiometricsEnabled(false);
        }
      },
      async unlockWithPin(pin) {
        apply(await request<SessionDto>('/v1/security/unlock', { method: 'POST', body: { pin } }));
      },
      async unlockWithBiometrics(reason) {
        const token = await biometrics.authenticate(reason);
        if (!token) return false;
        try {
          apply(await request<SessionDto>('/v1/security/unlock', { method: 'POST', body: { biometricToken: token } }));
          return true;
        } catch {
          // Токен устарел (например, сменили код) — выключаем биометрию, остаётся код.
          await biometrics.clear();
          setBiometricsEnabled(false);
          return false;
        }
      },
      async enableBiometrics(reason, pin) {
        const { biometricToken } = await request<BiometricTokenDto>('/v1/security/biometric', { method: 'POST', body: { pin } });
        const saved = await biometrics.saveToken(biometricToken, reason);
        if (!saved) await request('/v1/security/biometric/revoke', { method: 'POST' });
        setBiometricsEnabled(saved);
        return saved;
      },
      async disableBiometrics() {
        await biometrics.clear();
        await request('/v1/security/biometric/revoke', { method: 'POST' });
        setBiometricsEnabled(false);
      },
      async confirm(credential) {
        let body: { pin: string } | { biometricToken: string };
        if ('pin' in credential) body = { pin: credential.pin };
        else {
          const token = await biometrics.authenticate(credential.biometricReason);
          if (!token) return null;
          body = { biometricToken: token };
        }
        const { confirmationToken } = await request<ConfirmationDto>('/v1/security/confirm', { method: 'POST', body });
        return confirmationToken;
      },
      finishOnboarding() {
        setStage('ready');
      },
      retry() {
        setAttempt((n) => n + 1);
      },
    }),
    [stage, biometry, biometricsEnabled, apply],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
