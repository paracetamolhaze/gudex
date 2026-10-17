import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config';
import { UpayDepositInvoices } from '../../src/partner/upay/deposit-invoices';

describe('native invoice creation disabled while existing custody receipts stay readable', () => {
  it('reads an exact paid receipt with creation disabled and rejects create before any new HTTP request', async () => {
    const config = loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'local-fixture-secret-atleast16', CARD_PARTNER: 'upay',
      UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ', UPAY_INVOICE_DEPOSITS_ENABLED: 'false' });
    const readRequest = vi.fn(async (_method: string, path: string) => {
      if (path === '/quick/deposit/info') return { orderNo: 'own-order', status: 2 };
      if (path === '/bill/list') return { totalSize: 1, list: [{ id: 'own-receipt', orderNo: 'own-order', symbol: 'USDT' }] };
      if (path === '/bill/info') return { outInInfo: { orderNo: 'own-order', type: 1, sonType: 8, state: 1, inOut: 1, receiptType: 1,
        symbol: 'USDT', intoAmount: '9.82', amount: '10', fee: '0.18' } };
      throw new Error('Unexpected native read');
    });
    const createDepositInvoice = vi.fn(async () => { throw new Error('Invoice POST forbidden'); });
    const provider = new UpayDepositInvoices(config, { configured: true, readRequest, createDepositInvoice } as never);
    expect(provider.configured).toBe(true);
    expect(await provider.inspect({ orderNo: 'own-order', asset: 'USDT', network: 'TRC20' })).toMatchObject({ state: 'paid', receipt: { amount: 9_820_000n } });
    readRequest.mockClear();
    await expect(provider.create({ asset: 'USDT', network: 'TRC20', amount: 10_000_000n })).rejects.toMatchObject({ metadata: { phase: 'pre_dispatch' } });
    expect(readRequest).not.toHaveBeenCalled();
    expect(createDepositInvoice).not.toHaveBeenCalled();
  });
});
