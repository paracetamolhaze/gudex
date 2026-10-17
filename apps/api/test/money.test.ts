import { describe, expect, it } from 'vitest';
import { convertMinor, fromMinor, percentOf, toMinor } from '@gudex/shared';

describe('money', () => {
  it('converts decimal strings to minor units and back', () => {
    expect(toMinor('12.5', 'USDT')).toBe(12_500_000n);
    expect(toMinor('0,01', 'USD')).toBe(1n);
    expect(fromMinor(12_500_000n, 'USDT')).toBe('12.5');
    expect(fromMinor(-5n, 'USD')).toBe('-0.05');
    expect(fromMinor(0n, 'USDC')).toBe('0');
  });

  it('rejects malformed amounts and excess precision', () => {
    expect(() => toMinor('1e5', 'USDT')).toThrow();
    expect(() => toMinor('-1', 'USDT')).toThrow();
    expect(() => toMinor('1.001', 'USD')).toThrow();
  });

  it('converts between precisions rounding down', () => {
    expect(convertMinor(49_250_000n, 'USDT', 'USD')).toBe(4925n);
    expect(convertMinor(49_259_999n, 'USDT', 'USD')).toBe(4925n);
    expect(convertMinor(1000n, 'USD', 'USDC')).toBe(10_000_000n);
  });

  it('takes percentage fees rounding up', () => {
    expect(percentOf(50_000_000n, 150)).toBe(750_000n);
    expect(percentOf(1n, 150)).toBe(1n);
  });
});
