import { describe, expect, it } from 'vitest';
import { validInvoiceCheckoutUrl } from '../../src/services/deposit-invoices';

describe('owned invoice checkout origin validation', () => {
  it('accepts the native HTTPS origin and its opaque SPA fragment', () => {
    expect(validInvoiceCheckoutUrl('https://quick.upay.best/pay?invoice=fixture')).toBe(true);
    expect(validInvoiceCheckoutUrl('https://quick.upay.best/#/pay?invoice=fixture')).toBe(true);
  });
  it.each(['http://quick.upay.best/pay', 'https://quick.upay.best.evil.test/pay', 'https://quick.upay.best:8443/pay',
    'https://user:password@quick.upay.best/pay', 'javascript:alert(1)', 'https://evil.test/#https://quick.upay.best', 'not-a-url', ''])('rejects an unsafe payment target: %s', value => {
    expect(validInvoiceCheckoutUrl(value)).toBe(false);
  });
});
