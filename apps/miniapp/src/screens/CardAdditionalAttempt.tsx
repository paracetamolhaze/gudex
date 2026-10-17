import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Button, Loading, Notice, Page, QueryError, Row, Surface } from '../components/ui';
import { additionalAttemptConsent, freshAdditionalAttempt } from '../lib/additional-attempt';
import { useFormat } from '../lib/format';
import { useAdditionalAttempt, useAdditionalAttemptQuote } from '../lib/queries';
import { haptic } from '../lib/telegram';
import { CardOperationProgress } from './Wallet';

export function CardAdditionalAttempt() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const navigate = useNavigate();
  const [operationId, setOperationId] = useState<string | null>(null);
  const quote = useAdditionalAttemptQuote(operationId === null);
  const attempt = useAdditionalAttempt();
  const [acceptedToken, setAcceptedToken] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const idempotencyKey = useRef(crypto.randomUUID()).current;
  const token = quote.data?.eligible ? quote.data.quoteToken : null;
  useEffect(() => { setAcceptedToken(null); }, [token, quote.error, quote.isFetching]);
  useEffect(() => {
    const expiry = quote.data?.eligible ? Date.parse(quote.data.expiresAt) : NaN;
    if (!Number.isFinite(expiry)) return;
    const timer = setTimeout(() => { setNow(Date.now()); setAcceptedToken(null); }, Math.max(0, expiry - Date.now()));
    return () => clearTimeout(timer);
  }, [quote.data]);

  const existingId = quote.data?.eligible === false ? quote.data.existingOperation?.id : undefined;
  if (operationId || existingId) return <CardOperationProgress operationId={operationId ?? existingId!} title={t('issue.title')} kind="issue" />;
  if (quote.error) return <Page title={t('additionalAttempt.title')}><QueryError error={quote.error} onRetry={() => void quote.refetch()} /></Page>;
  if (!quote.data) return <Loading />;
  const terms = !quote.isFetching ? freshAdditionalAttempt(quote.data, now) : null;
  if (!terms) return <Page title={t('additionalAttempt.title')}>
    <Notice text={t(quote.data.eligible ? 'additionalAttempt.expired' : 'additionalAttempt.unavailable')} />
    {quote.data.eligible ? <Button title={t('common.refresh')} loading={quote.isFetching} onClick={() => void quote.refetch()} /> : null}
    <Button title={t('home.card')} variant="secondary" onClick={() => navigate('/card', { replace: true })} />
  </Page>;
  const consent = additionalAttemptConsent(terms, acceptedToken, idempotencyKey, now);
  return <Page title={t('additionalAttempt.title')}>
    <Notice tone="warning" text={t('additionalAttempt.originalUnknown')} />
    <Surface className="stack">
      <Row label={t('additionalAttempt.customerCharge')} value={fmt.amount(terms.customerCharge, 'USDT')} />
      <Row label={t('additionalAttempt.retained')} value={fmt.amount(terms.retainedBrokerReserveUsd, 'USD')} />
      <Row label={t('additionalAttempt.additional')} value={fmt.amount(terms.additionalBrokerCostUsd, 'USD')} />
      <Row label={t('additionalAttempt.cumulative')} value={fmt.amount(terms.maximumCumulativeCostUsd, 'USD')} strong />
    </Surface>
    <Notice tone="warning" text={t('additionalAttempt.twoCards')} />
    <label className="additional-attempt-ack">
      <input type="checkbox" checked={acceptedToken === terms.quoteToken} disabled={attempt.isPending}
        onChange={(event) => setAcceptedToken(event.target.checked ? terms.quoteToken : null)} />
      <span>{t('additionalAttempt.acknowledge')}</span>
    </label>
    {attempt.error ? <Notice tone="danger" text={fmt.error(attempt.error)} /> : null}
    <Button title={t('additionalAttempt.confirm', { amount: terms.additionalBrokerCostUsd })} loading={attempt.isPending} disabled={!consent}
      onClick={() => {
        // Recheck expiry at the human click, including a suspended/backgrounded MiniApp.
        const current = !quote.error && !quote.isFetching ? additionalAttemptConsent(quote.data, acceptedToken, idempotencyKey) : null;
        if (!current) { setAcceptedToken(null); setNow(Date.now()); return; }
        attempt.mutate(current, { onSuccess: ({ operation }) => setOperationId(operation.id),
          onError: () => { setAcceptedToken(null); haptic.error(); void quote.refetch(); } });
      }} />
    <Button title={t('common.cancel')} variant="ghost" disabled={attempt.isPending} onClick={() => navigate('/card', { replace: true })} />
  </Page>;
}
