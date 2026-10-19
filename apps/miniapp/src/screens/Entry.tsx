import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../components/Icon';
import { Mascot } from '../components/Mascot';
import { LanguageSwitch } from '../components/misc';
import { PinPad } from '../components/PinPad';
import { BIOMETRY_ICON, BiometricOffer, PinCreateFlow, usePinError } from '../components/security';
import { Button, Notice } from '../components/ui';
import { useFormat } from '../lib/format';
import { acceptTerms } from '../lib/queries';
import { TermsConsent } from './Legal';
import { useSession } from '../lib/session';

// Экраны до входа в приложение: Telegram не открыт / ошибка, первое знакомство, блокировка.

export function Outside() {
  const { t } = useTranslation();
  return (
    <div className="center-screen">
      <Mascot pose="hello" size={220} motion="pop" />
      <h1 className="title">{t('boot.outsideTitle')}</h1>
      <p className="muted">{t('boot.outsideText')}</p>
    </div>
  );
}

export function BootError() {
  const { t } = useTranslation();
  const session = useSession();
  return (
    <div className="center-screen">
      <Mascot pose="sad" size={200} motion="pop" />
      <h1 className="title">{t('boot.errorTitle')}</h1>
      <p className="muted">{t('boot.errorText')}</p>
      <div style={{ width: '100%', maxWidth: 320 }}>
        <Button title={t('common.retry')} onClick={session.retry} />
      </div>
    </div>
  );
}

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  { icon: 'globe', title: 'welcome.f1Title', text: 'welcome.f1Text' },
  { icon: 'phone', title: 'welcome.f2Title', text: 'welcome.f2Text' },
  { icon: 'coins', title: 'welcome.f3Title', text: 'welcome.f3Text' },
  { icon: 'shield', title: 'welcome.f4Title', text: 'welcome.f4Text' },
];

// Первое открытие: знакомство → код-пароль → предложение биометрии.
export function Onboarding() {
  const { t } = useTranslation();
  const session = useSession();
  const fmt = useFormat();
  const [step, setStep] = useState<'intro' | 'pin' | 'biometrics'>('intro');
  const [agreed, setAgreed] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<unknown>(null);
  // The Terms are accepted before the passcode is created; the server keeps the version and the time.
  const start = async () => {
    setAccepting(true);
    setAcceptError(null);
    try {
      await acceptTerms();
      setStep('pin');
    } catch (error) {
      setAcceptError(error);
    } finally {
      setAccepting(false);
    }
  };

  if (step === 'pin') {
    return (
      <div className="center-screen">
        <PinCreateFlow onDone={() => (session.biometry ? setStep('biometrics') : session.finishOnboarding())} />
      </div>
    );
  }
  if (step === 'biometrics') return <BiometricOffer onDone={session.finishOnboarding} />;

  return (
    <div className="page welcome">
      <div className="stack-sm">
        <h1 className="title welcome-title">{t('welcome.tagline')}</h1>
        <span className="muted welcome-subtitle">{t('welcome.subtitle')}</span>
      </div>
      <Mascot pose="hello" size="var(--welcome-mascot)" motion="pop" />
      <div className="feature-grid">
        {FEATURES.map((f) => (
          <div key={f.icon} className="surface stack welcome-feature">
            <span className="icon-gradient">
              <Icon name={f.icon} color="#fff" size={20} />
            </span>
            <span className="body-medium" style={{ fontWeight: 600 }}>
              {t(f.title)}
            </span>
            <span className="caption muted welcome-feature-text">{t(f.text)}</span>
          </div>
        ))}
      </div>
      <LanguageSwitch />
      <div className="welcome-footer">
        <div className="stack" style={{ maxWidth: 488, margin: '0 auto' }}>
          <TermsConsent checked={agreed} disabled={accepting} onChange={setAgreed} />
          {acceptError ? <Notice tone="danger" text={fmt.error(acceptError)} /> : null}
          <Button title={t('welcome.start')} disabled={!agreed} loading={accepting} onClick={() => void start()} />
        </div>
      </div>
    </div>
  );
}

export function Lock() {
  const { t } = useTranslation();
  const session = useSession();
  const pinError = usePinError();
  const [error, setError] = useState<string | null>(null);
  const [sad, setSad] = useState(0);

  // После неверного кода маскот грустит полторы секунды.
  useEffect(() => {
    if (!sad) return;
    const timer = setTimeout(() => setSad(0), 1600);
    return () => clearTimeout(timer);
  }, [sad]);

  // Если включена биометрия — предлагаем её сразу (один раз), код остаётся запасным вариантом.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !session.biometricsEnabled) return;
    asked.current = true;
    session.unlockWithBiometrics(t('security.unlockReason'));
  }, [session, t]);

  return (
    <div className="center-screen lock-screen">
      <Mascot key={sad} pose={sad ? 'sad' : 'hello'} size="var(--mascot-h)" motion={sad ? 'shake' : 'float'} />
      <PinPad
        title={t('security.enterTitle')}
        error={error}
        biometryIcon={session.biometry ? BIOMETRY_ICON[session.biometry] : undefined}
        onBiometrics={session.biometricsEnabled ? () => session.unlockWithBiometrics(t('security.unlockReason')) : undefined}
        onComplete={async (pin) => {
          try {
            await session.unlockWithPin(pin);
            return true;
          } catch (err) {
            setError(pinError(err));
            setSad((n) => n + 1);
            return false;
          }
        }}
      />
    </div>
  );
}
