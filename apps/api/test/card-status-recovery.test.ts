import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { cardIssueSponsorships, cardOperations, cards, jobs, kycProfiles, ledgerTransactions, users } from '../src/db/schema';
import { accounts, getBalance } from '../src/ledger/ledger';
import type { UpayClient } from '../src/partner/upay/client';
import { UpayFinancialPartner } from '../src/partner/upay/financial-partner';
import { DbUpaySubmissionStore } from '../src/partner/upay/submissions';
import { api, assertLedgerConsistent, createTestContext, registerUser, type TestContext } from './helpers';

// Real service, PostgreSQL journal, ledger and durable jobs; only the upstream
// reads are synthetic. No runtime provider factory or external request is used.
let ctx: TestContext | undefined;
const env = { CARD_PARTNER: 'upay', DEV_TOOLS: 'false', UPAY_WRITES_ENABLED: 'true', UPAY_PRODUCT_ID: 'fixture-product',
  UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture-only', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ', UPAY_PAYMENT_PASSWORD: '123456' };

async function setup(payer: 'wallet' | 'broker' = 'wallet') {
  let available = false;
  const submitRequest = vi.fn(async () => { throw new Error('Recovery must never submit a financial POST'); });
  const readRequest = vi.fn(async (method: string, endpoint: string, input?: { body?: Record<string, unknown>; query?: Record<string, unknown> }) => {
    // Creating the original local reserve now includes a read-only issuance
    // preflight. Recovery assertions below start after this fixture setup.
    if (method === 'GET' && endpoint === '/card/getMayApplyCardDetail') return {
      openFee: '10', defaultOpenAmount: '0', rechargeCurrency: 'USDT', currency: 'USD',
    };
    if (method === 'GET' && endpoint === '/card/getCardFee') return {
      customerNo: 'fixture-customer', needParams: [], defaultType: 1,
    };
    if (method === 'POST' && endpoint === '/card/getPageToCardOperateRecord') {
      expect(input?.body).toMatchObject({ operateType: 5, orderNo: 'fixture-exact-order' });
      return { totalPages: 1, list: available ? [{ orderNo: 'fixture-exact-order', id: 'fixture-record', status: 1,
        customerNo: 'fixture-customer', agentCustomerCardId: 'fixture-card', currency: 'USDT', openCardAmount: '10', rechargeAmount: '0', paymentAmount: '10' }] : [] };
    }
    if (method === 'GET' && endpoint === '/card/getAgentCustomerCardDetail') {
      expect(input?.query).toEqual({ agentCustomerCardId: 'fixture-card' });
      return { agentCustomerCardId: 'fixture-card', customerNo: 'fixture-customer', agentCardId: 'fixture-product', accountCardId: 'fixture-account',
        cardStatus: 1, cardNumber: '400000******1234', expirationTime: '12/29' };
    }
    throw new Error('Unexpected synthetic upstream read');
  });
  const client = { configured: true, submitRequest, readRequest, loginInfo: async () => ({ iv: '123456789012' }) } as unknown as UpayClient;
  const kyc = { assertReady: () => {}, createCustomer: async () => 'fixture-customer', getKycStatus: async () => ({ status: 'approved' as const }),
    getKycRequirements: async () => ({ selfieRequired: false, documentTypes: ['id_card' as const] }), getDocumentType: async () => 1 as const, reconcileKycSubmission: async () => null };
  let partner!: UpayFinancialPartner, journal!: DbUpaySubmissionStore;
  ctx = await createTestContext(db => {
    journal = new DbUpaySubmissionStore(db);
    partner = new UpayFinancialPartner(loadConfig({ DATABASE_URL: 'unused-no-connection', JWT_SECRET: 'isolated-recovery-fixture-key', ...env }), client, journal, kyc);
    return partner;
  }, { env });
  const owner = await registerUser(ctx);
  const ownerApi = api(ctx, owner.token);
  const [user] = await ctx.db.select().from(users).where(eq(users.telegramId, BigInt(owner.telegramId)));
  await ctx.db.update(kycProfiles).set({ status: 'approved', partnerProvider: 'upay', partnerCustomerId: 'fixture-customer',
    firstName: 'FIXTURE', lastName: 'USER' }).where(eq(kycProfiles.userId, user!.id));
  if (payer === 'wallet') await ctx.services.wallet.simulateDeposit(user!.id, 'USDT', 'TON', '100');
  else await ctx.services.cards.grantIssueSponsorship({ telegramId: String(owner.telegramId), reason: 'Explicit local crash-refund fixture' });
  const issued = await ctx.services.cards.issue(user!.id, { asset: 'USDT', idempotencyKey: randomUUID(),
    expectedFundingSource: payer, expectedCustomerCharge: payer === 'broker' ? '0' : '10' });
  await ctx.db.transaction(async tx => {
    await tx.execute(sql`select set_config('gudex.sponsorship_v1', 'true', true)`);
    await tx.update(cardOperations).set({ status: 'unknown', attempts: 1 }).where(eq(cardOperations.id, issued.operation.id));
  });
  // The original worker already finished before this simulated process restart.
  // Its financial handler is never executed by this test.
  await ctx.db.update(jobs).set({ status: 'done' }).where(eq(jobs.queue, 'card.issue'));
  await journal.begin({ reference: issued.operation.id, kind: 'issue', requestHash: 'fixture-request', evidence: {
    customerNo: 'fixture-customer', agentCardId: 'fixture-product', step: 'card_issue', openFeeUsdt: '10', maxFeeBudgetUsdt: '10',
  } });
  readRequest.mockClear();
  const issue = vi.spyOn(partner, 'issueCard');
  return { user: user!, ownerApi, operationId: issued.operation.id, cardId: issued.card.id, journal, submitRequest, readRequest, issue,
    setAvailable: () => { available = true; } };
}

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External HTTP is forbidden in recovery DB tests'); })); });
afterEach(async () => {
  try { if (ctx) { await assertLedgerConsistent(ctx.db); await ctx.close(); ctx = undefined; } }
  finally { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

describe('durable client status recovery without financial replay', () => {
  it.each(['wallet', 'broker'] as const)('recovers an old persisted pre-dispatch crash and refunds the %s reserve once under concurrent reconciliation', async payer => {
    const f = await setup(payer);
    await f.journal.record(f.operationId, { state: 'rejected', evidence: { dispatchPhase: 'pre_dispatch', responseAck: 'unconfirmed' } });
    await ctx!.db.transaction(async tx => {
      await tx.execute(sql`select set_config('gudex.sponsorship_v1', 'true', true)`);
      await tx.update(cardOperations).set({ createdAt: new Date(Date.now() - 48 * 60 * 60_000) }).where(eq(cardOperations.id, f.operationId));
    });
    const stranger = api(ctx!, (await registerUser(ctx!)).token);
    expect((await stranger.get(`/v1/operations/${f.operationId}`)).status).toBe(404);
    expect((await ctx!.db.select().from(jobs).where(eq(jobs.queue, 'card.reconcile')))).toHaveLength(0);
    await f.ownerApi.get(`/v1/operations/${f.operationId}`);
    await f.ownerApi.get(`/v1/operations/${f.operationId}`);
    expect(await ctx!.db.select().from(jobs).where(eq(jobs.queue, 'card.reconcile'))).toHaveLength(1);
    await Promise.all([ctx!.services.cards.handlers()['card.reconcile']!.run({ operationId: f.operationId }),
      ctx!.services.cards.reconcileUnknown(f.operationId), ctx!.services.cards.reconcileUnknown(f.operationId)]);
    await ctx!.runner.drain({ maxJobs: 30, maxDurationMs: 5000 });
    expect((await f.ownerApi.get(`/v1/operations/${f.operationId}`)).body.status).toBe('failed');
    expect((await ctx!.db.select().from(cards).where(eq(cards.id, f.cardId)))[0]!.status).toBe('failed');
    expect(await ctx!.db.select().from(ledgerTransactions).where(eq(ledgerTransactions.reference, `card_issue_refund:${f.operationId}`))).toHaveLength(1);
    expect(await getBalance(ctx!.db, accounts.clearing('USDT').code)).toBe(0n);
    expect(await getBalance(ctx!.db, accounts.userWallet(f.user.id, 'USDT').code)).toBe(payer === 'wallet' ? 100_000_000n : 0n);
    if (payer === 'broker') {
      expect(await getBalance(ctx!.db, accounts.brokerIssueExpense().code)).toBe(0n);
      expect((await ctx!.db.select().from(cardIssueSponsorships))[0]).toMatchObject({ operationId: null, consumedAt: null });
    }
    expect(f.readRequest).not.toHaveBeenCalled(); expect(f.submitRequest).not.toHaveBeenCalled(); expect(f.issue).not.toHaveBeenCalled();
  });

  it('automatically settles an accepted exact receipt when its card becomes visible later, without issuing again', async () => {
    const f = await setup();
    await f.journal.record(f.operationId, { state: 'unknown', partnerReceiptId: 'fixture-exact-order', evidence: {
      orderNo: 'fixture-exact-order', dispatchPhase: 'post_dispatched', responseAck: 'accepted_envelope',
    } });
    await f.ownerApi.get(`/v1/operations/${f.operationId}`);
    await ctx!.runner.drain({ maxJobs: 30, maxDurationMs: 5000 });
    expect((await f.ownerApi.get(`/v1/operations/${f.operationId}`)).body.status).toBe('unknown');
    expect(await getBalance(ctx!.db, accounts.clearing('USDT').code)).toBe(10_000_000n);
    expect(await ctx!.db.select().from(jobs).where(eq(jobs.queue, 'card.reconcile'))).toHaveLength(1);
    f.setAvailable();
    await ctx!.db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.queue, 'card.reconcile'));
    await ctx!.runner.drain({ maxJobs: 30, maxDurationMs: 5000 });
    expect((await f.ownerApi.get(`/v1/operations/${f.operationId}`)).body.status).toBe('succeeded');
    expect((await ctx!.db.select().from(cards).where(eq(cards.id, f.cardId)))[0]).toMatchObject({ status: 'active', partnerCardId: 'fixture-card', last4: '1234' });
    expect(await ctx!.db.select().from(ledgerTransactions).where(eq(ledgerTransactions.reference, `card_issue_settle:${f.operationId}`))).toHaveLength(1);
    expect(await getBalance(ctx!.db, accounts.partnerFunding('USDT').code)).toBe(10_000_000n);
    expect(await getBalance(ctx!.db, accounts.clearing('USDT').code)).toBe(0n);
    expect(f.submitRequest).not.toHaveBeenCalled(); expect(f.issue).not.toHaveBeenCalled();
  });

  it.each(['missing-receipt', 'historical-unknown-pre'] as const)('retains the hold and requires review for %s instead of guessing or dispatching again', async kind => {
    const f = await setup();
    await f.journal.record(f.operationId, { state: 'unknown', evidence: {
      dispatchPhase: kind === 'historical-unknown-pre' ? 'pre_dispatch' : 'post_dispatched',
      responseAck: kind === 'historical-unknown-pre' ? 'unconfirmed' : 'accepted_envelope',
    } });
    await f.ownerApi.get(`/v1/operations/${f.operationId}`);
    await ctx!.services.cards.reconcileUnknown(f.operationId);
    expect(await ctx!.db.select().from(jobs).where(eq(jobs.queue, 'card.reconcile'))).toHaveLength(0);
    expect((await f.ownerApi.get(`/v1/operations/${f.operationId}`)).body.status).toBe('unknown');
    expect(await getBalance(ctx!.db, accounts.clearing('USDT').code)).toBe(10_000_000n);
    expect(await getBalance(ctx!.db, accounts.userWallet(f.user.id, 'USDT').code)).toBe(90_000_000n);
    expect(await ctx!.db.select().from(ledgerTransactions).where(eq(ledgerTransactions.reference, `card_issue_refund:${f.operationId}`))).toHaveLength(0);
    expect(f.readRequest).not.toHaveBeenCalled(); expect(f.submitRequest).not.toHaveBeenCalled(); expect(f.issue).not.toHaveBeenCalled();
  });
});
