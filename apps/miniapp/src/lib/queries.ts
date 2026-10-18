import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import type {
  ActivityItemDto,
  AppConfigDto,
  CardDto,
  CardAdditionalAttemptInput,
  CardAdditionalAttemptQuoteDto,
  CardBillingAddressDto,
  CardBillingAddressInput,
  CardBillingCountryDto,
  CardApplicationDto,
  CardIssueQuoteDto,
  CardSensitiveDto,
  DepositAddressDto,
  DepositInvoiceDto,
  DepositInvoiceOptionDto,
  DepositInvoiceInput,
  ExchangeSessionDto,
  FeePaymentDto,
  FeeWalletNetwork,
  KycRequirementsDto,
  KycDto,
  Locale,
  MeDto,
  Network,
  OperationDto,
  RecipientDto,
  ReferralDto,
  ServiceNoticeDto,
  TopupQuoteDto,
  TransferDto,
  WalletAsset,
  WalletDto,
  WithdrawalDto,
} from '@gudex/shared';
import { request } from './api';
import { fundingEnabled } from './funding';
import { sendCardApplication, sendKycSubmission, type CardApplicationSubmission, type KycSubmission, type KycUploadCache } from './kyc';
import { invoicePollMs } from './deposit-invoice';

// Пока что-то «в обработке», экран опрашивает сервер — без ручного обновления.
const POLL_MS = 1500;
const BALANCE_REFRESH_MS = 30_000;

export const keys = {
  config: ['config'] as const,
  me: ['me'] as const,
  wallet: ['wallet'] as const,
  cards: ['cards'] as const,
  issueQuote: ['issue-quote'] as const,
  billingAddress: ['card-billing-address'] as const,
  additionalAttempt: ['card-additional-attempt'] as const,
  activeInvoice: ['active-deposit-invoice'] as const,
  invoice: ['deposit-invoice'] as const,
  activity: ['activity'] as const,
  feePayment: ['fee-payment'] as const,
};

export function useConfig() {
  return useQuery({ queryKey: keys.config, queryFn: () => request<AppConfigDto>('/v1/config'), staleTime: 60_000,
    refetchInterval: 60_000, refetchIntervalInBackground: false });
}

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: () => request<MeDto>('/v1/me'),
    // An operator review can take days: refresh it like the balance, not like a fast provider status.
    refetchInterval: (query) => (query.state.data?.kyc.status === 'pending' && query.state.data.kyc.submissionState !== 'unknown'
      ? query.state.data.kyc.submissionState === 'manual_review' ? BALANCE_REFRESH_MS : POLL_MS : false),
  });
}

export function useWallet() {
  return useQuery({ queryKey: keys.wallet, queryFn: () => request<WalletDto>('/v1/wallet'),
    refetchInterval: BALANCE_REFRESH_MS, refetchIntervalInBackground: false });
}

export function useCards(freshOnMount = false) {
  return useQuery({
    queryKey: keys.cards,
    queryFn: () => request<CardDto[]>('/v1/cards'),
    refetchOnMount: freshOnMount ? 'always' : undefined,
    refetchInterval: (query) => (query.state.data?.some((c) => c.status === 'pending' && c.pendingOperationStatus !== 'unknown' && c.pendingFulfillmentMode !== 'manual') ? POLL_MS : BALANCE_REFRESH_MS),
    refetchIntervalInBackground: false,
  });
}

export function useActivity(limit = 50) {
  const invalidate = useInvalidateMoney();
  const pending = useRef(new Set<string>());
  const query = useQuery({
    queryKey: [...keys.activity, limit],
    queryFn: () => request<ActivityItemDto[]>(`/v1/activity?limit=${limit}`),
    refetchInterval: (query) => (query.state.data?.some((a) => a.status === 'pending') ? POLL_MS : BALANCE_REFRESH_MS),
    refetchIntervalInBackground: false,
  });
  useEffect(() => {
    const items = query.data;
    if (!items) return;
    const settled = items.some((item) => pending.current.has(item.id) && item.status !== 'pending');
    pending.current = new Set(items.filter((item) => item.status === 'pending').map((item) => item.id));
    if (settled) void invalidate();
  }, [query.data, invalidate]);
  return query;
}

export function useDepositAddress(asset: WalletAsset, network: Network, mode: AppConfigDto['integration']['deposits'] | undefined) {
  return useQuery({
    queryKey: ['deposit-address', asset, network, mode ?? null],
    queryFn: () => request<DepositAddressDto>(`/v1/deposits/address?asset=${asset}&network=${network}`),
    enabled: fundingEnabled(mode),
    staleTime: 60_000,
  });
}

export function useDepositInvoiceOptions(enabled = true) {
  return useQuery({ queryKey: ['deposit-invoice-options'], queryFn: () => request<DepositInvoiceOptionDto[]>('/v1/deposit-invoices/options'),
    enabled, staleTime: 30_000, retry: false });
}

export function useActiveDepositInvoice(enabled = true) {
  const { data: me } = useMe();
  return useQuery({ queryKey: [...keys.activeInvoice, me?.id ?? null],
    queryFn: () => request<DepositInvoiceDto | null>('/v1/deposit-invoices/active'), enabled: enabled && Boolean(me?.id),
    staleTime: 0, gcTime: 0, refetchOnMount: 'always', retry: false,
    refetchInterval: query => invoicePollMs(query.state.data), refetchIntervalInBackground: false });
}

export function useDepositInvoice(id: string | null) {
  const { data: me } = useMe();
  return useQuery({ queryKey: [...keys.invoice, me?.id ?? null, id],
    queryFn: () => request<DepositInvoiceDto>(`/v1/deposit-invoices/${encodeURIComponent(id!)}`), enabled: Boolean(me?.id) && id !== null,
    staleTime: 0, gcTime: 0, refetchOnMount: 'always', retry: false,
    refetchInterval: query => invoicePollMs(query.state.data), refetchIntervalInBackground: false });
}

export function useCreateDepositInvoice() {
  const { data: me } = useMe();
  const client = useQueryClient();
  return useMutation({ gcTime: 0,
    mutationFn: (body: DepositInvoiceInput) => request<DepositInvoiceDto>('/v1/deposit-invoices', { method: 'POST', body }),
    onSuccess: invoice => {
      client.setQueryData([...keys.activeInvoice, me?.id ?? null], invoice);
      client.setQueryData([...keys.invoice, me?.id ?? null, invoice.id], invoice);
    },
    onSettled: () => client.invalidateQueries({ queryKey: [...keys.activeInvoice, me?.id ?? null] }),
  });
}

export function useRetryDepositInvoice(id: string | null) {
  const { data: me } = useMe();
  const client = useQueryClient();
  return useMutation({ gcTime: 0,
    mutationFn: () => request<DepositInvoiceDto>(`/v1/deposit-invoices/${encodeURIComponent(id!)}/retry`, { method: 'POST', body: {} }),
    onSuccess: invoice => {
      client.setQueryData([...keys.activeInvoice, me?.id ?? null], invoice);
      client.setQueryData([...keys.invoice, me?.id ?? null, invoice.id], invoice);
    },
    onSettled: () => client.invalidateQueries({ queryKey: [...keys.invoice, me?.id ?? null, id] }),
  });
}

export function fetchTopupQuote(asset: WalletAsset, amount: string, cardId?: string) {
  return request<TopupQuoteDto>(`/v1/cards/topup-quote?asset=${asset}&amount=${encodeURIComponent(amount.replace(',', '.'))}${cardId ? `&cardId=${encodeURIComponent(cardId)}` : ''}`);
}

export function useTopupQuote(asset: WalletAsset, amount: string, cardId?: string) {
  const valid = /^\d+([.,]\d+)?$/.test(amount) && Number(amount.replace(',', '.')) > 0;
  return useQuery({
    queryKey: ['topup-quote', asset, amount, cardId ?? null],
    queryFn: () => fetchTopupQuote(asset, amount, cardId),
    enabled: valid,
    retry: false,
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

// Любое изменение денег — обновляем всё, что их показывает.
export function useInvalidateMoney() {
  const client = useQueryClient();
  return useCallback(() =>
    Promise.all([
      client.invalidateQueries({ queryKey: keys.wallet }),
      client.invalidateQueries({ queryKey: keys.cards }),
      client.invalidateQueries({ queryKey: keys.activity }),
    ]), [client]);
}

// Следит за операцией, пока она не завершится, и обновляет балансы.
export function useOperation(operationId: string | null) {
  const invalidate = useInvalidateMoney();
  return useQuery({
    queryKey: ['operation', operationId],
    queryFn: async () => {
      const op = await request<OperationDto>(`/v1/operations/${operationId}`);
      if (op.status !== 'pending' && op.status !== 'processing') await invalidate();
      return op;
    },
    enabled: operationId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      // An operator request can take a while; poll it like the balance.
      if (status === 'unknown' || query.state.data?.fulfillmentMode === 'manual') return BALANCE_REFRESH_MS;
      return status && status !== 'pending' && status !== 'processing' ? false : POLL_MS;
    },
    refetchIntervalInBackground: false,
  });
}

export function useKycRequirements() {
  return useQuery({ queryKey: ['kyc-requirements'], queryFn: () => request<KycRequirementsDto>('/v1/kyc/requirements'), staleTime: 60_000 });
}

export function useSubmitKyc() {
  const client = useQueryClient();
  const uploads = useRef<KycUploadCache>(new Map());
  return useMutation({
    gcTime: 0,
    mutationFn: (body: KycSubmission) => sendKycSubmission(body, uploads.current),
    onSuccess: (kyc: KycDto) => client.setQueryData<MeDto>(keys.me, (me) => me ? { ...me, kyc } : me),
    // A lost submit response may still mean the server accepted the verification.
    onSettled: () => client.invalidateQueries({ queryKey: keys.me }),
  });
}

export function useSubmitCardApplication() {
  const client = useQueryClient();
  const invalidate = useInvalidateMoney();
  const uploads = useRef<KycUploadCache>(new Map());
  return useMutation({
    gcTime: 0,
    mutationFn: (body: CardApplicationSubmission) => sendCardApplication(body, uploads.current),
    onSuccess: ({ kyc }: CardApplicationDto) => {
      client.setQueryData<MeDto>(keys.me, (me) => me ? { ...me, kyc } : me);
      invalidate();
    },
    // A lost response may still mean the application and its reserve were committed.
    onSettled: () => Promise.all([client.invalidateQueries({ queryKey: keys.me }), client.invalidateQueries({ queryKey: keys.issueQuote })]),
  });
}

// The issuance fee request on the shared app wallet; polled while the transfer is awaited.
export function useFeePayment(enabled: boolean) {
  return useQuery({
    queryKey: keys.feePayment,
    queryFn: () => request<FeePaymentDto | null>('/v1/fee-payments/current'),
    enabled,
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.status === 'awaiting' ? 10_000 : false),
    refetchIntervalInBackground: false,
    retry: false,
  });
}

/** The saved application takes the fee from the balance (a refund or a payment confirmed late). */
export function usePayApplicationFromBalance() {
  const client = useQueryClient();
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (asset: WalletAsset) => request<CardApplicationDto>('/v1/card-application/pay', { method: 'POST', body: { asset } }),
    // The new pending card goes into the cache at once, so the screen moves on before the balance refresh lands.
    onSuccess: ({ kyc, card }) => {
      client.setQueryData<MeDto>(keys.me, (me) => me ? { ...me, kyc } : me);
      if (card) client.setQueryData<CardDto[]>(keys.cards, (cards) => [...(cards ?? []).filter(item => item.id !== card.id), card]);
    },
    onSettled: () => Promise.all([invalidate(), client.invalidateQueries({ queryKey: keys.me })]),
  });
}

export function useCreateFeePayment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { asset: WalletAsset; network: FeeWalletNetwork }) => request<FeePaymentDto>('/v1/fee-payments', { method: 'POST', body }),
    onSuccess: (value) => client.setQueryData(keys.feePayment, value),
  });
}

export function useRecheckKyc() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request<KycDto>('/v1/kyc/recheck', { method: 'POST' }),
    onSuccess: (kyc) => client.setQueryData<MeDto>(keys.me, (me) => me ? { ...me, kyc } : me),
    onSettled: () => client.invalidateQueries({ queryKey: keys.me }),
  });
}

export function useUpdateLocale() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (locale: Locale) => request<MeDto>('/v1/me', { method: 'PATCH', body: { locale } }),
    onSuccess: (me) => client.setQueryData(keys.me, me),
  });
}

export interface IssueCardInput {
  asset: WalletAsset;
  idempotencyKey: string;
  expectedFundingSource?: CardIssueQuoteDto['fundingSource'];
  expectedCustomerCharge?: string;
}

export function requestIssueCard(body: IssueCardInput) {
  return request<{ card: CardDto; operation: OperationDto }>('/v1/cards', { method: 'POST', body });
}

export function useIssueCard() {
  const invalidate = useInvalidateMoney();
  const client = useQueryClient();
  return useMutation({
    mutationFn: requestIssueCard,
    onSuccess: invalidate,
    onSettled: () => client.invalidateQueries({ queryKey: keys.issueQuote }),
  });
}

export function fetchIssueQuote(asset: WalletAsset) {
  return request<CardIssueQuoteDto>(`/v1/cards/issue-quote?asset=${asset}`);
}

export function useIssueQuote(asset: WalletAsset, enabled = true) {
  return useQuery({
    queryKey: [...keys.issueQuote, asset],
    queryFn: () => fetchIssueQuote(asset),
    enabled,
    staleTime: 30_000,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export function useCardBillingAddress(enabled = true) {
  const { data: me } = useMe();
  return useQuery({
    queryKey: [...keys.billingAddress, me?.id ?? null],
    queryFn: () => request<CardBillingAddressDto>('/v1/cards/billing-address'),
    enabled: enabled && Boolean(me?.id),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchInterval: (query) => query.state.data?.status === 'pending' ? BALANCE_REFRESH_MS : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

// A quote is read-only. Creating the additional attempt is a separate human action.
export function useAdditionalAttemptQuote(enabled = true) {
  const { data: me } = useMe();
  return useQuery({
    queryKey: [...keys.additionalAttempt, me?.id ?? null],
    queryFn: () => request<CardAdditionalAttemptQuoteDto>('/v1/cards/additional-attempt-quote'),
    enabled: enabled && Boolean(me?.id), staleTime: 0, gcTime: 0,
    refetchOnMount: 'always', retry: false,
  });
}

export function requestAdditionalAttempt(body: CardAdditionalAttemptInput) {
  return request<{ card: CardDto; operation: OperationDto }>('/v1/cards/additional-attempt', { method: 'POST', body });
}

export function useAdditionalAttempt() {
  const invalidate = useInvalidateMoney();
  const client = useQueryClient();
  return useMutation({ mutationFn: requestAdditionalAttempt, gcTime: 0, onSuccess: invalidate,
    onSettled: () => client.invalidateQueries({ queryKey: keys.additionalAttempt }) });
}

export function useCardBillingCountries(enabled = true) {
  return useQuery({ queryKey: ['card-billing-countries'], queryFn: () => request<CardBillingCountryDto[]>('/v1/cards/billing-countries'),
    staleTime: 5 * 60_000, retry: false, enabled });
}

export function useSaveCardBillingAddress() {
  const client = useQueryClient();
  const { data: me } = useMe();
  return useMutation({
    gcTime: 0,
    mutationFn: saveCardBillingAddress,
    onSuccess: (value) => client.setQueryData([...keys.billingAddress, me?.id ?? null], value),
    onSettled: () => client.invalidateQueries({ queryKey: keys.issueQuote }),
  });
}

export function saveCardBillingAddress(body: CardBillingAddressInput) {
  return request<CardBillingAddressDto>('/v1/cards/billing-address', { method: 'PUT', body });
}

export function useTopupCard(cardId: string) {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (body: { asset: WalletAsset; amount: string; idempotencyKey: string; expectedFee: string; expectedNetUsd: string }) =>
      request<OperationDto>(`/v1/cards/${cardId}/topup`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useSetFrozen(cardId: string) {
  return useMutation({
    mutationFn: ({ frozen, idempotencyKey }: { frozen: boolean; idempotencyKey: string }) =>
      request<OperationDto>(`/v1/cards/${cardId}/${frozen ? 'freeze' : 'unfreeze'}`, { method: 'POST', body: { idempotencyKey } }),
  });
}

// Реквизиты отдаются только с токеном подтверждения (код-пароль или биометрия).
export function useCardSensitive(cardId: string) {
  return useMutation({
    mutationFn: (confirmationToken: string) =>
      request<CardSensitiveDto>(`/v1/cards/${cardId}/sensitive`, { headers: { 'X-Confirmation-Token': confirmationToken } }),
  });
}

// ─── Вывод, переводы, приглашения ────────────────────────────────────────

// Деньги уходят с баланса только с токеном подтверждения (код-пароль или биометрия).
export function useWithdraw() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: ({ confirmationToken, ...body }: { asset: WalletAsset; network: Network; address: string; amount: string; idempotencyKey: string; confirmationToken: string }) =>
      request<WithdrawalDto>('/v1/withdrawals', { method: 'POST', body, headers: { 'X-Confirmation-Token': confirmationToken } }),
    onSuccess: invalidate,
  });
}

export function useRecipient(username: string) {
  const name = username.trim().replace(/^@/, '');
  return useQuery({
    queryKey: ['recipient', name.toLowerCase()],
    queryFn: () => request<RecipientDto>(`/v1/transfers/recipient?username=${encodeURIComponent(name)}`),
    enabled: /^[A-Za-z0-9_]{4,32}$/.test(name),
    retry: false,
    staleTime: 60_000,
  });
}

export function useTransfer() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: ({ confirmationToken, ...body }: { username: string; asset: WalletAsset; amount: string; idempotencyKey: string; confirmationToken: string }) =>
      request<TransferDto>('/v1/transfers', { method: 'POST', body, headers: { 'X-Confirmation-Token': confirmationToken } }),
    onSuccess: invalidate,
  });
}

export function useReferral() {
  return useQuery({ queryKey: ['referral'], queryFn: () => request<ReferralDto>('/v1/referral') });
}

// Ключи и адреса для виджета обменника WhiteBird. Не кэшируем надолго: в ответе пароль партнёра.
export function useExchangeSession() {
  return useQuery({
    queryKey: ['exchange-session'],
    queryFn: () => request<ExchangeSessionDto>('/v1/exchange/session'),
    staleTime: 0,
    gcTime: 0,
  });
}

// Объявление о сбоях: проверяем раз в минуту, пока приложение открыто.
export function useNotice() {
  return useQuery({
    queryKey: ['notice'],
    queryFn: () => request<ServiceNoticeDto>('/v1/notice'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

// ─── Только для тестового режима ─────────────────────────────────────────

export function useSimulateDeposit() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (body: { asset: WalletAsset; network: Network; amount: string }) =>
      request<WalletDto>('/v1/dev/deposit', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useSimulatePurchase(cardId: string) {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (body: { amount: string; merchant: string }) =>
      request(`/v1/dev/cards/${cardId}/purchase`, { method: 'POST', body }),
    // Покупка доходит до леджера через фоновую синхронизацию — обновляем чуть позже.
    onSuccess: () => setTimeout(invalidate, 1500),
  });
}
