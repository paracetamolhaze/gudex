import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { CardDto, CardSensitiveDto } from '@gudex/shared';
import { Icon } from './Icon';
import { LogoMark, SHIELD } from './Logo';
import { Spinner } from './ui';

// Знак Visa (Simple Icons, CC0): только надпись, без фона.
const VISA =
  'M9.112 8.262L5.97 15.758H3.92L2.374 9.775c-.094-.368-.175-.503-.461-.658C1.447 8.864.677 8.627 0 8.479l.046-.217h3.3a.904.904 0 0 1 .894.764l.817 4.338l2.018-5.102zm8.033 5.049c.008-1.979-2.736-2.088-2.717-2.972c.006-.269.262-.555.822-.628a3.66 3.66 0 0 1 1.913.336l.34-1.59a5.2 5.2 0 0 0-1.814-.333c-1.917 0-3.266 1.02-3.278 2.479c-.012 1.079.963 1.68 1.698 2.04c.756.367 1.01.603 1.006.931c-.005.504-.602.725-1.16.734c-.975.015-1.54-.263-1.992-.473l-.351 1.642c.453.208 1.289.39 2.156.398c2.037 0 3.37-1.006 3.377-2.564m5.061 2.447H24l-1.565-7.496h-1.656a.88.88 0 0 0-.826.55l-2.909 6.946h2.036l.405-1.12h2.488zm-2.163-2.656l1.02-2.815l.588 2.815zm-8.16-4.84l-1.603 7.496H8.34l1.605-7.496z';

const groupPan = (pan: string) => pan.replace(/(\d{4})(?=\d)/g, '$1 ');
const mmyy = (m: number, y: number) => `${String(m).padStart(2, '0')}/${String(y).slice(-2)}`;

// Контактная площадка чипа: серебро, как в макете «Аврора».
function Chip() {
  const id = useId();
  return (
    <svg className="bank-card-chip" width={40} height={30} viewBox="0 0 42 32" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#eef1f7" />
          <stop offset="0.5" stopColor="#9aa5b8" />
          <stop offset="1" stopColor="#dfe5ef" />
        </linearGradient>
      </defs>
      <rect x={0.5} y={0.5} width={41} height={31} rx={6} fill={`url(#${id})`} stroke="rgba(0,0,0,.25)" />
      <path d="M14 .5V10H.5M14 31.5V22H.5M28 .5V10h13.5M28 31.5V22h13.5M14 10h14v12H14z" fill="none" stroke="rgba(0,0,0,.28)" />
    </svg>
  );
}

// Виртуальная карта GUDEX «Аврора»: тёмное стекло с фирменным сиянием и контурным щитом.
export function BankCard({ card, sensitive, placeholder }: { card?: CardDto; sensitive?: CardSensitiveDto | null; placeholder?: boolean }) {
  const { t } = useTranslation();
  const pending = card?.status === 'pending';
  const needsReview = pending && card.pendingOperationStatus === 'unknown';
  const frozen = card?.status === 'frozen';
  const number = placeholder
    ? '•••• •••• •••• ••••'
    : sensitive
      ? groupPan(sensitive.pan)
      : `•••• •••• •••• ${card?.last4 ?? '••••'}`;
  const expiry = sensitive
    ? mmyy(sensitive.expiryMonth, sensitive.expiryYear)
    : card?.expiryMonth && card.expiryYear
      ? mmyy(card.expiryMonth, card.expiryYear)
      : '••/••';

  return (
    <div className={`bank-card${frozen ? ' frozen' : ''}`}>
      <svg className="bank-card-shield" viewBox="-2 -2 51 58" aria-hidden>
        <path d={SHIELD} />
      </svg>
      <i className="bank-card-grain" aria-hidden />
      <div className="row between">
        <span className="bank-card-logo">
          <LogoMark size={22} />
          GUDEX
        </span>
        <span className="bank-card-tag">{sensitive ? `CVV ${sensitive.cvv}` : 'VIRTUAL'}</span>
      </div>
      <Chip />
      <div className="number">{number}</div>
      <div className="row between" style={{ alignItems: 'flex-end' }}>
        <div className="bank-card-holder">
          <span className="ellipsis">{sensitive?.holderName ?? card?.holderName ?? 'GUDEX CARD'}</span>
          <small>{expiry}</small>
        </div>
        <svg className="visa" height={22} viewBox="0 7.6 24 8.8" role="img" aria-label="Visa">
          <path d={VISA} />
        </svg>
      </div>
      {pending || frozen ? (
        <div className="card-overlay">
          <span className="badge">
            {needsReview ? <Icon name="alert" size={18} /> : pending ? <Spinner /> : <Icon name="snowflake" size={18} />}
            {needsReview ? t('issue.pendingLabel') : pending ? t('card.issuing') : t('card.frozen')}
          </span>
        </div>
      ) : null}
    </div>
  );
}
