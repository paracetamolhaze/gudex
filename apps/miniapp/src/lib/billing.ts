import type { CardBillingAddressDto, CardBillingAddressInput } from '@gudex/shared';

export function validCardBillingAddress(input: CardBillingAddressInput): boolean {
  return typeof input.countryId === 'string' && input.countryId.trim().length > 0 && input.countryId.length <= 128 &&
    typeof input.postalCode === 'string' && /^[A-Za-z0-9 .-]{4,10}$/.test(input.postalCode.trim()) &&
    typeof input.address === 'string' && input.address.trim().length > 0 && input.address.trim().length <= 200 && /^[\x20-\x7E]+$/.test(input.address.trim());
}

export function cardBillingReady(value: CardBillingAddressDto | undefined): boolean {
  return Boolean(value && typeof value.required === 'boolean' && ['missing', 'ready', 'pending'].includes(value.status) &&
    (!value.required || value.status === 'ready' && value.address && validCardBillingAddress(value.address)));
}
