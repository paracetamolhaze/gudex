import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, Modal, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon, type IconName } from '../components/Icon';
import { LogoBadge } from '../components/Logo';
import { PinPad } from '../components/PinPad';
import { AppText } from '../components/ui';
import { space, useColors } from '../theme';
import { useAuth } from './auth';
import * as store from './security-store';
import type { BiometryKind } from './security-store';

// Если приложение было свёрнуто дольше этого времени — при возврате снова спрашиваем код.
const LOCK_AFTER_MS = 30_000;

export const BIOMETRY_ICON: Record<BiometryKind, IconName> = {
  faceId: 'faceId',
  face: 'faceId',
  touchId: 'fingerprint',
  fingerprint: 'fingerprint',
  biometrics: 'fingerprint',
};

interface SecurityContextValue {
  ready: boolean;
  hasPin: boolean;
  biometry: BiometryKind | null;
  biometricsEnabled: boolean;
  faceIdBlockedInExpoGo: boolean;
  createPin(pin: string): Promise<void>;
  checkPin(pin: string): Promise<{ ok: boolean; attemptsLeft: number }>;
  // Включение биометрии сначала подтверждается самой биометрией.
  setBiometricsEnabled(enabled: boolean): Promise<boolean>;
  // Подтверждение действия: биометрия (если включена), иначе — код-пароль.
  verify(reason: string): Promise<boolean>;
}

const SecurityContext = createContext<SecurityContextValue | null>(null);

export function SecurityProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { status, signOut } = useAuth();
  const [ready, setReady] = useState(false);
  const [hasPin, setHasPin] = useState(false);
  const [biometry, setBiometry] = useState<BiometryKind | null>(null);
  const [faceIdBlockedInExpoGo, setFaceIdBlocked] = useState(false);
  const [biometricsEnabled, setBiometricsOn] = useState(false);
  const [prompt, setPrompt] = useState<{ reason: string } | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  // Блокировка приложения: при запуске с сохранённой сессией и при возврате из фона.
  const [locked, setLocked] = useState(false);
  const firstLoad = useRef(true);
  const backgroundedAt = useRef<number | null>(null);
  const canLock = useRef(false);
  useEffect(() => {
    canLock.current = status === 'signedIn' && hasPin;
  }, [status, hasPin]);

  // Состояние перечитывается при входе/выходе: при выходе код и биометрия стираются.
  useEffect(() => {
    if (status === 'loading') return;
    let cancelled = false;
    Promise.all([store.hasPin(), store.isBiometricsEnabled(), store.detectBiometry()]).then(([pin, bio, detected]) => {
      if (cancelled) return;
      setHasPin(pin);
      setBiometry(detected.kind);
      setFaceIdBlocked(detected.faceIdBlockedInExpoGo);
      setBiometricsOn(bio && detected.kind !== null);
      // Сразу после ввода пароля не блокируем — только при запуске с уже сохранённой сессией.
      if (firstLoad.current) {
        firstLoad.current = false;
        if (status === 'signedIn' && pin) setLocked(true);
      }
      if (status === 'signedOut') setLocked(false);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [status]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') backgroundedAt.current = Date.now();
      if (state === 'active' && backgroundedAt.current !== null) {
        const away = Date.now() - backgroundedAt.current;
        backgroundedAt.current = null;
        if (away >= LOCK_AFTER_MS && canLock.current) setLocked(true);
      }
    });
    return () => sub.remove();
  }, []);

  const createPin = useCallback(async (pin: string) => {
    await store.savePin(pin);
    setHasPin(true);
  }, []);

  const checkPin = useCallback(
    async (pin: string) => {
      const result = await store.checkPin(pin);
      // Кончились попытки — выходим из аккаунта: дальше только вход по паролю.
      if (!result.ok && result.attemptsLeft === 0) await signOut();
      return result;
    },
    [signOut],
  );

  const setBiometricsEnabled = useCallback(
    async (enabled: boolean) => {
      if (enabled && !(await store.authenticateWithBiometrics(t('security.enableReason'), t('common.cancel')))) return false;
      await store.setBiometricsEnabled(enabled);
      setBiometricsOn(enabled);
      return true;
    },
    [t],
  );

  const askPin = useCallback((reason: string) => {
    resolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setPrompt({ reason });
    });
  }, []);

  const verify = useCallback(
    async (reason: string) => {
      if (biometricsEnabled && (await store.authenticateWithBiometrics(reason, t('security.usePin')))) return true;
      return askPin(reason);
    },
    [biometricsEnabled, askPin, t],
  );

  const finish = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setPrompt(null);
  };

  const value = useMemo(
    () => ({ ready, hasPin, biometry, biometricsEnabled, faceIdBlockedInExpoGo, createPin, checkPin, setBiometricsEnabled, verify }),
    [ready, hasPin, biometry, biometricsEnabled, faceIdBlockedInExpoGo, createPin, checkPin, setBiometricsEnabled, verify],
  );

  return (
    <SecurityContext.Provider value={value}>
      {children}
      {locked ? (
        <LockScreen
          checkPin={checkPin}
          biometry={biometricsEnabled ? biometry : null}
          onUnlock={() => setLocked(false)}
          onSignOut={() => {
            setLocked(false);
            signOut();
          }}
        />
      ) : null}
      {prompt ? (
        <PinPrompt
          reason={prompt.reason}
          checkPin={checkPin}
          biometry={biometricsEnabled ? biometry : null}
          onBiometrics={async () => {
            if (await store.authenticateWithBiometrics(prompt.reason, t('security.usePin'))) finish(true);
          }}
          onDone={finish}
        />
      ) : null}
    </SecurityContext.Provider>
  );
}

function PinPrompt({
  reason,
  checkPin,
  biometry,
  onBiometrics,
  onDone,
}: {
  reason: string;
  checkPin: SecurityContextValue['checkPin'];
  biometry: BiometryKind | null;
  onBiometrics: () => void;
  onDone: (ok: boolean) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal visible animationType="slide" onRequestClose={() => onDone(false)}>
      <SafeAreaView style={{ flex: 1, backgroundColor: c.background, padding: space.lg }}>
        <Pressable onPress={() => onDone(false)} hitSlop={12} style={{ alignSelf: 'flex-end' }}>
          <Icon name="close" color={c.text} size={26} />
        </Pressable>
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <PinPad
            title={t('security.enterTitle')}
            subtitle={reason}
            error={error}
            biometryIcon={biometry ? BIOMETRY_ICON[biometry] : undefined}
            onBiometrics={biometry ? onBiometrics : undefined}
            onComplete={async (pin) => {
              const result = await checkPin(pin);
              if (result.ok) {
                onDone(true);
                return true;
              }
              setError(result.attemptsLeft > 0 ? t('security.wrong', { count: result.attemptsLeft }) : t('security.lockedOut'));
              if (result.attemptsLeft === 0) onDone(false);
              return false;
            }}
          />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function LockScreen({
  checkPin,
  biometry,
  onUnlock,
  onSignOut,
}: {
  checkPin: SecurityContextValue['checkPin'];
  biometry: BiometryKind | null;
  onUnlock: () => void;
  onSignOut: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const [error, setError] = useState<string | null>(null);

  const tryBiometrics = useCallback(async () => {
    if (biometry && (await store.authenticateWithBiometrics(t('security.unlockReason'), t('security.usePin')))) onUnlock();
  }, [biometry, onUnlock, t]);

  // Биометрия предлагается сразу, код — запасной вариант.
  useEffect(() => {
    tryBiometrics();
  }, [tryBiometrics]);

  return (
    <Modal visible animationType="none" onRequestClose={() => {}}>
      <SafeAreaView style={{ flex: 1, backgroundColor: c.background, padding: space.lg, justifyContent: 'space-between' }}>
        <View style={{ alignItems: 'center', paddingTop: space.xl }}>
          <LogoBadge size={56} />
        </View>
        <PinPad
          title={t('security.enterTitle')}
          error={error}
          biometryIcon={biometry ? BIOMETRY_ICON[biometry] : undefined}
          onBiometrics={biometry ? tryBiometrics : undefined}
          onComplete={async (pin) => {
            const result = await checkPin(pin);
            if (result.ok) {
              onUnlock();
              return true;
            }
            setError(result.attemptsLeft > 0 ? t('security.wrong', { count: result.attemptsLeft }) : t('security.lockedOut'));
            return false;
          }}
        />
        <Pressable onPress={onSignOut} hitSlop={10} style={{ alignSelf: 'center', padding: space.md }}>
          <AppText variant="label" color={c.primary}>
            {t('security.forgot')}
          </AppText>
        </Pressable>
      </SafeAreaView>
    </Modal>
  );
}

export function useSecurity(): SecurityContextValue {
  const value = useContext(SecurityContext);
  if (!value) throw new Error('useSecurity must be used inside SecurityProvider');
  return value;
}
