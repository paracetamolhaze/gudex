import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { DEPOSIT_NETWORKS, fromMinor, isValidAddress, isWalletAsset, NETWORKS, type Network, toMinor, type WalletAsset } from '@gudex/shared';
import { Icon } from '../components/Icon';
import { AssetPicker, KycBanner, NetworkPicker, ServiceNotice, TestModeBanner } from '../components/misc';
import { useConfirmation } from '../components/security';
import { Button, ConfirmSheet, Field, Loading, Notice, Page, QueryError, Row, Surface } from '../components/ui';
import { shortAddress, useFormat } from '../lib/format';
import { fundingEnabled } from '../lib/funding';
import { useConfig, useMe, useRecipient, useTransfer, useWallet, useWithdraw } from '../lib/queries';
import { haptic } from '../lib/telegram';
import { useDebounced } from './Wallet';

// Сумма в минимальных единицах или null, если ввод некорректен. Только для показа — считает сервер.
function minor(amount: string, asset: WalletAsset): bigint | null {
  try {
    return toMinor(amount || '0', asset);
  } catch {
    return null;
  }
}

function AmountField({
  label,
  value,
  onChange,
  available,
  hint,
  maxLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  available: string;
  hint?: string;
  maxLabel: string;
}) {
  return (
    <div style={{ position: 'relative' }}>
      <Field
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, '').replace(',', '.'))}
        inputMode="decimal"
        placeholder="0.00"
        hint={hint}
      />
      <button className="link label" style={{ position: 'absolute', right: 16, top: 42 }} onClick={() => onChange(available)}>
        {maxLabel}
      </button>
    </div>
  );
}

// ─── Вывод на внешний кошелёк ────────────────────────────────────────────

export function Withdraw() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const configQuery = useConfig();
  const walletQuery = useWallet();
  const meQuery = useMe();
  const config = configQuery.data;
  const wallet = walletQuery.data;
  const me = meQuery.data;
  const withdraw = useWithdraw();
  const { confirm, element } = useConfirmation();
  const initial = params.get('asset');
  const [asset, setAsset] = useState<WalletAsset>(isWalletAsset(initial) ? initial : 'USDT');
  const networks = DEPOSIT_NETWORKS[asset];
  const [network, setNetwork] = useState<Network>(networks[0]!);
  const current = networks.includes(network) ? network : networks[0]!;
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  // Один ключ на экран: повторное нажатие не создаст второй вывод.
  const idempotencyKey = useRef(crypto.randomUUID()).current;

  const failedQuery = [configQuery, walletQuery, meQuery].find((query) => query.error && !query.data);
  if (failedQuery) return <Page title={t('withdraw.title')}><QueryError error={failedQuery.error} onRetry={() => void failedQuery.refetch()} /></Page>;
  if (!config || !wallet || !me) return <Loading />;
  const tariff = config.assets.find((a) => a.asset === asset)!.networks.find((n) => n.id === current)!;
  const available = wallet.balances.find((b) => b.asset === asset)?.amount ?? '0';
  const networkName = NETWORKS[current].name;

  const value = minor(amount, asset);
  const fee = toMinor(tariff.withdrawFee, asset);
  const min = toMinor(tariff.minWithdraw, asset);
  const enough = value !== null && value <= toMinor(available, asset);
  const amountOk = value !== null && value >= min && value > fee && enough;
  const addressOk = isValidAddress(current, address);
  const receive = value !== null && value > fee ? fromMinor(value - fee, asset) : null;
  const verified = me?.kyc.status === 'approved';
  const withdrawalsEnabled = fundingEnabled(config.integration.withdrawals);

  const submit = async () => {
    setSheetOpen(false);
    if (!withdrawalsEnabled) return;
    const confirmationToken = await confirm(t('withdraw.reason'));
    if (!confirmationToken) return;
    withdraw.mutate(
      { asset, network: current, address: address.trim(), amount, idempotencyKey, confirmationToken },
      {
        onSuccess: (result) => {
          if (result.status === 'succeeded') haptic.success();
          else if (result.status === 'failed' || result.status === 'unknown') haptic.error();
          navigate('/history', { replace: true });
        },
        onError: () => haptic.error(),
      },
    );
  };

  return (
    <Page title={t('withdraw.title')}>
      <ServiceNotice />
      <TestModeBanner />
      {!withdrawalsEnabled ? <Notice tone="warning" text={t('withdraw.unavailable')} /> : null}
      <KycBanner />
      <AssetPicker wallet={wallet} value={asset} onChange={setAsset} />
      <div className="stack-sm">
        <span className="label muted">{t('withdraw.network')}</span>
        <NetworkPicker networks={networks} value={current} onChange={setNetwork} />
      </div>
      <Field
        label={t('withdraw.address')}
        value={address}
        onChange={(e) => setAddress(e.target.value.trim())}
        placeholder={t('withdraw.addressPlaceholder', { network: networkName })}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        error={address && !addressOk ? t('withdraw.invalidAddress', { network: networkName }) : null}
      />
      <AmountField
        label={t('withdraw.amount')}
        value={amount}
        onChange={setAmount}
        available={available}
        maxLabel={t('withdraw.max')}
        hint={t('withdraw.min', { amount: tariff.minWithdraw, asset })}
      />
      <Surface className="stack">
        <Row label={t('withdraw.fee')} value={fmt.amount(tariff.withdrawFee, asset)} />
        <Row label={t('withdraw.receive')} value={receive ? fmt.amount(receive, asset) : '—'} strong />
      </Surface>
      {value !== null && value > 0n && !enough ? <Notice tone="warning" text={t('errors.insufficient_funds')} /> : null}
      <Notice tone="warning" text={t('withdraw.warning')} />
      {withdraw.error ? <Notice tone="danger" text={fmt.error(withdraw.error)} /> : null}
      <Button
        title={t('withdraw.submit')}
        icon="arrowUpRight"
        loading={withdraw.isPending}
        disabled={!withdrawalsEnabled || !verified || !addressOk || !amountOk}
        onClick={() => setSheetOpen(true)}
      />
      <ConfirmSheet
        open={sheetOpen}
        icon="arrowUpRight"
        title={t('withdraw.confirmTitle')}
        message={t('withdraw.confirmText', { amount: receive ?? '', asset, address: shortAddress(address), network: networkName })}
        confirmLabel={t('withdraw.confirmButton')}
        cancelLabel={t('common.cancel')}
        onConfirm={submit}
        onCancel={() => setSheetOpen(false)}
      />
      {element}
    </Page>
  );
}

// ─── Перевод пользователю GUDEX ──────────────────────────────────────────

export function Transfer() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const navigate = useNavigate();
  const walletQuery = useWallet();
  const meQuery = useMe();
  const wallet = walletQuery.data;
  const me = meQuery.data;
  const transfer = useTransfer();
  const { confirm, element } = useConfirmation();
  const [username, setUsername] = useState('');
  const debounced = useDebounced(username.trim());
  const recipient = useRecipient(debounced);
  const [asset, setAsset] = useState<WalletAsset>('USDT');
  const [amount, setAmount] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const idempotencyKey = useRef(crypto.randomUUID()).current;

  const failedQuery = [walletQuery, meQuery].find((query) => query.error && !query.data);
  if (failedQuery) return <Page title={t('transfer.title')}><QueryError error={failedQuery.error} onRetry={() => void failedQuery.refetch()} /></Page>;
  if (!wallet || !me) return <Loading />;
  const available = wallet.balances.find((b) => b.asset === asset)?.amount ?? '0';
  const value = minor(amount, asset);
  const enough = value !== null && value <= toMinor(available, asset);
  const amountOk = value !== null && value > 0n && enough;
  const found = recipient.data && debounced === username.trim() ? recipient.data : null;
  const verified = me?.kyc.status === 'approved';

  const submit = async () => {
    setSheetOpen(false);
    const confirmationToken = await confirm(t('transfer.reason'));
    if (!confirmationToken || !found) return;
    transfer.mutate(
      { username: found.username, asset, amount, idempotencyKey, confirmationToken },
      {
        onSuccess: () => {
          haptic.success();
          navigate('/history', { replace: true });
        },
        onError: () => haptic.error(),
      },
    );
  };

  return (
    <Page title={t('transfer.title')}>
      <ServiceNotice />
      <TestModeBanner />
      <KycBanner />
      <Field
        label={t('transfer.recipient')}
        value={username}
        onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))}
        placeholder={t('transfer.recipientPlaceholder')}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        hint={t('transfer.recipientHint')}
        error={recipient.error && username ? fmt.error(recipient.error) : null}
      />
      {found ? (
        <Surface className="row">
          <span className="avatar">
            <Icon name="user" color="var(--primary)" />
          </span>
          <div className="stack-sm grow">
            <span className="body-medium ellipsis">{found.name ?? `@${found.username}`}</span>
            <span className="caption muted">@{found.username}</span>
          </div>
          <Icon name="check" color="var(--success)" size={20} />
        </Surface>
      ) : null}
      <AssetPicker wallet={wallet} value={asset} onChange={setAsset} />
      <AmountField label={t('transfer.amount')} value={amount} onChange={setAmount} available={available} maxLabel={t('withdraw.max')} hint={t('transfer.free')} />
      {value !== null && value > 0n && !enough ? <Notice tone="warning" text={t('errors.insufficient_funds')} /> : null}
      {transfer.error ? <Notice tone="danger" text={fmt.error(transfer.error)} /> : null}
      <Button
        title={t('transfer.submit')}
        icon="send"
        loading={transfer.isPending}
        disabled={!verified || !found || !amountOk}
        onClick={() => setSheetOpen(true)}
      />
      <ConfirmSheet
        open={sheetOpen}
        icon="send"
        title={t('transfer.confirmTitle')}
        message={t('transfer.confirmText', { amount, asset, username: found?.username ?? '' })}
        confirmLabel={t('transfer.confirmButton')}
        cancelLabel={t('common.cancel')}
        onConfirm={submit}
        onCancel={() => setSheetOpen(false)}
      />
      {element}
    </Page>
  );
}
