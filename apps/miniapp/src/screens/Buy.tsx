import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Mascot } from '../components/Mascot';
import { ServiceNotice } from '../components/misc';
import { Button, Loading, Notice, Page, QueryError, Spinner, Surface } from '../components/ui';
import { useExchangeSession, useInvalidateMoney } from '../lib/queries';
import { mountWhiteBird } from '../lib/whitebird';

// Покупка и продажа крипты картой — виджет партнёра WhiteBird внутри приложения.
// Купленные монеты WhiteBird отправляет на адрес пополнения GUDEX клиента, дальше — обычное зачисление.
export function Buy() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const session = useExchangeSession();
  const invalidateMoney = useInvalidateMoney();
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [mounted, setMounted] = useState(false);

  const data = session.data;
  useEffect(() => {
    if (!data?.ready || !data.options.length || !container.current) return;
    let unmount: (() => void) | undefined;
    let cancelled = false;
    // Первая валюта по умолчанию — USDT в TRC-20. Зачисление придёт обычным депозитом на наш адрес.
    mountWhiteBird(container.current, { session: data, option: data.options[0]!, onArrived: () => invalidateMoney() })
      .then((cleanup) => {
        if (cancelled) cleanup();
        else {
          unmount = cleanup;
          setMounted(true);
        }
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
      unmount?.();
    };
  }, [data, invalidateMoney]);

  if (session.isLoading) return <Loading />;
  if (session.error && !data) return <Page title={t('buy.title')}><QueryError error={session.error} onRetry={() => void session.refetch()} /></Page>;

  if (!data?.ready) {
    return (
      <Page title={t('buy.title')}>
        <div className="stack" style={{ alignItems: 'center', textAlign: 'center', paddingTop: 8 }}>
          <Mascot pose="pay" size={190} motion="pop" />
          <h2 className="heading">{t('buy.soonTitle')}</h2>
          <span className="muted">{t('buy.soonText')}</span>
        </div>
        <Button title={t('buy.toDeposit')} icon="arrowDown" onClick={() => navigate('/deposit', { replace: true })} />
      </Page>
    );
  }

  return (
    <Page title={t('buy.title')}>
      <ServiceNotice />
      <Notice icon="check" text={t('buy.arrives')} />
      {failed || session.error ? (
        <Notice
          tone="danger"
          text={t('buy.error')}
          action={
            <Button
              small
              variant="ghost"
              title={t('common.retry')}
              onClick={() => {
                setFailed(false);
                session.refetch();
              }}
            />
          }
        />
      ) : null}
      <Surface className="exchange-widget" flush>
        {!mounted && !failed ? (
          <div className="center-row">
            <Spinner large />
          </div>
        ) : null}
        <div ref={container} />
      </Surface>
      <span className="caption muted">{t('buy.partner')}</span>
    </Page>
  );
}
