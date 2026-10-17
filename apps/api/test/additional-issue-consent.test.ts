import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardIssueRetryConsents, cardIssueSponsorships, cardOperations, cards, jobs, kycProfiles, ledgerEntries, ledgerTransactions, referralRewards, upaySubmissions, users } from '../src/db/schema';
import { accounts, getBalance, move, post } from '../src/ledger/ledger';
import { MockUpayPartner } from '../src/partner/mock';
import { loadConfig } from '../src/config';
import { CardService } from '../src/services/cards';
import { PartnerBillingAddressRequiredError, PartnerError, type CardPartner } from '../src/partner/types';
import { ADDITIONAL_ISSUE_ORIGINAL_ID, ADDITIONAL_ISSUE_TERMS } from '../src/services/additional-issue-quote';
import { api, assertLedgerConsistent, createTestContext, registerUser, telegramLogin, TEST_PIN, type TestContext } from './helpers';

let ctx: TestContext | undefined;
class FixturePartner extends MockUpayPartner {
  validateIssue = vi.fn(async (_input: Parameters<NonNullable<CardPartner['validateIssue']>>[0]) => {});
  calls = 0;
  result: 'success' | 'reject' | 'unknown' = 'success';
  getIssueSettlement: CardPartner['getIssueSettlement'] = async () => ({ grossUsd: 1000n });
  override async issueCard(input: Parameters<CardPartner['issueCard']>[0]) {
    this.calls++;
    if (this.result === 'reject') throw new PartnerError('Fixture definite preflight refusal', false);
    if (this.result === 'unknown') throw new PartnerError('Fixture uncertain result', true);
    return super.issueCard(input);
  }
}
async function setup() {
  let partner!: FixturePartner;
  ctx = await createTestContext(db => (partner = new FixturePartner(db)), { env: { CARD_PARTNER: 'upay', DEV_TOOLS: 'false', UPAY_PRODUCT_ID: 'fixture-product',
    UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ' } });
  const locked = await telegramLogin(ctx, 514468501);
  const pin = await api(ctx, locked.accessToken).post('/v1/security/pin', { pin: TEST_PIN });
  const client = api(ctx, pin.body.accessToken);
  const [user] = await ctx.db.select().from(users).where(eq(users.telegramId, 514468501n));
  const customerNo = await partner.createCustomer({ externalRef: user!.id, email: 'fixture@example.test', firstName: 'IVAN', lastName: 'PETROV', birthDate: '1990-01-01', citizenship: 'KZ' });
  await ctx.db.update(kycProfiles).set({ status: 'approved', partnerProvider: 'upay', partnerCustomerId: customerNo,
    submissionId: randomUUID(), firstName: 'IVAN', lastName: 'PETROV' }).where(eq(kycProfiles.userId, user!.id));
  await ctx.services.wallet.simulateDeposit(user!.id, 'USDT', 'TON', '50');
  await ctx.services.cards.grantIssueSponsorship({ telegramId: '514468501', reason: 'Local original-issue fixture' });
  const [primary] = await ctx.db.select().from(cardIssueSponsorships);
  await ctx.db.transaction(async tx => {
    await tx.execute(sql`select set_config('gudex.sponsorship_v1', 'true', true)`);
    const [card] = await tx.insert(cards).values({ userId: user!.id, productName: 'Original uncertain fixture', status: 'pending' }).returning();
    await tx.insert(cardOperations).values({ id: ADDITIONAL_ISSUE_ORIGINAL_ID, userId: user!.id, cardId: card!.id, type: 'issue', status: 'unknown', attempts: 1,
      partnerProvider: 'upay', sponsorshipId: primary!.id, asset: 'USDT', amount: 10_000_000n, fee: 10_000_000n, idempotencyKey: 'original-issue-fixture' });
    await post(tx, { kind: 'card_issue_hold', reference: `card_issue_hold:${ADDITIONAL_ISSUE_ORIGINAL_ID}`,
      postings: move(accounts.brokerIssueExpense(), accounts.clearing('USDT'), 10_000_000n) });
    await tx.update(cardIssueSponsorships).set({ operationId: ADDITIONAL_ISSUE_ORIGINAL_ID }).where(eq(cardIssueSponsorships.id, primary!.id));
    await tx.insert(jobs).values({ queue: 'card.issue', payload: { operationId: ADDITIONAL_ISSUE_ORIGINAL_ID }, status: 'done', attempts: 1 });
    await tx.insert(upaySubmissions).values({ reference: ADDITIONAL_ISSUE_ORIGINAL_ID, kind: 'issue', state: 'unknown', requestHash: 'historical-unknown-fixture',
      evidence: { customerNo, agentCardId: 'fixture-product' } });
  });
  const original = await originalState();
  const quote = await client.get('/v1/cards/additional-attempt-quote');
  expect(quote.status).toBe(200); expect(quote.body.eligible).toBe(true);
  const input = { quoteToken: quote.body.quoteToken as string, termsVersion: ADDITIONAL_ISSUE_TERMS, acceptedRisk: true as const, idempotencyKey: randomUUID() };
  return { partner, client, user: user!, original, quote: quote.body, input, primary: primary! };
}
async function originalState() {
  return {
    op: await ctx!.db.select().from(cardOperations).where(eq(cardOperations.id, ADDITIONAL_ISSUE_ORIGINAL_ID)),
    grant: await ctx!.db.select().from(cardIssueSponsorships).where(and(eq(cardIssueSponsorships.telegramId, 514468501n), sql`${cardIssueSponsorships.retryOfOperationId} is null`)),
    journal: await ctx!.db.select().from(upaySubmissions).where(eq(upaySubmissions.reference, ADDITIONAL_ISSUE_ORIGINAL_ID)),
    job: await ctx!.db.select().from(jobs).where(sql`${jobs.payload}->>'operationId' = ${ADDITIONAL_ISSUE_ORIGINAL_ID}`),
  };
}
async function counts() {
  const [ops, cardRows, grants, consents, entries, transactions, work] = await Promise.all([
    ctx!.db.select().from(cardOperations), ctx!.db.select().from(cards), ctx!.db.select().from(cardIssueSponsorships),
    ctx!.db.select().from(cardIssueRetryConsents), ctx!.db.select().from(ledgerEntries), ctx!.db.select().from(ledgerTransactions), ctx!.db.select().from(jobs),
  ]);
  return { ops, cards: cardRows, grants, consents, entries, transactions, work };
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External HTTP is forbidden'); })); });
afterEach(async () => {
  try { if (ctx) { await assertLedgerConsistent(ctx.db); await ctx.close(); ctx = undefined; } }
  finally { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); }
});

describe('one explicit human-authorized additional broker issuance', () => {
  it('shows a risk quote without changing the old attempt, and rejects unauthenticated, foreign and missing consent before any extra hold', async () => {
    const f = await setup();
    expect(f.quote).toMatchObject({ additionalBrokerCostUsd: '10', retainedBrokerReserveUsd: '10', maximumCumulativeCostUsd: '20', customerCharge: '0' });
    const before = await counts();
    expect((await ctx!.app.inject({ method: 'POST', url: '/v1/cards/additional-attempt', payload: f.input })).statusCode).toBe(401);
    const stranger = api(ctx!, (await registerUser(ctx!)).token);
    expect((await stranger.get('/v1/cards/additional-attempt-quote')).body).toEqual({ eligible: false, reason: 'unavailable' });
    expect((await stranger.post('/v1/cards/additional-attempt', f.input)).status).toBe(400);
    expect((await f.client.post('/v1/cards/additional-attempt', { ...f.input, acceptedRisk: false })).status).toBe(400);
    expect((await f.client.post('/v1/cards/additional-attempt', { ...f.input, maximumCumulativeCostUsd: '30' })).status).toBe(400);
    const after = await counts();
    expect({ ...after, work: undefined }).toEqual({ ...before, work: undefined }); // stranger registration may add only its reminder
    expect(await originalState()).toEqual(f.original);
    expect(f.partner.calls).toBe(0);
    expect(await getBalance(ctx!.db, accounts.clearing('USDT').code)).toBe(10_000_000n);
  });

  it('atomically records consent and one extra reserve under concurrent clicks; replays the same operation and preserves all original records', async () => {
    const f = await setup();
    const results = await Promise.all(Array.from({ length: 10 }, () => f.client.post('/v1/cards/additional-attempt', f.input)));
    expect(results.every(response => response.status === 202)).toBe(true);
    expect(new Set(results.map(response => response.body.operation.id)).size).toBe(1);
    expect(results[0]!.body.operation).toMatchObject({ status: 'pending', fundingSource: 'broker', amount: '0', fee: '0' });
    const rows = await counts();
    expect(rows.ops).toHaveLength(2); expect(rows.cards).toHaveLength(2); expect(rows.grants).toHaveLength(2); expect(rows.consents).toHaveLength(1);
    expect(rows.work.filter(job => job.queue === 'card.issue' && job.status === 'queued')).toHaveLength(1);
    expect(await originalState()).toEqual(f.original);
    expect(await getBalance(ctx!.db, accounts.clearing('USDT').code)).toBe(20_000_000n);
    expect(await getBalance(ctx!.db, accounts.brokerIssueExpense().code)).toBe(-20_000_000n);
    expect(await getBalance(ctx!.db, accounts.userWallet(f.user.id, 'USDT').code)).toBe(50_000_000n);
    expect(f.partner.calls).toBe(0);
    const replay = await f.client.post('/v1/cards/additional-attempt', { ...f.input, quoteToken: 'expired-response-recovery' });
    expect(replay.body.operation.id).toBe(results[0]!.body.operation.id);
    expect((await f.client.post('/v1/cards/additional-attempt', { ...f.input, idempotencyKey: randomUUID() })).status).toBe(400);
    expect((await f.client.get('/v1/cards/additional-attempt-quote')).body).toMatchObject({ eligible: false, reason: 'already_requested', existingOperation: { id: replay.body.operation.id } });
    // Existing normal endpoints cannot select/reuse the new grant or erase the original blockade.
    const normal = await f.client.post('/v1/cards', { asset: 'USDT', idempotencyKey: randomUUID(), expectedFundingSource: 'broker', expectedCustomerCharge: '0' });
    expect(normal.body.operation.id).toBe(ADDITIONAL_ISSUE_ORIGINAL_ID);
    expect((await ctx!.services.cards.grantIssueSponsorship({ telegramId: '514468501', reason: 'Fixture repeat primary grant' })).status).toBe('reserved');
  });

  it.each(['kyc', 'auth', 'original', 'tamper', 'billing'] as const)('rejects a changed %s quote or missing requirement without consuming consent or reserving money', async scenario => {
    const f = await setup();
    if (scenario === 'kyc') await ctx!.db.update(kycProfiles).set({ submissionId: randomUUID() }).where(eq(kycProfiles.userId, f.user.id));
    if (scenario === 'auth') await ctx!.db.update(users).set({ authVersion: f.user.authVersion + 1 }).where(eq(users.id, f.user.id));
    if (scenario === 'original') await ctx!.db.transaction(async tx => { await tx.execute(sql`select set_config('gudex.sponsorship_v1', 'true', true)`); await tx.update(cardOperations).set({ attempts: 2 }).where(eq(cardOperations.id, ADDITIONAL_ISSUE_ORIGINAL_ID)); });
    if (scenario === 'tamper') f.input.quoteToken = `${f.input.quoteToken.slice(0, -2)}xx`;
    if (scenario === 'billing') f.partner.validateIssue.mockRejectedValue(new PartnerBillingAddressRequiredError());
    const before = await counts();
    await expect(ctx!.services.cards.confirmAdditionalAttempt(f.user.id, f.input)).rejects.toMatchObject({ code: scenario === 'billing' ? 'billing_address_required' : 'validation' });
    expect(await counts()).toEqual(before);
    expect(f.partner.calls).toBe(0);
  });

  it.each(['success', 'reject', 'unknown'] as const)('handles the new %s result independently and never authorizes a third attempt', async result => {
    const f = await setup(); f.partner.result = result;
    const issued = await f.client.post('/v1/cards/additional-attempt', f.input);
    expect(issued.status).toBe(202);
    await ctx!.settle();
    expect(f.partner.calls).toBe(1);
    expect(await originalState()).toEqual(f.original);
    const op = (await ctx!.db.select().from(cardOperations).where(eq(cardOperations.id, issued.body.operation.id)))[0]!;
    expect(op.status).toBe(result === 'success' ? 'succeeded' : result === 'reject' ? 'failed' : 'unknown');
    expect(await getBalance(ctx!.db, accounts.clearing('USDT').code)).toBe(result === 'unknown' ? 20_000_000n : 10_000_000n);
    expect(await getBalance(ctx!.db, accounts.userWallet(f.user.id, 'USDT').code)).toBe(50_000_000n);
    expect(await ctx!.db.select().from(referralRewards)).toHaveLength(0);
    expect((await f.client.get('/v1/cards/additional-attempt-quote')).body).toMatchObject({ eligible: false, reason: 'already_requested' });
    expect((await f.client.post('/v1/cards/additional-attempt', { ...f.input, idempotencyKey: randomUUID() })).status).toBe(400);
    expect(await ctx!.db.select().from(cardIssueRetryConsents)).toHaveLength(1);
  });

  it('blocks a legacy v1 worker before processing the new operation, while preserving the reserved funds', async () => {
    const f = await setup();
    const issued = await f.client.post('/v1/cards/additional-attempt', f.input);
    expect(issued.status).toBe(202);
    await expect(ctx!.db.transaction(async tx => {
      await tx.execute(sql`select set_config('gudex.sponsorship_v1', 'true', true)`);
      await tx.update(cardOperations).set({ status: 'processing' }).where(eq(cardOperations.id, issued.body.operation.id));
    })).rejects.toThrow();
    expect((await ctx!.db.select().from(cardOperations).where(eq(cardOperations.id, issued.body.operation.id)))[0]!.status).toBe('pending');
    expect(await getBalance(ctx!.db, accounts.clearing('USDT').code)).toBe(20_000_000n);
    expect(await originalState()).toEqual(f.original);
  });

  it('retains the one-attempt limit if the original later succeeds and both broker expenses settle', async () => {
    const f = await setup();
    const extra = await f.client.post('/v1/cards/additional-attempt', f.input);
    expect(extra.status).toBe(202);
    await ctx!.settle();
    // Synthetic exact-reference recovery of the old result, never an external
    // call or a financial replay by CardService's reconciliation method.
    const [profile] = await ctx!.db.select().from(kycProfiles).where(eq(kycProfiles.userId, f.user.id));
    await f.partner.issueCard({ externalRef: ADDITIONAL_ISSUE_ORIGINAL_ID, partnerCustomerId: profile!.partnerCustomerId!, maxFeeUsd: 1000n });
    expect((await ctx!.services.cards.reconcileUnknown(ADDITIONAL_ISSUE_ORIGINAL_ID)).status).toBe('succeeded');
    expect(await getBalance(ctx!.db, accounts.partnerFunding('USDT').code)).toBe(20_000_000n);
    expect(await getBalance(ctx!.db, accounts.clearing('USDT').code)).toBe(0n);
    expect(await getBalance(ctx!.db, accounts.brokerIssueExpense().code)).toBe(-20_000_000n);
    expect((await f.client.get('/v1/cards/additional-attempt-quote')).body).toMatchObject({ eligible: false, reason: 'already_requested' });
    expect((await f.client.post('/v1/cards/additional-attempt', { ...f.input, idempotencyKey: randomUUID() })).status).toBe(400);
    expect((await ctx!.services.cards.grantIssueSponsorship({ telegramId: '514468501', reason: 'No third broker expense fixture' })).status).toBe('consumed');
    expect(await ctx!.db.select().from(cardIssueRetryConsents)).toHaveLength(1);
    expect(await ctx!.db.select().from(cardOperations)).toHaveLength(2);
    expect(await ctx!.db.select().from(referralRewards)).toHaveLength(0);
  });

  it('refunds only the new reserve without any dispatch if a queued worker uses another product', async () => {
    const f = await setup();
    const extra = await f.client.post('/v1/cards/additional-attempt', f.input);
    expect(extra.status).toBe(202);
    const changed = new CardService(ctx!.db, loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'local-fixture-secret-at-least16',
      CARD_PARTNER: 'upay', DEV_TOOLS: 'false', UPAY_PRODUCT_ID: 'changed-product',
      UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ' }), f.partner);
    await changed.handlers()['card.issue']!.run({ operationId: extra.body.operation.id });
    expect(f.partner.calls).toBe(0);
    expect((await ctx!.db.select().from(cardOperations).where(eq(cardOperations.id, extra.body.operation.id)))[0]!.status).toBe('failed');
    expect(await getBalance(ctx!.db, accounts.clearing('USDT').code)).toBe(10_000_000n);
    expect(await originalState()).toEqual(f.original);
    expect(await ctx!.db.select().from(cardIssueRetryConsents)).toHaveLength(1);
  });

  it('rolls back a new retry operation that has v2 markers but lacks exact durable human consent', async () => {
    const f = await setup(); const before = await counts();
    await expect(ctx!.db.transaction(async tx => {
      await tx.execute(sql`select set_config('gudex.sponsorship_v1', 'true', true), set_config('gudex.sponsorship_v2', 'true', true)`);
      const [grant] = await tx.insert(cardIssueSponsorships).values({ telegramId: 514468501n, retryOfOperationId: ADDITIONAL_ISSUE_ORIGINAL_ID, reason: 'Missing consent fixture' }).returning();
      const [card] = await tx.insert(cards).values({ userId: f.user.id, productName: 'Invalid retry fixture' }).returning();
      const [op] = await tx.insert(cardOperations).values({ userId: f.user.id, cardId: card!.id, sponsorshipId: grant!.id, type: 'issue', partnerProvider: 'upay', asset: 'USDT', amount: 10_000_000n, fee: 10_000_000n, idempotencyKey: randomUUID() }).returning();
      await tx.update(cardIssueSponsorships).set({ operationId: op!.id }).where(eq(cardIssueSponsorships.id, grant!.id));
    })).rejects.toThrow();
    expect(await counts()).toEqual(before);
    expect(await originalState()).toEqual(f.original);
  });
});
