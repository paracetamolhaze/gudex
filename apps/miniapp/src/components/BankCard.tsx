import { useTranslation } from 'react-i18next';
import type { CardDto, CardSensitiveDto } from '@gudex/shared';
import { Icon } from './Icon';
import { LogoMark, SHIELD } from './Logo';
import { Spinner } from './ui';

const groupPan = (pan: string) => pan.replace(/(\d{4})(?=\d)/g, '$1 ');
const mmyy = (m: number, y: number) => `${String(m).padStart(2, '0')}/${String(y).slice(-2)}`;

// Виртуальная карта GUDEX: графитовый пластик с синим свечением, как у карты маскота.
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
      <svg className="watermark" width={220} height={253} viewBox="0 0 47 54" aria-hidden>
        <path d={SHIELD} fill="#fff" fillRule="evenodd" />
      </svg>
      <div className="row between">
        <div className="row" style={{ gap: 8 }}>
          <LogoMark size={24} />
          <span className="heading" style={{ letterSpacing: '0.08em', fontWeight: 700 }}>
            GUDEX
          </span>
        </div>
        {sensitive ? <span className="label">CVV {sensitive.cvv}</span> : null}
      </div>
      <div className="number">{number}</div>
      <div className="row between" style={{ alignItems: 'flex-end' }}>
        <div className="stack-sm grow">
          <span className="caption" style={{ opacity: 0.7 }}>
            {expiry}
          </span>
          <span className="label ellipsis">{sensitive?.holderName ?? card?.holderName ?? 'GUDEX CARD'}</span>
        </div>
        <span className="visa">VISA</span>
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
