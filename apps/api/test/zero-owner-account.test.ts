import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { adminAuditLog, adminNotifications, cardBillingAddresses, cardIssueSponsorships, feePayments, jobs, kycProfiles, upaySubmissions, users } from '../src/db/schema';
import { notify } from '../src/services/notify';
import { inspectZeroOwnerAccount, zeroOwnerAccount } from '../src/ops/zero-owner-account';
import { api, createTestContext, telegramLogin, TEST_PIN, type TestContext } from './helpers';

const owner = 514468501;
let ctx: TestContext | undefined;
afterEach(async () => { await ctx?.close(); ctx = undefined; });
const env = { CARD_PARTNER: 'upay', DEV_TOOLS: 'false', UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture-only', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ' };

// The owner's state after the unfinished card was removed: an approved questionnaire linked to a UPay customer,
// its journal row, a saved billing address, an unused broker grant, admin traces and an expired unpaid fee lease.
async function ownerState() {
  ctx = await createTestContext(undefined, { env });
  const locked = await telegramLogin(ctx, owner);
  await api(ctx, locked.accessToken).post('/v1/security/pin', { pin: TEST_PIN });
  const [user] = await ctx.db.select().from(users).where(eq(users.telegramId, BigInt(owner)));
  const submissionId = randomUUID();
  await ctx.db.update(kycProfiles).set({ status: 'approved', partnerProvider: 'upay', partnerCustomerId: 'C-OWNER', firstName: 'ALMAZ', lastName: 'AZAMATOV',
    submissionId, submissionState: 'submitted', billingAddress: { countryId: 'KZ', countryName: 'Kazakhstan', postalCode: '050000', address: 'Abaya 1' } })
    .where(eq(kycProfiles.userId, user!.id));
  await ctx.db.insert(upaySubmissions).values({ reference: `customer:${submissionId}`, kind: 'customer', state: 'confirmed', requestHash: 'a'.repeat(64),
    partnerReceiptId: 'C-OWNER', evidence: { submissionId, customerNo: 'C-OWNER' } });
  await ctx.db.insert(upaySubmissions).values({ reference: 'someone-else', kind: 'customer', state: 'confirmed', requestHash: 'b'.repeat(64) });
  await ctx.db.insert(cardBillingAddresses).values({ userId: user!.id, customerNo: 'C-OWNER', marker: `GDXB${'0'.repeat(16)}`, requestHash: 'c'.repeat(64),
    ciphertext: 'x', iv: 'y', tag: 'z', status: 'ready' });
  await ctx.db.insert(cardIssueSponsorships).values({ telegramId: BigInt(owner), reason: 'Explicit local fixture authorization' });
  await ctx.db.insert(adminNotifications).values({ eventKey: `application:${submissionId}`, recipientTelegramId: BigInt(owner), userId: user!.id, stage: 'verification' });
  await ctx.db.insert(adminAuditLog).values({ actorUserId: user!.id, targetUserId: user!.id, action: 'manual_kyc_approve', reference: submissionId });
  await ctx.db.insert(feePayments).values({ userId: user!.id, asset: 'USDT', network: 'TRC20', family: 'tron', address: 'TFixture', amount: 10_000_000n,
    status: 'expired', expiresAt: new Date(Date.now() - 60_000) });
  await notify(ctx.db, user!.id, { type: 'kyc_approved' });
  return user!;
}

describe('resetting the owner account to zero', () => {
  it('deletes the account with its questionnaire, address, grant and traces; the next launch starts empty', async () => {
    const user = await ownerState();
    const [other] = await ctx!.db.insert(users).values({ telegramId: 777n, firstName: 'Other' }).returning();
    const plan = await inspectZeroOwnerAccount(ctx!.db);
    expect(plan).toMatchObject({ status: 'ready', userId: user.id, blockedReasons: [],
      remove: { users: 1, kycProfiles: 1, billingAddresses: 1, feePayments: 1, adminNotifications: 1, adminAuditLog: 1, upayJournal: 1, unusedSponsorships: 1 } });
    expect(plan.remove.jobs).toBeGreaterThan(0);

    await expect(zeroOwnerAccount(ctx!.db, randomUUID())).rejects.toMatchObject({ code: 'validation' });
    expect(await ctx!.db.select().from(users).where(eq(users.id, user.id))).toHaveLength(1);

    expect(await zeroOwnerAccount(ctx!.db, user.id)).toMatchObject({ status: 'reset', userId: user.id });
    expect(await ctx!.db.select().from(users).where(eq(users.telegramId, BigInt(owner)))).toEqual([]);
    expect(await ctx!.db.select().from(cardIssueSponsorships)).toEqual([]);
    expect(await ctx!.db.select().from(cardBillingAddresses)).toEqual([]);
    expect((await ctx!.db.select().from(upaySubmissions)).map(row => row.reference)).toEqual(['someone-else']);
    expect((await ctx!.db.select().from(jobs)).filter(job => JSON.stringify(job.payload).includes(user.id))).toEqual([]);
    expect(await ctx!.db.select().from(users).where(eq(users.id, other!.id))).toHaveLength(1);
    expect(await inspectZeroOwnerAccount(ctx!.db)).toMatchObject({ status: 'not_found' });

    const fresh = await telegramLogin(ctx!, owner);
    const me = await api(ctx!, fresh.accessToken).get('/v1/me');
    expect(me.body).toMatchObject({ hasPin: false, kyc: { status: 'none' } });
    expect(me.body.id).not.toBe(user.id);
  });

  it('refuses while any money arrived for the account, even a partial fee payment', async () => {
    const user = await ownerState();
    await ctx!.db.update(feePayments).set({ received: 4_000_000n }).where(eq(feePayments.userId, user.id));
    expect(await inspectZeroOwnerAccount(ctx!.db)).toMatchObject({ status: 'blocked', blockedReasons: ['paidFeePayments'] });
    await expect(zeroOwnerAccount(ctx!.db, user.id)).rejects.toMatchObject({ code: 'validation' });
    expect(await ctx!.db.select().from(users).where(eq(users.id, user.id))).toHaveLength(1);
  });
});
