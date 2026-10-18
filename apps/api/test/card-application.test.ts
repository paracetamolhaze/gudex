import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import type { Tx } from '../src/db/client';
import { adminAuditLog, cardOperations, cards, kycDocuments, kycProfiles, users } from '../src/db/schema';
import { AppError } from '../src/lib/errors';
import { ManualAdminService } from '../src/services/manual-admin';
import { api, assertLedgerConsistent, createTestContext, registerUser, telegramLogin, TEST_BOT_TOKEN, TEST_PIN, type TestContext } from './helpers';

let ctx: TestContext | undefined;
afterEach(async () => { if (ctx) { await assertLedgerConsistent(ctx.db); await ctx.close(); ctx = undefined; } });

const env = { CARD_ISSUANCE_MODE: 'manual', ADMIN_TELEGRAM_IDS: '999', CARD_REMINDER_MINUTES: '0' };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
const billing = { countryId: 'KZ', postalCode: '050000', address: 'Abay Ave 10, Almaty' };

async function client(funds = '100') {
  const user = await registerUser(ctx!);
  const http = api(ctx!, user.token);
  const me = await http.get('/v1/me');
  if (funds !== '0') await http.post('/v1/dev/deposit', { asset: 'USDT', network: 'TON', amount: funds });
  return { ...user, id: me.body.id as string, http };
}

async function apply(user: Awaited<ReturnType<typeof client>>, idempotencyKey = randomUUID()) {
  const photo = await user.http.post('/v1/kyc/documents', { kind: 'front', mimeType: 'image/png', base64: png });
  expect(photo.status).toBe(201);
  return user.http.post('/v1/card-application', {
    kyc: { firstName: 'Ivan', lastName: 'Petrov', email: 'ivan@test.dev', birthDate: '1990-05-01', citizenship: 'KZ', phone: '2025550100',
      globalCode: '+1', documentType: 'passport', documentCountry: 'KZ', documentIds: { front: photo.body.id } },
    billing, asset: 'USDT', idempotencyKey, expectedFundingSource: 'wallet', expectedCustomerCharge: '10',
  });
}

const usdt = async (user: Awaited<ReturnType<typeof client>>) =>
  (await user.http.get('/v1/wallet')).body.balances.find((b: { asset: string }) => b.asset === 'USDT').amount;
const messagesTo = (telegramId: number) => ctx!.bot.sent.filter(message => message.chatId === String(telegramId)).map(message => message.text);

async function admin() {
  const locked = await telegramLogin(ctx!, 999);
  await api(ctx!, locked.accessToken).post('/v1/security/pin', { pin: TEST_PIN });
  const [row] = await ctx!.db.select().from(users).where(eq(users.telegramId, 999n));
  return row!;
}

describe('single manual card application', () => {
  it('saves questionnaire, address and the reserved fee together and tells the client to wait for the card', async () => {
    ctx = await createTestContext(undefined, { env });
    const user = await client();
    const key = randomUUID();
    const result = await apply(user, key);
    expect(result.status).toBe(202);
    expect(result.body.kyc).toMatchObject({ status: 'pending', submissionState: 'manual_review' });
    expect(result.body.operation).toMatchObject({ type: 'issue', status: 'pending', fulfillmentMode: 'manual', asset: 'USDT', amount: '10' });
    expect(result.body.card).toMatchObject({ status: 'pending', pendingFulfillmentMode: 'manual', holderName: 'IVAN PETROV' });
    expect(await usdt(user)).toBe('90');
    const [profile] = await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, user.id));
    expect(profile!.billingAddress).toEqual({ ...billing, countryName: 'Kazakhstan' });
    const [photo] = await ctx.db.select().from(kycDocuments).where(eq(kycDocuments.userId, user.id));
    expect(photo!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86400_000);

    const replay = await user.http.post('/v1/card-application', { kyc: { firstName: 'Ivan', lastName: 'Petrov', email: 'ivan@test.dev', birthDate: '1990-05-01',
      citizenship: 'KZ', phone: '2025550100', globalCode: '+1', documentType: 'passport', documentCountry: 'KZ', documentIds: { front: photo!.id } },
      billing, asset: 'USDT', idempotencyKey: key });
    expect(replay.status).toBe(202);
    expect(replay.body.operation.id).toBe(result.body.operation.id);
    expect((await apply(user)).status).toBe(409);
    expect(await usdt(user)).toBe('90');

    await ctx.settle();
    const toClient = messagesTo(user.telegramId).filter(text => text.includes('Данные отправлены на проверку'));
    expect(toClient).toHaveLength(1);
    expect(toClient[0]).toContain('10 USDT');
    const toAdmin = messagesTo(999);
    expect(toAdmin).toHaveLength(1);
    expect(toAdmin[0]).toContain(user.id);
    expect(toAdmin[0]).not.toContain('ivan@test.dev');
    expect(await ctx.db.select().from(cardOperations).where(eq(cardOperations.userId, user.id))).toMatchObject([{ status: 'pending', attempts: 0 }]);
  });

  it('saves the application without a reserve when the balance cannot cover the fee; nobody is notified yet', async () => {
    ctx = await createTestContext(undefined, { env });
    const user = await client('5');
    const result = await apply(user);
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ kyc: { status: 'pending', submissionState: 'manual_review' }, card: null, operation: null });
    expect(await ctx.db.select().from(cards).where(eq(cards.userId, user.id))).toEqual([]);
    expect(await usdt(user)).toBe('5');
    await ctx.settle();
    expect(ctx.bot.sent.filter(message => !message.text.includes('Зачислено'))).toEqual([]);
  });

  it('accepts a driving licence with both sides photographed', async () => {
    ctx = await createTestContext(undefined, { env });
    const user = await client();
    const front = await user.http.post('/v1/kyc/documents', { kind: 'front', mimeType: 'image/png', base64: png });
    const back = await user.http.post('/v1/kyc/documents', { kind: 'back', mimeType: 'image/png', base64: png });
    const send = (documentIds: Record<string, string>) => user.http.post('/v1/card-application', {
      kyc: { firstName: 'Ivan', lastName: 'Petrov', email: 'ivan@test.dev', birthDate: '1990-05-01', citizenship: 'KZ', phone: '2025550100',
        globalCode: '+1', documentType: 'driving_license', documentCountry: 'KZ', documentIds },
      billing, asset: 'USDT', idempotencyKey: randomUUID(), expectedFundingSource: 'wallet', expectedCustomerCharge: '10' });
    expect((await send({ front: front.body.id })).status).toBe(400);
    expect((await send({ front: front.body.id, back: back.body.id })).status).toBe(202);
    expect((await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, user.id)))[0]).toMatchObject({ documentType: 'driving_license' });
    expect((await user.http.get('/v1/kyc/requirements')).body.documentTypes).toEqual(['passport', 'id_card', 'driving_license']);
  });

  it('is unavailable while issuance is automatic', async () => {
    ctx = await createTestContext(undefined, { env: { CARD_REMINDER_MINUTES: '0' } });
    const user = await client();
    expect((await apply(user)).status).toBe(400);
    expect(await usdt(user)).toBe('100');
  });

  it('declining returns the reserve and deletes the photos; the client can apply again', async () => {
    ctx = await createTestContext(undefined, { env });
    const user = await client();
    await apply(user);
    const operator = await admin();
    // Live profiles belong to UPay; the operator boundary accepts only those.
    await ctx.db.update(kycProfiles).set({ partnerProvider: 'upay' }).where(eq(kycProfiles.userId, user.id));
    const [profile] = await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, user.id));
    const live = loadConfig({ ...process.env, ...env, TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN, CARD_PARTNER: 'upay', UPAY_LOGIN: 'synthetic-login',
      UPAY_PASSWORD: 'synthetic-password', UPAY_TOTP_SECRET: 'JBSWY3DPEHPK3PXP', DEV_TOOLS: 'false' });
    const service = new ManualAdminService(ctx.db, live, undefined, ctx.services.cards);
    const result = await service.rejectKyc(operator.id, user.id, { submissionId: profile!.submissionId!, reason: 'Фото нечитаемо' });
    expect(result.kyc).toMatchObject({ status: 'rejected' });
    expect(await usdt(user)).toBe('100');
    expect(await ctx.db.select().from(kycDocuments).where(eq(kycDocuments.userId, user.id))).toEqual([]);
    expect(await ctx.db.select({ status: cards.status }).from(cards).where(eq(cards.userId, user.id))).toEqual([{ status: 'failed' }]);
    expect((await ctx.db.select().from(adminAuditLog)).map(row => row.action).sort()).toEqual(['manual_application_cancel', 'manual_kyc_reject']);
    await ctx.settle();
    const rejected = messagesTo(user.telegramId).find(text => text.startsWith('Верификация не пройдена'));
    expect(rejected).toContain('Верификация не пройдена: Фото нечитаемо');
    expect(rejected).toContain('10 USDT вернулись на баланс');

    expect((await apply(user)).status).toBe(202);
    expect(await usdt(user)).toBe('90');
  });

  it('links the card and approves the questionnaire in one transaction', async () => {
    ctx = await createTestContext(undefined, { env });
    const user = await client();
    const application = await apply(user);
    const operator = await admin();
    const [op] = await ctx.db.select().from(cardOperations).where(eq(cardOperations.id, application.body.operation.id));
    const [profile] = await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, user.id));
    const issued = { partnerCardId: 'fixture_card', last4: '4242', expiryMonth: 12, expiryYear: 2030 };
    const receipt = { grossUsd: 1000n, orderNo: 'fixture_order', partnerCustomerId: 'fixture_customer', submissionId: profile!.submissionId!,
      productId: '2040769880440840193', operationUpdatedAt: op!.updatedAt.toISOString() };
    const approve = async (tx: Tx) => {
      await tx.update(kycProfiles).set({ status: 'approved', submissionState: 'manual_verified', partnerCustomerId: 'fixture_customer' })
        .where(and(eq(kycProfiles.userId, user.id), eq(kycProfiles.submissionState, 'manual_review')));
    };
    await expect(ctx.services.cards.completeManualIssue(operator.id, user.id, op!.id, issued, receipt, async tx => {
      await approve(tx);
      throw new AppError('validation', 'Stop after approval');
    })).rejects.toMatchObject({ code: 'validation' });
    expect((await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, user.id)))[0]).toMatchObject({ status: 'pending', partnerCustomerId: null });
    expect((await ctx.db.select().from(cards).where(eq(cards.userId, user.id)))[0]).toMatchObject({ status: 'pending', partnerCardId: null });

    await ctx.services.cards.completeManualIssue(operator.id, user.id, op!.id, issued, receipt, approve);
    expect((await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, user.id)))[0]).toMatchObject({ status: 'approved', partnerCustomerId: 'fixture_customer' });
    expect((await ctx.db.select().from(cards).where(eq(cards.userId, user.id)))[0]).toMatchObject({ status: 'active', partnerCardId: 'fixture_card', last4: '4242' });
    expect((await user.http.get(`/v1/operations/${op!.id}`)).body.status).toBe('succeeded');
    expect(await usdt(user)).toBe('90');
    await ctx.settle();
    expect(messagesTo(user.telegramId).some(text => text.includes('•• 4242'))).toBe(true);
  });
});
