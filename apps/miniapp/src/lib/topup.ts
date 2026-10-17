import { toMinor, type TopupQuoteDto, type WalletAsset } from '@gudex/shared';

export function acceptedTopupQuote(asset: WalletAsset, amount: string, debounced: string,
  query: { data?: TopupQuoteDto; isFetching?: boolean; isStale?: boolean; error?: unknown }): TopupQuoteDto | null {
  if (!query.data || query.error || query.isFetching || query.isStale || debounced !== amount || query.data.asset !== asset) return null;
  try {
    const gross = toMinor(amount, asset);
    if (gross <= 0n || toMinor(query.data.amount, asset) !== gross || toMinor(query.data.fee, asset) >= gross || toMinor(query.data.netUsd, 'USD') <= 0n) return null;
    return query.data;
  } catch {
    return null;
  }
}
