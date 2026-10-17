import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cardOperations, cards, kycProfiles, users, adminNotifications, adminAuditLog, upaySubmissions, upaySubmissionAliases } from '../src/db/schema';
import { MockUpayPartner } from '../src/partner/mock';
import { DbUpaySubmissionStore } from '../src/partner/upay/submissions';
import { enqueue } from '../src/queue/queue';
import { CardService } from '../src/services/cards';
import { loadConfig } from '../src/config';
import { api, assertLedgerConsistent, createTestContext, registerUser, telegramLogin, TEST_PIN, TEST_BOT_TOKEN, type TestContext } from './helpers';

let ctx: TestContext | undefined;
afterEach(async () => { if (ctx) { await assertLedgerConsistent(ctx.db); await ctx.close(); ctx = undefined; } });

const env = { CARD_ISSUANCE_MODE: 'manual', ADMIN_TELEGRAM_IDS: '999', CARD_REMINDER_MINUTES: '0' };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');

async function applicant() {
  const user = await registerUser(ctx!);
  const client = api(ctx!, user.token);
  const me = await client.get('/v1/me');
  const photo = await client.post('/v1/kyc/documents', { kind: 'front', mimeType: 'image/png', base64: png });
  expect(photo.status).toBe(201);
  const submitted = await client.post('/v1/kyc', { firstName: 'Ivan', lastName: 'Petrov', email: 'ivan@test.dev',
    birthDate: '1990-05-01', citizenship: 'KZ', phone: '2025550100', globalCode: '+1',
    documentType: 'passport', documentCountry: 'KZ', documentIds: { front: photo.body.id } });
  expect(submitted.status).toBe(200);
  return { ...user, id: me.body.id as string, client };
}

describe('manual application and issuance workflow', () => {
  it('moves only a never-dispatched automatic issue to the manual queue when the mode changes', async () => {
    let partner!: MockUpayPartner;
    ctx = await createTestContext(db => { partner = new MockUpayPartner(db); return partner; }, { env });
    const issue = vi.spyOn(partner, 'issueCard');
    const user = await applicant();
    await ctx.db.update(kycProfiles).set({ status: 'approved', partnerCustomerId: 'fixture_customer' }).where(eq(kycProfiles.userId, user.id));
    await user.client.post('/v1/dev/deposit', { asset: 'USDT', network: 'TON', amount: '100' });
    const config = loadConfig({ ...process.env, TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN, CARD_ISSUANCE_MODE: 'automatic' });
    const automatic = new CardService(ctx.db, config, partner);
    const result = await automatic.issue(user.id, { asset: 'USDT', idempotencyKey: randomUUID() });
    expect(result.operation.fulfillmentMode).toBe('automatic');
    await ctx.settle();
    const [op] = await ctx.db.select().from(cardOperations).where(eq(cardOperations.id, result.operation.id));
    expect(op).toMatchObject({ fulfillmentMode: 'manual', status: 'pending', attempts: 0 });
    expect(issue).not.toHaveBeenCalled();
    expect((await user.client.get('/v1/wallet')).body.balances.find((b: { asset: string }) => b.asset === 'USDT').amount).toBe('90');
    await expect(ctx.db.update(cardOperations).set({ attempts: 1, status: 'processing' }).where(eq(cardOperations.id, op!.id))).rejects.toThrow();
  });

  it('keeps submitted documents for review and notifies admins without any partner writes', async () => {
    let partner!: MockUpayPartner;
    ctx = await createTestContext(db => { partner = new MockUpayPartner(db); return partner; }, { env });
    const create = vi.spyOn(partner, 'createCustomer');
    const issue = vi.spyOn(partner, 'issueCard');
    const user = await applicant();
    await ctx.settle();
    expect(create).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
    expect((await user.client.get('/v1/me')).body.kyc).toMatchObject({ status: 'pending', submissionState: 'manual_review' });
    await user.client.post('/v1/kyc/recheck');
    expect(create).not.toHaveBeenCalled();
    const notifications = await ctx.db.select().from(adminNotifications);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.sentAt).not.toBeNull();
    expect(ctx.bot.sent.filter(m => m.chatId === '999')).toHaveLength(1);
    expect(ctx.bot.sent.find(m => m.chatId === '999')!.text).toContain(user.id);
    expect(ctx.bot.sent.find(m => m.chatId === '999')!.text).not.toContain('ivan@test.dev');
    const [profile] = await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, user.id));
    await enqueue(ctx.db, 'kyc.submit', { userId: user.id, submissionId: profile!.submissionId });
    await ctx.settle();
    expect(create).not.toHaveBeenCalled();
  });

  it('reserves once, never dispatches a manual job, and atomically links and settles once', async () => {
    let partner!: MockUpayPartner;
    ctx = await createTestContext(db => { partner = new MockUpayPartner(db); return partner; }, { env });
    const issue = vi.spyOn(partner, 'issueCard');
    const user = await applicant();
    // The provider-proof/admin route has separate tests; this fixture represents its committed decision.
    await ctx.db.update(kycProfiles).set({ status: 'approved', submissionState: 'manual_verified', partnerCustomerId: 'fixture_customer' })
      .where(eq(kycProfiles.userId, user.id));
    await user.client.post('/v1/dev/deposit', { asset: 'USDT', network: 'TON', amount: '100' });
    const result = await user.client.post('/v1/cards', { asset: 'USDT', idempotencyKey: randomUUID() });
    expect(result.status).toBe(202);
    expect(result.body.operation.fulfillmentMode).toBe('manual');
    const again = await user.client.post('/v1/cards', { asset: 'USDT', idempotencyKey: randomUUID() });
    expect(again.body.operation.id).toBe(result.body.operation.id);
    expect((await user.client.get('/v1/wallet')).body.balances.find((b: { asset: string }) => b.asset === 'USDT').amount).toBe('90');
    await enqueue(ctx.db, 'card.issue', { operationId: result.body.operation.id });
    await ctx.settle();
    expect(issue).not.toHaveBeenCalled();
    const [op] = await ctx.db.select().from(cardOperations).where(eq(cardOperations.id, result.body.operation.id));
    expect(op).toMatchObject({ status: 'pending', attempts: 0, fulfillmentMode: 'manual' });
    const [profile] = await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, user.id));
    const lockedAdmin = await telegramLogin(ctx, 999);
    await api(ctx, lockedAdmin.accessToken).post('/v1/security/pin', { pin: TEST_PIN });
    const [admin] = await ctx.db.select().from(users).where(eq(users.telegramId, 999n));
    const issued = { partnerCardId: 'fixture_card', last4: '4242', expiryMonth: 12, expiryYear: 2030 };
    const receipt = { grossUsd: 1000n, orderNo: 'fixture_order', partnerCustomerId: profile!.partnerCustomerId!,
      submissionId: profile!.submissionId!, productId: '2040769880440840193', operationUpdatedAt: op!.updatedAt.toISOString() };
    await ctx.services.cards.completeManualIssue(admin!.id, user.id, op!.id, issued, receipt);
    await ctx.services.cards.completeManualIssue(admin!.id, user.id, op!.id, issued, receipt);
    expect((await ctx.db.select().from(cards).where(eq(cards.id, result.body.card.id)))[0]).toMatchObject({ status: 'active', partnerCardId: 'fixture_card', last4: '4242' });
    expect(await ctx.db.select().from(adminAuditLog)).toHaveLength(1);
    expect((await user.client.get(`/v1/operations/${op!.id}`)).body.status).toBe('succeeded');
    expect(issue).not.toHaveBeenCalled();

    const automaticJournal = new DbUpaySubmissionStore(ctx.db);
    const otherReference = randomUUID();
    await automaticJournal.begin({ reference: otherReference, kind: 'issue', requestHash: 'a'.repeat(64) });
    await expect(automaticJournal.claimAliases(otherReference, ['order:fixture_order'])).rejects.toThrow('already belongs');

    const autoConfig = loadConfig({ ...process.env, TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN, CARD_ISSUANCE_MODE: 'automatic', CARD_REMINDER_MINUTES: '0' });
    const auto = new CardService(ctx.db, autoConfig, partner);
    await auto.handlers()['card.issue']!.run({ operationId: op!.id }, undefined as never);
    expect(issue).not.toHaveBeenCalled();
  });

  it('refuses unprivileged, stale or automatic operation attachment without changing balances', async () => {
    ctx = await createTestContext(undefined, { env });
    const user = await applicant();
    await ctx.db.update(kycProfiles).set({ status: 'approved', partnerCustomerId: 'fixture_customer' }).where(eq(kycProfiles.userId, user.id));
    await user.client.post('/v1/dev/deposit', { asset: 'USDT', network: 'TON', amount: '100' });
    const result = await user.client.post('/v1/cards', { asset: 'USDT', idempotencyKey: randomUUID() });
    const [op] = await ctx.db.select().from(cardOperations).where(eq(cardOperations.id, result.body.operation.id));
    const receipt = { grossUsd: 1000n, orderNo: 'fixture_order', partnerCustomerId: 'fixture_customer', submissionId: randomUUID(),
      productId: '2040769880440840193', operationUpdatedAt: op!.updatedAt.toISOString() };
    const issued = { partnerCardId: 'fixture_card', last4: '4242', expiryMonth: 12, expiryYear: 2030 };
    await expect(ctx.services.cards.completeManualIssue(user.id, user.id, op!.id, issued, receipt)).rejects.toMatchObject({ code: 'forbidden' });
    const lockedAdmin = await telegramLogin(ctx, 999);
    await api(ctx, lockedAdmin.accessToken).post('/v1/security/pin', { pin: TEST_PIN });
    const [admin] = await ctx.db.select().from(users).where(eq(users.telegramId, 999n));
    await expect(ctx.services.cards.completeManualIssue(admin!.id, user.id, op!.id, issued, receipt)).rejects.toMatchObject({ code: 'validation' });
    const [profile] = await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, user.id));
    const previousReference = randomUUID();
    await ctx.db.insert(upaySubmissions).values({ reference: previousReference, kind: 'issue', state: 'unknown', requestHash: 'b'.repeat(64) });
    await ctx.db.insert(upaySubmissionAliases).values({ kind: 'issue', alias: 'record:fixture_existing_receipt', reference: previousReference });
    await expect(ctx.services.cards.completeManualIssue(admin!.id, user.id, op!.id, issued,
      { ...receipt, submissionId: profile!.submissionId!, receiptRecordId: 'fixture_existing_receipt' })).rejects.toMatchObject({ code: 'validation' });
    expect((await ctx.db.select().from(upaySubmissions).where(eq(upaySubmissions.reference, op!.id))).length).toBe(0);
    await ctx.db.update(cardOperations).set({ fulfillmentMode: 'automatic', status: 'unknown', attempts: 1 }).where(eq(cardOperations.id, op!.id));
    await expect(ctx.services.cards.completeManualIssue(admin!.id, user.id, op!.id, issued, receipt)).rejects.toMatchObject({ code: 'validation' });
    expect(await ctx.db.select().from(adminAuditLog)).toHaveLength(0);
    expect((await ctx.db.select().from(cards).where(eq(cards.id, result.body.card.id)))[0]!.partnerCardId).toBeNull();
  });
});
