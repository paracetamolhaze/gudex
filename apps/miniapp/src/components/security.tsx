import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useFormat } from '../lib/format';
import { useSession } from '../lib/session';
import type { BiometryKind } from '../lib/telegram';
import { Icon, type IconName } from './Icon';
import { PinPad } from './PinPad';

export const BIOMETRY_ICON: Record<BiometryKind, IconName> = {
  faceId: 'faceId',
  face: 'faceId',
  touchId: 'fingerprint',
  fingerprint: 'fingerprint',
};

// Текст ошибки кода-пароля: сколько попыток осталось или на сколько заблокирован.
export function usePinError() {
  const { t } = useTranslation();
  const fmt = useFormat();
  return (err: unknown): string => {
    if (err instanceof ApiError && err.code === 'pin_invalid' && err.attemptsLeft !== undefined) {
      return t('security.wrong', { count: err.attemptsLeft });
    }
    if (err instanceof ApiError && err.code === 'pin_locked') {
      const minutes = err.lockedUntil ? Math.max(1, Math.ceil((new Date(err.lockedUntil).getTime() - Date.now()) / 60_000)) : 15;
      return t('security.locked', { minutes });
    }
    return fmt.error(err);
  };
}

// Создание или смена кода-пароля: (текущий) → новый → повтор.
export function PinCreateFlow({ requireCurrent, onDone }: { requireCurrent?: boolean; onDone: () => void }) {
  const { t } = useTranslation();
  const session = useSession();
  const pinError = usePinError();
  const [step, setStep] = useState<'current' | 'new' | 'confirm'>(requireCurrent ? 'current' : 'new');
  const [currentPin, setCurrentPin] = useState<string | undefined>();
  const [firstPin, setFirstPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  const titles = { current: t('security.currentTitle'), new: t('security.createTitle'), confirm: t('security.confirmTitle') };

  return (
    <PinPad
      key={step}
      title={titles[step]}
      subtitle={step === 'new' ? t('security.createSubtitle') : undefined}
      error={error}
      onComplete={async (pin) => {
        if (step === 'current') {
          setCurrentPin(pin);
          setError(null);
          setStep('new');
          return;
        }
        if (step === 'new') {
          setFirstPin(pin);
          setError(null);
          setStep('confirm');
          return;
        }
        if (pin !== firstPin) {
          setError(t('security.mismatch'));
          setStep('new');
          return false;
        }
        try {
          await session.setPin(pin, currentPin);
          onDone();
        } catch (err) {
          // Неверный текущий код — начинаем заново с него.
          setError(pinError(err));
          setStep(requireCurrent ? 'current' : 'new');
          return false;
        }
      }}
    />
  );
}

// Выпуск нового биометрического токена всегда подтверждается свежим кодом.
export function useBiometricEnrollment() {
  const { t } = useTranslation();
  const session = useSession();
  const pinError = usePinError();
  const [reason, setReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolver = useRef<((saved: boolean) => void) | null>(null);
  useEffect(() => () => resolver.current?.(false), []);
  const finish = (saved: boolean) => {
    resolver.current?.(saved);
    resolver.current = null;
    setReason(null);
    setError(null);
  };
  const enable = (prompt: string) => new Promise<boolean>((resolve) => {
    if (resolver.current) return resolve(false);
    resolver.current = resolve;
    setError(null);
    setReason(prompt);
  });
  const element = reason ? (
    <div className="fullscreen">
      <button className="link" style={{ alignSelf: 'flex-end' }} onClick={() => finish(false)} aria-label={t('common.cancel')}>
        <Icon name="close" color="var(--text)" size={26} />
      </button>
      <div className="grow" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <PinPad title={t('security.enterTitle')} subtitle={reason} error={error} onComplete={async (pin) => {
          try {
            const saved = await session.enableBiometrics(reason, pin);
            finish(saved);
            return saved;
          } catch (err) {
            setError(pinError(err));
            return false;
          }
        }} />
      </div>
    </div>
  ) : null;
  return { enable, element };
}

export function BiometricOffer({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const session = useSession();
  const enrollment = useBiometricEnrollment();
  const [busy, setBusy] = useState(false);
  const kind = session.biometry!;
  return (
    <div className="center-screen" style={{ justifyContent: 'space-between' }}>
      <div className="stack grow" style={{ alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <div className="icon-circle" style={{ width: 96, height: 96 }}>
          <Icon name={BIOMETRY_ICON[kind]} color="var(--primary)" size={48} />
        </div>
        <h1 className="title">{t(`security.bioTitle.${kind}`)}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {t('security.bioText')}
        </p>
      </div>
      <div className="stack" style={{ width: '100%', maxWidth: 480 }}>
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const saved = await enrollment.enable(t('security.enableReason'));
            setBusy(false);
            if (saved) onDone();
          }}
        >
          {t('security.enable')}
        </button>
        <button className="btn ghost" onClick={onDone}>
          {t('security.notNow')}
        </button>
      </div>
      {enrollment.element}
    </div>
  );
}

// Подтверждение чувствительного действия: биометрия, если включена, иначе — экран кода.
export function useConfirmation(): { confirm: (reason: string) => Promise<string | null>; element: ReactNode } {
  const { t } = useTranslation();
  const session = useSession();
  const pinError = usePinError();
  const [prompt, setPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolver = useRef<((token: string | null) => void) | null>(null);

  const finish = (token: string | null) => {
    resolver.current?.(token);
    resolver.current = null;
    setPrompt(null);
    setError(null);
  };

  const askPin = (reason: string) =>
    new Promise<string | null>((resolve) => {
      resolver.current = resolve;
      setPrompt(reason);
    });

  const confirm = async (reason: string) => {
    if (session.biometricsEnabled) {
      const token = await session.confirm({ biometricReason: reason }).catch(() => null);
      if (token) return token;
    }
    return askPin(reason);
  };

  const element = prompt ? (
    <div className="fullscreen">
      <button className="link" style={{ alignSelf: 'flex-end' }} onClick={() => finish(null)} aria-label="Close">
        <Icon name="close" color="var(--text)" size={26} />
      </button>
      <div className="grow" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <PinPad
          title={t('security.enterTitle')}
          subtitle={prompt}
          error={error}
          biometryIcon={session.biometry ? BIOMETRY_ICON[session.biometry] : undefined}
          onBiometrics={
            session.biometricsEnabled
              ? async () => {
                  const token = await session.confirm({ biometricReason: prompt }).catch(() => null);
                  if (token) finish(token);
                }
              : undefined
          }
          onComplete={async (pin) => {
            try {
              finish(await session.confirm({ pin }));
              return true;
            } catch (err) {
              setError(pinError(err));
              return false;
            }
          }}
        />
      </div>
    </div>
  ) : null;

  return { confirm, element };
}
