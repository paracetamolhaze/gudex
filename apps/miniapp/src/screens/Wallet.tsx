import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { DEPOSIT_NETWORKS, isWalletAsset, NETWORKS, type Network, type OperationDto, type WalletAsset } from '@gudex/shared';
import { BankCard } from '../components/BankCard';
import { Icon } from '../components/Icon';
import { AssetPicker, NetworkPicker, ServiceNotice, TestModeBanner } from '../components/misc';
import { Button, Field, Loading, Notice, Page, QueryError, Row, Segmented, Surface } from '../components/ui';
import { ApiError, minimumAmountDetails } from '../lib/api';
import { useFormat } from '../lib/format';
import { cardIssueFunding, cardIssueQuote, fundingEnabled, liveDepositAddress } from '../lib/funding';
import { cardBillingReady } from '../lib/billing';
import { acceptedTopupQuote } from '../lib/topup';
import { isCardRegionRestricted } from '../lib/error-format';
import { AdditionalAttemptEntry } from '../components/AdditionalAttemptEntry';
import { useCardBillingAddress, useCards, useConfig, useDepositAddress, useIssueCard, useIssueQuote, useMe, useOperation, useSimulateDeposit, useTopupCard, useTopupQuote, useWallet } from '../lib/queries';
import { haptic } from '../lib/telegram';
import { CardBillingEditor } from './CardBilling';
import { DepositCheckout } from './DepositCheckout';
import { FeePaymentPanel } from '../components/FeePayment';
import { CardTopupAddresses } from '../components/CardTopupAddresses';

// ─── Пополнение баланса ──────────────────────────────────────────────────

export function Deposit() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const config = useConfig();
  const cards = useCards(true);
  const initial = params.get('asset');
  const [asset, setAsset] = useState<WalletAsset>(isWalletAsset(initial) ? initial : 'USDT');
  const networks = DEPOSIT_NETWORKS[asset];
  const [network, setNetwork] = useState<Network>(networks[0]!);
  const current = networks.includes(network) ? network : networks[0]!;

  if (config.error && !config.data) return <Page title={t('deposit.title')}><QueryError error={config.error} onRetry={() => void config.refetch()} /></Page>;
  if (!config.data) return <Loading />;
  // With manual issuance the client tops up the card itself, on the addresses UPay gives that card.
  const topupCard = config.data.integration.issuanceMode === 'manual' ? cards.data?.find(card => card.status === 'active' && card.topupAddresses?.length) : undefined;
  if (topupCard) return <Page title={t('topup.title')}>
    <CardTopupAddresses addresses={topupCard.topupAddresses} />
  </Page>;
  const invoiceCreation = config.data.integration.depositFlow === 'checkout';
  if (invoiceCreation || config.data.integration.depositInvoiceRead) return <DepositCheckout creationEnabled={invoiceCreation} />;
  if (config.data.integration.depositFlow !== 'address') return <Page title={t('deposit.title')}><Notice text={t('deposit.unavailable')} /></Page>;

  return (
    <Page title={t('deposit.title')}>
      <ServiceNotice />
      <TestModeBanner />
      <Segmented<WalletAsset>
        options={[
          { value: 'USDT', label: 'USDT' },
          { value: 'USDC', label: 'USDC' },
        ]}
        value={asset}
        onChange={setAsset}
      />
      {networks.length > 1 ? (
        <div className="stack-sm">
          <span className="label muted">{t('deposit.network')}</span>
          <NetworkPicker networks={networks} value={current} onChange={setNetwork} />
        </div>
      ) : null}
      <AddressCard key={`${asset}-${current}`} asset={asset} network={current} />
      <ExchangeHint />
    </Page>
  );
}

// Нет крипты — её можно купить картой прямо в приложении (обменник WhiteBird).
export function ExchangeHint() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: config } = useConfig();
  if (!config?.exchange.ready) return null;
  return (
    <Surface className="stack">
      <div className="row">
        <span className="icon-circle" style={{ width: 42, height: 42 }}>
          <Icon name="exchange" color="var(--primary)" size={20} />
        </span>
        <div className="stack-sm grow">
          <span className="body-medium">{t('deposit.exchangeTitle')}</span>
          <span className="caption muted">{t('deposit.exchangeText')}</span>
        </div>
      </div>
      <Button small variant="secondary" icon="card" title={t('deposit.exchangeButton')} onClick={() => navigate('/buy')} />
    </Surface>
  );
}

function AddressCard({ asset, network }: { asset: WalletAsset; network: Network }) {
  const { t } = useTranslation();
  const configQuery = useConfig();
  const config = configQuery.data;
  const mode = config?.integration.deposits;
  const address = useDepositAddress(asset, network, mode);
  const liveAddress = liveDepositAddress(mode, asset, network, address.data);
  const simulate = useSimulateDeposit();
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState('');

  useEffect(() => {
    let cancelled = false;
    setQr('');
    setCopied(false);
    if (liveAddress) void QRCode.toString(liveAddress.address, { type: 'svg', margin: 0 })
      .then((svg) => { if (!cancelled) setQr(svg); }).catch(() => {});
    return () => { cancelled = true; };
  }, [liveAddress]);

  if (configQuery.error) return <QueryError error={configQuery.error} onRetry={() => void configQuery.refetch()} />;
  if (!config) return <Loading />;
  if (!fundingEnabled(mode)) return <Notice tone="warning" text={t('deposit.unavailable')} />;
  if (address.error) return <QueryError error={address.error} onRetry={() => void address.refetch()} />;
  if (address.isLoading || !address.data) return <Loading />;
  if (!(mode === 'demo' && address.data.demo) && !liveAddress) return <Notice tone="warning" text={t('deposit.unavailable')}
    action={<Button small variant="ghost" title={t('common.refresh')} onClick={() => void address.refetch()} />} />;
  const networkName = NETWORKS[network].name;

  return (
    <>
      {!liveAddress ? <Notice tone="warning" icon="flask" text={t('deposit.demo')} /> : <Surface className="stack">
        <Row label={t('deposit.network')} value={networkName} />
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <div className="qr" dangerouslySetInnerHTML={{ __html: qr }} />
        </div>
        <span className="caption muted">{t('deposit.address')}</span>
        <button
          className="row link"
          style={{ color: 'var(--text)', textAlign: 'left', wordBreak: 'break-all' }}
          onClick={async () => {
            await navigator.clipboard?.writeText(liveAddress.address).catch(() => {});
            haptic.success();
            setCopied(true);
          }}
        >
          <span className="body-medium grow mono">{liveAddress.address}</span>
          <Icon name={copied ? 'check' : 'copy'} color="var(--primary)" size={20} />
        </button>
      </Surface>}
      {liveAddress ? <>
        <Notice tone="warning" text={t('deposit.warning', { asset, network: networkName })} />
        <span className="caption muted">{t('deposit.minAmount', { amount: liveAddress.minAmount, asset })}</span>
      </> : null}
      {config.devTools && mode === 'demo' ? (
        <>
          <Button
            variant="secondary"
            icon="flask"
            title={t('deposit.simulate', { asset })}
            loading={simulate.isPending}
            onClick={() => simulate.mutate({ asset, network, amount: '100' }, { onSuccess: () => haptic.success() })}
          />
          {simulate.isSuccess ? <Notice icon="check" text={t('deposit.simulated', { asset })} /> : null}
        </>
      ) : null}
    </>
  );
}

// ─── Выпуск карты ────────────────────────────────────────────────────────

export function CardOperationProgress({ operationId, title, kind, issueRestriction }: {
  operationId: string; title: string; kind: 'issue' | 'topup'; issueRestriction?: OperationDto['issueRestriction'];
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const operation = useOperation(operationId);
  const { data: config } = useConfig();
  const status = operation.data?.status;
  const manualPending = operation.data?.fulfillmentMode === 'manual' && status === 'pending';
  const restricted = kind === 'issue' && (operation.data?.issueRestriction ?? issueRestriction) === 'billing_phone_region_restricted';
  useEffect(() => {
    if (status === 'succeeded') haptic.success();
    else if (status === 'failed') haptic.error();
  }, [status]);
  return (
    <Page title={title}>
      {operation.error ? <QueryError error={operation.error} onRetry={() => void operation.refetch()} /> : null}
      {status === 'succeeded' ? <Notice icon="check" text={t(`${kind}.succeededText`)} />
        : status === 'failed' ? <Notice tone="danger" text={t(`${kind}.failedText`)} />
          : <Surface className="stack card-operation-progress">
            <div className="card-operation-progress-copy" role="status" aria-live="polite">
              <span className="body-medium">{t(restricted ? 'issue.restrictedTitle' : manualPending ? `${kind}.manualTitle` : kind === 'issue' && status === 'unknown' ? 'issue.reviewTitle' : `${kind}.processingTitle`)}</span>
              <span className="caption muted">{t(restricted ? 'errors.card_region_restricted' : manualPending ? `${kind}.manualText` : kind === 'issue' && status === 'unknown' ? 'issue.reviewText' : `${kind}.${status === 'unknown' ? 'checkingText' : 'processingText'}`)}</span>
            </div>
            {status === 'unknown' ? <Button variant="secondary" title={t('common.refresh')} loading={operation.isFetching} onClick={() => void operation.refetch()} /> : null}
          </Surface>}
      <Button title={t('home.card')} icon="card" onClick={() => navigate('/card', { replace: true })} />
      {kind === 'issue' && status === 'unknown' && !restricted && config?.integration.issuanceMode === 'automatic' ? <AdditionalAttemptEntry /> : null}
    </Page>
  );
}

export function CardIssue() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const navigate = useNavigate();
  const configQuery = useConfig();
  const walletQuery = useWallet();
  const cardsQuery = useCards(true);
  const { data: me } = useMe();
  const config = configQuery.data;
  const wallet = walletQuery.data;
  const issue = useIssueCard();
  const [operationId, setOperationId] = useState<string | null>(null);
  const billing = useCardBillingAddress(operationId === null);
  const [asset, setAsset] = useState<WalletAsset>('USDT');
  const quoteQuery = useIssueQuote(asset);
  // Один ключ на экран: повторное нажатие не выпустит вторую карту.
  const idempotencyKey = useRef(crypto.randomUUID()).current;

  if (operationId) return <CardOperationProgress operationId={operationId} title={t('issue.title')} kind="issue" />;
  if (cardsQuery.error) return <Page title={t('issue.title')}><QueryError error={cardsQuery.error} onRetry={() => void cardsQuery.refetch()} /></Page>;
  if (!cardsQuery.data) return <Loading />;
  const pendingCard = cardsQuery.data.find(card => card.status === 'pending');
  if (pendingCard?.pendingOperationId) return <CardOperationProgress operationId={pendingCard.pendingOperationId} issueRestriction={pendingCard.issueRestriction} title={t('issue.title')} kind="issue" />;
  if (pendingCard) return <Page title={t('issue.title')}><Notice text={t(pendingCard.issueRestriction === 'billing_phone_region_restricted' ? 'errors.card_region_restricted' : 'issue.reviewTitle')} />
    <Button title={t('home.card')} onClick={() => navigate('/card', { replace: true })} /></Page>;
  // Manual issuance starts with the single application form, which also reserves the fee.
  if (config?.integration.issuanceMode === 'manual' && me && me.kyc.status !== 'approved') return <Navigate to="/kyc" replace />;
  // Manual issuance gives every client one card.
  if (config?.integration.issuanceMode === 'manual' && cardsQuery.data.some(card => card.status === 'active' || card.status === 'frozen')) return <Navigate to="/card" replace />;
  if (configQuery.error && !config) return <Page title={t('issue.title')}><QueryError error={configQuery.error} onRetry={() => void configQuery.refetch()} /></Page>;
  if (walletQuery.error && !wallet) return <Page title={t('issue.title')}><QueryError error={walletQuery.error} onRetry={() => void walletQuery.refetch()} /></Page>;
  if (!config || !wallet) return <Loading />;
  if (billing.error) return <Page title={t('billing.title')}><QueryError error={billing.error} onRetry={() => void billing.refetch()} /></Page>;
  if (!billing.data || billing.isFetching) return <Loading />;
  if (!cardBillingReady(billing.data)) return <Page title={t('billing.title')}>
    <CardBillingEditor key={JSON.stringify(billing.data.address)} value={billing.data} onRefresh={() => void billing.refetch()} />
  </Page>;
  const quote = cardIssueQuote(asset, quoteQuery.data);
  const quoteReady = quote !== null && !quoteQuery.isFetching && !quoteQuery.isStale && !quoteQuery.error;
  const regionRestricted = isCardRegionRestricted(quoteQuery.error) || isCardRegionRestricted(issue.error);
  const brokerFunded = quoteReady && quote.fundingSource === 'broker';
  const noFunds = issue.error instanceof ApiError && issue.error.code === 'insufficient_funds';
  const funding = cardIssueFunding(wallet, asset, quoteQuery.data);
  const needsFunds = !regionRestricted && quoteReady && !brokerFunded && (!funding.enough || noFunds);
  const canDeposit = fundingEnabled(config.integration.deposits);
  const feeWallet = config.integration.issuanceMode === 'manual' ? config.integration.feeWallet ?? null : null;

  return (
    <Page title={t('issue.title')}>
      <TestModeBanner />
      {regionRestricted ? <Notice tone="warning" text={t('errors.card_region_restricted')} /> : null}
      {!config.integration.capabilities.issue ? <Notice tone="warning" text={t('integration.issueUnavailable')} /> : null}
      <BankCard placeholder />
      <h2 className="heading">{config.card.productName}</h2>
      {brokerFunded ? <Notice text={t('issue.brokerFunded')} /> : <>
        <span className="label muted">{t('issue.payFrom')}</span>
        <AssetPicker wallet={wallet} value={asset} onChange={(value) => { issue.reset(); setAsset(value); }} />
      </>}
      <Surface className="stack">
        <Row label={t('issue.fee')} value={quoteReady ? fmt.amount(quote.fee, 'USD') : '—'} />
        <Row label={t('issue.total')} value={quoteReady ? fmt.amount(quote.customerCharge, asset) : '—'} strong />
      </Surface>
      {billing.data.required && billing.data.address ? <Surface className="stack-sm">
        <span className="label muted">{t('billing.title')}</span>
        <span className="body-medium" style={{ overflowWrap: 'anywhere' }}>{billing.data.address.address}, {billing.data.address.postalCode}</span>
        <Button small variant="ghost" title={t('security.change')} onClick={() => navigate('/card/billing')} />
      </Surface> : null}
      {!regionRestricted ? quoteQuery.error ? <QueryError error={quoteQuery.error} onRetry={() => void quoteQuery.refetch()} />
        : !quoteQuery.isFetching && (!quote || quoteQuery.isStale) ? <Notice tone="warning" text={t('integration.issueUnavailable')}
          action={<Button small variant="ghost" title={t('common.refresh')} onClick={() => void quoteQuery.refetch()} />} /> : null : null}
      {/* Manual issuance: the fee is paid to an app wallet address; once it arrives the request moves on by itself. */}
      {needsFunds && feeWallet ? <>
        <span className="muted">{t('issue.payToWallet')}</span>
        <FeePaymentPanel wallet={feeWallet} onPaid={() => { void cardsQuery.refetch(); void walletQuery.refetch(); }} />
      </> : null}
      {needsFunds && !feeWallet ? (
        <Notice
          tone="warning"
          text={funding.shortage && funding.shortage !== '0'
            ? t('issue.shortage', { amount: funding.shortage, asset })
            : t('errors.insufficient_funds')}
          action={canDeposit ? <Button small variant="ghost" title={t('home.deposit')} onClick={() => navigate(`/deposit?asset=${asset}&amount=${encodeURIComponent(funding.shortage ?? '')}&returnTo=issue`)} /> : undefined}
        />
      ) : null}
      {needsFunds && !canDeposit && !feeWallet ? <Notice tone="warning" text={t('deposit.unavailable')} /> : null}
      {issue.error && !isCardRegionRestricted(issue.error) && (!noFunds || brokerFunded) ? (
        <Notice
          tone="danger"
          text={fmt.error(issue.error)}
        />
      ) : null}
      <Button
        title={quoteReady && !brokerFunded ? t('issue.submit', { amount: quote.customerCharge, asset }) : t('issue.submitCard')}
        icon="card"
        loading={issue.isPending || quoteQuery.isFetching || cardsQuery.isFetching}
        disabled={regionRestricted || !config.integration.capabilities.issue || !quoteReady || !funding.enough || cardsQuery.isFetching}
        onClick={() =>
          issue.mutate(
            { asset, idempotencyKey, expectedFundingSource: quote!.fundingSource, expectedCustomerCharge: quote!.customerCharge },
            {
              onSuccess: ({ operation }) => setOperationId(operation.id),
              onError: (error) => {
                if (error instanceof ApiError && error.code === 'billing_address_required') void billing.refetch();
                haptic.error();
              },
            },
          )
        }
      />
    </Page>
  );
}

// ─── Пополнение карты ────────────────────────────────────────────────────

export function useDebounced<T>(value: T, ms = 400): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function CardTopup() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const [params] = useSearchParams();
  const cardId = params.get('cardId') ?? '';
  const configQuery = useConfig();
  const walletQuery = useWallet();
  const config = configQuery.data;
  const wallet = walletQuery.data;
  const topup = useTopupCard(cardId);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [asset, setAsset] = useState<WalletAsset>('USDT');
  const [amount, setAmount] = useState('');
  const debounced = useDebounced(amount);
  const quote = useTopupQuote(asset, debounced, cardId);
  const [minimums, setMinimums] = useState<Record<string, string>>({});
  const minimumKey = `${cardId}:${asset}`;
  const quoteMinimum = minimumAmountDetails(quote.error);
  const submitMinimum = minimumAmountDetails(topup.error);
  const reportedMinimum = quoteMinimum?.asset === asset ? quoteMinimum.minAmount
    : quote.data?.asset === asset && quote.data.minAmount ? quote.data.minAmount
      : submitMinimum?.asset === asset ? submitMinimum.minAmount : null;
  useEffect(() => {
    if (reportedMinimum) setMinimums((previous) => previous[minimumKey] === reportedMinimum ? previous : { ...previous, [minimumKey]: reportedMinimum });
  }, [minimumKey, reportedMinimum]);
  const idempotencyKey = useRef(crypto.randomUUID()).current;
  const cardsQuery = useCards(true);
  const addresses = cardsQuery.data?.find(card => card.id === cardId)?.topupAddresses ?? [];

  // The card's own UPay addresses: the client sends crypto there and UPay tops the card up.
  if (addresses.length) return <Page title={t('topup.title')}>
    <CardTopupAddresses addresses={addresses} />
  </Page>;
  if (operationId) return <CardOperationProgress operationId={operationId} title={t('topup.title')} kind="topup" />;
  if (configQuery.error && !config) return <Page title={t('topup.title')}><QueryError error={configQuery.error} onRetry={() => void configQuery.refetch()} /></Page>;
  if (walletQuery.error && !wallet) return <Page title={t('topup.title')}><QueryError error={walletQuery.error} onRetry={() => void walletQuery.refetch()} /></Page>;
  if (!config || !wallet) return <Loading />;
  const available = wallet?.balances.find((b) => b.asset === asset)?.amount ?? '0';
  const acceptedQuote = acceptedTopupQuote(asset, amount, debounced, quote);
  const quoteReady = acceptedQuote !== null;

  return (
    <Page title={t('topup.title')}>
      <TestModeBanner />
      {!config.integration.capabilities.topup ? <Notice tone="warning" text={t('integration.topupUnavailable')} /> : null}
      <span className="label muted">{t('topup.from')}</span>
      <AssetPicker wallet={wallet} value={asset} onChange={setAsset} />
      <div style={{ position: 'relative' }}>
        <Field
          label={t('topup.amount')}
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))}
          inputMode="decimal"
          placeholder="0.00"
          hint={reportedMinimum || minimums[minimumKey]
            ? t('topup.minAsset', { amount: reportedMinimum ?? minimums[minimumKey], asset })
            : t('topup.min', { amount: config.card.minTopupUsd })}
        />
        <button className="link label" style={{ position: 'absolute', right: 16, top: 42 }} onClick={() => setAmount(available)}>
          {t('topup.max')}
        </button>
      </div>
      <Surface className="stack">
        <Row
          label={t('topup.fee', { percent: fmt.percent(config.card.topupFeeBps / 100) })}
          value={acceptedQuote ? fmt.amount(acceptedQuote.fee, asset) : '—'}
        />
        <Row label={t('topup.receive')} value={acceptedQuote ? fmt.amount(acceptedQuote.netUsd, 'USD') : '—'} strong />
      </Surface>
      {quote.error && amount ? <Notice tone="warning" text={fmt.error(quote.error)} action={<Button small variant="ghost" title={t('common.refresh')} onClick={() => void quote.refetch()} />} /> : null}
      {topup.error ? <Notice tone="danger" text={fmt.error(topup.error)} /> : null}
      <Button
        title={t('topup.submit')}
        icon="plus"
        loading={topup.isPending}
        disabled={!quoteReady || !config.integration.capabilities.topup}
        onClick={() => {
          if (!acceptedQuote) return;
          topup.mutate(
            { asset, amount: amount.replace(',', '.'), idempotencyKey, expectedFee: acceptedQuote.fee, expectedNetUsd: acceptedQuote.netUsd },
            {
              onSuccess: (operation) => setOperationId(operation.id),
              onError: (error) => {
                if (error instanceof ApiError && error.code === 'quote_changed') void quote.refetch();
                haptic.error();
              },
            },
          );
        }}
      />
    </Page>
  );
}
