import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ActivityItemDto,
  AppConfigDto,
  CardDto,
  CardSensitiveDto,
  DepositAddressDto,
  KycDto,
  Locale,
  MeDto,
  Network,
  OperationDto,
  TopupQuoteDto,
  WalletAsset,
  WalletDto,
} from '@gudex/shared';
import { request } from './api';

// Пока что-то «в обработке», экран опрашивает сервер — без ручного обновления.
const POLL_MS = 1500;

export const keys = {
  config: ['config'] as const,
  me: ['me'] as const,
  wallet: ['wallet'] as const,
  cards: ['cards'] as const,
  activity: ['activity'] as const,
};

export function useConfig() {
  return useQuery({ queryKey: keys.config, queryFn: () => request<AppConfigDto>('/v1/config', { auth: false }), staleTime: 5 * 60_000 });
}

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: () => request<MeDto>('/v1/me'),
    refetchInterval: (query) => (query.state.data?.kyc.status === 'pending' ? POLL_MS : false),
  });
}

export function useWallet() {
  return useQuery({ queryKey: keys.wallet, queryFn: () => request<WalletDto>('/v1/wallet') });
}

export function useCards() {
  return useQuery({
    queryKey: keys.cards,
    queryFn: () => request<CardDto[]>('/v1/cards'),
    refetchInterval: (query) => (query.state.data?.some((c) => c.status === 'pending') ? POLL_MS : false),
  });
}

export function useActivity(limit = 50) {
  return useQuery({
    queryKey: [...keys.activity, limit],
    queryFn: () => request<ActivityItemDto[]>(`/v1/activity?limit=${limit}`),
    refetchInterval: (query) => (query.state.data?.some((a) => a.status === 'pending') ? POLL_MS : false),
  });
}

export function useDepositAddress(asset: WalletAsset, network: Network) {
  return useQuery({
    queryKey: ['deposit-address', asset, network],
    queryFn: () => request<DepositAddressDto>(`/v1/deposits/address?asset=${asset}&network=${network}`),
    staleTime: Infinity,
  });
}

export function useTopupQuote(asset: WalletAsset, amount: string) {
  const valid = /^\d+([.,]\d+)?$/.test(amount) && Number(amount.replace(',', '.')) > 0;
  return useQuery({
    queryKey: ['topup-quote', asset, amount],
    queryFn: () => request<TopupQuoteDto>(`/v1/cards/topup-quote?asset=${asset}&amount=${encodeURIComponent(amount.replace(',', '.'))}`),
    enabled: valid,
    retry: false,
  });
}

// Любое изменение денег — обновляем всё, что их показывает.
function useInvalidateMoney() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: keys.wallet }),
      client.invalidateQueries({ queryKey: keys.cards }),
      client.invalidateQueries({ queryKey: keys.activity }),
    ]);
}

// Следит за операцией, пока она не завершится, и обновляет балансы.
export function useOperation(operationId: string | null) {
  const invalidate = useInvalidateMoney();
  return useQuery({
    queryKey: ['operation', operationId],
    queryFn: async () => {
      const op = await request<OperationDto>(`/v1/operations/${operationId}`);
      if (op.status === 'succeeded' || op.status === 'failed') await invalidate();
      return op;
    },
    enabled: operationId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'succeeded' || status === 'failed' ? false : POLL_MS;
    },
  });
}

export function useSubmitKyc() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { firstName: string; lastName: string; birthDate: string; citizenship: string }) =>
      request<KycDto>('/v1/kyc', { method: 'POST', body }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.me }),
  });
}

export function useUpdateLocale() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (locale: Locale) => request<MeDto>('/v1/me', { method: 'PATCH', body: { locale } }),
    onSuccess: (me) => client.setQueryData(keys.me, me),
  });
}

export function useIssueCard() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (body: { asset: WalletAsset; idempotencyKey: string }) =>
      request<{ card: CardDto; operation: OperationDto }>('/v1/cards', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useTopupCard(cardId: string) {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (body: { asset: WalletAsset; amount: string; idempotencyKey: string }) =>
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

export function useCardSensitive(cardId: string) {
  return useMutation({ mutationFn: () => request<CardSensitiveDto>(`/v1/cards/${cardId}/sensitive`) });
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
