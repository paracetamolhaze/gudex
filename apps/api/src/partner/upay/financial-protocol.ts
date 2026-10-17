import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { PartnerBillingAddressRequiredError, PartnerError } from '../types';
import { assertNativeIssuanceFields } from './native-validation';

export type UpayObject = Record<string, unknown>;
export function object(value: unknown, label: string): UpayObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PartnerError(`UPay ${label} has an unsupported shape`, true);
  return value as UpayObject;
}
export function identifier(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}
export function decimal(value: unknown, label: string): { value: bigint; scale: bigint; text: string } {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,24}(?:\.\d{1,12})?$/.test(text)) throw new PartnerError(`UPay ${label} is missing or invalid`, false);
  const [whole, fraction = ''] = text.split('.');
  return { value: BigInt(whole! + fraction), scale: 10n ** BigInt(fraction.length), text };
}
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
const fractionText = (value: bigint, scale: bigint) => {
  const places = scale.toString().length - 1;
  return `${value / scale}.${(value % scale).toString().padStart(places, '0')}`.replace(/\.?0+$/, '') || '0';
};
export const formatCents = (value: bigint) => `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
export function exactCents(value: unknown, label: string): bigint {
  const d = decimal(value, label);
  if ((d.value * 100n) % d.scale !== 0n) throw new PartnerError(`UPay ${label} has unsupported precision`, false);
  return d.value * 100n / d.scale;
}

export function encryptPaymentPin(pin: string, info: { id: string; iv?: string }): string {
  if (!/^\d{6}$/.test(pin) || !info.id || !info.iv) throw new PartnerError('UPay payment PIN or login encryption metadata is unavailable', false);
  const key = Buffer.from(createHash('md5').update(`${info.id}broker-manage`).digest('hex'), 'utf8');
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(info.iv, 'utf8'));
  return Buffer.concat([cipher.update(pin, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
export function decryptCardField(encrypted: unknown, accountCardId: string, iv: string): string {
  if (typeof encrypted !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) throw new PartnerError('UPay encrypted card details are unavailable', true);
  try {
    const bytes = Buffer.from(encrypted, 'base64');
    if (bytes.length <= 16) throw new Error('missing tag');
    const key = Buffer.from(createHash('md5').update(`${accountCardId}broker-manage`).digest('hex'), 'utf8');
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'utf8'));
    cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([cipher.update(bytes.subarray(0, -16)), cipher.final()]).toString('utf8');
  } catch { throw new PartnerError('UPay card details could not be authenticated', true); }
}
export function expiry(value: string): { expiryMonth: number; expiryYear: number } {
  const match = /^(\d{2})\/(\d{2}|\d{4})$/.exec(value.trim()) ?? /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(value.trim());
  if (!match) throw new PartnerError('UPay card expiry has an unsupported format', true);
  const iso = match[1]!.length === 4;
  const expiryMonth = Number(match[iso ? 2 : 1]);
  const year = Number(match[iso ? 1 : 2]);
  const expiryYear = year < 100 ? year + 2000 : year;
  if (expiryMonth < 1 || expiryMonth > 12 || expiryYear < 2000 || expiryYear > 2200) throw new PartnerError('UPay card expiry is invalid', true);
  return { expiryMonth, expiryYear };
}

export function rechargeQuote(info: UpayObject, netUsd: bigint, maxDebitUsd: bigint) {
  if (netUsd <= 0n || maxDebitUsd < netUsd) throw new PartnerError('UPay recharge budget is invalid', false);
  if (info.rechargeCurrency !== 'USDT' || info.cardCurrency !== 'USD') throw new PartnerError('UPay recharge currencies must be verified as USDT / USD', false);
  const rate = decimal(info.rechargeRate, 'rechargeRate');
  const exchange = decimal(info.executeExchangeRate, 'executeExchangeRate');
  const remaining = 100n * rate.scale - rate.value;
  if (remaining <= 0n || exchange.value <= 0n) throw new PartnerError('UPay recharge tariff is invalid', false);
  // The actual panel accepts a gross amount with two decimals and rounds the received USD down.
  const numerator = remaining * exchange.value;
  const denominator = 100n * rate.scale * exchange.scale;
  const grossCents = ceil(netUsd * denominator, numerator);
  const received = grossCents * numerator / denominator;
  if (received !== netUsd || grossCents > maxDebitUsd) throw new PartnerError('UPay recharge cost exceeds the reserved budget or cannot deliver the quoted net amount exactly', false);
  const min = decimal(info.minRechargeAmount, 'minRechargeAmount');
  const max = decimal(info.maxRechargeAmount, 'maxRechargeAmount');
  if (grossCents * min.scale < min.value * 100n || grossCents * max.scale > max.value * 100n) throw new PartnerError(`UPay gross recharge must be between ${min.text} and ${max.text} USDT; increase or reduce the amount`, false);
  return { grossCents, netUsd, grossUsdt: formatCents(grossCents), partnerFeeUsdt: fractionText(grossCents * rate.value, 10_000n * rate.scale),
    exchangeRate: exchange.text, rechargeRate: rate.text };
}

export function minimumRechargeNet(info: UpayObject): bigint {
  if (info.rechargeCurrency !== 'USDT' || info.cardCurrency !== 'USD') throw new PartnerError('UPay recharge currencies must be verified as USDT / USD', false);
  const rate = decimal(info.rechargeRate, 'rechargeRate');
  const exchange = decimal(info.executeExchangeRate, 'executeExchangeRate');
  const gross = exactCents(info.minRechargeAmount, 'minRechargeAmount');
  const remaining = 100n * rate.scale - rate.value;
  if (remaining <= 0n || exchange.value <= 0n || gross <= 0n) throw new PartnerError('UPay recharge minimum is invalid', false);
  return gross * remaining * exchange.value / (100n * rate.scale * exchange.scale);
}

export function billingAddressRequired(form: UpayObject): boolean {
  // The native form renders this field from addressType, independently of
  // needParams. Its P('addressId') rule makes it mandatory for requiredInfo.
  if (form.addressType === undefined || form.addressType === null || form.addressType === '') return false;
  if (typeof form.addressType !== 'string' || !/^[1-3](?:,[1-3])*$/.test(form.addressType)
      || typeof form.requiredInfo !== 'boolean') throw new PartnerError('UPay billing address requirements are unavailable', false);
  return form.requiredInfo;
}

export function issuancePayload(detail: UpayObject, form: UpayObject, customerNo: string, productId: string, maxFeeUsd: bigint) {
  const fee = exactCents(detail.openFee, 'openFee');
  const initial = exactCents(detail.defaultOpenAmount, 'defaultOpenAmount');
  if (fee > maxFeeUsd || initial !== 0n) throw new PartnerError('UPay issuance cost exceeds the reserved fee or requires an unsupported initial recharge', false);
  if (detail.rechargeCurrency !== 'USDT' || (detail.cardCurrency ?? detail.currency) !== 'USD') throw new PartnerError('UPay product currencies must be verified as USDT / USD', false);
  if (form.customerNo !== undefined && String(form.customerNo) !== customerNo) throw new PartnerError('UPay issuance form belongs to a different customer', false);
  if (billingAddressRequired(form) && !identifier(form.addressId)) throw new PartnerBillingAddressRequiredError();
  const payload: UpayObject = { ...structuredClone(form), customerNo, agentCardId: productId, amount: formatCents(fee + initial), number: 1,
    documentType: form.documentType ?? form.defaultType, workYear: form.workYear === 'null' ? '' : form.workYear,
    copyPhone: form.phone, copyEmail: form.email };
  for (const field of ['holdBackPath', 'holdFrontPath', 'holdPassportPath', 'signPath']) {
    const value = form[field];
    if (value !== undefined && value !== null && typeof value !== 'string') throw new PartnerError('UPay issuance document path has an unsupported shape', false);
    // Native rs turns a stored signature into a display-only preview. ls then
    // serializes no signPath until the user supplies a newly captured URI.
    if (field === 'signPath' && value) delete payload[field];
    else payload[field] = value ?? '';
  }
  if (!Array.isArray(form.needParams)) throw new PartnerError('UPay issuance requirements are unavailable', false);
  for (const field of form.needParams) {
    if (typeof field !== 'string') throw new PartnerError('UPay issuance requirements are invalid', false);
    if (['Modal', 'selfie'].includes(field)) continue;
    if (payload[field] === undefined || payload[field] === null || payload[field] === '') throw new PartnerError(`UPay issuance requires ${field}`, false);
  }
  assertNativeIssuanceFields(detail, form, payload);
  delete payload.pinCode;
  return { payload, feeCents: fee, openFeeUsdt: formatCents(fee), defaultOpenUsdt: formatCents(initial) };
}

export function requestHash(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : input && typeof input === 'object'
    ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : input;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
