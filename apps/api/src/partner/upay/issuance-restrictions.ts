import { PartnerCardRegionRestrictedError, PartnerError } from '../types';

const unavailable = (): never => { throw new PartnerError('UPay card calling-code restrictions cannot be verified', false); };

function callingCode(value: unknown): string | null {
  // The observed CSV includes +1-869. Normalize only this separator inside a
  // calling-code token; never alter a subscriber phone number or select a new country.
  if (typeof value !== 'string' || !/^\+[1-9]\d{0,3}(?:-\d{1,3})?$/.test(value)) return null;
  const digits = value.slice(1).replace('-', '');
  return digits.length <= 4 ? digits : null;
}

/** Validate the exact, owned saved billing calling code against the product's
 * observed restrictedCallingCode CSV. This is a pre-dispatch restriction, not a
 * reason to change the customer's verified identity or invent another contact. */
export function assertBillingCallingCodeAllowed(intlDialCode: string, restrictionPolicy?: unknown): void {
  if (restrictionPolicy === undefined || restrictionPolicy === null || typeof restrictionPolicy === 'string' && !restrictionPolicy.trim()) return;
  if (typeof restrictionPolicy !== 'string' || restrictionPolicy.length > 4096) return unavailable();
  const tokens = restrictionPolicy.split(',');
  if (!tokens.length || tokens.length > 300) return unavailable();
  const restricted = new Set<string>();
  for (const token of tokens) {
    const code = callingCode(token.trim());
    if (!code) return unavailable();
    restricted.add(code);
  }
  const ownedCode = callingCode(intlDialCode);
  if (!ownedCode) return unavailable();
  if (restricted.has(ownedCode)) throw new PartnerCardRegionRestrictedError();
}
