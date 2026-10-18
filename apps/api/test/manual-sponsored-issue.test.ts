import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { cardIssueSponsorships, cardOperations, cards, kycProfiles, users } from '../src/db/schema';
import { accounts, getBalance } from '../src/ledger/ledger';
import { inspectOwnerApplication, removeOwnerApplication } from '../src/ops/remove-owner-application';
import { api, assertLedgerConsistent, createTestContext, registerUser, telegramLogin, TEST_PIN, type TestContext } from './helpers';

let ctx: TestContext | undefined;
afterEach(async () => { if (ctx) { await assertLedgerConsistent(ctx.db); await ctx.close(); ctx = undefined; } });

// Production shape: live UPay partner settings, manual issuance and the app wallet pool.
const env = { CARD_ISSUANCE_MODE: 'manual', ADMIN_TELEGRAM_IDS: '999', CARD_REMINDER_MINUTES: '0', CARD_PARTNER: 'upay', DEV_TOOLS: 'false',
  UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture-only', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ', APP_WALLET_TRON: 'TQ1TkHLPYPKn9wBRUySxD3pXZt4sb5bhZx' };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');

describe('first issuance paid by the broker', () => {
  it('shows 0 to the client, reserves from the broker, and the admin link settles it once', async () => {
    ctx = await createTestContext(undefined, { env });
    const owner = await registerUser(ctx);
    const http = api(ctx, owner.token);
    const me = await http.get('/v1/me');
    expect(await ctx.services.cards.grantIssueSponsorship({ telegramId: String(owner.telegramId), reason: 'Owner first manual test issuance' }))
      .toMatchObject({ status: 'available', fundingSource: 'broker' });

    const quote = await http.get('/v1/cards/issue-quote?asset=USDT');
    expect(quote.body).toMatchObject({ customerCharge: '0', fundingSource: 'broker' });
    const front = await http.post('/v1/kyc/documents', { kind: 'front', mimeType: 'image/png', base64: png });
    const applied = await http.post('/v1/card-application', {
      kyc: { firstName: 'Almaz', lastName: 'Azamatov', email: 'owner@example.test', birthDate: '1990-05-01', citizenship: 'KZ', phone: '7011234567',
        globalCode: '+7', documentType: 'passport', documentCountry: 'KZ', documentIds: { front: front.body.id } },
      billing: { countryId: 'KZ', postalCode: '050000', address: 'Abay Ave 10, Almaty' }, asset: 'USDT', idempotencyKey: randomUUID(),
      expectedFundingSource: 'broker', expectedCustomerCharge: '0' });
    expect(applied.status).toBe(202);
    expect(applied.body.operation).toMatchObject({ status: 'pending' });
    expect(await getBalance(ctx.db, accounts.userWallet(me.body.id, 'USDT').code)).toBe(0n);
    expect(await getBalance(ctx.db, accounts.clearing('USDT').code)).toBe(10_000_000n);
    expect((await ctx.db.select().from(cardIssueSponsorships))[0]).toMatchObject({ operationId: applied.body.operation.id, consumedAt: null });
    // Nothing to pay: no payment address is lent for a card that is already being prepared.
    expect((await http.post('/v1/fee-payments', { asset: 'USDT', network: 'TRC20' })).body.error.code).toBe('card_limit');

    const locked = await telegramLogin(ctx, 999);
    await api(ctx, locked.accessToken).post('/v1/security/pin', { pin: TEST_PIN });
    const [admin] = await ctx.db.select().from(users).where(eq(users.telegramId, 999n));
    const [op] = await ctx.db.select().from(cardOperations).where(eq(cardOperations.id, applied.body.operation.id));
    const [profile] = await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, me.body.id));
    const bind = () => ctx!.services.cards.completeManualIssue(admin!.id, me.body.id, op!.id, { partnerCardId: 'fixture_card', last4: '4242', expiryMonth: 12, expiryYear: 2030 },
      { grossUsd: 1000n, orderNo: `manual-${op!.id}`, partnerCustomerId: 'fixture_customer', submissionId: profile!.submissionId!, productId: '2040769880440840193',
        operationUpdatedAt: op!.updatedAt.toISOString() }, async tx => {
        await tx.update(kycProfiles).set({ status: 'approved', submissionState: 'manual_verified', partnerCustomerId: 'fixture_customer' }).where(eq(kycProfiles.userId, me.body.id));
      });
    await bind();
    await bind(); // a repeated link changes nothing
    expect((await ctx.db.select({ status: cards.status }).from(cards).where(eq(cards.userId, me.body.id)))).toEqual([{ status: 'active' }]);
    expect((await ctx.db.select().from(cardIssueSponsorships))[0]!.consumedAt).toBeInstanceOf(Date);
    expect(await getBalance(ctx.db, accounts.clearing('USDT').code)).toBe(0n);
    expect(await getBalance(ctx.db, accounts.userWallet(me.body.id, 'USDT').code)).toBe(0n);
  });

  it('removes the owner\'s waiting application on request; the new one is again paid by the broker', async () => {
    ctx = await createTestContext(undefined, { env });
    const locked = await telegramLogin(ctx, 514468501);
    const token = (await api(ctx, locked.accessToken).post('/v1/security/pin', { pin: TEST_PIN })).body.accessToken as string;
    const http = api(ctx, token);
    const me = await http.get('/v1/me');
    await ctx.services.cards.grantIssueSponsorship({ telegramId: '514468501', reason: 'Owner first manual test issuance' });
    const apply = async () => {
      const front = await http.post('/v1/kyc/documents', { kind: 'front', mimeType: 'image/png', base64: png });
      return http.post('/v1/card-application', {
        kyc: { firstName: 'Almaz', lastName: 'Azamatov', email: 'owner@example.test', birthDate: '1990-05-01', citizenship: 'KZ', phone: '7011234567',
          globalCode: '+7', documentType: 'passport', documentCountry: 'KZ', documentIds: { front: front.body.id } },
        billing: { countryId: 'KZ', postalCode: '050000', address: 'Abay Ave 10, Almaty' }, asset: 'USDT', idempotencyKey: randomUUID(),
        expectedFundingSource: 'broker', expectedCustomerCharge: '0' });
    };
    const first = await apply();
    expect(first.status).toBe(202);

    const plan = await inspectOwnerApplication(ctx.db);
    expect(plan).toMatchObject({ status: 'ready', userId: me.body.id, operationId: first.body.operation.id, blockedReasons: [] });
    await expect(removeOwnerApplication(ctx.db, { userId: me.body.id, operationId: randomUUID() })).rejects.toMatchObject({ code: 'validation' });
    expect(await removeOwnerApplication(ctx.db, { userId: me.body.id, operationId: first.body.operation.id })).toMatchObject({ status: 'removed' });

    expect(await ctx.db.select().from(cards).where(eq(cards.userId, me.body.id))).toEqual([]);
    expect(await ctx.db.select().from(cardOperations).where(eq(cardOperations.userId, me.body.id))).toEqual([]);
    expect((await ctx.db.select().from(cardIssueSponsorships))[0]).toMatchObject({ operationId: null, consumedAt: null });
    expect(await getBalance(ctx.db, accounts.clearing('USDT').code)).toBe(0n);
    expect((await http.get('/v1/me')).body.kyc).toMatchObject({ status: 'none', submissionState: 'none' });
    expect(await inspectOwnerApplication(ctx.db)).toMatchObject({ status: 'ready', operationId: null });

    expect((await http.get('/v1/cards/issue-quote?asset=USDT')).body).toMatchObject({ customerCharge: '0', fundingSource: 'broker' });
    const second = await apply();
    expect(second.status).toBe(202);
    expect(second.body.operation).toMatchObject({ status: 'pending' });
  });
});
