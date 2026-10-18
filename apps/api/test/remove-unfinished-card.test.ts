import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { cardIssueSponsorships, cardOperations, cards, depositInvoices, jobs, kycProfiles, ledgerTransactions, upaySubmissions, users } from '../src/db/schema';
import { MockUpayPartner } from '../src/partner/mock';
import { type CardPartner, PartnerError } from '../src/partner/types';
import { enqueue } from '../src/queue/queue';
import { inspectUnfinishedCard, removeUnfinishedCard } from '../src/ops/remove-unfinished-card';
import { api, assertLedgerConsistent, createTestContext, telegramLogin, TEST_PIN, type TestContext } from './helpers';

const owner = 514468501;
let ctx: TestContext | undefined;
afterEach(async () => { if (ctx) { await assertLedgerConsistent(ctx.db); await ctx.close(); ctx = undefined; } });

class UnknownIssue extends MockUpayPartner {
  override async issueCard(_input: Parameters<CardPartner['issueCard']>[0]): Promise<never> { throw new PartnerError('Fixture remote outcome unknown', true); }
}
const env = { CARD_PARTNER: 'upay', DEV_TOOLS: 'false', UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture-only', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ' };
const cardList = (list: unknown[]) => ({ readRequest: async (method: string, path: string, options: { query?: Record<string, unknown> }) => {
  if (method !== 'GET' || path !== '/card/list') throw new Error('Only the card list may be read');
  return { pageNo: 1, totalPages: list.length ? 1 : 0, list: list.filter(row => (row as { customerNo: string }).customerNo === options.query?.customerNo) };
} }) as never;

// The owner's real state: an approved questionnaire, a broker-paid issuance left UNKNOWN with its reserve, and an unpaid invoice.
async function ownerState() {
  let partner!: UnknownIssue;
  ctx = await createTestContext(db => (partner = new UnknownIssue(db)), { env });
  const locked = await telegramLogin(ctx, owner);
  const client = api(ctx, (await api(ctx, locked.accessToken).post('/v1/security/pin', { pin: TEST_PIN })).body.accessToken);
  const [user] = await ctx.db.select().from(users).where(eq(users.telegramId, BigInt(owner)));
  const customerNo = await partner.createCustomer({ externalRef: user!.id, email: 'owner@example.test', firstName: 'Almaz', lastName: 'Azamatov', birthDate: '1990-01-01', citizenship: 'KZ' });
  await ctx.db.update(kycProfiles).set({ status: 'approved', partnerProvider: 'upay', partnerCustomerId: customerNo, firstName: 'ALMAZ', lastName: 'AZAMATOV' }).where(eq(kycProfiles.userId, user!.id));
  await ctx.services.cards.grantIssueSponsorship({ telegramId: String(owner), reason: 'Explicit local fixture authorization' });
  const issued = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: randomUUID(), expectedFundingSource: 'broker', expectedCustomerCharge: '0' });
  await ctx.settle();
  const [op] = await ctx.db.select().from(cardOperations).where(eq(cardOperations.id, issued.body.operation.id));
  expect(op).toMatchObject({ status: 'unknown' });
  await ctx.db.insert(upaySubmissions).values({ reference: op!.id, kind: 'issue', state: 'unknown', requestHash: 'a'.repeat(64) });
  const [invoice] = await ctx.db.insert(depositInvoices).values({ userId: user!.id, idempotencyKey: randomUUID(), requestHash: 'b'.repeat(64), asset: 'USDT',
    network: 'TRC20', requestedAmount: 10_000_000n, state: 'awaiting_payment', orderNo: 'fixture-unpaid-order' }).returning();
  await enqueue(ctx.db, 'deposit.invoice.reconcile', { invoiceId: invoice!.id }, { dedupeKey: `deposit.invoice:${invoice!.id}` });
  return { user: user!, op: op!, customerNo };
}

describe('removing the owner\'s unfinished test card', () => {
  it('shows the plan, refuses while UPay lists a card, then removes only the card, its reserve, journal, tasks and the unpaid invoice', async () => {
    const { user, op, customerNo } = await ownerState();
    expect(await inspectUnfinishedCard(ctx!.db, undefined)).toMatchObject({ status: 'blocked', blockedReasons: ['upay_card_list_unavailable'] });
    expect(await inspectUnfinishedCard(ctx!.db, cardList([{ customerNo, agentCustomerCardId: 'remote-card' }])))
      .toMatchObject({ status: 'blocked', upayCustomerCards: 1, blockedReasons: ['upay_customer_has_cards'] });
    const plan = await inspectUnfinishedCard(ctx!.db, cardList([{ customerNo: 'someone-else', agentCustomerCardId: 'foreign-card' }]));
    expect(plan).toMatchObject({ status: 'ready', userId: user.id, operationId: op.id, cardId: op.cardId, upayCustomerCards: 0, invoices: 1,
      blockedReasons: [], kept: { kycStatus: 'approved', customerLinked: true, billingAddress: false } });
    expect(plan.jobs).toBeGreaterThan(0);

    await expect(removeUnfinishedCard(ctx!.db, cardList([]), { userId: user.id, operationId: randomUUID(), cardId: op.cardId })).rejects.toMatchObject({ code: 'validation' });
    expect(await ctx!.db.select().from(cards).where(eq(cards.userId, user.id))).toHaveLength(1);

    const removed = await removeUnfinishedCard(ctx!.db, cardList([]), { userId: user.id, operationId: op.id, cardId: op.cardId });
    expect(removed.status).toBe('removed');
    expect(await ctx!.db.select().from(cards).where(eq(cards.userId, user.id))).toEqual([]);
    expect(await ctx!.db.select().from(cardOperations).where(eq(cardOperations.userId, user.id))).toEqual([]);
    expect(await ctx!.db.select().from(cardIssueSponsorships)).toEqual([]);
    expect(await ctx!.db.select().from(upaySubmissions).where(eq(upaySubmissions.reference, op.id))).toEqual([]);
    expect(await ctx!.db.select().from(depositInvoices).where(eq(depositInvoices.userId, user.id))).toEqual([]);
    expect((await ctx!.db.select().from(ledgerTransactions)).filter(row => row.reference.includes(op.id))).toEqual([]);
    expect((await ctx!.db.select().from(jobs)).filter(job => JSON.stringify(job.payload).includes(op.id))).toEqual([]);
    const [balances] = (await ctx!.db.execute(sql`select coalesce(sum(balance), 0)::text as total from ledger_accounts
      where code in ('system:clearing:USDT', 'system:broker_issue_expense:USDT')`)).rows as { total: string }[];
    expect(balances!.total).toBe('0');
    expect((await ctx!.db.select().from(kycProfiles).where(eq(kycProfiles.userId, user.id)))[0]).toMatchObject({ status: 'approved', partnerCustomerId: customerNo });
    expect(await inspectUnfinishedCard(ctx!.db, cardList([]))).toMatchObject({ status: 'nothing_to_remove', invoices: 0 });
  });
});
