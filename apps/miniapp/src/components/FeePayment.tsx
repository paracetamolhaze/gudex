import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NETWORKS, type FeeWalletDto, type FeeWalletNetwork, type WalletAsset } from '@gudex/shared';
import { useFormat } from '../lib/format';
import { useCreateFeePayment, useFeePayment, useInvalidateMoney } from '../lib/queries';
import { haptic } from '../lib/telegram';
import { Icon } from './Icon';
import { Button, Loading, Notice, QueryError, Row, Segmented, Spinner, Surface } from './ui';

export function CopyRow({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return <button className="row link" style={{ color: 'var(--text)', textAlign: 'left', wordBreak: 'break-all' }} aria-label={label}
    onClick={async () => { await navigator.clipboard?.writeText(value).catch(() => {}); haptic.success(); setCopied(true); }}>
    <span className="body-medium grow mono">{value}</span>
    <Icon name={copied ? 'check' : 'copy'} color="var(--primary)" size={20} />
  </button>;
}

// Milliseconds left until the deadline (a local timestamp), refreshed every second.
function useTimeLeft(deadline: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  return deadline === undefined ? null : Math.max(0, deadline - now);
}

const clock = (ms: number) => {
  const seconds = Math.ceil(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

// The issuance fee goes to an app wallet address lent to this client only; the address tells who paid.
export function FeePaymentPanel({ wallet, onPaid }: { wallet: FeeWalletDto; onPaid: () => void }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const payment = useFeePayment(true);
  const create = useCreateFeePayment();
  const invalidate = useInvalidateMoney();
  const [asset, setAsset] = useState<WalletAsset>('USDT');
  const [network, setNetwork] = useState<FeeWalletNetwork | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [qr, setQr] = useState('');
  const current = payment.data;
  const awaiting = current?.status === 'awaiting' && !choosing;
  const assets = [...new Set(wallet.networks.flatMap(item => item.assets))];
  const networks = wallet.networks.filter(item => item.assets.includes(asset)).map(item => item.network);
  const selected = network && networks.includes(network) ? network : networks[0] ?? null;
  const received = current ? Number(current.received) > 0 : false;
  // The server says how many seconds are left; counting from when that answer arrived ignores a wrong phone clock.
  const left = useTimeLeft(current?.status === 'awaiting' ? payment.dataUpdatedAt + current.secondsLeft * 1000 : undefined);

  useEffect(() => {
    if (current?.status !== 'paid' && !received) return;
    invalidate();
    if (current?.status === 'paid') onPaid();
  }, [current?.status, current?.received, current?.id]);
  // When the time is up the server ends the lease; the panel then offers a new address.
  useEffect(() => { if (left === 0) void payment.refetch(); }, [left === 0]);
  useEffect(() => {
    let cancelled = false;
    setQr('');
    if (current?.status === 'awaiting') void QRCode.toString(current.address, { type: 'svg', margin: 0 })
      .then(svg => { if (!cancelled) setQr(svg); }).catch(() => {});
    return () => { cancelled = true; };
  }, [current?.address, current?.status]);

  if (payment.error && !current) return <QueryError error={payment.error} onRetry={() => void payment.refetch()} />;
  if (payment.isPending) return <Loading />;
  // Right after paying the screen moves on by itself; if it is still here a while later, the client can pay the rest.
  const paidNotice = current?.status === 'paid' ? <Notice icon="check" text={t('fee.paid', { amount: current.received, asset: current.asset })} /> : null;
  if (current?.status === 'paid' && Date.now() - Date.parse(current.paidAt ?? current.createdAt) < 2 * 60_000) return paidNotice;

  if (awaiting) {
    const networkName = NETWORKS[current.network].name;
    const minutes = Math.max(1, Math.round((Date.parse(current.expiresAt) - Date.parse(current.createdAt)) / 60_000));
    return <Surface className="stack">
      <div className="stack-sm" style={{ alignItems: 'center', textAlign: 'center' }} role="timer" aria-live="off">
        <span className="caption muted">{t('fee.timeLeft')}</span>
        <span className="display mono" style={left !== null && left < 2 * 60_000 ? { color: 'var(--danger)' } : undefined}>{clock(left ?? 0)}</span>
        <span className="caption muted">{t('fee.timerHint', { minutes })}</span>
      </div>
      <Row label={t('fee.send')} value={`${current.amount} ${current.asset}`} strong />
      <Row label={t('fee.network')} value={networkName} />
      <div style={{ display: 'flex', justifyContent: 'center' }}><div className="qr" dangerouslySetInnerHTML={{ __html: qr }} /></div>
      <span className="caption muted">{t('fee.address')}</span>
      <CopyRow value={current.address} label={t('fee.copyAddress')} />
      {received ? <Notice tone="warning" text={t('fee.partial', { received: current.received, missing: current.missing, asset: current.asset })} />
        : <Notice tone="warning" text={t('fee.warning', { amount: current.amount, asset: current.asset, network: networkName })} />}
      <div className="row" role="status" aria-live="polite"><Spinner /><span className="caption muted grow">{t('fee.waiting')}</span></div>
      <Button small variant="ghost" title={t('fee.change')} onClick={() => { create.reset(); setChoosing(true); }} />
    </Surface>;
  }

  const partlyPaid = current?.status === 'expired' && Number(current.received) > 0;
  return <Surface className="stack">
    {paidNotice}
    <span className="muted">{t('fee.intro', { fee: wallet.fee })}</span>
    {current?.status === 'expired' && !choosing ? <Notice tone="warning" text={partlyPaid
      ? t('fee.partialExpired', { received: current.received, missing: current.missing, asset: current.asset }) : t('fee.expired')} /> : null}
    <span className="label muted">{t('fee.asset')}</span>
    <Segmented<WalletAsset> options={assets.map(value => ({ value, label: value }))} value={asset} onChange={value => { create.reset(); setAsset(value); }} />
    <span className="label muted">{t('fee.network')}</span>
    <Segmented<FeeWalletNetwork> options={networks.map(value => ({ value, label: NETWORKS[value].short }))} value={selected ?? networks[0]!}
      onChange={value => { create.reset(); setNetwork(value); }} />
    {create.error ? <Notice tone="danger" text={fmt.error(create.error)} /> : null}
    <Button title={t('fee.getAddress')} loading={create.isPending} disabled={!selected}
      onClick={() => create.mutate({ asset, network: selected! }, { onSuccess: () => { setChoosing(false); haptic.success(); }, onError: () => haptic.error() })} />
  </Surface>;
}
