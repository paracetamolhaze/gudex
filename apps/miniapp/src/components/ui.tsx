import { type InputHTMLAttributes, type ReactNode, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../lib/format';
import { backButton, haptic, inTelegram } from '../lib/telegram';
import { Icon, type IconName } from './Icon';

// Экран внутреннего уровня: заголовок + системная кнопка «Назад» Telegram.
// Вне Telegram (разработка в браузере) рисуем свою стрелку.
export function Page({ title, children, tabbar }: { title?: string; children: ReactNode; tabbar?: boolean }) {
  const navigate = useNavigate();
  const hasBack = !tabbar;

  useEffect(() => {
    if (!hasBack) return;
    return backButton.show(() => navigate(-1));
  }, [hasBack, navigate]);

  return (
    <div className={`page${tabbar ? ' with-tabbar' : ''}`}>
      {title ? (
        <div className="row">
          {hasBack && !inTelegram ? (
            <button className="link" onClick={() => navigate(-1)} aria-label="Back">
              <Icon name="arrowLeft" color="var(--text)" size={26} />
            </button>
          ) : null}
          <h1 className={tabbar ? 'title' : 'heading'}>{title}</h1>
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function Button({
  title,
  onClick,
  variant = 'primary',
  loading,
  disabled,
  icon,
  small,
}: {
  title: string;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  icon?: IconName;
  small?: boolean;
}) {
  return (
    <button
      className={`btn ${variant}${small ? ' small' : ''}`}
      disabled={disabled || loading}
      onClick={() => {
        haptic.tap();
        onClick?.();
      }}
    >
      {loading ? <span className="spinner" /> : icon ? <Icon name={icon} size={20} /> : null}
      {title}
    </button>
  );
}

// Круглая кнопка с подписью — быстрые действия на главной и на карте.
export function ActionButton({ icon, label, onClick, disabled }: { icon: IconName; label: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      className="action"
      disabled={disabled}
      onClick={() => {
        haptic.tap();
        onClick?.();
      }}
    >
      <span className="action-icon">
        <Icon name={icon} color="var(--primary)" />
      </span>
      {label}
    </button>
  );
}

export function Surface({ children, flush, className }: { children: ReactNode; flush?: boolean; className?: string }) {
  return <div className={`surface${flush ? ' flush' : ''}${className ? ` ${className}` : ''}`}>{children}</div>;
}

export function Notice({ text, tone = 'info', icon, action }: { text: string; tone?: 'info' | 'warning' | 'danger'; icon?: IconName; action?: ReactNode }) {
  const color = { info: 'var(--primary)', warning: 'var(--warning)', danger: 'var(--danger)' }[tone];
  return (
    <div className={`notice${tone === 'warning' ? ' warning' : ''}`}>
      <Icon name={icon ?? 'alert'} color={color} size={20} />
      <span className="grow">{text}</span>
      {action}
    </div>
  );
}

export function QueryError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  return <Notice tone="danger" text={fmt.error(error)} action={<Button small variant="ghost" title={t('common.retry')} onClick={onRetry} />} />;
}

export function Field({ label, error, hint, ...input }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | null; hint?: string }) {
  return (
    <label className="field">
      <span className="label muted">{label}</span>
      <input className={`input${error ? ' error' : ''}`} {...input} />
      {error ? <span className="caption danger-text">{error}</span> : hint ? <span className="caption muted">{hint}</span> : null}
    </label>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          className={o.value === value ? 'active' : ''}
          onClick={() => {
            haptic.select();
            onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="row between">
      <span className={strong ? 'body-medium' : 'muted'}>{label}</span>
      <span className={strong ? 'heading' : 'body-medium'}>{value}</span>
    </div>
  );
}

export function SectionTitle({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="row between">
      <h2 className="heading">{title}</h2>
      {action}
    </div>
  );
}

export function Spinner({ large }: { large?: boolean }) {
  return <span className={`spinner${large ? ' large' : ''}`} />;
}

export function Loading() {
  return (
    <div className="center-screen">
      <Spinner large />
    </div>
  );
}

export function Switch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      className={`switch${on ? ' on' : ''}`}
      role="switch"
      aria-checked={on}
      onClick={() => {
        haptic.select();
        onChange(!on);
      }}
    />
  );
}

// Нижняя панель «вы уверены?» с объяснением последствий.
export function ConfirmSheet({
  open,
  icon,
  title,
  message,
  confirmLabel,
  cancelLabel,
  loading,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  icon?: IconName;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <>
      <div className="backdrop" onClick={onCancel} />
      <div className="sheet" role="dialog">
        {icon ? (
          <div className="icon-circle">
            <Icon name={icon} color="var(--primary)" size={28} />
          </div>
        ) : null}
        <h2 className="title">{title}</h2>
        <p className="muted" style={{ margin: 0 }}>
          {message}
        </p>
        <div className="stack">
          <Button title={confirmLabel} onClick={onConfirm} loading={loading} />
          <Button title={cancelLabel} variant="ghost" onClick={onCancel} />
        </div>
      </div>
    </>
  );
}
