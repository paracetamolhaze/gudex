import { useState } from 'react';
import { haptic } from '../lib/telegram';
import { Icon, type IconName } from './Icon';

export const PIN_LENGTH = 4;
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'bio', '0', 'del'] as const;

// Цифровая клавиатура для код-пароля. onComplete вызывается, когда набраны все цифры;
// если он вернёт false — ввод сбрасывается с вибрацией и встряской.
export function PinPad({
  title,
  subtitle,
  error,
  onComplete,
  biometryIcon,
  onBiometrics,
}: {
  title: string;
  subtitle?: string;
  error?: string | null;
  onComplete: (pin: string) => Promise<boolean | void> | boolean | void;
  biometryIcon?: IconName;
  onBiometrics?: () => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);

  const press = async (key: (typeof KEYS)[number]) => {
    if (busy) return;
    haptic.tap();
    if (key === 'bio') return onBiometrics?.();
    if (key === 'del') return setValue((v) => v.slice(0, -1));
    const next = value + key;
    setValue(next);
    if (next.length < PIN_LENGTH) return;
    setBusy(true);
    const result = await onComplete(next);
    if (result === false) {
      haptic.error();
      setShake((n) => n + 1);
    }
    setValue('');
    setBusy(false);
  };

  return (
    <div className="pin-pad">
      <div className="stack-sm" style={{ alignItems: 'center', textAlign: 'center' }}>
        <h1 className="title">{title}</h1>
        {subtitle ? <span className="muted">{subtitle}</span> : null}
      </div>
      <div key={shake} className={`pin-dots${error ? ' error' : ''}${shake ? ' shake' : ''}`}>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span key={i} className={`pin-dot${i < value.length ? ' filled' : ''}`} />
        ))}
      </div>
      <span className="caption danger-text" style={{ minHeight: 18, marginTop: -8, textAlign: 'center' }}>
        {error ?? ''}
      </span>
      <div className="keypad">
        {KEYS.map((key) => {
          if (key === 'bio') {
            return (
              <button key={key} className={`key plain${onBiometrics ? '' : ' hidden'}`} onClick={() => press(key)} aria-label="Biometrics">
                <Icon name={biometryIcon ?? 'faceId'} color="var(--primary)" size={30} />
              </button>
            );
          }
          if (key === 'del') {
            return (
              <button key={key} className="key plain" onClick={() => press(key)} aria-label="Delete">
                <Icon name="backspace" size={26} />
              </button>
            );
          }
          return (
            <button key={key} className="key" onClick={() => press(key)}>
              {key}
            </button>
          );
        })}
      </div>
    </div>
  );
}
