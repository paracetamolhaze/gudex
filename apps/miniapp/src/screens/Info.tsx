import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { NETWORKS } from '@gudex/shared';
import { Icon } from '../components/Icon';
import { Mascot } from '../components/Mascot';
import { Button, Loading, Notice, Page, QueryError, Row, Surface } from '../components/ui';
import { useFormat } from '../lib/format';
import { useConfig, useReferral } from '../lib/queries';
import { haptic, openLink, openTelegramLink, shareLink } from '../lib/telegram';

// ─── Пригласить друзей ───────────────────────────────────────────────────

export function Referral() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const referral = useReferral();
  const [copied, setCopied] = useState(false);

  if (referral.error && !referral.data) return <Page title={t('referral.title')}><QueryError error={referral.error} onRetry={() => void referral.refetch()} /></Page>;
  if (!referral.data) return <Loading />;
  const { link, invited, earned, shareBps } = referral.data;
  const percent = fmt.percent(shareBps / 100);

  return (
    <Page title={t('referral.title')}>
      <Surface className="promo">
        <div className="stack grow">
          <h2 className="heading">{t('referral.headline', { percent })}</h2>
          <span className="caption muted">{t('referral.text', { percent })}</span>
        </div>
        <Mascot pose="success" size={130} />
      </Surface>

      <Surface className="stack">
        <span className="label muted">{t('referral.link')}</span>
        <button
          className="row link"
          style={{ color: 'var(--text)', textAlign: 'left', wordBreak: 'break-all' }}
          onClick={async () => {
            await navigator.clipboard?.writeText(link).catch(() => {});
            haptic.success();
            setCopied(true);
          }}
        >
          <span className="body-medium grow mono">{link}</span>
          <Icon name={copied ? 'check' : 'copy'} color="var(--primary)" size={20} />
        </button>
        <Button title={t('referral.share')} icon="share" onClick={() => shareLink(link, t('referral.shareText'))} />
      </Surface>

      <div className="row" style={{ alignItems: 'stretch' }}>
        <Surface className="stack grow">
          <span className="caption muted">{t('referral.invited')}</span>
          <span className="heading mono">{invited}</span>
        </Surface>
        <Surface className="stack grow">
          <span className="caption muted">{t('referral.earned')}</span>
          {earned.map((e) => (
            <span key={e.asset} className="body-medium mono">
              {fmt.amount(e.amount, e.asset)}
            </span>
          ))}
        </Surface>
      </div>

      <h2 className="heading">{t('referral.how')}</h2>
      <Surface className="stack">
        {[t('referral.step1'), t('referral.step2'), t('referral.step3', { percent })].map((step, i) => (
          <div key={step} className="row" style={{ alignItems: 'flex-start' }}>
            <span className="step-number">{i + 1}</span>
            <span style={{ paddingTop: 3 }}>{step}</span>
          </div>
        ))}
      </Surface>
    </Page>
  );
}

// ─── Тарифы и лимиты ─────────────────────────────────────────────────────

export function Tariffs() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { data: config } = useConfig();
  if (!config) return <Loading />;
  const { card } = config;
  // Manual issuance: the card is topped up on its own UPay addresses and the wallet only pays the issuance,
  // so in-app top-up, deposit, transfer, withdrawal and referral fees do not apply.
  const manual = config.integration.issuanceMode === 'manual';
  const limits = [
    { label: t('tariffs.perTransaction'), value: card.limits.perTransactionUsd },
    { label: t('tariffs.daily'), value: card.limits.dailyUsd },
    { label: t('tariffs.monthly'), value: card.limits.monthlyUsd },
  ].filter((l): l is { label: string; value: string } => l.value !== null);
  // Комиссия вывода зависит только от сети — одна строка на сеть.
  const withdrawals = new Map(config.assets.flatMap((a) => a.networks).map((n) => [n.id, n]));

  return (
    <Page title={t('tariffs.title')}>
      <h2 className="heading">{t('tariffs.card')}</h2>
      <Surface className="stack">
        <Row label={t('tariffs.issue')} value={fmt.amount(card.issueFeeUsd, 'USD')} />
        <Row label={t('tariffs.service')} value={t('tariffs.free')} />
        {manual ? null : <>
          <Row label={t('tariffs.topupFee')} value={`${fmt.percent(card.topupFeeBps / 100)}%`} />
          <Row label={t('tariffs.topupMin')} value={fmt.amount(card.minTopupUsd, 'USD')} />
        </>}
        <Row label={t('tariffs.rate')} value="1 USDT = 1 USDC = $1" />
        <Row label={t('tariffs.maxCards')} value={String(card.maxCardsPerUser)} />
      </Surface>

      {limits.length ? (
        <>
          <h2 className="heading">{t('tariffs.limits')}</h2>
          <Surface className="stack">
            {limits.map((l) => (
              <Row key={l.label} label={l.label} value={fmt.amount(l.value, 'USD')} />
            ))}
          </Surface>
        </>
      ) : null}

      {manual ? null : <>
      <h2 className="heading">{t('tariffs.wallet')}</h2>
      <Surface className="stack">
        <Row label={t('tariffs.deposit')} value={t('tariffs.free')} />
        <Row label={t('tariffs.depositMin')} value={fmt.amount(config.assets[0]!.minDeposit, 'USD')} />
        <Row label={t('tariffs.transfers')} value={t('tariffs.free')} />
        <Row label={t('tariffs.referral')} value={t('tariffs.referralValue', { percent: fmt.percent(config.referral.shareBps / 100) })} />
      </Surface>

      <h2 className="heading">{t('tariffs.withdrawals')}</h2>
      <Surface className="stack">
        {[...withdrawals.values()].map((n) => (
          <Row
            key={n.id}
            label={NETWORKS[n.id].name}
            value={t('tariffs.withdrawValue', { fee: fmt.amount(n.withdrawFee, 'USD'), min: fmt.amount(n.minWithdraw, 'USD') })}
          />
        ))}
      </Surface>
      <span className="caption muted">{t('tariffs.withdrawNote')}</span>
      </>}
    </Page>
  );
}

// ─── Помощь ──────────────────────────────────────────────────────────────

const FAQ = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;

export function Help() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: config } = useConfig();
  const [open, setOpen] = useState<number | null>(null);
  if (!config) return <Loading />;
  const { channel, site } = config.links;

  return (
    <Page title={t('help.title')}>
      <div className="stack">
        <Button title={t('help.support')} icon="chat" onClick={() => navigate('/support')} />
        {channel ? (
          <Button title={t('help.channel')} icon="megaphone" variant="secondary" onClick={() => openTelegramLink(`https://t.me/${channel}`)} />
        ) : null}
        <Button title={t('help.site')} icon="globe" variant="secondary" onClick={() => openLink(site)} />
      </div>
      <Notice icon="shield" text={t('help.safety')} />

      <h2 className="heading">{t('help.faq')}</h2>
      <Surface flush>
        {FAQ.map((n) => (
          <div key={n} className="faq-item">
            <button
              className="list-item"
              onClick={() => {
                haptic.select();
                setOpen(open === n ? null : n);
              }}
            >
              <span className="body-medium grow">{t(`help.q${n}`)}</span>
              <span className={`faq-chevron${open === n ? ' open' : ''}`}>
                <Icon name="chevronDown" color="var(--muted)" size={18} />
              </span>
            </button>
            {open === n ? <p className="faq-answer muted">{t(`help.a${n}`, { fee: config.card.issueFeeUsd })}</p> : null}
          </div>
        ))}
      </Surface>
    </Page>
  );
}
