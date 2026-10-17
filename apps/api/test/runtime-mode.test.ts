import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { appSettings, cardOperations, cards, kycProfiles, users } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { prepareRuntimeMode } from '../src/runtime-mode';
import { CardService } from '../src/services/cards';
import type { CardPartner } from '../src/partner/types';
import { createTestContext, telegramLogin, type TestContext, verifiedUserWithFunds } from './helpers';

let ctx: TestContext | undefined;
afterEach(async () => { await ctx?.close(); ctx = undefined; });
const config = (writes: boolean, invoices = false) => loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'local-test-secret-16',
  CARD_PARTNER: 'upay', UPAY_LOGIN: 'automation@example.test', UPAY_PASSWORD: 'fixture',
  UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ', UPAY_WRITES_ENABLED: String(writes),
  UPAY_PAYMENT_PASSWORD: '123456', UPAY_INVOICE_DEPOSITS_ENABLED: String(invoices) });

describe('live financial database boundary', () => {
  it('seals invoice-only deposits even while card writes are disabled', async () => {
    ctx = await createTestContext();
    await prepareRuntimeMode(config(false, true), ctx.db);
    expect(await ctx.db.select().from(appSettings)).toContainEqual(expect.objectContaining({ key: 'financial_mode', value: 'live' }));
  });
  it('rejects invoice-only activation over demo balances', async () => {
    ctx = await createTestContext();
    await verifiedUserWithFunds(ctx, '100');
    await expect(prepareRuntimeMode(config(false, true), ctx.db)).rejects.toThrow('clean live database');
  });
  it('seals a clean database before writes and refuses a subsequent mock runtime', async () => {
    ctx = await createTestContext();
    await prepareRuntimeMode(config(true), ctx.db);
    expect(await ctx.db.select().from(appSettings)).toContainEqual(expect.objectContaining({ key: 'financial_mode', value: 'live' }));
    const mock = loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'local-test-secret-16', CARD_PARTNER: 'mock', DEV_TOOLS: 'true' });
    await expect(prepareRuntimeMode(mock, ctx.db)).rejects.toThrow('sealed for live');
    await expect(prepareRuntimeMode(config(false), ctx.db)).resolves.toBeUndefined();
  });
  it('refuses to turn demo funds or mock KYC into real card value', async () => {
    ctx = await createTestContext();
    await verifiedUserWithFunds(ctx, '100');
    await expect(prepareRuntimeMode(config(true), ctx.db)).rejects.toThrow('clean live database');
    expect(await ctx.db.select().from(appSettings)).not.toContainEqual(expect.objectContaining({ key: 'financial_mode' }));
  });
  it('permits read-only diagnostics against an existing demo database without sealing it', async () => {
    ctx = await createTestContext();
    await verifiedUserWithFunds(ctx, '100');
    await prepareRuntimeMode(config(false), ctx.db);
    expect(await ctx.db.select().from(appSettings)).not.toContainEqual(expect.objectContaining({ key: 'financial_mode' }));
  });
  it('lets a new Telegram user sign in after the live seal', async () => {
    ctx = await createTestContext(undefined, { env: { CARD_PARTNER: 'upay', DEV_TOOLS: 'false', UPAY_LOGIN: 'automation@example.test',
      UPAY_PASSWORD: 'fixture', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ' } });
    await prepareRuntimeMode(config(true), ctx.db);
    const session = await telegramLogin(ctx, 456800);
    expect(session.hasPin).toBe(false);
    const [user] = await ctx.db.select().from(users).where(eq(users.telegramId, 456800n));
    const [kyc] = await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, user!.id));
    expect(kyc).toMatchObject({ status: 'none', partnerProvider: 'upay' });
  });
  it('blocks an already warm demo service after the live seal and keeps its deposit atomic', async () => {
    ctx = await createTestContext();
    const [user] = await ctx.db.insert(users).values({ telegramId: 456789n }).returning();
    await prepareRuntimeMode(config(true), ctx.db);
    await expect(ctx.services.wallet.simulateDeposit(user!.id, 'USDT', 'TON', '100')).rejects.toThrow();
    const wallet = await ctx.services.wallet.getWallet(user!.id);
    expect(wallet.balances.every(balance => Number(balance.amount) === 0)).toBe(true);
    await expect(ctx.db.delete(appSettings).where(eq(appSettings.key, 'financial_mode'))).rejects.toThrow();
    await expect(ctx.db.update(appSettings).set({ value: 'mock' }).where(eq(appSettings.key, 'financial_mode'))).rejects.toThrow();
  });
  it('blocks unstamped legacy operations after activation and requires a live provider stamp', async () => {
    ctx = await createTestContext();
    const [user] = await ctx.db.insert(users).values({ telegramId: 456790n }).returning();
    const [card] = await ctx.db.insert(cards).values({ userId: user!.id, productName: 'Fixture' }).returning();
    await prepareRuntimeMode(config(true), ctx.db);
    const op = { userId: user!.id, cardId: card!.id, type: 'issue' as const, idempotencyKey: 'legacy-operation' };
    await expect(ctx.db.insert(cardOperations).values(op)).rejects.toThrow();
    await expect(ctx.db.insert(cardOperations).values({ ...op, partnerProvider: 'upay' })).resolves.toBeDefined();
  });
  it('refuses activation while legacy operations are queued', async () => {
    ctx = await createTestContext();
    const [user] = await ctx.db.insert(users).values({ telegramId: 456791n }).returning();
    const [card] = await ctx.db.insert(cards).values({ userId: user!.id, productName: 'Fixture' }).returning();
    await ctx.db.insert(cardOperations).values({ userId: user!.id, cardId: card!.id, type: 'issue', idempotencyKey: 'queued-legacy' });
    await expect(prepareRuntimeMode(config(true), ctx.db)).rejects.toThrow('clean live database');
  });
  it('never submits or refunds a queued mock operation through the live partner', async () => {
    ctx = await createTestContext();
    const [user] = await ctx.db.insert(users).values({ telegramId: 456792n }).returning();
    const [card] = await ctx.db.insert(cards).values({ userId: user!.id, productName: 'Fixture' }).returning();
    const [op] = await ctx.db.insert(cardOperations).values({ userId: user!.id, cardId: card!.id, type: 'issue', idempotencyKey: 'queued-mock-stamp' }).returning();
    let calls = 0;
    const partner = new Proxy({} as CardPartner, { get: () => async () => { calls++; throw new Error('Live partner must not be called'); } });
    const service = new CardService(ctx.db, config(true), partner);
    await service.handlers()['card.issue']!.run({ operationId: op!.id }, undefined!);
    expect((await service.reconcileUnknown(op!.id)).status).toBe('unknown');
    expect(calls).toBe(0);
    expect((await service.getOperation(user!.id, op!.id)).error).toBeTruthy();
  });
});
