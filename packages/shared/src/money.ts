import { ASSET_DECIMALS, type Asset } from './assets';

// Перевод между десятичной строкой ("12.5") и минимальными единицами (12500000n для USDT).
// Никаких float: только строки и bigint.

const DECIMAL_RE = /^\d+(\.\d+)?$/;

export function toMinor(amount: string, asset: Asset): bigint {
  const value = amount.trim().replace(',', '.');
  if (!DECIMAL_RE.test(value)) throw new Error(`Invalid amount: ${amount}`);
  const decimals = ASSET_DECIMALS[asset];
  const [whole, frac = ''] = value.split('.');
  if (frac.length > decimals) throw new Error(`Too many decimals for ${asset}: ${amount}`);
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

export function fromMinor(minor: bigint, asset: Asset): string {
  const decimals = ASSET_DECIMALS[asset];
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return (negative ? '-' : '') + whole + (frac ? `.${frac}` : '');
}

// Пересчёт между активами с разной точностью по курсу 1:1 (USDT/USDC → USD).
// Округление вниз, чтобы никогда не зачислить больше, чем списали.
export function convertMinor(minor: bigint, from: Asset, to: Asset): bigint {
  const diff = ASSET_DECIMALS[to] - ASSET_DECIMALS[from];
  if (diff >= 0) return minor * 10n ** BigInt(diff);
  return minor / 10n ** BigInt(-diff);
}

// Процент в базисных пунктах (150 = 1.5%), округление вверх в пользу комиссии.
export function percentOf(minor: bigint, bps: number): bigint {
  const raw = minor * BigInt(bps);
  return (raw + 9999n) / 10000n;
}
