import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DepositInvoiceInput } from '@gudex/shared';
import { loadConfig } from '../src/config';
import { appSettings, depositInvoices, deposits, jobs, ledgerTransactions } from '../src/db/schema';
import { DisabledDepositProvider } from '../src/deposits/provider';
import { accounts, getBalance } from '../src/ledger/ledger';
import type { NativeDepositInvoices, UpayInvoiceInspection } from '../src/partner/upay/deposit-invoices';
import { UpayError } from '../src/partner/upay/transport';
import { prepareRuntimeMode } from '../src/runtime-mode';
import { DepositInvoiceService } from '../src/services/deposit-invoices';
import { RetryLater } from '../src/queue/queue';
import { api, assertLedgerConsistent, createTestContext, registerUser, telegramLogin, TEST_BOT_TOKEN, type TestContext } from './helpers';

let ctx: TestContext | undefined;
async function setup(seal = true) {
  const env = { CARD_PARTNER: 'upay', DEV_TOOLS: 'false', UPAY_INVOICE_DEPOSITS_ENABLED: 'true',
    UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ' };
  ctx = await createTestContext(undefined, { env, depositProvider: new DisabledDepositProvider() });
  const config = loadConfig({ DATABASE_URL: 'unused', TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN, ...env });
  if (seal) await prepareRuntimeMode(config, ctx.db);
  const user = await registerUser(ctx);
  const client = api(ctx, user.token);
  const userId = (await client.get('/v1/me')).body.id as string;
  const remote = { creates: 0, posts: 0, reads: 0, failCreate: false, preDispatchFailure: false, failRead: false, unsafeUrl: false, duplicateOrder: false,
    pauseBeforeDispatch: undefined as (() => Promise<void>) | undefined,
    statuses: new Map<string, UpayInvoiceInspection>() };
  const provider: NativeDepositInvoices = {
    configured: true,
    options: async () => [{ asset: 'USDT', network: 'TRC20', minAmount: '1', maxAmount: '100000', decimals: 2 }, { asset: 'USDC', network: 'BEP20', minAmount: '1', maxAmount: '100000', decimals: 2 }],
    create: async input => {
      remote.creates++;
      // Separate pooled query sees the durable row BEFORE any external creation.
      const [claim] = await ctx!.db.select().from(depositInvoices).where(eq(depositInvoices.state, 'sending'));
      expect(claim).toBeDefined();
      expect(await ctx!.db.select().from(jobs).where(eq(jobs.queue, 'deposit.invoice.reconcile'))).not.toHaveLength(0);
      await remote.pauseBeforeDispatch?.();
      await input.beforeDispatch?.();
      if (remote.preDispatchFailure) throw new UpayError('Synthetic catalog failure before invoice POST', true, undefined, { phase: 'pre_dispatch', ack: 'unconfirmed' });
      remote.posts++;
      if (remote.failCreate) throw new Error('Synthetic lost creation response, never expose private URL');
      const orderNo = remote.duplicateOrder ? 'order-1' : `order-${remote.creates}`;
      remote.statuses.set(orderNo, { state: 'processing', receipt: null });
      return { orderNo, url: remote.unsafeUrl ? 'https://evil.test/private-token' : `https://quick.upay.best/#/pay?privateToken=fixture-${orderNo}`,
        expiresAt: new Date(Date.now() + 60_000) };
    },
    inspect: async input => {
      remote.reads++;
      if (remote.failRead) throw new Error('Synthetic private upstream error');
      return remote.statuses.get(input.orderNo) ?? { state: 'processing', receipt: null };
    },
  };
  const lifecycle = { enabled: true, live: true };
  const service = new DepositInvoiceService(ctx.db, config.appSecret, provider, (tx, value) => ctx!.services.wallet.creditInvoice(tx, value), lifecycle);
  ctx.services.depositInvoices = service;
  const input: DepositInvoiceInput = { asset: 'USDT', network: 'TRC20', amount: '10', idempotencyKey: randomUUID() };
  return { user, userId, client, remote, provider, service, config, input, lifecycle };
}
function paid(orderNo: string, receiptId = `receipt-${orderNo}`, amount = 9_820_000n): UpayInvoiceInspection {
  return { state: 'paid', receipt: { orderNo, receiptId, asset: 'USDT', network: 'TRC20', amount } };
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real external calls are forbidden in invoice fixtures'); })); });
afterEach(async () => {
  try { if (ctx) { await assertLedgerConsistent(ctx.db); await ctx.close(); ctx = undefined; } }
  finally { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); }
});

describe('native UPay invoices credited only from exact received bookkeeping', () => {
  it('continues exact-receipt crediting of an existing invoice when new invoice creation is disabled', async () => {
    const f = await setup(); const created = await f.client.post('/v1/deposit-invoices', f.input);
    f.lifecycle.enabled = false;
    expect(f.service.ready).toBe(false);
    expect((await f.client.post('/v1/deposit-invoices', { ...f.input, idempotencyKey: randomUUID() })).status).toBe(503);
    expect((await f.client.post(`/v1/deposit-invoices/${created.body.id}/retry`, {})).body.id).toBe(created.body.id);
    f.remote.statuses.set('order-1', paid('order-1'));
    expect((await f.client.get(`/v1/deposit-invoices/${created.body.id}`)).body).toMatchObject({ state: 'credited', creditedAmount: '9.82', paymentUrl: null });
    await f.service.handlers()['deposit.invoices.sync_all']!.run({});
    expect(await getBalance(ctx!.db, accounts.userWallet(f.userId, 'USDT').code)).toBe(9_820_000n);
    expect(await ctx!.db.select().from(deposits)).toHaveLength(1);
    expect(f.remote.posts).toBe(1);
  });
  it('defers an old watchdog while an explicit prepared retry has a fresh sending claim', async () => {
    const f = await setup(); f.remote.preDispatchFailure = true;
    const first = await f.client.post('/v1/deposit-invoices', f.input);
    expect(first.body.state).toBe('prepared');
    await ctx!.db.update(depositInvoices).set({ updatedAt: new Date(Date.now() - 120_000) }).where(eq(depositInvoices.id, first.body.id));
    f.remote.preDispatchFailure = false;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.remote.pauseBeforeDispatch = async () => { entered(); await paused; };
    const retry = f.client.post(`/v1/deposit-invoices/${first.body.id}/retry`, {});
    await started;
    try {
      await expect(f.service.handlers()['deposit.invoice.reconcile']!.run({ invoiceId: first.body.id })).rejects.toBeInstanceOf(RetryLater);
      expect((await ctx!.db.select().from(depositInvoices).where(eq(depositInvoices.id, first.body.id)))[0]!.state).toBe('sending');
      expect(f.remote.posts).toBe(0);
    } finally {
      release();
      const completed = await retry;
      expect(completed.body.state).toBe('awaiting_payment');
      expect(f.remote.posts).toBe(1);
    }
  });
  it('permits only an explicit, serialized retry of a proven pre-dispatch failure using the same invoice', async () => {
    const f = await setup(); f.remote.preDispatchFailure = true;
    const first = await f.client.post('/v1/deposit-invoices', f.input);
    expect(first.body).toMatchObject({ state: 'prepared', paymentUrl: null });
    expect(f.remote.posts).toBe(0);
    await f.client.get('/v1/deposit-invoices/active');
    await f.client.get(`/v1/deposit-invoices/${first.body.id}`);
    expect(f.remote.creates).toBe(1);
    f.remote.preDispatchFailure = false;
    const retries = await Promise.all(Array.from({ length: 8 }, () => f.client.post(`/v1/deposit-invoices/${first.body.id}/retry`, {})));
    expect(retries.every(result => result.status === 202 && result.body.id === first.body.id)).toBe(true);
    expect(f.remote.posts).toBe(1);
    expect(f.remote.creates).toBe(2);
    expect(await ctx!.db.select().from(depositInvoices)).toHaveLength(1);
  });
  it('requires unlocked owner access, encrypts the payment URL and never credits a processing invoice', async () => {
    const f = await setup();
    expect((await ctx!.app.inject({ method: 'POST', url: '/v1/deposit-invoices', payload: f.input })).statusCode).toBe(401);
    const locked = await telegramLogin(ctx!, f.user.telegramId);
    expect((await api(ctx!, locked.accessToken).post('/v1/deposit-invoices', f.input)).status).toBe(403);
    const created = await f.client.post('/v1/deposit-invoices', f.input);
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({ state: 'awaiting_payment', requestedAmount: '10', creditedAmount: null });
    expect(created.body.paymentUrl).toContain('https://quick.upay.best/');
    const [stored] = await ctx!.db.select().from(depositInvoices);
    expect(JSON.stringify(stored, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).not.toContain('privateToken');
    expect((await f.client.get('/v1/deposit-invoices/active')).body.id).toBe(created.body.id);
    const stranger = api(ctx!, (await registerUser(ctx!)).token);
    expect((await stranger.get(`/v1/deposit-invoices/${created.body.id}`)).status).toBe(404);
    expect((await stranger.get('/v1/deposit-invoices/active')).body).toBeNull();
    expect(await getBalance(ctx!.db, accounts.userWallet(f.userId, 'USDT').code)).toBe(0n);
    expect(await ctx!.db.select().from(deposits)).toHaveLength(0);
    expect(f.remote.creates).toBe(1);
  });

  it('serializes different keys for the same active invoice and does not create twice after a remount or lost response', async () => {
    const f = await setup();
    const results = await Promise.all(Array.from({ length: 8 }, () => f.client.post('/v1/deposit-invoices', { ...f.input, idempotencyKey: randomUUID() })));
    expect(results.every(result => result.status === 202)).toBe(true);
    expect(new Set(results.map(result => result.body.id)).size).toBe(1);
    expect(f.remote.creates).toBe(1);
    expect(await ctx!.db.select().from(depositInvoices)).toHaveLength(1);
    expect((await f.client.post('/v1/deposit-invoices', { ...f.input, amount: '11' })).status).toBe(400);
    expect(f.remote.creates).toBe(1);
  });

  it('never replays an unknown creation, including new service instances and a new client key', async () => {
    const f = await setup(); f.remote.failCreate = true;
    const created = await f.client.post('/v1/deposit-invoices', f.input);
    expect(created.body).toMatchObject({ state: 'unknown', paymentUrl: null });
    ctx!.services.depositInvoices = new DepositInvoiceService(ctx!.db, f.config.appSecret, f.provider,
      (tx, value) => ctx!.services.wallet.creditInvoice(tx, value), { enabled: true, live: true });
    expect((await f.client.post('/v1/deposit-invoices', f.input)).body.id).toBe(created.body.id);
    expect((await f.client.post('/v1/deposit-invoices', { ...f.input, idempotencyKey: randomUUID() })).body.id).toBe(created.body.id);
    await f.service.handlers()['deposit.invoice.reconcile']!.run({ invoiceId: created.body.id });
    expect((await f.client.get('/v1/deposit-invoices/active')).body.state).toBe('unknown');
    expect(f.remote.creates).toBe(1);
    expect(await ctx!.db.select().from(deposits)).toHaveLength(0);
  });

  it.each(['no receipt', 'wrong order', 'wrong asset', 'wrong network', 'zero amount'] as const)('holds a paid invoice as confirming for %s without giving a payment link or credit', async reason => {
    const f = await setup(); const created = await f.client.post('/v1/deposit-invoices', f.input);
    const inspection = paid('order-1');
    if (reason === 'no receipt') inspection.receipt = null;
    if (reason === 'wrong order') inspection.receipt!.orderNo = 'foreign-order';
    if (reason === 'wrong asset') inspection.receipt!.asset = 'USDC';
    if (reason === 'wrong network') inspection.receipt!.network = 'BEP20';
    if (reason === 'zero amount') inspection.receipt!.amount = 0n;
    f.remote.statuses.set('order-1', inspection);
    expect((await f.client.get(`/v1/deposit-invoices/${created.body.id}`)).body).toMatchObject({ state: 'confirming', paymentUrl: null, creditedAmount: null });
    expect(await getBalance(ctx!.db, accounts.userWallet(f.userId, 'USDT').code)).toBe(0n);
    expect(await ctx!.db.select().from(deposits)).toHaveLength(0);
  });

  it('uses actual net9.82 instead of requested10 and posts one real wallet credit under concurrent status reads', async () => {
    const f = await setup(); const created = await f.client.post('/v1/deposit-invoices', f.input);
    f.remote.statuses.set('order-1', paid('order-1'));
    const results = await Promise.all(Array.from({ length: 10 }, () => f.client.get(`/v1/deposit-invoices/${created.body.id}`)));
    expect(results.every(result => result.body.state === 'credited')).toBe(true);
    expect(results[0]!.body).toMatchObject({ creditedAmount: '9.82', requestedAmount: '10', paymentUrl: null });
    expect(await getBalance(ctx!.db, accounts.userWallet(f.userId, 'USDT').code)).toBe(9_820_000n);
    const [deposit] = await ctx!.db.select().from(deposits);
    expect(deposit).toMatchObject({ providerId: 'upay-invoice', status: 'credited', amount: 9_820_000n });
    expect(await ctx!.db.select().from(ledgerTransactions).where(eq(ledgerTransactions.kind, 'deposit'))).toHaveLength(1);
    expect((await ctx!.services.activity.list(f.userId)).find(item => item.kind === 'deposit')).toMatchObject({ amount: '+9.82', asset: 'USDT', status: 'succeeded' });
    expect((await f.client.get('/v1/deposit-invoices/active')).body).toBeNull();
    expect((await f.client.post('/v1/deposit-invoices', f.input)).body.state).toBe('credited');
    expect(f.remote.creates).toBe(1);
  });

  it('credits an expired invoice paid later while preserving a separate new active invoice', async () => {
    const f = await setup(); const first = await f.client.post('/v1/deposit-invoices', f.input);
    f.remote.statuses.set('order-1', { state: 'expired', receipt: null });
    expect((await f.client.get(`/v1/deposit-invoices/${first.body.id}`)).body.state).toBe('expired');
    const second = await f.client.post('/v1/deposit-invoices', { ...f.input, idempotencyKey: randomUUID() });
    expect(second.body.id).not.toBe(first.body.id);
    f.remote.statuses.set('order-1', paid('order-1'));
    await f.service.handlers()['deposit.invoice.reconcile']!.run({ invoiceId: first.body.id });
    expect((await f.client.get(`/v1/deposit-invoices/${first.body.id}`)).body.state).toBe('credited');
    expect((await f.client.get('/v1/deposit-invoices/active')).body.id).toBe(second.body.id);
    expect(f.remote.creates).toBe(2);
    expect(await getBalance(ctx!.db, accounts.userWallet(f.userId, 'USDT').code)).toBe(9_820_000n);
  });

  it('does not credit the same receipt to another invoice or user', async () => {
    const f = await setup(); const first = await f.client.post('/v1/deposit-invoices', f.input);
    const other = api(ctx!, (await registerUser(ctx!)).token);
    const otherId = (await other.get('/v1/me')).body.id as string;
    const second = await other.post('/v1/deposit-invoices', { ...f.input, idempotencyKey: randomUUID() });
    f.remote.statuses.set('order-1', paid('order-1', 'shared-receipt'));
    f.remote.statuses.set('order-2', paid('order-2', 'shared-receipt'));
    expect((await f.client.get(`/v1/deposit-invoices/${first.body.id}`)).body.state).toBe('credited');
    expect((await other.get(`/v1/deposit-invoices/${second.body.id}`)).body).toMatchObject({ state: 'confirming', paymentUrl: null });
    expect(await getBalance(ctx!.db, accounts.userWallet(f.userId, 'USDT').code)).toBe(9_820_000n);
    expect(await getBalance(ctx!.db, accounts.userWallet(otherId, 'USDT').code)).toBe(0n);
    expect(await ctx!.db.select().from(deposits)).toHaveLength(1);
    expect(await ctx!.db.select().from(ledgerTransactions).where(eq(ledgerTransactions.kind, 'deposit'))).toHaveLength(1);
  });

  it('rejects unsafe checkout targets, unsupported amount precision and an unsealed database without any credit', async () => {
    const f = await setup();
    expect((await f.client.post('/v1/deposit-invoices', { ...f.input, amount: '1.001' })).status).toBe(400);
    expect(f.remote.creates).toBe(0);
    f.remote.unsafeUrl = true;
    expect((await f.client.post('/v1/deposit-invoices', f.input)).body).toMatchObject({ state: 'unknown', paymentUrl: null });
    expect(await ctx!.db.select().from(deposits)).toHaveLength(0);
    const read = await f.client.get('/v1/deposit-invoices/active');
    expect(JSON.stringify(read.body)).not.toContain('evil.test');
    expect(JSON.stringify(read.body)).not.toContain('private-token');
  });

  it('requires the immutable live seal before creating an invoice', async () => {
    const f = await setup(false);
    expect(await ctx!.db.select().from(appSettings).where(eq(appSettings.key, 'financial_mode'))).toHaveLength(0);
    expect((await f.client.post('/v1/deposit-invoices', f.input)).status).toBe(503);
    expect(f.remote.creates).toBe(0);
    expect(await ctx!.db.select().from(depositInvoices)).toHaveLength(0);
    expect(await ctx!.db.select().from(deposits)).toHaveLength(0);
  });

  it('keeps checkout hidden on read failure and limits automatic expired checks to seven days', async () => {
    const f = await setup(); const created = await f.client.post('/v1/deposit-invoices', f.input);
    f.remote.failRead = true;
    expect((await f.client.get(`/v1/deposit-invoices/${created.body.id}`)).body.paymentUrl).toBeNull();
    f.remote.failRead = false;
    f.remote.statuses.set('order-1', { state: 'expired', receipt: null });
    await f.client.get(`/v1/deposit-invoices/${created.body.id}`);
    await ctx!.db.update(depositInvoices).set({ expiresAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) }).where(eq(depositInvoices.id, created.body.id));
    const reads = f.remote.reads;
    await f.service.handlers()['deposit.invoice.reconcile']!.run({ invoiceId: created.body.id });
    expect(f.remote.reads).toBe(reads);
    f.remote.statuses.set('order-1', paid('order-1'));
    expect((await f.client.get(`/v1/deposit-invoices/${created.body.id}`)).body.state).toBe('credited');
    expect(f.remote.creates).toBe(1);
  });
});
