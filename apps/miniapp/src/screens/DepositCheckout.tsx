import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { NETWORKS, type DepositInvoiceDto, type Network, type WalletAsset } from '@gudex/shared';
import { NetworkPicker, ServiceNotice } from '../components/misc';
import { Button, Field, Loading, Notice, Page, QueryError, Row, Segmented, Surface } from '../components/ui';
import { creditedInvoiceAmount, invoiceAmount, invoiceOptions, invoicePaymentLink, invoiceResumeId, invoiceResumeSearch } from '../lib/deposit-invoice';
import { useFormat } from '../lib/format';
import { useActiveDepositInvoice, useCreateDepositInvoice, useDepositInvoice, useDepositInvoiceOptions, useInvalidateMoney, useRetryDepositInvoice } from '../lib/queries';
import { haptic, openLink } from '../lib/telegram';

export function DepositCheckout({ creationEnabled = true }: { creationEnabled?: boolean }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const resumeId = invoiceResumeId(params.get('invoiceId'));
  const [remembered, setRemembered] = useState<DepositInvoiceDto | null>(null);
  const optionsQuery = useDepositInvoiceOptions(creationEnabled);
  const active = useActiveDepositInvoice(remembered === null && resumeId === null);
  const create = useCreateDepositInvoice();
  const invalidate = useInvalidateMoney();
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const resumed = active.data?.id !== dismissedId ? active.data : null;
  const id = resumeId ?? remembered?.id ?? resumed?.id ?? null;
  const observed = useDepositInvoice(id);
  const retry = useRetryDepositInvoice(id);
  const invoice = observed.data?.id === id ? observed.data : remembered?.id === id ? remembered : resumed?.id === id ? resumed : null;
  const [asset, setAsset] = useState<WalletAsset | null>(null);
  const [network, setNetwork] = useState<Network | null>(null);
  const [amount, setAmount] = useState(params.get('amount') ?? '');
  const idempotencyKey = useRef(crypto.randomUUID());
  const creditedIds = useRef(new Set<string>());
  const [now, setNow] = useState(Date.now);

  // Keep observing this exact invoice even after /active excludes a terminal result.
  useEffect(() => { if (resumeId === null && resumed && !remembered) setRemembered(resumed); }, [resumeId, resumed, remembered]);
  useEffect(() => {
    if (invoice && invoiceResumeId(invoice.id) && params.get('invoiceId') !== invoice.id) {
      setParams(invoiceResumeSearch(params, invoice.id), { replace: true });
    }
  }, [invoice, params, setParams]);
  const credited = creditedInvoiceAmount(invoice);
  useEffect(() => {
    if (!invoice || credited === null || creditedIds.current.has(invoice.id)) return;
    creditedIds.current.add(invoice.id);
    void invalidate();
    haptic.success();
  }, [invoice, credited, invalidate]);
  useEffect(() => {
    if (!invoice?.expiresAt) return;
    const expiry = Date.parse(invoice.expiresAt);
    if (!Number.isFinite(expiry)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, expiry - Date.now()));
    return () => clearTimeout(timer);
  }, [invoice?.id, invoice?.expiresAt]);

  const refresh = () => { if (id) void observed.refetch(); else void active.refetch(); };
  if (invoice) {
    const checking = retry.isPending || observed.isFetching || (!observed.data && active.isFetching);
    const readError = observed.error;
    const payUrl = !checking && !readError ? invoicePaymentLink(invoice, now) : null;
    const state = invoice.state === 'credited' && credited === null ? 'confirming' : invoice.state;
    return <Page title={t('deposit.title')}>
      <ServiceNotice />
      <Surface className="stack">
        <span className="heading" role="status" aria-live="polite">{t(`checkout.${state}Title`)}</span>
        <span className="muted">{t(`checkout.${state}Text`)}</span>
      </Surface>
      <Surface className="stack">
        <Row label={t('checkout.requested')} value={`${invoice.requestedAmount} ${invoice.asset}`} />
        <Row label={t('deposit.network')} value={NETWORKS[invoice.network]?.name ?? '-'} />
        {credited !== null ? <Row label={t('checkout.creditedAmount')} value={`${credited} ${invoice.asset}`} strong /> : null}
      </Surface>
      {state === 'awaiting_payment' ? <Notice text={t('checkout.feeNote')} /> : null}
      {readError ? <QueryError error={readError} onRetry={refresh} /> : null}
      {retry.error ? <Notice tone="danger" text={fmt.error(retry.error)} /> : null}
      {!creationEnabled ? <Notice text={t('checkout.creationUnavailable')} /> : null}
      {creationEnabled && state === 'prepared' ? <Button title={t('checkout.retryInvoice')} loading={retry.isPending} disabled={Boolean(readError) || checking}
        onClick={() => { if (creationEnabled && invoice.state === 'prepared' && !readError && !checking) retry.mutate(undefined,
          { onSuccess: value => setRemembered(value), onError: () => { haptic.error(); refresh(); } }); }} /> : null}
      {payUrl ? <Button title={t('checkout.openPayment')} icon="arrowUpRight" onClick={() => {
        const current = !checking && !readError ? invoicePaymentLink(invoice) : null;
        if (current) openLink(current); else { setNow(Date.now()); refresh(); }
      }} /> : state === 'awaiting_payment' ? <Notice text={t('checkout.linkUnavailable')} /> : null}
      {state !== 'credited' ? <Button title={t('checkout.checkStatus')} variant="secondary" loading={checking} onClick={refresh} /> : null}
      {credited !== null ? <Button title={t(params.get('returnTo') === 'issue' ? 'checkout.continueIssue' : 'home.card')}
        onClick={() => navigate(params.get('returnTo') === 'issue' ? '/card/issue' : '/card', { replace: true })} /> : null}
      {creationEnabled && state === 'expired' ? <Button title={t('checkout.newInvoice')} variant="secondary" onClick={() => {
        setDismissedId(invoice.id); setRemembered(null); setParams(invoiceResumeSearch(params, null), { replace: true });
        idempotencyKey.current = crypto.randomUUID(); create.reset(); void active.refetch();
      }} /> : null}
    </Page>;
  }

  if (id) return <Page title={t('deposit.title')}>{observed.error
    ? <QueryError error={observed.error} onRetry={() => void observed.refetch()} /> : <Loading />}</Page>;

  // An absent invoice must be established by a fresh owner-only read before creating one.
  if (active.error) return <Page title={t('deposit.title')}><QueryError error={active.error} onRetry={() => void active.refetch()} /></Page>;
  if (active.data === undefined || active.isFetching) return <Loading />;
  if (!creationEnabled) return <Page title={t('deposit.title')}><Notice text={t('checkout.creationUnavailable')} /></Page>;
  if (optionsQuery.error) return <Page title={t('deposit.title')}><QueryError error={optionsQuery.error} onRetry={() => void optionsQuery.refetch()} /></Page>;
  if (!optionsQuery.data) return <Loading />;
  const options = invoiceOptions(optionsQuery.data);
  const assets = [...new Set(options.map(option => option.asset))];
  const currentAsset = asset && assets.includes(asset) ? asset : assets.find(value => value === params.get('asset')) ?? assets[0];
  const networks = options.filter(option => option.asset === currentAsset).map(option => option.network);
  const currentNetwork = network && networks.includes(network) ? network : networks[0];
  const option = options.find(item => item.asset === currentAsset && item.network === currentNetwork);
  const normalized = invoiceAmount(option, amount);
  if (!option || !currentAsset || !currentNetwork) return <Page title={t('deposit.title')}><Notice text={t('deposit.unavailable')} /></Page>;
  return <Page title={t('deposit.title')}>
    <ServiceNotice />
    <Notice text={t('checkout.intro')} />
    <span className="label muted">{t('deposit.asset')}</span>
    <Segmented<WalletAsset> options={assets.map(value => ({ value, label: value }))} value={currentAsset}
      onChange={value => { if (!create.isPending) { setAsset(value); setNetwork(null); create.reset(); } }} />
    <span className="label muted">{t('deposit.network')}</span>
    <NetworkPicker networks={networks} value={currentNetwork} onChange={value => { if (!create.isPending) { setNetwork(value); create.reset(); } }} />
    <Field label={t('checkout.amount', { asset: currentAsset })} value={amount} inputMode="decimal" placeholder="0.00" disabled={create.isPending}
      onChange={event => { setAmount(event.target.value.replace(/[^\d.,]/g, '')); create.reset(); }}
      hint={t('checkout.range', { min: option.minAmount, max: option.maxAmount, asset: currentAsset, decimals: option.decimals })} />
    <Notice text={t('checkout.feeNote')} />
    {create.error ? <Notice tone="danger" text={fmt.error(create.error)} /> : null}
    <Button title={t('checkout.createInvoice')} loading={create.isPending} disabled={!normalized || optionsQuery.isFetching}
      onClick={() => {
        if (!creationEnabled || !normalized || active.error || active.isFetching || active.data === undefined) return;
        create.mutate({ asset: currentAsset, network: currentNetwork, amount: normalized, idempotencyKey: idempotencyKey.current },
          { onSuccess: value => setRemembered(value), onError: () => { haptic.error(); void active.refetch(); } });
      }} />
  </Page>;
}
