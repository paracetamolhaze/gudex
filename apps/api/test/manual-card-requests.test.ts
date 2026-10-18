import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { adminNotifications, cardOperations, cards, kycProfiles, users } from '../src/db/schema';
import { MockUpayPartner } from '../src/partner/mock';
import { CardRequisitesVault } from '../src/services/card-requisites';
import { api, assertLedgerConsistent, createTestContext, registerUser, telegramLogin, TEST_BOT_TOKEN, TEST_PIN, type TestContext } from './helpers';

let ctx: TestContext | undefined;
afterEach(async () => { if (ctx) { await assertLedgerConsistent(ctx.db); await ctx.close(); ctx = undefined; } });

const env = { CARD_ISSUANCE_MODE: 'manual', ADMIN_TELEGRAM_IDS: '999', CARD_REMINDER_MINUTES: '0' };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');

// A client whose manual application was linked to an issued card with operator-typed details.
async function cardholder(partner: MockUpayPartner) {
  const user = await registerUser(ctx!);
  const http = api(ctx!, user.token);
  const me = await http.get('/v1/me');
  await http.post('/v1/dev/deposit', { asset: 'USDT', network: 'TON', amount: '100' });
  const photo = await http.post('/v1/kyc/documents', { kind: 'front', mimeType: 'image/png', base64: png });
  const application = await http.post('/v1/card-application', { kyc: { firstName: 'Ivan', lastName: 'Petrov', email: 'ivan@test.dev', birthDate: '1990-05-01',
    citizenship: 'KZ', phone: '2025550100', globalCode: '+1', documentType: 'passport', documentCountry: 'KZ', documentIds: { front: photo.body.id } },
    billing: { countryId: 'KZ', postalCode: '050000', address: 'Abay Ave 10' }, asset: 'USDT', idempotencyKey: randomUUID() });
  const locked = await telegramLogin(ctx!, 999);
  const adminToken = (await api(ctx!, locked.accessToken).post('/v1/security/pin', { pin: TEST_PIN })).body.accessToken as string;
  const [admin] = await ctx!.db.select().from(users).where(eq(users.telegramId, 999n));
  const [op] = await ctx!.db.select().from(cardOperations).where(eq(cardOperations.id, application.body.operation.id));
  const [profile] = await ctx!.db.select().from(kycProfiles).where(eq(kycProfiles.userId, me.body.id));
  const vault = new CardRequisitesVault(loadConfig({ ...process.env, ...env, TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN }).appSecret);
  await ctx!.services.cards.completeManualIssue(admin!.id, me.body.id, op!.id, { partnerCardId: 'fixture_card', last4: '4242', expiryMonth: 12, expiryYear: 2030 },
    { grossUsd: 1000n, orderNo: `manual-${op!.id}`, partnerCustomerId: 'fixture_customer', submissionId: profile!.submissionId!, productId: '2040769880440840193',
      operationUpdatedAt: op!.updatedAt.toISOString() }, async tx => {
      await tx.update(kycProfiles).set({ status: 'approved', submissionState: 'manual_verified', partnerCustomerId: 'fixture_customer' }).where(eq(kycProfiles.userId, me.body.id));
      await tx.update(cards).set(vault.seal(me.body.id, op!.cardId, { pan: '4242424242424242', cvv: '123' })).where(eq(cards.id, op!.cardId));
    });
  const confirm = async () => (await http.post('/v1/security/confirm', { pin: TEST_PIN })).body.confirmationToken as string;
  return { ...user, id: me.body.id as string, http, cardId: op!.cardId, adminId: admin!.id, admin: api(ctx!, adminToken), adminToken, confirm, partner };
}

const usdt = async (http: ReturnType<typeof api>) =>
  (await http.get('/v1/wallet')).body.balances.find((b: { asset: string }) => b.asset === 'USDT').amount as string;

describe('manual card requests', () => {
  it('shows the operator-typed card details to the owner after the code-password', async () => {
    let partner!: MockUpayPartner;
    ctx = await createTestContext(db => { partner = new MockUpayPartner(db); return partner; }, { env });
    const sensitive = vi.spyOn(partner, 'getCardSensitive');
    const user = await cardholder(partner);
    const details = await user.http.get(`/v1/cards/${user.cardId}/sensitive`, { 'x-confirmation-token': await user.confirm() });
    expect(details.body).toEqual({ pan: '4242424242424242', cvv: '123', expiryMonth: 12, expiryYear: 2030, holderName: 'IVAN PETROV' });
    expect(sensitive).not.toHaveBeenCalled();
  });

  it('keeps card top-up for the personal wallet: nothing is reserved or sent to the bot', async () => {
    let partner!: MockUpayPartner;
    ctx = await createTestContext(db => { partner = new MockUpayPartner(db); return partner; }, { env });
    const recharge = vi.spyOn(partner, 'rechargeCard');
    const user = await cardholder(partner);
    const topup = await user.http.post(`/v1/cards/${user.cardId}/topup`, { asset: 'USDT', amount: '50', idempotencyKey: randomUUID() });
    expect(topup.status).toBe(503);
    expect(await usdt(user.http)).toBe('90');
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/config' })).json().integration.capabilities.topup).toBe(false);
    await ctx.settle();
    expect(recharge).not.toHaveBeenCalled();
  });

  it('freezes through the bot right away and confirms the state by the Customer ID', async () => {
    let partner!: MockUpayPartner;
    ctx = await createTestContext(db => { partner = new MockUpayPartner(db); return partner; }, { env });
    const freeze = vi.spyOn(partner, 'freezeCard').mockResolvedValue();
    const user = await cardholder(partner);
    const request = await user.http.post(`/v1/cards/${user.cardId}/freeze`, { idempotencyKey: randomUUID() });
    expect(request.body).toMatchObject({ type: 'freeze', fulfillmentMode: 'automatic' });
    await ctx.settle();
    expect(freeze).toHaveBeenCalledWith('fixture_card', request.body.id, expect.any(Function), 'fixture_customer');
    expect((await user.http.get(`/v1/cards/${user.cardId}`)).body.status).toBe('frozen');
    expect((await ctx.db.select().from(adminNotifications)).some(row => row.stage === 'card_request')).toBe(false);
  });

  it('confirms a freeze whose answer was lost from this Customer ID card list, without sending it again', async () => {
    let partner!: MockUpayPartner;
    ctx = await createTestContext(db => { partner = new MockUpayPartner(db); return partner; }, { env });
    const freeze = vi.spyOn(partner, 'freezeCard').mockRejectedValue(new Error('freeze response lost'));
    const state = vi.spyOn(partner, 'getCardState').mockResolvedValue('active');
    const user = await cardholder(partner);
    const request = await user.http.post(`/v1/cards/${user.cardId}/freeze`, { idempotencyKey: randomUUID() });
    await ctx.runner.drain();
    expect((await user.http.get(`/v1/operations/${request.body.id}`)).body.status).toBe('processing');
    const reconcile = () => ctx!.services.cards.handlers()['card.reconcile']!.run({ operationId: request.body.id }, undefined as never);
    await expect(reconcile()).rejects.toMatchObject({ delaySeconds: 30 });
    state.mockResolvedValue('frozen');
    await reconcile();
    expect(state).toHaveBeenCalledWith('fixture_card', 'fixture_customer');
    expect((await user.http.get(`/v1/operations/${request.body.id}`)).body.status).toBe('succeeded');
    expect((await user.http.get(`/v1/cards/${user.cardId}`)).body.status).toBe('frozen');
    expect(freeze).toHaveBeenCalledTimes(1);
  });

  it('ends a freeze the card list still does not show after ten minutes, so the client can freeze again', async () => {
    let partner!: MockUpayPartner;
    ctx = await createTestContext(db => { partner = new MockUpayPartner(db); return partner; }, { env });
    vi.spyOn(partner, 'freezeCard').mockRejectedValue(new Error('freeze response lost'));
    vi.spyOn(partner, 'getCardState').mockResolvedValue('active');
    const user = await cardholder(partner);
    const request = await user.http.post(`/v1/cards/${user.cardId}/freeze`, { idempotencyKey: randomUUID() });
    await ctx.runner.drain();
    await ctx.db.update(cardOperations).set({ createdAt: new Date(Date.now() - 11 * 60_000) }).where(eq(cardOperations.id, request.body.id));
    await ctx.services.cards.handlers()['card.reconcile']!.run({ operationId: request.body.id }, undefined as never);
    expect((await user.http.get(`/v1/operations/${request.body.id}`)).body.status).toBe('failed');
    expect((await user.http.get(`/v1/cards/${user.cardId}`)).body.status).toBe('active');
    expect(await usdt(user.http)).toBe('90');
    expect((await user.http.post(`/v1/cards/${user.cardId}/freeze`, { idempotencyKey: randomUUID() })).status).toBe(202);
  });

  it('follows a freeze already on its way instead of sending another, and ends one left without any answer for a day', async () => {
    let partner!: MockUpayPartner;
    ctx = await createTestContext(db => { partner = new MockUpayPartner(db); return partner; }, { env });
    const freeze = vi.spyOn(partner, 'freezeCard').mockRejectedValue(new Error('freeze response lost'));
    vi.spyOn(partner, 'getCardState').mockRejectedValue(new Error('card list unavailable'));
    const user = await cardholder(partner);
    const first = await user.http.post(`/v1/cards/${user.cardId}/freeze`, { idempotencyKey: randomUUID() });
    await ctx.runner.drain();
    const second = await user.http.post(`/v1/cards/${user.cardId}/freeze`, { idempotencyKey: randomUUID() });
    expect(second.body.id).toBe(first.body.id);
    expect((await user.http.post(`/v1/cards/${user.cardId}/unfreeze`, { idempotencyKey: randomUUID() })).status).toBe(422);
    await ctx.runner.drain();
    expect(freeze).toHaveBeenCalledTimes(1);
    await ctx.db.update(cardOperations).set({ createdAt: new Date(Date.now() - 25 * 60 * 60_000) }).where(eq(cardOperations.id, first.body.id));
    await ctx.services.cards.handlers()['card.reconcile']!.run({ operationId: first.body.id }, undefined as never);
    expect((await user.http.get(`/v1/operations/${first.body.id}`)).body.status).toBe('failed');
    expect((await user.http.post(`/v1/cards/${user.cardId}/freeze`, { idempotencyKey: randomUUID() })).body.id).not.toBe(first.body.id);
  });

  it('lets the admin save the card top-up addresses, which the owner then sees on the card', async () => {
    let partner!: MockUpayPartner;
    ctx = await createTestContext(db => { partner = new MockUpayPartner(db); return partner; }, { env });
    const user = await cardholder(partner);
    const confirm = async () => (await user.admin.post('/v1/security/confirm', { pin: TEST_PIN })).body.confirmationToken as string;
    const url = `/v1/admin/clients/${user.id}/cards/${user.cardId}/topup-addresses`;
    const tron = 'TQ1TkHLPYPKn9wBRUySxD3pXZt4sb5bhZx', evm = '0x27ABFbd775d68b692fdF1e15B87d915C3E458404';
    expect((await user.admin.post(url, { USDT_TRC20: 'not-an-address' }, { 'x-confirmation-token': await confirm() })).status).toBe(400);
    expect((await user.admin.post(url, { USDT_TRC20: tron }, {})).status).toBe(403);
    expect((await user.http.post(url, { USDT_TRC20: tron }, { 'x-confirmation-token': await user.confirm() })).status).toBe(403);
    const saved = await user.admin.post(url, { USDT_TRC20: tron, USDT_ERC20: '', USDT_BEP20: evm, USDC_BEP20: evm }, { 'x-confirmation-token': await confirm() });
    expect(saved.status).toBe(200);
    expect(saved.body.cards).toEqual([{ id: user.cardId, status: 'active', last4: '4242', topupAddresses: { USDT_TRC20: tron, USDT_BEP20: evm, USDC_BEP20: evm } }]);
    expect((await user.http.get(`/v1/cards/${user.cardId}`)).body.topupAddresses).toEqual([
      { asset: 'USDT', network: 'TRC20', address: tron }, { asset: 'USDT', network: 'BEP20', address: evm }, { asset: 'USDC', network: 'BEP20', address: evm }]);
  });

  it('sends no money out of the app: transfers and withdrawals are refused', async () => {
    let partner!: MockUpayPartner;
    ctx = await createTestContext(db => { partner = new MockUpayPartner(db); return partner; }, { env });
    const user = await cardholder(partner);
    const transfer = await user.http.post('/v1/transfers', { username: 'someone', asset: 'USDT', amount: '1', idempotencyKey: randomUUID() },
      { 'x-confirmation-token': await user.confirm() });
    const withdrawal = await user.http.post('/v1/withdrawals', { asset: 'USDT', network: 'TRC20', address: 'TQ1TkHLPYPKn9wBRUySxD3pXZt4sb5bhZx',
      amount: '10', idempotencyKey: randomUUID() }, { 'x-confirmation-token': await user.confirm() });
    expect([transfer.status, withdrawal.status]).toEqual([503, 503]);
    expect(await usdt(user.http)).toBe('90');
  });

  it('gives each client one card: no new payment address and no second reserve once the card exists', async () => {
    let partner!: MockUpayPartner;
    ctx = await createTestContext(db => { partner = new MockUpayPartner(db); return partner; },
      { env: { ...env, APP_WALLET_TRON: 'TQ1TkHLPYPKn9wBRUySxD3pXZt4sb5bhZx' } });
    const user = await cardholder(partner);
    const lease = await user.http.post('/v1/fee-payments', { asset: 'USDT', network: 'TRC20' });
    expect(lease.status).toBe(422);
    expect(lease.body.error.code).toBe('card_limit');
    expect(await ctx.db.transaction(tx => ctx!.services.cards.canReserveManualApplication(tx, user.id, 'USDT'))).toBe(false);
    expect(await usdt(user.http)).toBe('90');
  });
});
