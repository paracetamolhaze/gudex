import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config';
import { UpayDepositInvoices } from '../../src/partner/upay/deposit-invoices';
import { UpayClient } from '../../src/partner/upay/client';
import { UpayTransport } from '../../src/partner/upay/transport';
import { UpayError } from '../../src/partner/upay/transport';
import type { UpaySessionStore } from '../../src/partner/upay/session-store';

const config = () => loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'invoice-fixture-secret-32-characters',
  CARD_PARTNER: 'upay', UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture',
  UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', UPAY_INVOICE_DEPOSITS_ENABLED: 'true' });
const catalog = [{ symbol: 'USDT', coinId: 'coin-usdt', inMinAmount: '2', decimals: 2,
  chainListRes: [{ chainId: 'chain-tron', chainTag: 'TRC20', inStatus: 1 }] }];
const ptf = () => ({ ditchCode: 'PTF', minAmount: '0.000001', maxAmount: '100000000',
  chainInfos: [{ chainId: 'chain-tron', symbol: 'TRC20' }] });

function setup() {
  const readRequest = vi.fn(async (_method: string, endpoint: string): Promise<unknown> => {
    if (endpoint === '/asset/coin/list') return catalog;
    if (endpoint === '/quick/deposit/check') return { isSupportQuickDeposit: 1, ditchInfos: [ptf()] };
    throw new Error('Unexpected read');
  });
  const createDepositInvoice = vi.fn(async (_body: unknown, _options?: { beforeDispatch?: () => Promise<void> }): Promise<unknown> =>
    ({ orderNo: 'invoice-own', url: 'https://quick.upay.best/pay/fixture', expireTime: '2026-10-17 12:00:00' }));
  const client = { configured: true, readRequest, createDepositInvoice };
  return { client, readRequest, createDepositInvoice, provider: new UpayDepositInvoices(config(), client as never) };
}

function settlement(change: Record<string, unknown> = {}, billChange: Record<string, unknown> = {}) {
  const ctx = setup();
  ctx.readRequest.mockImplementation(async (_method, endpoint) => {
    if (endpoint === '/quick/deposit/info') return { orderNo: 'invoice-own', status: 2 };
    if (endpoint === '/bill/list') return { totalSize: 1, list: [{ id: 'bill-own', orderNo: 'invoice-own', symbol: 'USDT', ...billChange }] };
    if (endpoint === '/bill/info') return { outInInfo: { orderNo: 'invoice-own', type: 1, sonType: 8, state: 1, inOut: 1, receiptType: 1,
      symbol: 'USDT', intoAmount: '9.690000', amount: '10', fee: '0.30', ...change } };
    throw new Error('Unexpected read');
  });
  return ctx;
}
const ownInvoice = { orderNo: 'invoice-own', asset: 'USDT' as const, network: 'TRC20' as const };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('native UPay invoice deposits', () => {
  it('uses native two-decimal invoice amounts while retaining six-decimal ledger units and no fabricated expiry', async () => {
    const ctx = setup();
    const beforeDispatch = vi.fn();
    expect(await ctx.provider.create({ asset: 'USDT', network: 'TRC20', amount: 10_120000n, beforeDispatch })).toEqual({
      orderNo: 'invoice-own', url: 'https://quick.upay.best/pay/fixture', expiresAt: null,
    });
    expect(ctx.createDepositInvoice).toHaveBeenCalledOnce();
    expect(ctx.createDepositInvoice).toHaveBeenCalledWith({ coinId: 'coin-usdt', chainId: 'chain-tron', amount: 10.12, ditchCode: 'PTF' }, { beforeDispatch: expect.any(Function) });
  });

  it('credits only the exact ordinary successful merchant NET receipt, without substituting gross-minus-fee', async () => {
    const ctx = settlement();
    expect(await ctx.provider.inspect(ownInvoice)).toEqual({ state: 'paid', receipt: {
      receiptId: 'bill-own', orderNo: 'invoice-own', asset: 'USDT', network: 'TRC20', amount: 9_690000n,
    } });
    expect(ctx.readRequest).toHaveBeenCalledWith('GET', '/bill/list', { query: { orderNo: 'invoice-own', type: 1, orderType: 1, pageNo: 1, pageSize: 100 } });
    expect(ctx.readRequest).toHaveBeenCalledWith('GET', '/bill/info', { query: { id: 'bill-own' } });
    expect(ctx.createDepositInvoice).not.toHaveBeenCalled();
  });

  it.each([{ receiptType: 2 }, { receiptType: undefined }, { state: 2 }, { state: 3 }, { inOut: 2 }, { type: 2 }, { sonType: 5 }])(
    'does not make AML bookkeeping or incomplete/non-invoice receipt funds available: %j', async change => {
      const ctx = settlement(change);
      expect(await ctx.provider.inspect(ownInvoice)).toEqual({ state: 'paid', receipt: null });
      expect(ctx.createDepositInvoice).not.toHaveBeenCalled();
    });

  it.each([{ orderNo: 'invoice-foreign' }, { symbol: 'USDC' }, { chainTag: 'BEP20' }, { id: 'bill-foreign' },
    { intoAmount: '9.6900001' }, { intoAmount: '0' }, { intoAmount: undefined }, { fee: undefined }, { amount: '-10' }, { fee: '11' }])(
    'rejects mismatched or malformed receipt proof conservatively: %j', async change => {
      const ctx = settlement(change);
      await expect(ctx.provider.inspect(ownInvoice)).rejects.toMatchObject({ retryable: true });
      expect(ctx.createDepositInvoice).not.toHaveBeenCalled();
    });

  it('does not adopt another bill with the same gross amount or a paid invoice lacking a bill', async () => {
    const ctx = settlement({}, { orderNo: 'invoice-foreign' });
    expect(await ctx.provider.inspect(ownInvoice)).toEqual({ state: 'paid', receipt: null });
    expect(ctx.readRequest.mock.calls.some(call => call[1] === '/bill/info')).toBe(false);
  });

  it('rejects two exact-order receipt candidates instead of choosing the newest', async () => {
    const ctx = settlement();
    ctx.readRequest.mockImplementation(async (_method, endpoint) => endpoint === '/quick/deposit/info' ? { orderNo: 'invoice-own', status: 2 } : {
      totalSize: 2, list: [{ id: 'bill-a', orderNo: 'invoice-own' }, { id: 'bill-b', orderNo: 'invoice-own' }],
    });
    await expect(ctx.provider.inspect(ownInvoice)).rejects.toMatchObject({ retryable: true });
    expect(ctx.readRequest.mock.calls.some(call => call[1] === '/bill/info')).toBe(false);
  });

  it.each([1, 3])('does not query credit receipts when native invoice status is %s', async status => {
    const ctx = settlement();
    ctx.readRequest.mockResolvedValue({ orderNo: 'invoice-own', status });
    expect(await ctx.provider.inspect(ownInvoice)).toEqual({ state: status === 1 ? 'processing' : 'expired', receipt: null });
    expect(ctx.readRequest).toHaveBeenCalledOnce();
  });

  it('rejects an invoice status belonging to another order without querying a bill', async () => {
    const ctx = settlement();
    ctx.readRequest.mockResolvedValue({ orderNo: 'invoice-foreign', status: 2 });
    await expect(ctx.provider.inspect(ownInvoice)).rejects.toMatchObject({ retryable: true });
    expect(ctx.readRequest).toHaveBeenCalledOnce();
  });

  it('exposes only enabled real quick-deposit network pairs and honors the catalog minimum before sending', async () => {
    const ctx = setup();
    expect(await ctx.provider.options()).toEqual([{ asset: 'USDT', network: 'TRC20', minAmount: '2', maxAmount: '100000', decimals: 2 }]);
    await expect(ctx.provider.create({ asset: 'USDT', network: 'TRC20', amount: 1_000000n })).rejects.toMatchObject({ metadata: { phase: 'pre_dispatch' } });
    await expect(ctx.provider.create({ asset: 'USDT', network: 'TON', amount: 10_000000n })).rejects.toMatchObject({ metadata: { phase: 'pre_dispatch' } });
    expect(ctx.createDepositInvoice).not.toHaveBeenCalled();
  });

  it('diagnoses the exact blocked catalog read without exposing upstream messages, values or starting a POST', async () => {
    const ctx = setup();
    ctx.readRequest.mockRejectedValue(new UpayError('PRIVATE token or customer data', false, 10003,
      { phase: 'post_dispatched', ack: 'rejected_envelope', httpStatus: 200 }));
    const result = await ctx.provider.inspectInvoiceReadiness();
    expect(result).toMatchObject({ ready: false, configured: true, mutationsPerformed: false, stage: 'catalog_read',
      error: { code: 10003, httpStatus: 200, retryable: false } });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|coin-usdt|fixture@example/);
    expect(ctx.createDepositInvoice).not.toHaveBeenCalled();
  });

  it('diagnoses a native catalog shape/precision validation failure separately from provider permission', async () => {
    const ctx = setup();
    ctx.readRequest.mockResolvedValue([{ ...catalog[0], decimals: '2', coinName: 'PRIVATE human label' }]);
    const result = await ctx.provider.inspectInvoiceReadiness();
    expect(result).toMatchObject({ ready: false, stage: 'catalog_precision', catalogRowCount: 1,
      catalogShape: { type: 'array', sample: { decimals: 'string', coinName: 'string' } }, error: { code: null } });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|coin-usdt|chain-tron/);
    expect(ctx.createDepositInvoice).not.toHaveBeenCalled();
  });

  it('diagnoses support failures on their exact public network without leaking query/native IDs or amounts', async () => {
    const ctx = setup();
    ctx.readRequest.mockImplementation(async (_method, endpoint) => {
      if (endpoint === '/asset/coin/list') return catalog;
      throw new UpayError('PRIVATE response body', true, 10020, { phase: 'post_dispatched', ack: 'rejected_envelope', httpStatus: 200 });
    });
    const result = await ctx.provider.inspectInvoiceReadiness();
    expect(result).toMatchObject({ ready: false, stage: 'support_read', currentPair: { asset: 'USDT', network: 'TRC20' },
      error: { code: 10020 } });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|coin-usdt|chain-tron|minAmount|maxAmount/);
    expect(ctx.createDepositInvoice).not.toHaveBeenCalled();
  });

  it('reports validated native capability through the same read-only catalog path', async () => {
    const ctx = setup();
    expect(await ctx.provider.inspectInvoiceReadiness()).toMatchObject({ ready: true, stage: 'complete', optionCount: 1,
      checks: [{ asset: 'USDT', network: 'TRC20', quickSupported: true, hasPtf: true }] });
    expect(ctx.createDepositInvoice).not.toHaveBeenCalled();
  });

  it('does not offer or dispatch a supported quick network without the configured native PTF provider', async () => {
    const ctx = setup();
    ctx.readRequest.mockImplementation(async (_method, endpoint) => endpoint === '/asset/coin/list' ? catalog :
      { isSupportQuickDeposit: 1, ditchInfos: [{ ditchCode: 'OTHER' }] });
    expect(await ctx.provider.options()).toEqual([]);
    await expect(ctx.provider.create({ asset: 'USDT', network: 'TRC20', amount: 10_000000n })).rejects.toMatchObject({ metadata: { phase: 'pre_dispatch' } });
    expect(ctx.createDepositInvoice).not.toHaveBeenCalled();
  });

  it('intersects PTF limits with catalog/policy bounds and rounds inward to native amount precision', async () => {
    const ctx = setup();
    ctx.readRequest.mockImplementation(async (_method, endpoint) => endpoint === '/asset/coin/list' ? catalog :
      { isSupportQuickDeposit: 1, ditchInfos: [{ ...ptf(), minAmount: '5.005', maxAmount: '12.349' }] });
    expect(await ctx.provider.options()).toEqual([{ asset: 'USDT', network: 'TRC20', minAmount: '5.01', maxAmount: '12.34', decimals: 2 }]);
    await expect(ctx.provider.create({ asset: 'USDT', network: 'TRC20', amount: 5_000000n })).rejects.toMatchObject({ metadata: { phase: 'pre_dispatch' } });
    await expect(ctx.provider.create({ asset: 'USDT', network: 'TRC20', amount: 12_350000n })).rejects.toMatchObject({ metadata: { phase: 'pre_dispatch' } });
    expect(ctx.createDepositInvoice).not.toHaveBeenCalled();
    expect((await ctx.provider.create({ asset: 'USDT', network: 'TRC20', amount: 12_340000n })).orderNo).toBe('invoice-own');
    expect(ctx.createDepositInvoice).toHaveBeenCalledOnce();
  });

  it.each([
    [{ ...ptf(), minAmount: 'not-a-number' }],
    [{ ...ptf(), maxAmount: null }],
    [{ ...ptf(), minAmount: '10', maxAmount: '9' }],
    [{ ...ptf(), minAmount: '200000', maxAmount: '300000' }],
    [{ ...ptf(), minAmount: '0' }],
    [{ ...ptf(), chainInfos: [{ chainId: 'foreign-chain', symbol: 'TRC20' }] }],
    [{ ...ptf(), chainInfos: [{ chainId: 'chain-tron', symbol: 'BEP20' }] }],
    [{ ...ptf(), chainInfos: { list: [{ chainId: 'chain-tron', symbol: 'TRC20' }] } }],
    [{ ...ptf(), chainInfos: [{ chainId: 'chain-tron', symbol: 'TRC20' }, { chainId: 'chain-tron', symbol: 'BEP20' }] }],
    [ptf(), ptf()],
  ].map(providers => ({ providers })))('rejects malformed, ambiguous or foreign PTF evidence before invoice creation: %j', async ({ providers }) => {
    const ctx = setup();
    ctx.readRequest.mockImplementation(async (_method, endpoint) => endpoint === '/asset/coin/list' ? catalog :
      { isSupportQuickDeposit: 1, ditchInfos: providers });
    await expect(ctx.provider.create({ asset: 'USDT', network: 'TRC20', amount: 10_000000n })).rejects.toMatchObject({ metadata: { phase: 'pre_dispatch' } });
    const diagnostic = await ctx.provider.inspectInvoiceReadiness();
    expect(diagnostic.ready).toBe(false);
    expect(['provider_bounds', 'provider_chains', 'provider_duplicate']).toContain(diagnostic.stage);
    expect(ctx.createDepositInvoice).not.toHaveBeenCalled();
  });

  it('revalidates a changed provider upper bound when creating instead of trusting the previously displayed option', async () => {
    const ctx = setup();
    let maxAmount = '100000000';
    ctx.readRequest.mockImplementation(async (_method, endpoint) => endpoint === '/asset/coin/list' ? catalog :
      { isSupportQuickDeposit: 1, ditchInfos: [{ ...ptf(), maxAmount }] });
    expect((await ctx.provider.options())[0]?.maxAmount).toBe('100000');
    maxAmount = '8';
    await expect(ctx.provider.create({ asset: 'USDT', network: 'TRC20', amount: 10_000000n })).rejects.toMatchObject({ metadata: { phase: 'pre_dispatch' } });
    expect(ctx.createDepositInvoice).not.toHaveBeenCalled();
  });

  it('rejects sub-cent invoice requests even though ledger and receipt amounts support six decimals', async () => {
    const ctx = setup();
    await expect(ctx.provider.create({ asset: 'USDT', network: 'TRC20', amount: 10_123456n })).rejects.toMatchObject({ metadata: { phase: 'pre_dispatch' } });
    expect(ctx.createDepositInvoice).not.toHaveBeenCalled();
  });

  it.each(['catalog', 'support'])('proves no invoice POST occurred when a %s GET fails after its own dispatch', async step => {
    const ctx = setup();
    ctx.readRequest.mockImplementation(async (_method, endpoint) => {
      if (step === 'support' && endpoint === '/asset/coin/list') return catalog;
      throw new UpayError('fixture read lost response', true, undefined, { phase: 'post_dispatched', ack: 'unconfirmed' });
    });
    await expect(ctx.provider.create({ asset: 'USDT', network: 'TRC20', amount: 10_000000n })).rejects.toMatchObject({
      retryable: true, metadata: { phase: 'pre_dispatch', ack: 'unconfirmed' },
    });
    expect(ctx.createDepositInvoice).not.toHaveBeenCalled();
  });

  it('keeps a dispatched invoice error distinct from preflight reads and never resends it', async () => {
    const ctx = setup();
    ctx.createDepositInvoice.mockRejectedValue(new UpayError('fixture invoice lost response', true, 10020,
      { phase: 'post_dispatched', ack: 'rejected_envelope', httpStatus: 200 }));
    await expect(ctx.provider.create({ asset: 'USDT', network: 'TRC20', amount: 10_000000n })).rejects.toMatchObject({
      retryable: true, code: 10020, metadata: { phase: 'post_dispatched', ack: 'rejected_envelope', httpStatus: 200 },
    });
    expect(ctx.createDepositInvoice).toHaveBeenCalledOnce();
  });

  it('bounds a stalled read-only invoice lookup to fifteen seconds without starting a bill read', async () => {
    vi.useFakeTimers();
    const ctx = setup();
    ctx.readRequest.mockImplementation(() => new Promise(() => {}));
    const result = expect(ctx.provider.inspect(ownInvoice)).rejects.toMatchObject({ retryable: true });
    await vi.advanceTimersByTimeAsync(15_001);
    await result;
    expect(ctx.readRequest).toHaveBeenCalledOnce();
    expect(ctx.createDepositInvoice).not.toHaveBeenCalled();
  });

  it('shares a fifteen-second budget across catalog/support reads instead of starting the next read', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const ctx = setup();
    ctx.readRequest.mockImplementation(async (_method, endpoint) => {
      if (endpoint === '/asset/coin/list') return catalog;
      now += 16_000;
      return { isSupportQuickDeposit: 1, ditchInfos: [ptf()] };
    });
    await expect(ctx.provider.options()).rejects.toMatchObject({ retryable: true });
    expect(ctx.readRequest).toHaveBeenCalledTimes(2);
  });

  it.each(['authentication', 'service-guard'])('never submits after preflight budget expires during %s', async stage => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const ctx = setup();
    let submissions = 0;
    const beforeDispatch = vi.fn(async () => { if (stage === 'service-guard') now += 16_000; });
    ctx.createDepositInvoice.mockImplementation(async (_body, options) => {
      if (stage === 'authentication') now += 16_000;
      await options?.beforeDispatch?.();
      submissions++;
      return { orderNo: 'invoice-own', url: 'https://quick.upay.best/pay', expireTime: '' };
    });
    await expect(ctx.provider.create({ asset: 'USDT', network: 'TRC20', amount: 10_000000n, beforeDispatch })).rejects.toMatchObject({
      metadata: { phase: 'pre_dispatch' },
    });
    expect(submissions).toBe(0);
    expect(beforeDispatch).toHaveBeenCalledTimes(stage === 'authentication' ? 0 : 1);
  });

  it('preserves a native checkout SPA fragment on the exact trusted origin', async () => {
    const ctx = setup();
    ctx.createDepositInvoice.mockResolvedValue({ orderNo: 'invoice-own', url: 'https://quick.upay.best/#/pay/fixture', expireTime: '' });
    expect(await ctx.provider.create({ asset: 'USDT', network: 'TRC20', amount: 10_000000n })).toMatchObject({ url: 'https://quick.upay.best/#/pay/fixture' });
  });

  it.each([null, 1, {}, { orderNo: 'invoice-own' }])('does not turn an accepted but incomplete response into another invoice POST: %j', async response => {
    const ctx = setup();
    ctx.createDepositInvoice.mockResolvedValue(response as never);
    await expect(ctx.provider.create({ asset: 'USDT', network: 'TRC20', amount: 10_000000n })).rejects.toMatchObject({ retryable: true, metadata: { phase: 'post_dispatched' } });
    expect(ctx.createDepositInvoice).toHaveBeenCalledOnce();
  });

  it('uses offset-aware expiry without treating an unqualified server wall clock as UTC', async () => {
    const ctx = setup();
    ctx.createDepositInvoice.mockResolvedValue({ orderNo: 'invoice-own', url: 'https://quick.upay.best/pay', expireTime: '2026-10-17T12:00:00+05:00' });
    expect((await ctx.provider.create({ asset: 'USDT', network: 'TRC20', amount: 10_000000n })).expiresAt?.toISOString()).toBe('2026-10-17T07:00:00.000Z');
  });

  it('does not settle a partial or changing bill search despite an exact candidate on its first page', async () => {
    const ctx = settlement();
    ctx.readRequest.mockImplementation(async (_method, endpoint) => {
      if (endpoint === '/quick/deposit/info') return { orderNo: 'invoice-own', status: 2 };
      if (ctx.readRequest.mock.calls.filter(call => call[1] === '/bill/list').length === 1) return { totalSize: 2, list: [{ id: 'bill-own', orderNo: 'invoice-own' }] };
      return { totalSize: 1, list: [] };
    });
    await expect(ctx.provider.inspect(ownInvoice)).rejects.toMatchObject({ retryable: true });
    expect(ctx.readRequest.mock.calls.some(call => call[1] === '/bill/info')).toBe(false);
  });

  it('completes a bounded exact-order search before using the sole direct receipt', async () => {
    const ctx = settlement();
    ctx.readRequest.mockImplementation(async (_method, endpoint) => {
      if (endpoint === '/quick/deposit/info') return { orderNo: 'invoice-own', status: 2 };
      if (endpoint === '/bill/list') return { totalSize: 2, list: ctx.readRequest.mock.calls.filter(call => call[1] === '/bill/list').length === 1
        ? [{ id: 'bill-foreign', orderNo: 'invoice-foreign' }] : [{ id: 'bill-own', orderNo: 'invoice-own' }] };
      return { outInInfo: { orderNo: 'invoice-own', type: 1, sonType: 8, state: 1, inOut: 1, receiptType: 1,
        symbol: 'USDT', intoAmount: '9.690000', amount: '10', fee: '0.30' } };
    });
    expect((await ctx.provider.inspect(ownInvoice)).receipt?.amount).toBe(9_690000n);
    expect(ctx.readRequest.mock.calls.filter(call => call[1] === '/bill/list')).toHaveLength(2);
  });

  it.each(['https://evil.example/pay', 'http://quick.upay.best/pay', 'https://quick.upay.best.evil.example/pay',
    'https://user:password@quick.upay.best/pay', 'https://quick.upay.best:8443/pay'])('preserves an unknown creation result for an untrusted checkout URL %s', async url => {
      const ctx = setup();
      ctx.createDepositInvoice.mockResolvedValue({ orderNo: 'invoice-own', url, expireTime: '' });
      await expect(ctx.provider.create({ asset: 'USDT', network: 'TRC20', amount: 10_000000n })).rejects.toMatchObject({ retryable: true });
      expect(ctx.createDepositInvoice).toHaveBeenCalledOnce();
    });
});

describe('native invoice dispatch boundary', () => {
  function clientSetup(failure?: 'expired' | 'timeout', enabled = true) {
    const requests: { endpoint: string; method: string }[] = [];
    const fixtureConfig = loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'invoice-client-fixture-32-characters',
      UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      UPAY_INVOICE_DEPOSITS_ENABLED: String(enabled) });
    const store: UpaySessionStore = { withLock: async fn => fn({ get: async () => null, set: async () => {} }) };
    const transport = new UpayTransport({ baseUrl: fixtureConfig.UPAY_BASE_URL, deviceId: fixtureConfig.UPAY_DEVICE_ID, timeoutMs: 1000,
      fetch: async (url, init) => {
        const endpoint = new URL(String(url)).pathname.replace('/api/v1', '');
        requests.push({ endpoint, method: init?.method ?? 'GET' });
        const ok = (data: unknown) => Response.json({ code: 200, data });
        if (endpoint === '/sys/member/login') return ok({ token: 'fixture-token', googleState: 1 });
        if (endpoint === '/sys/member/validateGoogle') return ok({});
        if (endpoint === '/sys/member/loginInfo') return ok({ id: 'fixture' });
        if (failure === 'expired') return Response.json({ code: 10020 });
        if (failure === 'timeout') throw new Error('lost response');
        return ok({ orderNo: 'invoice-own', url: 'https://quick.upay.best/fixture' });
      } });
    return { client: new UpayClient(fixtureConfig, store, transport), requests };
  }
  const body = { coinId: 'coin-usdt', chainId: 'chain-tron', amount: 10, ditchCode: 'PTF' as const };

  it.each(['expired', 'timeout'] as const)('never authenticates/replays an invoice POST again after %s', async failure => {
    const ctx = clientSetup(failure);
    await expect(ctx.client.createDepositInvoice(body)).rejects.toMatchObject({ retryable: true, metadata: { phase: 'post_dispatched' } });
    expect(ctx.requests.filter(item => item.endpoint === '/quick/deposit/submit')).toHaveLength(1);
    expect(ctx.requests.filter(item => item.endpoint === '/sys/member/login')).toHaveLength(1);
  });

  it('uses the invoice flag separately from card spending and runs the lease guard after authentication', async () => {
    const ctx = clientSetup();
    await expect(ctx.client.createDepositInvoice(body, { beforeDispatch: async () => {
      expect(ctx.requests.some(item => item.endpoint === '/sys/member/loginInfo')).toBe(true);
      throw new Error('claim expired');
    } })).rejects.toMatchObject({ metadata: { phase: 'pre_dispatch' } });
    expect(ctx.requests.some(item => item.endpoint === '/quick/deposit/submit')).toBe(false);
  });

  it('blocks disabled invoice creation and all invoice/address generation through generic reads/writes', async () => {
    const ctx = clientSetup(undefined, false);
    await expect(ctx.client.createDepositInvoice(body)).rejects.toMatchObject({ metadata: { phase: 'pre_dispatch' } });
    await expect(ctx.client.readRequest('POST', '/quick/deposit/submit', { body })).rejects.toThrow('approved read');
    await expect(ctx.client.submitRequest('/quick/deposit/submit', body)).rejects.toThrow('not enabled');
    await expect(ctx.client.readRequest('POST', '/asset/address', { body: { coinId: 'coin-usdt', chainId: 'chain-tron' } })).rejects.toThrow('approved read');
    expect(ctx.requests).toHaveLength(0);
  });
});
