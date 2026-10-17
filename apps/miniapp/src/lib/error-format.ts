import type { WalletAsset } from '@gudex/shared';
import { ApiError, minimumAmountDetails } from './api';

export function isCardRegionRestricted(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'card_region_restricted';
}

/** Pure translation input: safe to reuse without initializing Telegram or React. */
export function errorTranslation(error: unknown, language: string): {
  key: string;
  options: { lng: string; amount?: string; asset?: WalletAsset };
} {
  const minimum = minimumAmountDetails(error);
  if (minimum) return {
    key: 'errors.amount_too_small_min',
    options: { lng: language, amount: language === 'ru' ? minimum.minAmount.replace('.', ',') : minimum.minAmount, asset: minimum.asset },
  };
  const code = (error as { code?: string } | null)?.code;
  return { key: `errors.${code ?? 'internal'}`, options: { lng: language } };
}
