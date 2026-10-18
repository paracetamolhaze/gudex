import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { type ActivityItemDto, type Locale, type Network, NETWORKS, type WalletAsset, type WalletDto } from '@gudex/shared';
import { setLocale } from '../i18n';
import { shortAddress, useFormat } from '../lib/format';
import { useActivity, useCards, useConfig, useMe, useNotice } from '../lib/queries';
import { haptic } from '../lib/telegram';
import { AssetIcon } from './AssetIcon';
import { Icon, type IconName } from './Icon';
import { Notice, Segmented } from './ui';

const ACTIVITY_ICON: Record<ActivityItemDto['kind'], IconName> = {
  deposit: 'arrowDown',
  withdrawal: 'arrowUpRight',
  transfer_in: 'send',
  transfer_out: 'send',
  referral_reward: 'gift',
  card_issue: 'card',
  card_topup: 'arrowUp',
  card_purchase: 'bag',
  card_refund: 'arrowDown',
};

export function ActivityRow({ item }: { item: ActivityItemDto }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const incoming = item.amount.startsWith('+');
  const failed = item.status === 'failed';
  const title =
    item.kind === 'card_purchase' && item.merchant
      ? item.merchant
      : t(`activity.${item.kind}`, { asset: item.asset, who: item.counterparty ?? '' });
  const details = [
    fmt.time(item.createdAt),
    item.cardLast4 ? `•• ${item.cardLast4}` : null,
    item.kind === 'withdrawal' && item.counterparty ? shortAddress(item.counterparty) : null,
    item.network,
    item.kind === 'card_issue' && item.fundingSource === 'broker' ? t('activity.brokerFunded') : null,
    item.status === 'pending' ? t('activity.pending') : null,
    failed ? t('activity.failed') : null,
    item.status === 'unknown' ? t('activity.unknown') : null,
  ].filter(Boolean);

  return (
    <div className="row" style={{ padding: '8px 0' }}>
      <span className="icon-circle" style={{ width: 42, height: 42 }}>
        <Icon name={ACTIVITY_ICON[item.kind]} color={incoming ? 'var(--success)' : 'var(--primary)'} size={20} />
      </span>
      <div className="stack-sm grow">
        <span className="body-medium ellipsis">{title}</span>
        <span className={`caption ellipsis ${failed ? 'danger-text' : 'muted'}`}>{details.join(' · ')}</span>
      </div>
      <span
        className={`body-medium mono ${failed ? 'muted' : incoming ? 'success-text' : ''}`}
        style={failed ? { textDecoration: 'line-through' } : undefined}
      >
        {fmt.amount(item.amount, item.asset, { sign: true })}
      </span>
    </div>
  );
}

// Объявление о сбоях и технических работах. Текст задаёт администратор командой боту /notice.
export function ServiceNotice() {
  const { data } = useNotice();
  if (!data?.message) return null;
  return <Notice tone="warning" icon="megaphone" text={data.message} />;
}

// Выбор сети: короткие названия, чтобы пять сетей помещались в одну строку.
export function NetworkPicker({ networks, value, onChange }: { networks: Network[]; value: Network; onChange: (n: Network) => void }) {
  return <Segmented<Network> options={networks.map((n) => ({ value: n, label: NETWORKS[n].short }))} value={value} onChange={onChange} />;
}

// Тестовый режим: чтобы никто не отправил на адрес-заглушку реальные деньги.
export function TestModeBanner() {
  const { t } = useTranslation();
  const { data: config } = useConfig();
  if (!config) return null;
  const demo = config.integration.cardPartner === 'mock' || config.integration.deposits === 'demo' || config.integration.withdrawals === 'demo';
  if (demo) return <Notice tone="warning" icon="flask" text={`${t('common.testMode')}. ${t('common.testModeHint')}`} />;
  if (!config.integration.capabilities.issue && !config.integration.capabilities.topup && !config.integration.capabilities.freeze) return <Notice tone="warning" text={t('integration.cardUnavailable')} />;
  return null;
}

export function KycBanner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const { data: config } = useConfig();
  const { data: cards } = useCards();
  const status = me?.kyc.status;
  if (!status || status === 'approved') return null;
  const application = config?.integration.issuanceMode === 'manual';
  // A new client starts from the «Get a card» offer on the home screen, which opens the application.
  if (application && status === 'none') return null;
  const unpaid = application && cards !== undefined && !cards.some(card => card.status === 'pending' && card.pendingFulfillmentMode === 'manual');
  const text = { none: t(application ? 'home.applicationNeeded' : 'home.kycNeeded'), pending: me?.kyc.submissionState === 'unknown' ? t('kyc.unknownTitle') :
    me?.kyc.submissionState === 'manual_review' ? t(unpaid ? 'home.applicationUnpaid' : 'home.applicationPending') : t('home.kycPending'), unknown: t('kyc.unknownTitle'),
    rejected: t(application ? 'home.applicationRejected' : 'home.kycRejected') }[status];
  return (
    <button className="link" style={{ color: 'inherit', textAlign: 'left' }} onClick={() => navigate('/kyc')}>
      <Notice
        tone={status === 'rejected' ? 'danger' : 'info'}
        icon="shield"
        text={text}
        action={status === 'pending' && !unpaid ? undefined : <Icon name="chevronRight" color="var(--muted)" size={18} />}
      />
    </button>
  );
}

const CARD_ACTIVITY_SEEN_KEY = 'gudex.cardActivitySeenAt';

// Card purchases and refunds are shown inside the Mini App instead of Telegram messages:
// a notice lists operations newer than the last time the client looked at them.
export function CardActivityNotice() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const fmt = useFormat();
  const { data } = useActivity(20);
  let seen = 0;
  try {
    seen = Number(localStorage.getItem(CARD_ACTIVITY_SEEN_KEY) ?? 0);
    if (!seen) localStorage.setItem(CARD_ACTIVITY_SEEN_KEY, String(Date.now()));
  } catch { /* storage may be unavailable; the history still shows everything */ }
  if (!seen || !data) return null;
  const fresh = data.filter(item => (item.kind === 'card_purchase' || item.kind === 'card_refund') && Date.parse(item.createdAt) > seen);
  if (!fresh.length) return null;
  const latest = fresh[0]!;
  const open = () => {
    try { localStorage.setItem(CARD_ACTIVITY_SEEN_KEY, String(Date.now())); } catch { /* ignore */ }
    navigate('/history');
  };
  return (
    <button className="link" style={{ color: 'inherit', textAlign: 'left' }} onClick={open}>
      <Notice icon="card" text={t('home.cardActivity', { count: fresh.length, merchant: latest.merchant ?? '', amount: fmt.amount(latest.amount, 'USD') })}
        action={<Icon name="chevronRight" color="var(--muted)" size={18} />} />
    </button>
  );
}

// Выбор, с какого баланса списывать: USDT или USDC, с остатком.
export function AssetPicker({ wallet, value, onChange }: { wallet?: WalletDto; value: WalletAsset; onChange: (a: WalletAsset) => void }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  return (
    <div className="row" style={{ alignItems: 'stretch' }}>
      {(wallet?.balances ?? []).map((b) => (
        <button
          key={b.asset}
          className="surface grow stack"
          style={{ gap: 8, textAlign: 'left', cursor: 'pointer', borderWidth: 2, borderColor: b.asset === value ? 'var(--primary)' : 'var(--border)' }}
          onClick={() => {
            haptic.select();
            onChange(b.asset);
          }}
        >
          <span className="row" style={{ gap: 8 }}>
            <AssetIcon asset={b.asset} size={28} />
            <span className="body-medium">{b.asset}</span>
          </span>
          <span className="caption muted">{t('issue.available', { amount: fmt.amount(b.amount, b.asset) })}</span>
        </button>
      ))}
    </div>
  );
}

export function LanguageSwitch({ onChange }: { onChange?: (locale: Locale) => void }) {
  const { i18n } = useTranslation();
  const value: Locale = i18n.language === 'en' ? 'en' : 'ru';
  return (
    <Segmented<Locale>
      options={[
        { value: 'ru', label: 'Русский' },
        { value: 'en', label: 'English' },
      ]}
      value={value}
      onChange={(locale) => {
        setLocale(locale);
        onChange?.(locale);
      }}
    />
  );
}
