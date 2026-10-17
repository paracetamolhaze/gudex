import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { cardOperationRequestAliases, cardOperations, cards, jobs, ledgerTransactions } from '../src/db/schema';
import { MockUpayPartner } from '../src/partner/mock';
import type { CardPartner } from '../src/partner/types';
import { api, assertLedgerConsistent, createTestContext, telegramLogin, TEST_PIN, type TestContext, verifiedUserWithFunds } from './helpers';

let ctx: TestContext | undefined;
class CountingPartner extends MockUpayPartner {
  calls = 0;
  override async issueCard(input: Parameters<CardPartner['issueCard']>[0]) { this.calls++; return super.issueCard(input); }
}
afterEach(async () => {
  if (ctx) { try { await assertLedgerConsistent(ctx.db); } finally { await ctx.close(); ctx = undefined; } }
});

describe('durable normal issuance resumption across lost client state', () => {
  it.each(['pending', 'processing'] as const)('resumes the same %s issuance with a new key after session relock, without another reserve or queue entry', async status => {
    let partner!: CountingPartner;
    ctx = await createTestContext(db => (partner = new CountingPartner(db)));
    const user = await verifiedUserWithFunds(ctx, '100');
    const first = await user.client.post('/v1/cards', { asset: 'USDT', idempotencyKey: randomUUID(), expectedFundingSource: 'wallet', expectedCustomerCharge: '10' });
    expect(first.status).toBe(202);
    if (status === 'processing') await ctx.db.update(cardOperations).set({ status }).where(eq(cardOperations.id, first.body.operation.id));
    const locked = await telegramLogin(ctx, user.telegramId);
    const unlocked = await api(ctx, locked.accessToken).post('/v1/security/unlock', { pin: TEST_PIN });
    const reopened = api(ctx, unlocked.body.accessToken);
    const second = await reopened.post('/v1/cards', { asset: 'USDT', idempotencyKey: randomUUID(), expectedFundingSource: 'wallet', expectedCustomerCharge: '10' });
    expect(second.status).toBe(202);
    expect(second.body.operation.id).toBe(first.body.operation.id);
    expect(second.body.card.id).toBe(first.body.card.id);
    expect(second.body.card).toMatchObject({ pendingOperationId: first.body.operation.id, pendingOperationStatus: status });
    expect((await reopened.get('/v1/cards')).body[0]).toMatchObject({ pendingOperationId: first.body.operation.id });
    expect(await ctx.db.select().from(cardOperations)).toHaveLength(1);
    expect(await ctx.db.select().from(cards)).toHaveLength(1);
    expect(await ctx.db.select().from(jobs).where(eq(jobs.queue, 'card.issue'))).toHaveLength(1);
    expect(await ctx.db.select().from(ledgerTransactions).where(eq(ledgerTransactions.kind, 'card_issue_hold'))).toHaveLength(1);
    expect((await reopened.get('/v1/wallet')).body.balances[0].amount).toBe('90');
    expect(partner.calls).toBe(0);
  });

  it('serializes distinct simultaneous keys to one pending operation while permitting a later sequential card', async () => {
    let partner!: CountingPartner;
    ctx = await createTestContext(db => (partner = new CountingPartner(db)));
    const { client } = await verifiedUserWithFunds(ctx, '100');
    const results = await Promise.all(Array.from({ length: 8 }, () => client.post('/v1/cards', { asset: 'USDT', idempotencyKey: randomUUID() })));
    expect(results.every(result => result.status === 202)).toBe(true);
    expect(new Set(results.map(result => result.body.operation.id)).size).toBe(1);
    expect((await client.get('/v1/wallet')).body.balances[0].amount).toBe('90');
    await ctx.settle();
    expect(partner.calls).toBe(1);
    const later = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: randomUUID() });
    expect(later.status).toBe(202);
    expect(later.body.operation.id).not.toBe(results[0]!.body.operation.id);
    await ctx.settle();
    expect(partner.calls).toBe(2);
    expect((await client.get('/v1/cards')).body).toHaveLength(2);
    expect((await client.get('/v1/wallet')).body.balances[0].amount).toBe('80');
  });

  it('keeps a resumed key bound after completion even when its first response was lost', async () => {
    let partner!: CountingPartner;
    ctx = await createTestContext(db => (partner = new CountingPartner(db)));
    const { client } = await verifiedUserWithFunds(ctx, '100');
    const first = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: randomUUID() });
    const resumedKey = randomUUID();
    // The client did not receive this response and retries only after the worker completes.
    const resumed = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: resumedKey });
    expect(resumed.body.operation.id).toBe(first.body.operation.id);
    await ctx.settle();
    const replay = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: resumedKey });
    expect(replay.body.operation.id).toBe(first.body.operation.id);
    expect(replay.body.operation.status).toBe('succeeded');
    expect(await ctx.db.select().from(cardOperations)).toHaveLength(1);
    expect((await client.get('/v1/wallet')).body.balances[0].amount).toBe('90');
    expect(partner.calls).toBe(1);
    const fresh = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: randomUUID() });
    expect(fresh.body.operation.id).not.toBe(first.body.operation.id);
  });

  it('keeps aliases immutable and owner-scoped, and rejects primary-key collisions even for an older writer', async () => {
    ctx = await createTestContext();
    const firstUser = await verifiedUserWithFunds(ctx, '100');
    const primaryKey = randomUUID();
    const first = await firstUser.client.post('/v1/cards', { asset: 'USDT', idempotencyKey: primaryKey });
    const resumedKey = randomUUID();
    await firstUser.client.post('/v1/cards', { asset: 'USDT', idempotencyKey: resumedKey });
    const [operation] = await ctx.db.select().from(cardOperations).where(eq(cardOperations.id, first.body.operation.id));
    const otherUser = await verifiedUserWithFunds(ctx, '100');
    const other = await otherUser.client.post('/v1/cards', { asset: 'USDT', idempotencyKey: resumedKey });
    expect(other.status).toBe(202);
    expect(other.body.operation.id).not.toBe(first.body.operation.id);
    const [foreign] = await ctx.db.select().from(cardOperations).where(eq(cardOperations.id, other.body.operation.id));
    await expect(ctx.db.insert(cardOperationRequestAliases).values({ userId: foreign!.userId, idempotencyKey: randomUUID(), operationId: operation!.id })).rejects.toThrow();
    await expect(ctx.db.insert(cardOperationRequestAliases).values({ userId: operation!.userId, idempotencyKey: primaryKey, operationId: operation!.id })).rejects.toThrow();
    await expect(ctx.db.update(cardOperationRequestAliases).set({ operationId: foreign!.id }).where(eq(cardOperationRequestAliases.operationId, operation!.id))).rejects.toThrow();
    await expect(ctx.db.delete(cardOperationRequestAliases).where(eq(cardOperationRequestAliases.operationId, operation!.id))).rejects.toThrow();
    // An older deployment knows only card_operations; it must not reserve a new operation with B.
    await expect(ctx.db.insert(cardOperations).values({ userId: operation!.userId, cardId: operation!.cardId, type: 'issue', idempotencyKey: resumedKey })).rejects.toThrow();
    expect(await ctx.db.select().from(cardOperations)).toHaveLength(2);
    expect(await ctx.db.select().from(cardOperationRequestAliases)).toHaveLength(1);
  });

  it('rejects another asset or payer while a wallet-funded issuance is pending', async () => {
    ctx = await createTestContext();
    const { client } = await verifiedUserWithFunds(ctx, '100');
    await client.post('/v1/dev/deposit', { asset: 'USDC', network: 'BEP20', amount: '100' });
    const first = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: randomUUID() });
    const changedAsset = await client.post('/v1/cards', { asset: 'USDC', idempotencyKey: randomUUID() });
    expect(changedAsset.status).toBe(409);
    expect(changedAsset.body.error.code).toBe('quote_changed');
    expect((await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: randomUUID(), expectedFundingSource: 'broker', expectedCustomerCharge: '0' })).status).toBe(503);
    expect(await ctx.db.select().from(cardOperations)).toHaveLength(1);
    expect((await client.get(`/v1/operations/${first.body.operation.id}`)).body.status).toBe('pending');
    expect((await client.get('/v1/wallet')).body.balances).toEqual([{ asset: 'USDT', amount: '90' }, { asset: 'USDC', amount: '100' }]);
  });
});
