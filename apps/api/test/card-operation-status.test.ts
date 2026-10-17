import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cardBillingAddresses, cardIssueSponsorships, cardOperations, cards, jobs, kycProfiles, upaySubmissionAliases, upaySubmissions, users } from '../src/db/schema';
import { inspectCardOperationStatus } from '../src/ops/card-operation-status';
import { inspectCardOperationProviderStatus } from '../src/ops/card-operation-provider-status';
import type { UpayClient } from '../src/partner/upay/client';
import { UpayError } from '../src/partner/upay/transport';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { DisabledDepositProvider } from '../src/deposits/provider';
import { MockUpayPartner } from '../src/partner/mock';
import { createTestContext, telegramLogin, type TestContext } from './helpers';

const opsToken = 'card-status-operator-token-at-least-32-characters';
const owner = 514468501n;
let ctx: TestContext | undefined;
afterEach(async () => { vi.restoreAllMocks(); if (ctx) { await ctx.close(); ctx = undefined; } });

async function seed(telegramId = owner, sponsored = false) {
  const [user] = await ctx!.db.insert(users).values({ telegramId, username: 'PRIVATE_username', firstName: 'PRIVATE_name' }).returning();
  const [card] = await ctx!.db.insert(cards).values({ userId: user!.id, productName: 'PRIVATE_product', status: 'pending', holderName: 'PRIVATE_holder' }).returning();
  const [grant] = sponsored ? await ctx!.db.insert(cardIssueSponsorships).values({ telegramId, reason: 'PRIVATE authorization reason' }).returning() : [];
  const [operation] = await ctx!.db.insert(cardOperations).values({ userId: user!.id, cardId: card!.id, type: 'issue', partnerProvider: 'upay',
    sponsorshipId: grant?.id,
    idempotencyKey: `PRIVATE-${randomUUID()}`, status: 'unknown', attempts: 1, amount: 10000000n, fee: 10000000n,
    asset: 'USDT', error: 'Partner result is unconfirmed; funds remain reserved' }).returning();
  if (grant) await ctx!.db.update(cardIssueSponsorships).set({ operationId: operation!.id }).where(eq(cardIssueSponsorships.id, grant.id));
  return { user: user!, card: card!, operation: operation!, grant };
}

describe('read-only operator card operation status', () => {
  it('reports only the operation owner’s closed billing state without decrypting or returning foreign or private fields', async () => {
    ctx = await createTestContext();
    const { user, operation } = await seed();
    const [foreign] = await ctx.db.insert(users).values({ telegramId: owner + 1n }).returning();
    await ctx.db.insert(kycProfiles).values({ userId: user.id, status: 'approved', partnerProvider: 'upay', partnerCustomerId: 'PRIVATE_customer' });
    await ctx.db.insert(cardBillingAddresses).values({ userId: foreign!.id, customerNo: 'PRIVATE_foreign_customer', marker: 'GDXB0123456789abcdef',
      requestHash: 'PRIVATE_foreign_hash', ciphertext: 'PRIVATE_foreign_address', iv: 'PRIVATE', tag: 'PRIVATE', status: 'ready', partnerAddressId: 'PRIVATE_foreign_id' });
    expect((await inspectCardOperationStatus(ctx.db, operation.id)).billing).toEqual({
      exists: false, status: null, customerMatchesKyc: false, hasPartnerAddressId: false, updatedAt: null,
    });
    const updatedAt = new Date('2026-10-16T20:30:00.000Z');
    await ctx.db.insert(cardBillingAddresses).values({ userId: user.id, customerNo: 'PRIVATE_customer', marker: 'GDXBfedcba9876543210',
      requestHash: 'PRIVATE_own_hash', ciphertext: 'PRIVATE_own_address', iv: 'PRIVATE', tag: 'PRIVATE', status: 'ready', partnerAddressId: 'PRIVATE_own_id', updatedAt });
    const before = await ctx.db.select().from(cardBillingAddresses);
    const result = await inspectCardOperationStatus(ctx.db, operation.id);
    expect(result.billing).toEqual({ exists: true, status: 'ready', customerMatchesKyc: true, hasPartnerAddressId: true, updatedAt: updatedAt.toISOString() });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(result)).not.toContain('GDXB');
    expect(await ctx.db.select().from(cardBillingAddresses)).toEqual(before);
    await ctx.db.update(cardBillingAddresses).set({ customerNo: 'PRIVATE_mismatch', status: 'unknown', partnerAddressId: null }).where(eq(cardBillingAddresses.userId, user.id));
    expect((await inspectCardOperationStatus(ctx.db, operation.id)).billing).toMatchObject({ exists: true, status: 'unknown', customerMatchesKyc: false, hasPartnerAddressId: false });
  });

  it('distinguishes no dispatch journal from an uncertain local operation without exposing card or user data', async () => {
    ctx = await createTestContext();
    const { operation } = await seed();
    const result = await inspectCardOperationStatus(ctx.db, operation.id);
    expect(result).toMatchObject({ matchingUser: true, operation: { type: 'issue', status: 'unknown', attempts: 1, errorCategory: 'partner_unconfirmed' },
      card: { status: 'pending', partnerLinked: false, matchingUser: true }, journal: { exists: false, hasReceiptId: false, hasCardId: false },
      sponsorship: { fundingSource: 'wallet', status: 'not_applicable' }, aliases: { total: 0 }, jobs: { items: [], truncated: false } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('protects GET with OPS and no-store, validates the UUID, and never wakes the queue or calls a provider', async () => {
    let wakeups = 0;
    ctx = await createTestContext(undefined, { env: { OPS_API_TOKEN: opsToken }, onResponse: () => { wakeups++; } });
    const { operation } = await seed();
    const token = (await telegramLogin(ctx, Number(owner))).accessToken;
    const url = `/v1/ops/cards/${operation.id}/status`, headers = { authorization: `Bearer ${opsToken}` };
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Status must not make external requests'));
    const reconcile = vi.spyOn(ctx.services.cards, 'reconcileUnknown').mockRejectedValue(new Error('Status must not reconcile'));
    const drain = vi.spyOn(ctx.runner, 'drain').mockRejectedValue(new Error('Status must not drain jobs'));
    wakeups = 0;
    for (const auth of [{}, { authorization: `Bearer ${token}` }]) {
      const response = await ctx.app.inject({ method: 'GET', url, headers: auth });
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const response = await ctx.app.inject({ method: 'GET', url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const invalid = await ctx.app.inject({ method: 'GET', url: '/v1/ops/cards/invalid/status', headers });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.headers['cache-control']).toBe('no-store');
    expect(fetch).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled(); expect(drain).not.toHaveBeenCalled();
    expect(wakeups).toBe(0);
  });

  it('returns only closed evidence names, safe dispatch metadata and exact-operation jobs and alias counts', async () => {
    ctx = await createTestContext(undefined, { env: { OPS_API_TOKEN: opsToken } });
    const { user, operation } = await seed();
    await ctx.db.insert(kycProfiles).values({ userId: user.id, status: 'approved', submissionState: 'submitted', partnerProvider: 'upay',
      partnerCustomerId: 'PRIVATE_customer', email: 'PRIVATE@example.test', firstName: 'PRIVATE_name' });
    await ctx.db.insert(upaySubmissions).values({ reference: operation.id, kind: 'issue', state: 'unknown', requestHash: 'PRIVATE_hash',
      partnerReceiptId: 'PRIVATE_receipt', partnerCardId: 'PRIVATE_card', evidence: { customerNo: 'PRIVATE_customer', orderNo: 'PRIVATE_order',
        maxFeeBudgetUsdt: 'PRIVATE_value', dispatchPhase: 'post_dispatched', responseAck: 'rejected_envelope', upstreamCode: 987654, httpStatus: 200,
        PRIVATE_KEY: 'PRIVATE_payload', pinCode: 'PRIVATE_pin', uri: 'PRIVATE_uri' } });
    await ctx.db.insert(upaySubmissionAliases).values(['order:PRIVATE_order', 'record:PRIVATE_record', 'card:PRIVATE_card'].map(alias => ({ reference: operation.id, kind: 'issue', alias })));
    await ctx.db.insert(jobs).values([
      { queue: 'card.issue', payload: { operationId: operation.id, email: 'PRIVATE@example.test' }, status: 'failed', attempts: 1, lastError: 'PRIVATE upstream identity' },
      { queue: 'card.reconcile', payload: { operationId: operation.id }, status: 'queued', lastError: 'Job lease lost' },
      { queue: 'card.issue', payload: { operationId: randomUUID() }, status: 'running', lastError: 'PRIVATE foreign error' },
      { queue: 'PRIVATE_queue', payload: { operationId: operation.id }, status: 'done', lastError: 'PRIVATE foreign error' },
    ]);
    const before = await Promise.all([ctx.db.select().from(users), ctx.db.select().from(cardOperations), ctx.db.select().from(cards),
      ctx.db.select().from(jobs), ctx.db.select().from(upaySubmissions), ctx.db.select().from(upaySubmissionAliases), ctx.db.select().from(kycProfiles)]);
    const result = await inspectCardOperationStatus(ctx.db, operation.id);
    expect(result.journal).toMatchObject({ exists: true, kind: 'issue', state: 'unknown', kindMatchesOperation: true,
      hasReceiptId: true, hasCardId: true, customerMatchesKyc: true, diagnostic: { dispatchPhase: 'post_dispatched', responseAck: 'rejected_envelope', upstreamCode: 987654, httpStatus: 200 } });
    expect(result.journal.evidenceKeys).toEqual(['customerNo', 'orderNo', 'maxFeeBudgetUsdt', 'dispatchPhase', 'responseAck', 'upstreamCode', 'httpStatus']);
    expect(result.aliases).toEqual({ total: 3, order: 1, record: 1, card: 1, other: 0 });
    expect(result.kyc).toEqual({ status: 'approved', submissionState: 'submitted' });
    expect(result.jobs.items.map(job => ({ queue: job.queue, status: job.status, errorCategory: job.errorCategory }))).toEqual([
      { queue: 'card.issue', status: 'failed', errorCategory: 'unclassified' }, { queue: 'card.reconcile', status: 'queued', errorCategory: 'lease_lost' },
    ]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(await Promise.all([ctx.db.select().from(users), ctx.db.select().from(cardOperations), ctx.db.select().from(cards),
      ctx.db.select().from(jobs), ctx.db.select().from(upaySubmissions), ctx.db.select().from(upaySubmissionAliases), ctx.db.select().from(kycProfiles)])).toEqual(before);
  });

  it('shows reserved and consumed broker coverage without exposing its amount, reason or identifiers', async () => {
    ctx = await createTestContext();
    const { operation, grant } = await seed(owner, true);
    expect((await inspectCardOperationStatus(ctx.db, operation.id)).sponsorship).toEqual({ fundingSource: 'broker', status: 'reserved', bindingMatches: true });
    await ctx.db.update(cardIssueSponsorships).set({ consumedAt: new Date() }).where(eq(cardIssueSponsorships.id, grant!.id));
    expect((await inspectCardOperationStatus(ctx.db, operation.id)).sponsorship).toEqual({ fundingSource: 'broker', status: 'consumed', bindingMatches: true });
    expect(JSON.stringify(await inspectCardOperationStatus(ctx.db, operation.id))).not.toContain('PRIVATE');
  });

  it('makes another user’s operation indistinguishable from a nonexistent one even for OPS', async () => {
    ctx = await createTestContext(undefined, { env: { OPS_API_TOKEN: opsToken } });
    const { operation } = await seed(owner + 1n);
    const headers = { authorization: `Bearer ${opsToken}` };
    const foreign = await ctx.app.inject({ method: 'GET', url: `/v1/ops/cards/${operation.id}/status`, headers });
    const absent = await ctx.app.inject({ method: 'GET', url: `/v1/ops/cards/${randomUUID()}/status`, headers });
    expect(foreign.statusCode).toBe(404); expect(absent.statusCode).toBe(404);
    expect(foreign.json()).toEqual(absent.json());
    expect(foreign.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(foreign.json())).not.toContain('PRIVATE');
  });

  it('omits malformed diagnostic values and bounds long operation job histories', async () => {
    ctx = await createTestContext();
    const { operation } = await seed();
    await ctx.db.insert(upaySubmissions).values({ reference: operation.id, kind: 'PRIVATE_kind', state: 'PRIVATE_state', requestHash: 'PRIVATE',
      evidence: { dispatchPhase: 'PRIVATE', responseAck: 'PRIVATE', upstreamCode: 'PRIVATE', httpStatus: 999, PRIVATE: 'PRIVATE' } });
    await ctx.db.insert(jobs).values(Array.from({ length: 52 }, () => ({ queue: 'card.issue', payload: { operationId: operation.id }, status: 'done' as const })));
    const result = await inspectCardOperationStatus(ctx.db, operation.id);
    expect(result.journal).toMatchObject({ exists: true, kind: 'other', state: 'other', kindMatchesOperation: false, diagnostic: {} });
    expect(result.jobs.truncated).toBe(true); expect(result.jobs.items).toHaveLength(50);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
});

describe('read-only owner-scoped provider card observations', () => {
  async function scope(telegramId = owner) {
    const seeded = await seed(telegramId), customerNo = 'PRIVATE_customer', productId = 'PRIVATE_product';
    await ctx!.db.insert(kycProfiles).values({ userId: seeded.user.id, status: 'approved', partnerProvider: 'upay', partnerCustomerId: customerNo });
    await ctx!.db.insert(upaySubmissions).values({ reference: seeded.operation.id, kind: 'issue', state: 'unknown', requestHash: 'PRIVATE_hash',
      evidence: { customerNo, agentCardId: productId, maxFeeBudgetUsdt: '10.00', openFeeUsdt: '10.00', defaultOpenUsdt: '0.00' } });
    return { ...seeded, customerNo, productId };
  }
  it.each([{ detailSource: undefined, registrationSource: 'system' }, { detailSource: 3, registrationSource: 'unknown' }])(
    'observes exact customer group and tariffs without exposing names, identifiers or changing the customer ($registrationSource)', async ({ detailSource, registrationSource }) => {
    ctx = await createTestContext();
    const { operation, productId, customerNo } = await scope();
    const calls: { method: string; path: string; options: unknown }[] = [];
    const client = { readRequest: async (method: string, path: string, options: unknown) => {
      calls.push({ method, path, options });
      if (path === '/customer/list') return { totalPages: 1, list: [{ customerId: 'PRIVATE_customer_id', no: customerNo, source: 2, email: 'PRIVATE@example.test' }] };
      if (path === '/customer/get') return { customerId: 'PRIVATE_customer_id', no: customerNo, groupId: 'PRIVATE_default', source: detailSource, givenName: 'PRIVATE_name' };
      if (path === '/customer/group/list') return { totalPages: 1, list: [{ id: 'PRIVATE_default', no: 'PRIVATE_group1', name: 'Default Group', isDefault: 1, rateBatchNo: null },
        { id: 'PRIVATE_gudex', no: 'PRIVATE_group2', name: 'GudEx Bot', rateBatchNo: 'PRIVATE_rate' }] };
      if (path === '/card/rate/list') return { totalPages: 1, list: [{ batchNo: 'PRIVATE_rate', customerGroupNo: 'PRIVATE_group2', name: 'PRIVATE_tariff' }] };
      if (path === '/card/rate/list/all') return [{ batchNo: 'PRIVATE_rate', name: 'PRIVATE_tariff' }];
      if (path === '/card/choose') return [{ agentCardId: productId, coinSymbol: 'USDT', costFee: '10.00', cardName: 'PRIVATE' }];
      if (path === '/card/rate/info') return { batchNo: 'PRIVATE_rate', name: 'PRIVATE', items: [{ agentCardId: productId, openFee: '20.00', rechargeRate: 'PRIVATE' }] };
      if (path === '/card/getMayApplyCardDetail') return { agentCardId: null, openFee: '10.00', defaultOpenAmount: '0.00', rechargeCurrency: 'USDT', cardCurrency: 'USD', accountCoinSymbol: 'USDT', accountCoinBalance: '210.10' };
      if (path === '/card/getCardFee') return { customerNo, agentCardId: productId, needParams: ['givenName'], givenName: 'PRIVATE NAME' };
      return path === '/card/getCardOperateStatus' ? [] : { totalPages: 1, list: [] };
    } } as unknown as UpayClient;
    const before = await Promise.all([ctx.db.select().from(upaySubmissions), ctx.db.select().from(kycProfiles)]);
    const result = await inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId);
    expect(result).toMatchObject({ customerGroup: { complete: true, customerMatches: true, detailIdentifierMatches: true, registrationSource,
      groups: { complete: true, observedRows: 2, currentGroupUnique: true, currentIsDefault: true, currentHasRate: false, gudexBotMatches: 1, currentIsGudexBot: false,
        gudexBotHasRate: true, sameRateAsGudexBot: false },
      rates: { complete: true, observedRows: 1, currentRateMatches: 0, gudexBotRateMatches: 1, catalogHasCurrentRate: false, catalogHasGudexBotRate: true },
      selectedProductTariff: { complete: true, brokerProductUnique: true, tariffProductUnique: true, targetRateMatches: true, currencyMatchesUsdt: true,
        brokerCostUsdt: '10.00', customerOpenFeeUsdt: '20.00', withinOpBrokerBudget: true, costCustomerAreDifferent: true },
      product: { productMatches: true, feeFormCustomerMatches: true, feeFormReady: true, openFeeUsdt: '10.00', initialPaymentUsdt: '0.00',
        paymentUsdt: '10.00', withinOperationBudget: true, accountCoinBalanceUsdt: '210.10', groupAllowed: null, customerTariffEqualsBrokerCostEstablished: false } } });
    expect(calls.find(call => call.path === '/customer/get')).toEqual({ method: 'GET', path: '/customer/get', options: { query: { customerId: 'PRIVATE_customer_id' } } });
    expect(calls.every(call => call.method === 'GET' || call.path === '/card/getPageToCardOperateRecord')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(await Promise.all([ctx.db.select().from(upaySubmissions), ctx.db.select().from(kycProfiles)])).toEqual(before);
    expect(result.exactOperationBindingEstablished).toBe(false);
  });
  it.each(['conflicting_batch', 'duplicate_product', 'non_usdt', 'wrapped_choices', 'alternate_id', 'choice_rejected', 'null_choice', 'choice_private_error'] as const)('does not infer selected product tariff amounts from %s', async mode => {
    ctx = await createTestContext();
    const { operation, productId, customerNo } = await scope();
    const client = { readRequest: async (_method: string, path: string) => {
      if (path === '/customer/list') return { totalPages: 1, list: [{ customerId: 'PRIVATE_id', no: customerNo }] };
      if (path === '/customer/get') return { customerId: 'PRIVATE_id', no: customerNo, groupId: 'PRIVATE_default' };
      if (path === '/customer/group/list') return { totalPages: 1, list: [{ id: 'PRIVATE_default', name: 'Default Group' },
        { id: 'PRIVATE_gudex', name: 'GudEx Bot', rateBatchNo: 'PRIVATE_rate' }] };
      if (path === '/card/rate/list') return { totalPages: 1, list: [] };
      if (path === '/card/rate/list/all') return [];
      if (path === '/card/choose') {
        if (mode === 'choice_rejected') throw new UpayError('PRIVATE endpoint response or personal detail', false, 40321, { phase: 'post_dispatched', ack: 'rejected_envelope', httpStatus: 200 });
        if (mode === 'choice_private_error') throw Object.assign(new Error('PRIVATE diagnostic'), { code: 40321, httpStatus: 503 });
        if (mode === 'null_choice') return null;
        if (mode === 'wrapped_choices') return { data: { items: [{ id: productId, coinSymbol: 'USDT', costFee: '10', secret: 'PRIVATE' }] } };
        if (mode === 'alternate_id') return [{ id: productId, coinSymbol: 'USDT', costFee: '10' }];
        return [{ agentCardId: productId, coinSymbol: mode === 'non_usdt' ? 'USDC' : 'USDT', costFee: '10' },
          ...(mode === 'duplicate_product' ? [{ agentCardId: productId, coinSymbol: 'USDT', costFee: 'PRIVATE' }] : [])];
      }
      if (path === '/card/rate/info') return { batchNo: mode === 'conflicting_batch' ? 'PRIVATE_wrong' : 'PRIVATE_rate',
        items: [{ agentCardId: productId, openFee: '20' }] };
      return path === '/card/getCardOperateStatus' ? [] : { totalPages: 1, list: [] };
    } } as unknown as UpayClient;
    const result = await inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId);
    expect(result.customerGroup).toMatchObject({ selectedProductTariff: { complete: false, customerOpenFeeUsdt: null, costCustomerAreDifferent: null } });
    if (mode !== 'conflicting_batch') expect(result.customerGroup).toMatchObject({ selectedProductTariff: { brokerCostUsdt: null, withinOpBrokerBudget: null } });
    if (mode === 'wrapped_choices') expect(result.customerGroup).toMatchObject({ selectedProductTariff: { choicesSchema: { shape: 'object', fieldShapes: { data: 'object' },
      nested: { data: { fieldShapes: { items: 'array' }, nested: { items: { shape: 'array', count: 1, samples: [{ shape: 'object', fieldShapes: { id: 'string', costFee: 'string', secret: 'string' } }] } } } } } } });
    if (mode === 'alternate_id') expect(result.customerGroup).toMatchObject({ selectedProductTariff: { choicesSchema: { shape: 'array', count: 1,
      samples: [{ fieldShapes: { id: 'string', costFee: 'string', coinSymbol: 'string' } }] } } });
    if (mode === 'choice_rejected') expect(result.customerGroup).toMatchObject({ selectedProductTariff: { choicesSchema: { shape: 'null' },
      choicesRead: { ok: false, httpStatus: 200, upstreamCode: 40321 } } });
    if (mode === 'null_choice') expect(result.customerGroup).toMatchObject({ selectedProductTariff: { choicesSchema: { shape: 'null' },
      choicesRead: { ok: true, httpStatus: null, upstreamCode: null } } });
    if (mode === 'choice_private_error') expect(result.customerGroup).toMatchObject({ selectedProductTariff: { choicesSchema: { shape: 'null' },
      choicesRead: { ok: false, httpStatus: null, upstreamCode: null } } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('observes the native issuance bill date window without treating a matching amount or time as an operation receipt', async () => {
    ctx = await createTestContext();
    const { operation, productId, customerNo } = await scope();
    const calls: { method: string; path: string; options: unknown }[] = [];
    const client = { readRequest: async (method: string, path: string, options: unknown) => {
      calls.push({ method, path, options });
      if (path === '/bill/list') return { totalPages: 1, totalSize: 3, list: [
        { id: 'PRIVATE_bill', orderNo: 'PRIVATE_order', customerNo, amount: '10.00', symbol: 'USDT', type: 4, state: 1, inOut: 2,
          createTimeTimestamp: String(operation.createdAt.getTime() + 1000), selfId: 'PRIVATE_unbound', last4: 'PRIVATE', ditchCardName: 'PRIVATE', unknown: 'PRIVATE' },
        { amount: '20.00', symbol: 'USDC', type: 4, state: 2, inOut: 1, createTime: '2026-10-16 17:39:54' },
        { amount: 'PRIVATE', symbol: 'USDT', type: 987654321, state: 987654321, inOut: 987654321, createTimeTimestamp: 'PRIVATE' },
      ] };
      return path === '/card/getCardOperateStatus' ? [] : { totalPages: 1, list: [] };
    } } as unknown as UpayClient;
    const before = await ctx.db.select().from(upaySubmissions);
    const result = await inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId);
    expect(result).toMatchObject({ brokerBills: { complete: true, observedRows: 3, pages: 1, evidenceOnly: true, exactOperationBindingEstablished: false,
      allRowsMatchRequestedType: false, items: [
        { amountUsdt: '10.00', currencyMatchesUsdt: true, type: 'card_issue', state: 'succeeded', direction: 'debit', customerMatches: true,
          orderMatchesKnownReceipt: false, cardMatchesKnownCard: false, amountMatchesOperationBudget: true, timeClass: 'operation_window', hasOrderId: true },
        { amountUsdt: null, currencyMatchesUsdt: false, type: 'card_issue', state: 'pending', direction: 'credit', timeClass: 'unconfirmed' },
        { amountUsdt: null, type: 'other', state: 'other', direction: 'unknown', timeClass: 'unconfirmed' },
      ] } });
    const start = new Date(operation.createdAt.getTime() - 86400000).toISOString().slice(0, 10);
    const end = new Date(operation.updatedAt.getTime() + 86400000).toISOString().slice(0, 10);
    expect(calls.filter(call => call.path === '/bill/list')).toEqual([{ method: 'GET', path: '/bill/list', options: {
      query: { orderType: 1, type: 4, startTime: start, endTime: end, pageNo: 1, pageSize: 100 } } }]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(JSON.stringify(result)).not.toContain('987654321');
    expect(await ctx.db.select().from(upaySubmissions)).toEqual(before);
  });
  it.each(['duplicate_customer', 'incomplete_scan', 'conflicting_detail'] as const)('does not infer a group from %s or make related tariff reads', async mode => {
    ctx = await createTestContext();
    const { operation, productId, customerNo } = await scope();
    const paths: string[] = [];
    const client = { readRequest: async (_method: string, path: string) => {
      paths.push(path);
      if (path === '/customer/list') return { totalPages: mode === 'incomplete_scan' ? 21 : 1,
        list: [{ customerId: 'PRIVATE_id', no: customerNo }, ...(mode === 'duplicate_customer' ? [{ customerId: 'PRIVATE_second', no: customerNo }] : [])] };
      if (path === '/customer/get') return { customerId: 'PRIVATE_id', no: 'PRIVATE_foreign', groupId: 'PRIVATE_group' };
      return path === '/card/getCardOperateStatus' ? [] : { totalPages: 1, list: [] };
    } } as unknown as UpayClient;
    const result = await inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId);
    expect(result.customerGroup.complete).toBe(false);
    expect(paths).not.toContain('/customer/group/list'); expect(paths).not.toContain('/card/rate/list'); expect(paths).not.toContain('/card/getCardFee');
    if (mode !== 'conflicting_detail') expect(paths).not.toContain('/customer/get');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('caps merchant bill pagination and suppresses unknown financial shapes without declaring absence', async () => {
    ctx = await createTestContext();
    const { operation, productId } = await scope();
    const client = { readRequest: async (_method: string, path: string) => path === '/bill/list'
      ? { totalPages: 11, list: [{ amount: 'PRIVATE', symbol: 'PRIVATE', type: 4, state: 999999999 }] }
      : path === '/card/getCardOperateStatus' ? [] : { totalPages: 1, list: [] } } as unknown as UpayClient;
    const result = await inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId);
    expect(result.brokerBills).toMatchObject({ complete: false, reason: 'pagination_limit', observedRows: 1, pages: 1,
      items: [{ amountUsdt: null, state: 'other' }] });
    expect(result.exactOperationBindingEstablished).toBe(false); expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(result)).not.toContain('999999999');
  });
  it('reads only one native cleared-date bill history page after a complete empty operation window', async () => {
    ctx = await createTestContext();
    const { operation, productId } = await scope();
    const billReads: unknown[] = [];
    const client = { readRequest: async (method: string, path: string, options?: { query?: Record<string, unknown> }) => {
      if (path === '/bill/list') {
        expect(method).toBe('GET'); billReads.push(options);
        return options?.query?.startTime === '' ? { totalPages: 2, totalSize: 101, list: [{ orderNo: 'PRIVATE_order', amount: '10', symbol: 'USDT',
          state: 1, inOut: 2, type: 4, createTimeTimestamp: String(operation.createdAt.getTime() - 86400000), customerNo: 'PRIVATE_foreign' }] }
          : { totalPages: 1, totalSize: 0, list: [] };
      }
      return path === '/card/getCardOperateStatus' ? [] : { totalPages: 1, list: [] };
    } } as unknown as UpayClient;
    const result = await inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId);
    expect(result.brokerBills).toMatchObject({ complete: true, observedRows: 0 });
    expect(result.brokerBillsHistoryPreview).toMatchObject({ complete: false, reason: 'pagination_limit', observedRows: 1, pages: 1,
      exactOperationBindingEstablished: false, items: [{ amountUsdt: '10.00', customerMatches: false, orderMatchesKnownReceipt: false, timeClass: 'before_operation' }] });
    expect(billReads).toHaveLength(2); expect(billReads[1]).toEqual({ query: { orderType: 1, type: 4, startTime: '', endTime: '', pageNo: 1, pageSize: 100 } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('reads native issuance records and exact owned cards without binding a receipt or exposing provider values', async () => {
    ctx = await createTestContext();
    const { user, operation } = await seed();
    const customerNo = 'PRIVATE_customer', productId = 'PRIVATE_product';
    await ctx.db.insert(kycProfiles).values({ userId: user.id, status: 'approved', partnerProvider: 'upay', partnerCustomerId: customerNo });
    await ctx.db.insert(upaySubmissions).values({ reference: operation.id, kind: 'issue', state: 'unknown', requestHash: 'PRIVATE_hash',
      evidence: { customerNo, agentCardId: productId, maxFeeBudgetUsdt: '10.00', openFeeUsdt: '10.00', defaultOpenUsdt: '0.00' } });
    const calls: { method: string; path: string; options: unknown }[] = [];
    const client = { readRequest: async (method: string, path: string, options: unknown) => {
      calls.push({ method, path, options });
      if (path === '/card/getPageToCardOperateRecord') return { totalPages: 1, list: [{ id: 'PRIVATE_record', orderNo: 'PRIVATE_order', status: 1,
        customerNo, agentCardId: productId, cardId: 'PRIVATE_broker', currency: 'USDT', openCardAmount: '10.00', rechargeAmount: '0.00', paymentAmount: '10.00',
        createTime: new Date(operation.createdAt.getTime() + 1000).toISOString(), email: 'PRIVATE@example.test' }] };
      if (path === '/card/list') return { totalPages: 1, list: [{ customerNo, agentCardId: productId, brokerCardId: 'PRIVATE_broker',
        agentCustomerCardId: 'PRIVATE_card', state: 1, cardNumber: 'PRIVATE_pan' }] };
      if (path === '/card/getCardOperateStatus') return [{ code: 1, label: 'PRIVATE_label' }];
      if (path === '/card/getAgentCustomerCardDetail') return { customerNo, agentCardId: productId, agentCustomerCardId: 'PRIVATE_card', brokerCardId: 'PRIVATE_broker',
        cardStatus: 1, cardNumber: 'PRIVATE_pan', cvv: 'PRIVATE_cvv' };
      throw new Error('Unexpected provider read');
    } } as unknown as Pick<UpayClient, 'readRequest'>;
    const before = await ctx.db.select().from(upaySubmissions);
    const result = await inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId);
    expect(result).toMatchObject({ matchingUser: true, customerMatchesJournal: true,
      records: { complete: true, observedRows: 1, items: [{ statusCode: 1, hasRecordId: true, hasOrderId: true, hasCardId: true,
        customerMatches: true, productMatches: true, currencyMatchesUsdt: true, openFeeMatchesQuote: true, initialRechargeMatchesQuote: true,
        paymentWithinBudget: true, issuerTimeAtOrAfterOperation: true, exactCardListMatches: 1 }] },
      cards: { complete: true, observedRows: 1 }, details: { items: [{ customerMatches: true, cardIdentifierMatches: true, productMatches: true, statusCode: 1 }] },
      statusCatalog: { codes: [1] } });
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual(['POST /card/getPageToCardOperateRecord', 'GET /card/list',
      'GET /card/getCardOperateStatus', 'GET /customer/list', 'GET /bill/list', 'GET /card/getAgentCustomerCardDetail']);
    expect(calls[0]!.options).toEqual({ body: { customerNo, operateType: 5, pageNo: 1, pageSize: 100 } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(await ctx.db.select().from(upaySubmissions)).toEqual(before);
  });

  it('makes no provider reads for another owner or a mismatched journal customer', async () => {
    ctx = await createTestContext();
    const { operation, productId } = await scope(owner + 1n);
    const readRequest = vi.fn().mockRejectedValue(new Error('No provider call permitted'));
    const client = { readRequest } as unknown as Pick<UpayClient, 'readRequest'>;
    await expect(inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId)).rejects.toMatchObject({ code: 'not_found' });
    await ctx.db.update(users).set({ telegramId: owner });
    await ctx.db.update(upaySubmissions).set({ evidence: { customerNo: 'PRIVATE_foreign' } }).where(eq(upaySubmissions.reference, operation.id));
    await expect(inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId)).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(readRequest).not.toHaveBeenCalled();
  });

  it('observes only the authenticated operator’s bounded time window and returns closed log flags without text or identifiers', async () => {
    ctx = await createTestContext();
    const { operation, productId, customerNo } = await scope();
    const calls: { method: string; path: string; options: unknown }[] = [];
    const client = { loginInfo: vi.fn(async () => ({ id: '123', iv: 'PRIVATE_iv' })),
      readRequest: async (method: string, path: string, options: unknown) => {
        calls.push({ method, path, options });
        if (path === '/agentOperateLog/getPage') return { totalPages: 1, list: [{ accountId: 123, memberName: 'PRIVATE_bot_name', typeName: 'PRIVATE_type',
          subTypeName: 'PRIVATE_subtype', createTime: 'PRIVATE_time', status: 2, operateContent: `PRIVATE response /card/applyOpenCard ${customerNo}`,
          requestParams: 'PRIVATE_request', response: { PRIVATE: 'PRIVATE_value' }, code: 987654321, message: 'PRIVATE_message' }] };
        return path === '/card/getCardOperateStatus' ? [] : { totalPages: 1, list: [] };
      } } as unknown as UpayClient;
    const result = await inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId);
    expect(result.audit).toMatchObject({ available: true, complete: true, reason: 'none', observedRows: 1, pages: 1, truncated: false,
      items: [{ statusCode: 2, operatorMatchesLogin: true, ownCustomerMentioned: true, endpointMentioned: true,
        fieldTypes: { accountId: 'number', memberId: 'missing', memberName: 'string', typeName: 'string', subTypeName: 'string', createTime: 'string', status: 'number',
          requestParams: 'string', response: 'object', code: 'number', message: 'string', errorCode: 'missing', httpStatus: 'missing', path: 'missing' } }] });
    const logCalls = calls.filter(call => call.path === '/agentOperateLog/getPage');
    expect(logCalls).toEqual([{ method: 'GET', path: '/agentOperateLog/getPage', options: { query: { pageNo: 1, pageSize: 100, memberId: '123',
      operatedTimeBegin: operation.createdAt.getTime() - 60000, operatedTimeEnd: operation.updatedAt.getTime() + 60000 } } }]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(result)).not.toContain('987654321');
    expect(result.exactOperationBindingEstablished).toBe(false);
  });

  it('discovers audit field shapes and confirms a unique exact authenticated member name without exposing any values', async () => {
    ctx = await createTestContext();
    const { operation, productId } = await scope();
    const reads: { method: string; path: string; options: unknown }[] = [];
    const client = { loginInfo: async () => ({ id: '123', email: 'PRIVATE_bot@example.test' }),
      readRequest: async (method: string, path: string, options: unknown) => {
        reads.push({ method, path, options });
        if (path === '/sys/member/list') return { totalPages: 1, totalSize: 2, list: [{ id: 123, name: 'PRIVATE_bot_name', email: 'PRIVATE_bot@example.test' },
          { id: 456, name: 'PRIVATE_other_name', email: 'PRIVATE_other@example.test' }] };
        if (path === '/agentOperateLog/getPage') return { totalPages: 1, list: [{ memberId: null, memberName: 'PRIVATE_bot_name', createTime: String(operation.createdAt.getTime() + 1000),
          createTimeStr: '2026-10-16 17:39:57', resCode: '45001', resDescribe: 'PRIVATE untrusted failure', type: 8, subType: 3,
          operateContent: 'PRIVATE original business response', responseData: { secret: 'PRIVATE' }, resultCode: 987654321,
          'PRIVATE@example.test': 'PRIVATE', ['a'.repeat(62)]: 'PRIVATE' }] };
        return path === '/card/getCardOperateStatus' ? [] : { totalPages: 1, list: [] };
      } } as unknown as UpayClient;
    const result = await inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId);
    expect(result.audit).toMatchObject({ complete: true, identity: { memberCatalogComplete: true, ownMemberUnique: true, nameIdentityAvailable: true },
      items: [{ operatorMatchesLogin: true, operatorNameMatchesLogin: true, operatorIdentityBasis: 'unique_member_name',
        fieldShapes: { memberId: 'null', memberName: 'string', createTime: 'string', operateContent: 'string', responseData: 'object', resultCode: 'number' },
        timestampFormat: 'wall_clock', timestampSource: 'createTimeStr', displayedTime: '2026-10-16 17:39:57', timestampTimezoneVerified: false,
        createdAtUtc: new Date(operation.createdAt.getTime() + 1000).toISOString(), epochWithinOperationWindow: true,
        resCode: 45001, resCodeMeaningVerified: false, resDescribeState: 'text', resDescribeLength: 25, typeCode: 8, subTypeCode: 3 }] });
    expect(reads.filter(call => call.path === '/sys/member/list')).toEqual([{ method: 'POST', path: '/sys/member/list', options: { body: { pageNo: 1, pageSize: 1000 } } }]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(JSON.stringify(result)).not.toContain('987654321');
    expect(Object.keys(result.audit.items[0]!.fieldShapes).every(key => /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(key))).toBe(true);
    expect(result.exactOperationBindingEstablished).toBe(false);
  });
  it.each(['duplicate_name', 'masked_name', 'incomplete_catalog', 'conflicting_id', 'different_login'] as const)(
    'keeps name-only operator identity unconfirmed for %s and suppresses its displayed time', async mode => {
      ctx = await createTestContext();
      const { operation, productId } = await scope();
      const ownName = mode === 'masked_name' ? 'PRIVATE***' : 'PRIVATE_bot';
      const client = { loginInfo: async () => ({ id: '123' }), readRequest: async (_method: string, path: string) => {
        if (path === '/sys/member/list') return { totalPages: mode === 'incomplete_catalog' ? 2 : 1, list: [
          { id: mode === 'different_login' ? '456' : '123', name: ownName }, ...(mode === 'duplicate_name' ? [{ id: '789', email: ownName }] : [])] };
        if (path === '/agentOperateLog/getPage') return { totalPages: 1, list: [{ memberId: mode === 'conflicting_id' ? '456' : null,
          memberName: ownName, createTime: '2026-10-16 17:39:57', operateContent: 'PRIVATE upstream error' }] };
        return path === '/card/getCardOperateStatus' ? [] : { totalPages: 1, list: [] };
      } } as unknown as UpayClient;
      const result = await inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId);
      expect(result.audit).toMatchObject({ complete: false, reason: 'identity_unconfirmed',
        items: [{ operatorMatchesLogin: false, operatorIdentityBasis: 'unconfirmed', displayedTime: null }] });
      expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(JSON.stringify(result)).not.toContain('2026-10-16 17:39:57');
    });
  it.each(['unowned_row', 'invalid_code_and_date', 'oversized_description'] as const)('bounds audit result metadata and never exposes private strings for %s', async mode => {
    ctx = await createTestContext();
    const { operation, productId } = await scope();
    const client = { loginInfo: async () => ({ id: '123' }), readRequest: async (_method: string, path: string) => {
      if (path === '/agentOperateLog/getPage') return { totalPages: 1, list: [{ accountId: mode === 'unowned_row' ? '456' : '123',
        createTime: mode === 'invalid_code_and_date' ? 'PRIVATE' : String(operation.createdAt.getTime()),
        createTimeStr: mode === 'invalid_code_and_date' ? '2026-02-30 17:39:57' : '2026-10-16 17:39:57',
        resCode: mode === 'invalid_code_and_date' ? '514468501001234567' : '200',
        resDescribe: 'PRIVATE'.repeat(mode === 'oversized_description' ? 1000 : 1), type: 987654321, subType: 'PRIVATE' }] };
      return path === '/card/getCardOperateStatus' ? [] : { totalPages: 1, list: [] };
    } } as unknown as UpayClient;
    const result = await inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId);
    const item = result.audit.items[0]!;
    expect(item).toMatchObject({ typeCode: null, subTypeCode: null, resCodeMeaningVerified: false, timestampTimezoneVerified: false });
    if (mode === 'unowned_row') expect(item).toMatchObject({ resCode: null, resDescribeState: 'unconfirmed', resDescribeLength: null, createdAtUtc: null, displayedTime: null });
    if (mode === 'invalid_code_and_date') expect(item).toMatchObject({ resCode: null, createdAtUtc: null, displayedTime: null, timestampFormat: 'other' });
    if (mode === 'oversized_description') expect(item).toMatchObject({ resCode: 200, resDescribeState: 'text', resDescribeLength: 4096, resDescribeLengthTruncated: true });
    expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(JSON.stringify(result)).not.toContain('987654321');
    expect(JSON.stringify(result)).not.toContain('514468501001234567');
  });

  it('previews one broad epoch-window page of the same operator only after a complete empty narrow audit', async () => {
    ctx = await createTestContext();
    const { operation, productId, customerNo } = await scope();
    const auditCalls: { method: string; query: Record<string, unknown> }[] = [];
    const loginInfo = vi.fn(async () => ({ id: '123' }));
    const client = { loginInfo, readRequest: async (method: string, path: string, options?: { query?: Record<string, unknown> }) => {
      if (path === '/agentOperateLog/getPage') {
        auditCalls.push({ method, query: options!.query! });
        return options?.query?.operatedTimeBegin === 0 ? { totalSize: 2, list: [{ accountId: '123', status: 1, createTime: String(operation.createdAt.getTime() + 1000), message: `PRIVATE ${customerNo}` }] }
          : { totalPages: 1, list: [] };
      }
      return path === '/card/getCardOperateStatus' ? [] : { totalPages: 1, list: [] };
    } } as unknown as UpayClient;
    const result = await inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId);
    expect(result.audit).toMatchObject({ complete: true, observedRows: 0 });
    expect(result.auditHistoryPreview).toMatchObject({ available: true, complete: false, observedRows: 1, pages: 1,
      items: [{ operatorMatchesLogin: true, ownCustomerMentioned: true, statusCode: 1 }] });
    expect(result).toMatchObject({ auditFilterConsistency: { narrowCompleteAndEmpty: true, historyOwnRowsInOperationWindow: 1, filterReliability: 'contradicted' } });
    expect(auditCalls).toHaveLength(2); expect(auditCalls.every(call => call.method === 'GET')).toBe(true);
    expect(auditCalls[1]!.query).toEqual({ memberId: '123', pageNo: 1, pageSize: 100, operatedTimeBegin: 0, operatedTimeEnd: expect.any(Number) });
    expect(loginInfo).toHaveBeenCalledTimes(1); expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('does not broaden an audit that already returned a narrow operator row', async () => {
    ctx = await createTestContext();
    const { operation, productId } = await scope();
    let auditReads = 0;
    const client = { loginInfo: async () => ({ id: '123' }), readRequest: async (_method: string, path: string) => {
      if (path === '/agentOperateLog/getPage') { auditReads++; return { totalPages: 1, list: [{ accountId: '123', status: 2 }] }; }
      return path === '/card/getCardOperateStatus' ? [] : { totalPages: 1, list: [] };
    } } as unknown as UpayClient;
    const result = await inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId);
    expect(result.auditHistoryPreview).toBeNull(); expect(auditReads).toBe(1);
    expect(result).toMatchObject({ auditFilterConsistency: { filterReliability: 'unverified', historyOwnRowsInOperationWindow: 0 } });
  });

  it.each([{ memberName: 'PRIVATE_name' }, { accountId: 'PRIVATE_other' }, { accountId: '123', memberId: 'PRIVATE_other' }])(
    'cannot confirm audit rows without consistent exact authenticated operator metadata', async metadata => {
      ctx = await createTestContext();
      const { operation, productId, customerNo } = await scope();
      const client = { loginInfo: async () => ({ id: '123' }), readRequest: async (_method: string, path: string) => {
        if (path === '/agentOperateLog/getPage') return { totalPages: 1, list: [{ ...metadata, status: 2, responseContent: customerNo }] };
        return path === '/card/getCardOperateStatus' ? [] : { totalPages: 1, list: [] };
      } } as unknown as UpayClient;
      const result = await inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId);
      expect(result.audit).toMatchObject({ available: true, complete: false, reason: 'identity_unconfirmed', items: [{ operatorMatchesLogin: false }] });
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    });

  it('caps audit history and returns no arbitrary numbers or labels', async () => {
    ctx = await createTestContext();
    const { operation, productId, customerNo } = await scope();
    let auditReads = 0;
    const client = { loginInfo: async () => ({ id: '123' }), readRequest: async (_method: string, path: string) => {
      if (path === '/agentOperateLog/getPage') {
        auditReads++;
        return { list: Array.from({ length: 100 }, () => ({ accountId: '123', status: 987654321, memberName: 'PRIVATE_name',
          extraNumeric: 987654321, operateContent: `PRIVATE /card/applyOpenCard ${customerNo}` })) };
      }
      return path === '/card/getCardOperateStatus' ? [] : { totalPages: 1, list: [] };
    } } as unknown as UpayClient;
    const result = await inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId);
    expect(result.audit).toMatchObject({ complete: false, reason: 'pagination_limit', observedRows: 1000, pages: 10, truncated: true });
    expect(result.audit.items).toHaveLength(50); expect(auditReads).toBe(10);
    expect(result.audit.items.every(item => item.statusCode === null)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('987654321'); expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('does not request logs when the authenticated operator identity is unavailable', async () => {
    ctx = await createTestContext();
    const { operation, productId } = await scope();
    const paths: string[] = [];
    const client = { loginInfo: async () => { throw new Error('PRIVATE login error'); }, readRequest: async (_method: string, path: string) => {
      paths.push(path); return path === '/card/getCardOperateStatus' ? [] : { totalPages: 1, list: [] };
    } } as unknown as UpayClient;
    const result = await inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId);
    expect(result.audit).toMatchObject({ available: true, complete: false, reason: 'read_failed', observedRows: 0, items: [] });
    expect(paths).not.toContain('/agentOperateLog/getPage'); expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('rejects mixed customer rows and never reads their card detail or returns their data', async () => {
    ctx = await createTestContext();
    const { operation, productId, customerNo } = await scope();
    const calls: string[] = [];
    const client = { readRequest: async (_method: string, path: string) => {
      calls.push(path);
      if (path === '/card/getPageToCardOperateRecord') return { totalPages: 1, list: [{ customerNo, cardId: 'PRIVATE_broker' },
        { customerNo: 'PRIVATE_foreign', status: 999, cardId: 'PRIVATE_broker' }] };
      if (path === '/card/list') return { totalPages: 1, list: [{ customerNo, brokerCardId: 'PRIVATE_broker', agentCustomerCardId: 'PRIVATE_card' }] };
      if (path === '/card/getCardOperateStatus') return [];
      throw new Error('Foreign detail access attempted');
    } } as unknown as Pick<UpayClient, 'readRequest'>;
    const result = await inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId);
    expect(result.records).toMatchObject({ complete: false, reason: 'ownership_unconfirmed', observedRows: 2, items: [] });
    expect(result.details.items).toEqual([]);
    expect(calls).not.toContain('/card/getAgentCustomerCardDetail');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it.each(['declared_over_limit', 'never_ending'] as const)('bounds %s pagination and cannot mistake it for absence of issuance', async mode => {
    ctx = await createTestContext();
    const { operation, productId, customerNo } = await scope();
    let recordReads = 0;
    const client = { readRequest: async (_method: string, path: string) => {
      if (path === '/card/getPageToCardOperateRecord') {
        recordReads++;
        return { ...(mode === 'declared_over_limit' ? { totalPages: 101 } : {}), list: Array.from({ length: 100 }, () => ({ customerNo, status: 3 })) };
      }
      if (path === '/card/list') return { totalPages: 1, list: [] };
      return [];
    } } as unknown as Pick<UpayClient, 'readRequest'>;
    const result = await inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId);
    expect(result.records).toMatchObject({ complete: false, reason: 'pagination_limit', truncated: true });
    expect(recordReads).toBe(mode === 'declared_over_limit' ? 1 : 100);
    expect(result.exactOperationBindingEstablished).toBe(false);
  });

  it('sanitizes read errors and unsupported rows without exposing arbitrary provider labels', async () => {
    ctx = await createTestContext();
    const { operation, productId } = await scope();
    const client = { readRequest: async (_method: string, path: string) => {
      if (path === '/card/getPageToCardOperateRecord') throw new Error('PRIVATE provider failure');
      if (path === '/card/list') return { totalPages: 1, list: ['PRIVATE malformed row'] };
      return [{ code: 1, label: 'PRIVATE human label' }, { code: 'PRIVATE' }, { code: 123456789 }];
    } } as unknown as Pick<UpayClient, 'readRequest'>;
    const result = await inspectCardOperationProviderStatus(ctx.db, client, operation.id, productId);
    expect(result.records).toMatchObject({ complete: false, reason: 'read_failed' });
    expect(result.cards).toMatchObject({ complete: false, reason: 'unsupported_shape' });
    expect(result.statusCatalog).toEqual({ ok: true, shape: 'array', codes: [1] });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('protects the provider observation route with OPS and no-store without financial dispatch or queue wakeup', async () => {
    ctx = await createTestContext();
    const { operation, productId } = await scope();
    let wakeups = 0;
    const readRequest = vi.fn(async (_method: string, path: string) => path === '/card/getCardOperateStatus' ? [] : { totalPages: 1, list: [] });
    const submitRequest = vi.fn().mockRejectedValue(new Error('Financial writes forbidden'));
    const uploadRequest = vi.fn().mockRejectedValue(new Error('Uploads forbidden'));
    const upay = { readRequest, submitRequest, uploadRequest } as unknown as UpayClient;
    const config = loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'local-provider-observation-test-secret', OPS_API_TOKEN: opsToken, UPAY_PRODUCT_ID: productId });
    await ctx.app.close();
    ctx.app = await buildApp({ config, db: ctx.db, partner: new MockUpayPartner(ctx.db), depositProvider: new DisabledDepositProvider(),
      withdrawalProvider: { providerId: 'disabled', send: async () => { throw new Error('Withdrawals forbidden'); } }, bot: ctx.bot, upay }, ctx.services,
    { onResponse: () => { wakeups++; } });
    const url = `/v1/ops/cards/${operation.id}/provider-status`, headers = { authorization: `Bearer ${opsToken}` };
    const before = await Promise.all([ctx.db.select().from(cardOperations), ctx.db.select().from(upaySubmissions), ctx.db.select().from(jobs)]);
    for (const auth of [{}, { authorization: 'Bearer ordinary-user-jwt' }]) {
      const response = await ctx.app.inject({ method: 'GET', url, headers: auth });
      expect(response.statusCode).toBe(401); expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(readRequest).not.toHaveBeenCalled();
    const response = await ctx.app.inject({ method: 'GET', url, headers });
    expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    const invalid = await ctx.app.inject({ method: 'GET', url: '/v1/ops/cards/invalid/provider-status', headers });
    expect(invalid.statusCode).toBe(400); expect(invalid.headers['cache-control']).toBe('no-store');
    expect(readRequest).toHaveBeenCalledTimes(6); expect(submitRequest).not.toHaveBeenCalled(); expect(uploadRequest).not.toHaveBeenCalled(); expect(wakeups).toBe(0);
    expect(await Promise.all([ctx.db.select().from(cardOperations), ctx.db.select().from(upaySubmissions), ctx.db.select().from(jobs)])).toEqual(before);
  });
});
