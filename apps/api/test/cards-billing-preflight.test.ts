import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client';
import { cardIssueSponsorships, cardOperations, cards, jobs, kycProfiles, ledgerAccounts, ledgerEntries, ledgerTransactions, upaySubmissions, users } from '../src/db/schema';
import { accounts, getBalance } from '../src/ledger/ledger';
import { MockUpayPartner } from '../src/partner/mock';
import { PartnerBillingAddressRequiredError, PartnerCardRegionRestrictedError, PartnerError, type CardPartner } from '../src/partner/types';
import { api, assertLedgerConsistent, createTestContext, telegramLogin, TEST_PIN, type TestContext } from './helpers';

let ctx: TestContext | undefined;
class BillingPartner extends MockUpayPartner {
  validateIssue = vi.fn(async (_input: Parameters<NonNullable<CardPartner['validateIssue']>>[0]): Promise<void> => {});
  issueCalls = 0;
  override async issueCard(input: Parameters<CardPartner['issueCard']>[0]) {
    this.issueCalls++;
    return super.issueCard(input);
  }
}

// This is the real API/CardService path with a local partner seam. No worker or
// UPay client is started; the live provider stamp exercises grant eligibility.
async function setup() {
  let partner!: BillingPartner;
  ctx = await createTestContext(db => (partner = new BillingPartner(db)), { env: {
    CARD_PARTNER: 'upay', DEV_TOOLS: 'false', UPAY_LOGIN: 'fixture@example.test',
    UPAY_PASSWORD: 'fixture-only', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ',
  } });
  const login = await telegramLogin(ctx, 514468501);
  const unlocked = await api(ctx, login.accessToken).post('/v1/security/pin', { pin: TEST_PIN });
  expect(unlocked.status).toBe(200);
  const client = api(ctx, unlocked.body.accessToken);
  const [user] = await ctx.db.select().from(users).where(eq(users.telegramId, 514468501n));
  const customerNo = await partner.createCustomer({ externalRef: user!.id, email: 'billing@example.test',
    firstName: 'Ivan', lastName: 'Petrov', birthDate: '1990-01-01', citizenship: 'KZ' });
  await ctx.db.update(kycProfiles).set({ status: 'approved', partnerProvider: 'upay',
    partnerCustomerId: customerNo, firstName: 'IVAN', lastName: 'PETROV' }).where(eq(kycProfiles.userId, user!.id));
  await ctx.services.wallet.simulateDeposit(user!.id, 'USDT', 'TON', '50');
  await ctx.services.cards.grantIssueSponsorship({ telegramId: '514468501', reason: 'Local billing preflight regression fixture' });
  return { partner, client, user: user!, customerNo };
}

async function snapshot(db: Db) {
  const [accounts, transactions, entries, cardsState, operations, jobsState, grants, journal] = await Promise.all([
    db.select().from(ledgerAccounts).orderBy(ledgerAccounts.id),
    db.select().from(ledgerTransactions).orderBy(ledgerTransactions.id),
    db.select().from(ledgerEntries).orderBy(ledgerEntries.id),
    db.select().from(cards).orderBy(cards.id),
    db.select().from(cardOperations).orderBy(cardOperations.id),
    db.select().from(jobs).orderBy(jobs.id),
    db.select().from(cardIssueSponsorships).orderBy(cardIssueSponsorships.id),
    db.select().from(upaySubmissions).orderBy(upaySubmissions.reference),
  ]);
  return { accounts, transactions, entries, cards: cardsState, operations, jobs: jobsState, grants, journal };
}

afterEach(async () => {
  if (ctx) {
    try { await assertLedgerConsistent(ctx.db); }
    finally { await ctx.close(); ctx = undefined; }
  }
});

describe('card issuance billing preflight before financial reservation', () => {
  it.each(['restricted', 'historical', 'wrong_ack', 'wrong_step', 'confirmed'] as const)
    ('exposes only an exact owned post-dispatch restriction without changing %s settlement', async mode => {
      const { client, user } = await setup();
      const first = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: randomUUID(),
        expectedFundingSource: 'broker', expectedCustomerCharge: '0' });
      expect(first.status).toBe(202);
      await ctx!.db.transaction(async tx => {
        await tx.execute(sql`select set_config('gudex.sponsorship_v1', 'true', true), set_config('gudex.sponsorship_v2', 'true', true)`);
        await tx.update(cardOperations).set({ status: 'unknown',
          error: 'Partner result is unconfirmed; funds remain reserved' }).where(eq(cardOperations.id, first.body.operation.id));
      });
      await ctx!.db.insert(upaySubmissions).values({ reference: first.body.operation.id, kind: 'issue', requestHash: 'fixture-region-proof',
        state: mode === 'confirmed' ? 'confirmed' : 'unknown', evidence: {
          step: mode === 'wrong_step' ? 'card_recharge' : 'card_issue', dispatchPhase: 'post_dispatched',
          responseAck: mode === 'wrong_ack' ? 'unconfirmed' : 'rejected_envelope',
          ...(mode !== 'historical' ? { businessCategory: 'billing_phone_region_restricted' } : {}),
          privateResponse: 'PRIVATE upstream response must never reach a client',
        } });
      const before = await snapshot(ctx!.db);

      const operation = await client.get(`/v1/operations/${first.body.operation.id}`);
      const card = await client.get(`/v1/cards/${first.body.card.id}`);

      expect(operation.status).toBe(200);
      expect(card.status).toBe(200);
      const expected = mode === 'restricted' ? 'billing_phone_region_restricted' : null;
      expect(operation.body).toMatchObject({ status: 'unknown', fundingSource: 'broker', amount: '0', issueRestriction: expected });
      expect(card.body).toMatchObject({ status: 'pending', pendingOperationStatus: 'unknown', issueRestriction: expected });
      expect(JSON.stringify([operation.body, card.body])).not.toContain('PRIVATE');
      expect(await snapshot(ctx!.db)).toEqual(before);
      expect(await getBalance(ctx!.db, accounts.userWallet(user.id, 'USDT').code)).toBe(50_000_000n);
    });

  it('returns a specific restriction before any wallet or broker reserve or financial dispatch', async () => {
    const { partner, client } = await setup();
    partner.validateIssue.mockRejectedValue(new PartnerCardRegionRestrictedError());
    const before = await snapshot(ctx!.db);

    const response = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: randomUUID(),
      expectedFundingSource: 'broker', expectedCustomerCharge: '0' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('card_region_restricted');
    expect(partner.issueCalls).toBe(0);
    expect(await snapshot(ctx!.db)).toEqual(before);
  });

  it('returns 422 for missing owned billing without reserving funds, claiming a grant or creating card work', async () => {
    const { partner, client, user, customerNo } = await setup();
    partner.validateIssue.mockRejectedValue(new PartnerBillingAddressRequiredError());
    const before = await snapshot(ctx!.db);
    expect(before.grants[0]).toMatchObject({ operationId: null, consumedAt: null });
    expect(before.operations).toHaveLength(0);
    expect(await getBalance(ctx!.db, accounts.userWallet(user.id, 'USDT').code)).toBe(50_000_000n);

    const response = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: randomUUID(),
      expectedFundingSource: 'broker', expectedCustomerCharge: '0' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('billing_address_required');
    expect(partner.validateIssue).toHaveBeenCalledExactlyOnceWith({ partnerCustomerId: customerNo, maxFeeUsd: 1000n });
    expect(partner.issueCalls).toBe(0);
    expect(await snapshot(ctx!.db)).toEqual(before);
  });

  it('returns 503 for an unrelated preflight failure without mislabelling billing or reserving anything', async () => {
    const { partner, client } = await setup();
    partner.validateIssue.mockRejectedValue(new PartnerError('private upstream failure fixture', true));
    const before = await snapshot(ctx!.db);

    const response = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: randomUUID() });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('provider_unavailable');
    expect(JSON.stringify(response.body)).not.toContain('private upstream failure fixture');
    expect(partner.issueCalls).toBe(0);
    expect(await snapshot(ctx!.db)).toEqual(before);
  });

  it('replays an existing key without rerunning changed billing preflight or scheduling a second issuance', async () => {
    const { partner, client } = await setup();
    const input = { asset: 'USDT', idempotencyKey: randomUUID(), expectedFundingSource: 'broker', expectedCustomerCharge: '0' };
    const first = await client.post('/v1/cards', input);
    expect(first.status).toBe(202);
    expect(first.body.operation).toMatchObject({ status: 'pending', fundingSource: 'broker', amount: '0' });
    expect(partner.validateIssue).toHaveBeenCalledTimes(1);
    const beforeReplay = await snapshot(ctx!.db);
    expect(beforeReplay.grants[0]!.operationId).toBe(first.body.operation.id);
    expect(beforeReplay.jobs.filter(job => job.queue === 'card.issue')).toHaveLength(1);
    partner.validateIssue.mockClear();
    partner.validateIssue.mockRejectedValue(new PartnerBillingAddressRequiredError());

    const replay = await client.post('/v1/cards', input);

    expect(replay.status).toBe(202);
    expect(replay.body.operation.id).toBe(first.body.operation.id);
    expect(replay.body.card.id).toBe(first.body.card.id);
    expect(partner.validateIssue).not.toHaveBeenCalled();
    expect(partner.issueCalls).toBe(0);
    expect(await snapshot(ctx!.db)).toEqual(beforeReplay);
  });
});
