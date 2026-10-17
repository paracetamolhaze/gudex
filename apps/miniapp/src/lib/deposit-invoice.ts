import { ASSET_DECIMALS, fromMinor, isWalletAsset, NETWORK_IDS, toMinor, type DepositInvoiceDto, type DepositInvoiceOptionDto } from '@gudex/shared';

export function invoiceOptions(values: DepositInvoiceOptionDto[] | undefined): DepositInvoiceOptionDto[] {
  if (!Array.isArray(values)) return [];
  return values.filter(option => {
    try {
      return isWalletAsset(option.asset) && NETWORK_IDS.includes(option.network) && Number.isInteger(option.decimals) && option.decimals >= 0 &&
        option.decimals <= ASSET_DECIMALS[option.asset] && toMinor(option.minAmount, option.asset) > 0n &&
        toMinor(option.maxAmount, option.asset) >= toMinor(option.minAmount, option.asset) &&
        values.filter(other => other.asset === option.asset && other.network === option.network).length === 1;
    } catch { return false; }
  });
}

export function invoiceAmount(option: DepositInvoiceOptionDto | undefined, amount: string): string | null {
  if (!option || invoiceOptions([option]).length !== 1) return null;
  try {
    if ((amount.trim().replace(',', '.').split('.')[1]?.length ?? 0) > option.decimals) return null;
    const value = toMinor(amount, option.asset);
    if (value <= 0n || value < toMinor(option.minAmount, option.asset) || value > toMinor(option.maxAmount, option.asset)) return null;
    return fromMinor(value, option.asset);
  } catch { return null; }
}

// Never turn an invoice URL into a wallet address, QR code or arbitrary external link.
export function paymentLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    return url.origin === 'https://quick.upay.best' && !url.username && !url.password ? value : null;
  } catch { return null; }
}

export function invoicePaymentLink(invoice: DepositInvoiceDto | null | undefined, now = Date.now()): string | null {
  if (invoice?.state !== 'awaiting_payment') return null;
  if (invoice.expiresAt !== null && (!Number.isFinite(Date.parse(invoice.expiresAt)) || Date.parse(invoice.expiresAt) <= now)) return null;
  return paymentLink(invoice.paymentUrl);
}

export function creditedInvoiceAmount(invoice: DepositInvoiceDto | null | undefined): string | null {
  if (invoice?.state !== 'credited' || !invoice.creditedAmount) return null;
  try { return toMinor(invoice.creditedAmount, invoice.asset) > 0n ? fromMinor(toMinor(invoice.creditedAmount, invoice.asset), invoice.asset) : null; }
  catch { return null; }
}

export function invoicePollMs(invoice: Pick<DepositInvoiceDto, 'state'> | null | undefined): number | false {
  if (!invoice || invoice.state === 'credited' || invoice.state === 'expired') return false;
  return invoice.state === 'unknown' ? 15_000 : 5_000;
}

export function invoiceResumeId(value: string | null): string | null {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

// MemoryRouter only: no payment URL, token, PIN or form data survives the lock.
export function invoiceResumeSearch(params: URLSearchParams, id: string | null): URLSearchParams {
  const next = new URLSearchParams();
  const asset = params.get('asset');
  if (isWalletAsset(asset)) next.set('asset', asset);
  const amount = params.get('amount');
  if (amount && /^\d{1,24}(?:[.,]\d{1,6})?$/.test(amount)) next.set('amount', amount);
  if (params.get('returnTo') === 'issue') next.set('returnTo', 'issue');
  const validId = invoiceResumeId(id);
  if (validId) next.set('invoiceId', validId);
  return next;
}

