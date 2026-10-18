import { ISO_COUNTRY_CODES } from '@gudex/shared';

// Billing address countries of a manual card application.
// The operator enters the address in UPay by country name, so no provider list is read.
const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' });
export const BILLING_COUNTRIES: { id: string; name: string; code: string }[] = ISO_COUNTRY_CODES.map(code => ({ id: code, name: names.of(code) ?? code, code }));
