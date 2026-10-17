import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { AssetIcon } from '../components/AssetIcon';
import { BankCard } from '../components/BankCard';
import { Mascot } from '../components/Mascot';
import { ActivityRow, KycBanner, ServiceNotice, TestModeBanner } from '../components/misc';
import { ActionButton, Button, Page, QueryError, SectionTitle, Surface } from '../components/ui';
import { useFormat } from '../lib/format';
import { useActivity, useCards, useMe, useWallet } from '../lib/queries';

export function Home() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const navigate = useNavigate();
  const wallet = useWallet();
  const cards = useCards();
  const activity = useActivity(5);
  const { data: me } = useMe();
  const card = cards.data?.[0];
  const clientReady = me !== undefined && cards.data !== undefined;
  const openCardFlow = () => navigate(me?.kyc.status === 'approved' ? '/card/issue' : '/kyc');

  return (
    <Page tabbar>
      <ServiceNotice />
      <TestModeBanner />
      {wallet.error ? <QueryError error={wallet.error} onRetry={() => void wallet.refetch()} /> : null}
      {cards.error ? <QueryError error={cards.error} onRetry={() => void cards.refetch()} /> : null}

      <div className="stack-sm">
        <span className="label muted">{t('home.totalBalance')}</span>
        <span className="display mono">{wallet.data ? fmt.amount(wallet.data.totalUsd, 'USD') : '—'}</span>
      </div>

      <KycBanner />

      {card ? (
        <button className="link" style={{ color: 'inherit' }} onClick={() => navigate('/card')}>
          <BankCard card={card} />
        </button>
      ) : clientReady && me.kyc.status === 'approved' ? (
        <Surface className="promo">
          <div className="stack grow">
            <h2 className="heading">{t('home.getCardTitle')}</h2>
            <span className="caption muted">{t('home.getCardText')}</span>
            <Button small title={t('home.getCard')} icon="card" onClick={openCardFlow} />
          </div>
          <Mascot pose="card" size={150} />
        </Surface>
      ) : null}

      {clientReady ? <div className="actions">
        <ActionButton icon="arrowDown" label={t('home.deposit')} onClick={() => navigate('/deposit')} />
        <ActionButton icon="send" label={t('home.transfer')} onClick={() => navigate('/transfer')} />
        <ActionButton icon="arrowUpRight" label={t('home.withdraw')} onClick={() => navigate('/withdraw')} />
        <ActionButton icon="card" label={t('home.card')} onClick={() => navigate('/card')} />
      </div> : null}

      <SectionTitle title={t('home.assets')} />
      <Surface flush>
        {(wallet.data?.balances ?? []).map((b) => (
          <button key={b.asset} className="list-item" onClick={() => navigate(`/deposit?asset=${b.asset}`)}>
            <AssetIcon asset={b.asset} />
            <span className="stack-sm grow">
              <span className="body-medium">{b.asset}</span>
              <span className="caption muted">{b.asset === 'USDT' ? 'Tether' : 'USD Coin'}</span>
            </span>
            <span className="body-medium mono">{fmt.amount(b.amount, b.asset)}</span>
          </button>
        ))}
      </Surface>

      <SectionTitle
        title={t('home.recent')}
        action={
          activity.data?.length ? (
            <button className="link label" onClick={() => navigate('/history')}>
              {t('common.all')}
            </button>
          ) : null
        }
      />
      <Surface>
        {activity.error ? <QueryError error={activity.error} onRetry={() => void activity.refetch()} /> : null}
        {activity.data?.length ? (
          activity.data.map((item) => <ActivityRow key={item.id} item={item} />)
        ) : activity.error ? null : (
          <div className="row">
            <Mascot pose="chill" size={90} motion="none" />
            <span className="muted grow">{t('home.noActivity')}</span>
          </div>
        )}
      </Surface>
    </Page>
  );
}
