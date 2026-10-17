import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { cardIssueSponsorships, cardOperations, cards, depositInvoices, deposits, jobs, kycProfiles, ledgerEntries, referralRewards, users } from '../src/db/schema';
import { accounts, getBalance } from '../src/ledger/ledger';
import { MockUpayPartner } from '../src/partner/mock';
import { type CardPartner, PartnerError } from '../src/partner/types';
import { CardService } from '../src/services/cards';
import { DepositInvoiceService } from '../src/services/deposit-invoices';
import { prepareRuntimeMode } from '../src/runtime-mode';
import type { NativeDepositInvoices } from '../src/partner/upay/deposit-invoices';
import { api, assertLedgerConsistent, createTestContext, telegramLogin, TEST_PIN, type TestContext } from './helpers';

const target = 514468501;
let ctx: TestContext | undefined;
let partner: FixturePartner;
class FixturePartner extends MockUpayPartner {
  calls = 0;
  cost = 1000n;
  result: 'success' | 'reject' | 'unknown' = 'success';
  getIssueSettlement: CardPartner['getIssueSettlement'] = async () => ({ grossUsd: this.cost });
  override async issueCard(input: Parameters<CardPartner['issueCard']>[0]) {
    this.calls++;
    if (this.result === 'reject') throw new PartnerError('Fixture preflight rejected without dispatch', false);
    if (this.result === 'unknown') throw new PartnerError('Fixture remote outcome unknown', true);
    return super.issueCard(input);
  }
}
const env = { CARD_PARTNER: 'upay', DEV_TOOLS: 'false', UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture-only', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ' };
async function setup(telegramId = target, amount = '0') {
  ctx = await createTestContext(db => (partner = new FixturePartner(db)), { env });
  const locked = await telegramLogin(ctx, telegramId);
  const unlocked = await api(ctx, locked.accessToken).post('/v1/security/pin', { pin: TEST_PIN });
  const client = api(ctx, unlocked.body.accessToken);
  const [user] = await ctx.db.select().from(users).where(eq(users.telegramId, BigInt(telegramId)));
  const customerNo = await partner.createCustomer({ externalRef: user!.id, email: 'fixture@example.test', firstName: 'Ivan', lastName: 'Petrov', birthDate: '1990-01-01', citizenship: 'KZ' });
  await ctx.db.update(kycProfiles).set({ status: 'approved', partnerProvider: 'upay', partnerCustomerId: customerNo, firstName: 'IVAN', lastName: 'PETROV' }).where(eq(kycProfiles.userId, user!.id));
  if (amount !== '0') await ctx.services.wallet.simulateDeposit(user!.id, 'USDT', 'TON', amount);
  return { user: user!, client };
}
async function grant(telegramId = target) {
  return ctx!.services.cards.grantIssueSponsorship({ telegramId: String(telegramId), reason: 'Explicit local fixture authorization' });
}
const sponsoredRequest = () => ({ asset: 'USDT' as const, idempotencyKey: randomUUID(), expectedFundingSource: 'broker' as const, expectedCustomerCharge: '0' });
afterEach(async () => { if (ctx) { await assertLedgerConsistent(ctx.db); await ctx.close(); ctx = undefined; } });

describe('one-time broker-paid first issuance', () => {
  it.each(['success', 'unknown'] as const)('does not depend on an unpaid native invoice or wallet funding: %s issuance outcome', async result => {
    const external = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('External HTTP is forbidden in this local fixture'); });
    try {
      const { user, client } = await setup();
      const config = loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'fixture-secret-at-least-16', ...env, UPAY_INVOICE_DEPOSITS_ENABLED: 'true' });
      await prepareRuntimeMode(config, ctx!.db);
      let invoicePosts = 0;
      const invoiceProvider: NativeDepositInvoices = {
        configured: true,
        options: async () => [{ asset: 'USDT', network: 'TRC20', minAmount: '1', maxAmount: '100000', decimals: 2 }],
        create: async input => {
          await input.beforeDispatch?.(); invoicePosts++;
          return { orderNo: 'local-unpaid-invoice', url: 'https://quick.upay.best/#/pay?fixture=unpaid', expiresAt: new Date(Date.now() + 3_600_000) };
        },
        inspect: async () => ({ state: 'processing', receipt: null }),
      };
      ctx!.services.depositInvoices = new DepositInvoiceService(ctx!.db, config.appSecret, invoiceProvider,
        (tx, input) => ctx!.services.wallet.creditInvoice(tx, input), { enabled: true, live: true });
      const invoice = await client.post('/v1/deposit-invoices', { asset: 'USDT', network: 'TRC20', amount: '10', idempotencyKey: randomUUID() });
      expect(invoice.status).toBe(202);
      expect(invoice.body.state).toBe('awaiting_payment');
      await grant();
      const expectedQuote = { asset: 'USDT', fee: '10', customerCharge: '0', fundingSource: 'broker' };
      expect((await client.get('/v1/cards/issue-quote?asset=USDT')).body).toEqual(expectedQuote);
      expect(await getBalance(ctx!.db, accounts.userWallet(user.id, 'USDT').code)).toBe(0n);
      expect(partner.calls).toBe(0);
      // The sealed live fixture must not use mock_upay_cards as receipt evidence.
      // This in-memory partner result represents the worker seam; fetch remains forbidden.
      partner.issueCard = async (input: Parameters<CardPartner['issueCard']>[0]) => {
        await input.beforeSubmit?.(); partner.calls++;
        if (result === 'unknown') throw new PartnerError('Synthetic uncertain issuer outcome', true);
        return { partnerCardId: randomUUID(), last4: '4242', expiryMonth: 12, expiryYear: 2030 };
      };
      const issued = await client.post('/v1/cards', sponsoredRequest());
      expect(issued.status).toBe(202);
      expect(issued.body.operation).toMatchObject({ status: 'pending', amount: '0', fundingSource: 'broker' });
      expect(partner.calls).toBe(0); // API reserves; only the worker may dispatch.
      expect(await ctx!.db.select().from(jobs).where(eq(jobs.queue, 'card.issue'))).toHaveLength(1);
      await ctx!.services.cards.handlers()['card.issue']!.run({ operationId: issued.body.operation.id });
      expect((await ctx!.services.cards.getOperation(user.id, issued.body.operation.id)).status).toBe(result === 'success' ? 'succeeded' : 'unknown');
      expect(partner.calls).toBe(1);
      expect(invoicePosts).toBe(1);
      expect((await ctx!.db.select().from(depositInvoices))[0]!.state).toBe('awaiting_payment');
      expect(await ctx!.db.select().from(deposits)).toHaveLength(0);
      expect(await getBalance(ctx!.db, accounts.userWallet(user.id, 'USDT').code)).toBe(0n);
      if (result === 'unknown') {
        const before = { operations: await ctx!.db.select().from(cardOperations), grants: await ctx!.db.select().from(cardIssueSponsorships), entries: await ctx!.db.select().from(ledgerEntries) };
        expect((await client.get('/v1/cards/issue-quote?asset=USDT')).body).toEqual(expectedQuote);
        const repeated = await client.post('/v1/cards', sponsoredRequest());
        expect(repeated.body.operation).toMatchObject({ id: issued.body.operation.id, status: 'unknown' });
        expect({ operations: await ctx!.db.select().from(cardOperations), grants: await ctx!.db.select().from(cardIssueSponsorships), entries: await ctx!.db.select().from(ledgerEntries) }).toEqual(before);
        expect((await grant()).status).toBe('reserved');
        expect(await getBalance(ctx!.db, accounts.clearing('USDT').code)).toBe(10_000_000n);
        expect(partner.calls).toBe(1);
      }
      expect(external).not.toHaveBeenCalled();
    } finally { external.mockRestore(); }
  });

  it('targets the exact authenticated Telegram identity and never creates a spendable wallet credit', async () => {
    const { user } = await setup();
    expect(await grant()).toMatchObject({ telegramId: String(target), budgetUsd: '10', fundingSource: 'broker', status: 'available' });
    expect(await ctx!.services.cards.quoteIssue(user.id, 'USDT')).toEqual({ asset: 'USDT', fee: '10', customerCharge: '0', fundingSource: 'broker' });
    expect(await ctx!.services.cards.quoteIssue(user.id, 'USDC')).toMatchObject({ customerCharge: '10', fundingSource: 'wallet' });
    expect(await getBalance(ctx!.db, accounts.userWallet(user.id, 'USDT').code)).toBe(0n);
    const other = await telegramLogin(ctx!, target + 1);
    const otherMe = await api(ctx!, other.accessToken).get('/v1/me');
    expect(await ctx!.services.cards.quoteIssue(otherMe.body.id, 'USDT')).toMatchObject({ customerCharge: '10', fundingSource: 'wallet' });
    expect(partner.calls).toBe(0);
  });

  it('atomically reserves one grant for concurrent distinct keys even when the user has money for a paid fallback', async () => {
    const { user } = await setup(target, '50');
    await grant();
    const results = await Promise.all(Array.from({ length: 12 }, () => ctx!.services.cards.issue(user.id, sponsoredRequest())));
    expect(new Set(results.map(result => result.operation.id)).size).toBe(1);
    expect(results[0]!.operation).toMatchObject({ amount: '0', fee: '0', fundingSource: 'broker', status: 'pending' });
    expect(await getBalance(ctx!.db, accounts.userWallet(user.id, 'USDT').code)).toBe(50_000_000n);
    expect(await getBalance(ctx!.db, accounts.brokerIssueExpense().code)).toBe(-10_000_000n);
    expect(await getBalance(ctx!.db, accounts.clearing('USDT').code)).toBe(10_000_000n);
    expect(await ctx!.db.select().from(cardOperations)).toHaveLength(1);
    expect(await ctx!.db.select().from(cards)).toHaveLength(1);
    expect((await grant()).status).toBe('reserved');
  });

  it('settles only the actual broker cost, returns unused hold to the broker and grants no referral income', async () => {
    const { user } = await setup();
    const ref = await telegramLogin(ctx!, target + 1);
    const refMe = await api(ctx!, ref.accessToken).get('/v1/me');
    await ctx!.db.update(users).set({ referredBy: refMe.body.id }).where(eq(users.id, user.id));
    partner.cost = 960n;
    await grant();
    const issued = await ctx!.services.cards.issue(user.id, sponsoredRequest());
    await ctx!.settle();
    expect(await ctx!.services.cards.getOperation(user.id, issued.operation.id)).toMatchObject({ status: 'succeeded', amount: '0', fee: '0', fundingSource: 'broker' });
    expect(partner.calls).toBe(1);
    expect(await getBalance(ctx!.db, accounts.userWallet(user.id, 'USDT').code)).toBe(0n);
    expect(await getBalance(ctx!.db, accounts.brokerIssueExpense().code)).toBe(-9_600_000n);
    expect(await getBalance(ctx!.db, accounts.partnerFunding('USDT').code)).toBe(9_600_000n);
    expect(await getBalance(ctx!.db, accounts.clearing('USDT').code)).toBe(0n);
    expect(await getBalance(ctx!.db, accounts.fees('USDT').code)).toBe(0n);
    expect(await ctx!.db.select().from(referralRewards)).toHaveLength(0);
    expect((await ctx!.services.activity.list(user.id)).find(item => item.kind === 'card_issue')).toMatchObject({ amount: '0', fee: '0', fundingSource: 'broker' });
    expect((await grant()).status).toBe('consumed');
    await expect(ctx!.services.cards.issue(user.id, sponsoredRequest())).rejects.toMatchObject({ code: 'provider_unavailable' });
    await ctx!.services.cards.reconcileUnknown(issued.operation.id);
    expect(await getBalance(ctx!.db, accounts.brokerIssueExpense().code)).toBe(-9_600_000n);
  });

  it('keeps an uncertain outcome reserved across new keys, grant activation and reconciliation without a second dispatch', async () => {
    const { user } = await setup(target, '50');
    partner.result = 'unknown';
    await grant();
    const issued = await ctx!.services.cards.issue(user.id, sponsoredRequest());
    await ctx!.settle();
    expect((await ctx!.services.cards.getOperation(user.id, issued.operation.id)).status).toBe('unknown');
    expect((await ctx!.services.cards.issue(user.id, sponsoredRequest())).operation.id).toBe(issued.operation.id);
    expect((await grant()).status).toBe('reserved');
    await ctx!.services.cards.reconcileUnknown(issued.operation.id);
    expect(partner.calls).toBe(1);
    expect(await getBalance(ctx!.db, accounts.clearing('USDT').code)).toBe(10_000_000n);
    expect(await getBalance(ctx!.db, accounts.userWallet(user.id, 'USDT').code)).toBe(50_000_000n);
  });

  it('returns a confirmed rejection to the broker and releases only that grant for a new explicit action', async () => {
    const { user } = await setup();
    partner.result = 'reject';
    await grant();
    const request = sponsoredRequest();
    const rejected = await ctx!.services.cards.issue(user.id, request);
    await ctx!.settle();
    expect((await ctx!.services.cards.getOperation(user.id, rejected.operation.id)).status).toBe('failed');
    expect(await getBalance(ctx!.db, accounts.brokerIssueExpense().code)).toBe(0n);
    expect(await getBalance(ctx!.db, accounts.userWallet(user.id, 'USDT').code)).toBe(0n);
    expect((await grant()).status).toBe('available');
    expect((await ctx!.services.cards.issue(user.id, request)).operation.id).toBe(rejected.operation.id);
    partner.result = 'success';
    const replacement = await ctx!.services.cards.issue(user.id, sponsoredRequest());
    expect(replacement.operation.id).not.toBe(rejected.operation.id);
    await ctx!.services.cards.handlers()['card.issue']!.onExhausted!({ operationId: rejected.operation.id }, new Error('late obsolete hook'));
    expect((await ctx!.db.select().from(cardIssueSponsorships))[0]!.operationId).toBe(replacement.operation.id);
    await ctx!.settle();
    expect(partner.calls).toBe(2);
    expect(ctx!.bot.sent.some(message => message.text.includes('Средства с вашего баланса не списывались'))).toBe(true);
  });

  it.each(['missing', 'over-budget'] as const)('never activates a sponsored card without a valid receipt: %s', async failure => {
    const { user } = await setup();
    if (failure === 'missing') partner.getIssueSettlement = undefined;
    else partner.cost = 1001n;
    await grant();
    const issued = await ctx!.services.cards.issue(user.id, sponsoredRequest());
    await ctx!.settle();
    expect((await ctx!.services.cards.getOperation(user.id, issued.operation.id)).status).toBe('unknown');
    expect((await ctx!.services.cards.get(user.id, issued.card.id)).status).toBe('pending');
    expect((await grant()).status).toBe('reserved');
    expect(await getBalance(ctx!.db, accounts.clearing('USDT').code)).toBe(10_000_000n);
    expect(await getBalance(ctx!.db, accounts.userWallet(user.id, 'USDT').code)).toBe(0n);
  });

  it('requires the quoted payer and charge before reserving anything and never downgrades a broker click to paid issuance', async () => {
    const { user } = await setup(target, '50');
    await grant();
    await expect(ctx!.services.cards.issue(user.id, { ...sponsoredRequest(), expectedCustomerCharge: '10' })).rejects.toMatchObject({ code: 'provider_unavailable' });
    const changed = new CardService(ctx!.db, loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'fixture-secret-at-least-16', ...env, CARD_ISSUE_FEE_USD: '11' }), partner);
    await expect(changed.issue(user.id, sponsoredRequest())).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(await ctx!.db.select().from(cardOperations)).toHaveLength(0);
    expect(await getBalance(ctx!.db, accounts.userWallet(user.id, 'USDT').code)).toBe(50_000_000n);
  });

  it('does not sponsor unapproved KYC, a different provider or a user who already completed a paid issuance', async () => {
    const { user } = await setup(target, '50');
    await grant();
    await ctx!.db.update(kycProfiles).set({ status: 'none' }).where(eq(kycProfiles.userId, user.id));
    await expect(ctx!.services.cards.issue(user.id, sponsoredRequest())).rejects.toMatchObject({ code: 'kyc_required' });
    expect((await grant()).status).toBe('available');
    const mockService = new CardService(ctx!.db, loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'fixture-secret-at-least-16' }), partner);
    expect(await mockService.quoteIssue(user.id, 'USDT')).toMatchObject({ fundingSource: 'wallet', customerCharge: '10' });
    await expect(mockService.grantIssueSponsorship({ telegramId: String(target), reason: 'fixture' })).rejects.toMatchObject({ code: 'provider_unavailable' });
    await ctx!.db.update(kycProfiles).set({ status: 'approved' }).where(eq(kycProfiles.userId, user.id));
    // A prior paid success makes a still-unclaimed grant ineligible.
    const [card] = await ctx!.db.insert(cards).values({ userId: user.id, productName: 'Earlier paid fixture', status: 'failed' }).returning();
    const [prior] = await ctx!.db.insert(cardOperations).values({ userId: user.id, cardId: card!.id, type: 'issue', partnerProvider: 'upay', status: 'succeeded', asset: 'USDT', amount: 10_000_000n, fee: 10_000_000n, idempotencyKey: randomUUID() }).returning();
    for (const status of ['pending', 'processing', 'unknown', 'succeeded'] as const) {
      await ctx!.db.update(cardOperations).set({ status }).where(eq(cardOperations.id, prior!.id));
      expect(await ctx!.services.cards.quoteIssue(user.id, 'USDT')).toMatchObject({ fundingSource: 'wallet', customerCharge: '10' });
      await expect(ctx!.services.cards.issue(user.id, sponsoredRequest())).rejects.toMatchObject({ code: 'provider_unavailable' });
    }
    expect(await ctx!.db.select().from(cardOperations)).toHaveLength(1);
    expect((await ctx!.db.execute(sql`select count(*)::int as count from jobs where queue = 'card.issue'`)).rows[0]!.count).toBe(0);
  });
});
