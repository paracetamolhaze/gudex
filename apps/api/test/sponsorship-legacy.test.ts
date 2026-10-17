import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { cardIssueSponsorships, cardOperations, kycProfiles, ledgerTransactions, users } from '../src/db/schema';
import { accounts, getBalance, move, post } from '../src/ledger/ledger';
import { assertLedgerConsistent, createTestContext, type TestContext } from './helpers';

let ctx: TestContext | undefined;
async function reserved() {
  ctx = await createTestContext(undefined, { env: { CARD_PARTNER: 'upay', DEV_TOOLS: 'false', UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture-only', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ' } });
  const [user] = await ctx.db.insert(users).values({ telegramId: 514468501n, firstName: 'Synthetic fixture' }).returning();
  await ctx.db.insert(kycProfiles).values({ userId: user!.id, partnerProvider: 'upay', status: 'approved', firstName: 'SYNTHETIC', lastName: 'FIXTURE' });
  await ctx.services.cards.grantIssueSponsorship({ telegramId: '514468501', reason: 'Local legacy compatibility fixture' });
  const issued = await ctx.services.cards.issue(user!.id, { asset: 'USDT', idempotencyKey: randomUUID(), expectedFundingSource: 'broker', expectedCustomerCharge: '0' });
  return { user: user!, operationId: issued.operation.id };
}
async function unchanged(userId: string, operationId: string) {
  expect(await getBalance(ctx!.db, accounts.userWallet(userId, 'USDT').code)).toBe(0n);
  expect(await getBalance(ctx!.db, accounts.fees('USDT').code)).toBe(0n);
  expect(await getBalance(ctx!.db, accounts.clearing('USDT').code)).toBe(10_000_000n);
  expect((await ctx!.db.select().from(cardOperations).where(eq(cardOperations.id, operationId)))[0]!.status).toBe('pending');
  expect((await ctx!.db.select().from(cardIssueSponsorships))[0]).toMatchObject({ operationId, consumedAt: null });
}
afterEach(async () => { if (ctx) { await assertLedgerConsistent(ctx.db); await ctx.close(); ctx = undefined; } });

describe('database fence for immutable legacy workers', () => {
  it('blocks legacy pending-to-processing before any partner dispatch and does not leak a transaction-local marker', async () => {
    const { user, operationId } = await reserved();
    const marker = await ctx!.db.execute(sql`select current_setting('gudex.sponsorship_v1', true) as value`);
    expect(marker.rows[0]!.value).not.toBe('true');
    await expect(ctx!.db.update(cardOperations).set({ status: 'processing' }).where(eq(cardOperations.id, operationId))).rejects.toThrow();
    await unchanged(user.id, operationId);
  });

  it('rolls back the old clearing-to-user-wallet refund without minting a spendable gift', async () => {
    const { user, operationId } = await reserved();
    await expect(ctx!.db.transaction(async tx => {
      await post(tx, { kind: 'card_issue_refund', reference: `card_issue_refund:${operationId}`,
        postings: move(accounts.clearing('USDT'), accounts.userWallet(user.id, 'USDT'), 10_000_000n) });
      await tx.update(cardOperations).set({ status: 'failed' }).where(eq(cardOperations.id, operationId));
    })).rejects.toThrow();
    expect(await ctx!.db.select().from(ledgerTransactions).where(eq(ledgerTransactions.reference, `card_issue_refund:${operationId}`))).toHaveLength(0);
    await unchanged(user.id, operationId);
  });

  it('blocks a legacy settlement that would manufacture fee margin from broker coverage', async () => {
    const { user, operationId } = await reserved();
    await expect(ctx!.db.transaction(async tx => {
      await post(tx, { kind: 'card_issue_settle', reference: `card_issue_settle:${operationId}`, postings: [
        { account: accounts.clearing('USDT'), amount: -10_000_000n },
        { account: accounts.partnerFunding('USDT'), amount: 9_600_000n },
        { account: accounts.fees('USDT'), amount: 400_000n },
      ] });
      await tx.update(cardOperations).set({ status: 'succeeded' }).where(eq(cardOperations.id, operationId));
    })).rejects.toThrow();
    await unchanged(user.id, operationId);
  });

  it.each(['refund', 'settle'] as const)('rejects wrong %s accounts even in a sponsorship-aware transaction', async action => {
    const { user, operationId } = await reserved();
    await expect(ctx!.db.transaction(async tx => {
      await tx.execute(sql`select set_config('gudex.sponsorship_v1', 'true', true)`);
      await post(tx, { kind: `card_issue_${action}`, reference: `card_issue_${action}:${operationId}`,
        postings: move(accounts.clearing('USDT'), action === 'refund' ? accounts.userWallet(user.id, 'USDT') : accounts.fees('USDT'), 10_000_000n) });
    })).rejects.toThrow();
    await unchanged(user.id, operationId);
  });

  it.each(['succeeded', 'failed'] as const)('requires real settlement postings as well as grant state for %s', async status => {
    const { user, operationId } = await reserved();
    await expect(ctx!.db.transaction(async tx => {
      await tx.execute(sql`select set_config('gudex.sponsorship_v1', 'true', true)`);
      await tx.update(cardIssueSponsorships).set(status === 'succeeded' ? { consumedAt: new Date() } : { operationId: null });
      await tx.update(cardOperations).set({ status }).where(eq(cardOperations.id, operationId));
    })).rejects.toThrow();
    await unchanged(user.id, operationId);
  });

  it('forbids referral rewards for a sponsored issuance even with a compatible worker marker', async () => {
    const { user, operationId } = await reserved();
    await expect(ctx!.db.transaction(async tx => {
      await tx.execute(sql`select set_config('gudex.sponsorship_v1', 'true', true)`);
      await post(tx, { kind: 'referral_reward', reference: `referral_reward:card_issue:${operationId}`,
        postings: move(accounts.fees('USDT'), accounts.userWallet(user.id, 'USDT'), 100_000n) });
    })).rejects.toThrow();
    await unchanged(user.id, operationId);
  });
});
