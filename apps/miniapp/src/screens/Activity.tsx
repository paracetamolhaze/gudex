import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useParams } from 'react-router';
import { type ActivityItemDto, NETWORKS } from '@gudex/shared';
import { Icon } from '../components/Icon';
import { ACTIVITY_ICON, activityTitle } from '../components/misc';
import { Button, Loading, Notice, Page, QueryError, Surface } from '../components/ui';
import { shortAddress, useFormat } from '../lib/format';
import { useActivity } from '../lib/queries';
import { haptic, openLink } from '../lib/telegram';

type Detail = { key: string; label: string; value: string; copy?: string };

/** История › операция: всё, что известно об операции, с копированием хэша, адреса и номера. */
export function ActivityDetails() {
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const { id = '' } = useParams<{ id: string }>();
  const passed = (useLocation().state as { item?: ActivityItemDto } | null)?.item;
  const activity = useActivity(100);
  const [copied, setCopied] = useState<string | null>(null);
  // The list's copy wins when it has the operation: a pending one may have finished since the row was tapped.
  const item = activity.data?.find((entry) => entry.id === id) ?? (passed?.id === id ? passed : undefined);

  if (!item) {
    if (activity.isLoading) return <Loading />;
    return (
      <Page title={t('activity.title')}>
        {activity.error ? <QueryError error={activity.error} onRetry={() => void activity.refetch()} /> : <Notice text={t('activity.notFound')} />}
      </Page>
    );
  }

  const incoming = item.amount.startsWith('+');
  const failed = item.status === 'failed';
  const status = {
    succeeded: t('activity.done'),
    pending: t('activity.pending'),
    failed: t('activity.failedShort'),
    unknown: t('activity.unknownShort'),
  }[item.status];
  const date = new Date(item.createdAt).toLocaleString(i18n.language === 'en' ? 'en-GB' : 'ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  // The operation number support can ask for: the record id without its kind prefix.
  const reference = item.id.slice(item.id.indexOf(':') + 1);
  const counterpartyLabel = item.kind === 'withdrawal' ? t('activity.address') : item.kind === 'transfer_in' ? t('activity.from') : t('activity.to');
  const rows: (Detail | null)[] = [
    { key: 'date', label: t('activity.date'), value: date },
    item.merchant ? { key: 'type', label: t('activity.type'), value: t(`activity.${item.kind}`, { asset: item.asset, who: '' }) } : null,
    item.cardLast4 ? { key: 'card', label: t('activity.card'), value: `•• ${item.cardLast4}` } : null,
    item.network ? { key: 'network', label: t('activity.network'), value: NETWORKS[item.network].name } : null,
    item.counterparty
      ? item.kind === 'withdrawal'
        ? { key: 'counterparty', label: counterpartyLabel, value: shortAddress(item.counterparty), copy: item.counterparty }
        : { key: 'counterparty', label: counterpartyLabel, value: item.counterparty }
      : null,
    // A card issue's fee is the whole amount above, so only fees taken on top of an amount get their own row.
    item.kind !== 'card_issue' && item.fee !== null && Number(item.fee) > 0 ? { key: 'fee', label: t('activity.fee'), value: fmt.amount(item.fee, item.asset) } : null,
    item.kind === 'card_issue' && item.fundingSource === 'broker' ? { key: 'paidBy', label: t('activity.paidBy'), value: t('activity.brokerFunded') } : null,
    item.txHash ? { key: 'hash', label: t('activity.txHash'), value: shortAddress(item.txHash), copy: item.txHash } : null,
    { key: 'reference', label: t('activity.reference'), value: reference.slice(0, 8).toUpperCase(), copy: reference },
  ];

  return (
    <Page title={t('activity.title')}>
      <div className="activity-hero">
        <span className="icon-circle">
          <Icon name={ACTIVITY_ICON[item.kind]} color={incoming ? 'var(--success)' : 'var(--primary)'} size={28} />
        </span>
        <span className="muted">{activityTitle(item, t)}</span>
        <span className={`activity-amount ${failed ? 'muted' : incoming ? 'success-text' : ''}`} style={failed ? { textDecoration: 'line-through' } : undefined}>
          {fmt.amount(item.amount, item.asset, { sign: true })}
        </span>
        <span className={`activity-status ${item.status}`}>{status}</span>
      </div>
      {failed ? <Notice tone="danger" text={t('activity.failed')} /> : item.status === 'unknown' ? <Notice tone="warning" text={t('activity.unknown')} /> : null}
      <Surface className="detail-list">
        {rows.filter((row): row is Detail => row !== null).map((row) => (
          <div key={row.key} className="detail-row">
            <span className="muted">{row.label}</span>
            <span className="body-medium detail-value">{row.value}</span>
            {row.copy ? (
              <button
                type="button"
                className="link"
                aria-label={t('common.copy')}
                onClick={async () => {
                  await navigator.clipboard?.writeText(row.copy!).catch(() => {});
                  haptic.success();
                  setCopied(row.key);
                }}
              >
                <Icon name={copied === row.key ? 'check' : 'copy'} color="var(--primary)" size={18} />
              </button>
            ) : null}
          </div>
        ))}
      </Surface>
      {item.explorerUrl ? <Button title={t('activity.explorer')} icon="arrowUpRight" variant="secondary" onClick={() => openLink(item.explorerUrl!)} /> : null}
    </Page>
  );
}
