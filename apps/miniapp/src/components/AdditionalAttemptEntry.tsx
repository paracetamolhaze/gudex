import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { freshAdditionalAttempt } from '../lib/additional-attempt';
import { useAdditionalAttemptQuote } from '../lib/queries';
import { isCardRegionRestricted } from '../lib/error-format';
import { Button, Notice } from './ui';

// Eligibility is server-owned; ordinary customers never see this exceptional action.
export function AdditionalAttemptEntry() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const quote = useAdditionalAttemptQuote();
  if (isCardRegionRestricted(quote.error)) return <Notice tone="warning" text={t('errors.card_region_restricted')} />;
  if (quote.isFetching || quote.error) return null;
  const available = freshAdditionalAttempt(quote.data);
  const existing = quote.data?.eligible === false && quote.data.existingOperation;
  if (!available && !existing) return null;
  return <Button variant="secondary" title={t(existing ? 'additionalAttempt.viewStatus' : 'additionalAttempt.review')}
    onClick={() => navigate('/card/additional-attempt')} />;
}
