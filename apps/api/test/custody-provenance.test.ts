import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { depositAddresses, deposits, users, withdrawals } from '../src/db/schema';
import { WalletService } from '../src/services/wallet';
import { WithdrawalService } from '../src/services/withdrawals';
import { assertLedgerConsistent, createTestContext, registerUser, TEST_PIN, type TestContext, verifiedUserWithFunds } from './helpers';

let ctx: TestContext | undefined;
afterEach(async () => { if (ctx) { await assertLedgerConsistent(ctx.db); await ctx.close(); ctx = undefined; } });
const ADDRESS = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';

describe('custody provider provenance', () => {
  it('replaces a demo identifier before showing a live deposit address and never simulates live funds', async () => {
    ctx = await createTestContext();
    const user = await registerUser(ctx);
    const [owner] = await ctx.db.select().from(users).where(eq(users.telegramId, BigInt(user.telegramId)));
    const demo = await ctx.services.wallet.getDepositAddress(owner!.id, 'USDT', 'TRC20');
    expect(demo.address).toMatch(/^GUDEX-DEMO:/);
    let allocations = 0;
    const wallet = new WalletService(ctx.db, { mode: 'live', providerId: 'custody-fixture', createAddress: async () => { allocations++; return ADDRESS; } }, '5');
    const live = await wallet.getDepositAddress(owner!.id, 'USDT', 'TRC20');
    expect(live).toMatchObject({ address: ADDRESS, demo: false });
    expect((await wallet.getDepositAddress(owner!.id, 'USDT', 'TRC20')).address).toBe(ADDRESS);
    expect(allocations).toBe(1);
    expect((await ctx.db.select().from(depositAddresses))[0]?.providerId).toBe('custody-fixture');
    await expect(wallet.simulateDeposit(owner!.id, 'USDT', 'TRC20', '100')).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(await ctx.db.select().from(deposits)).toHaveLength(0);
    expect((await wallet.getWallet(owner!.id)).balances.every(balance => balance.amount === '0')).toBe(true);
  });

  it('does not allocate an unnamed live provider or overwrite another live integration', async () => {
    ctx = await createTestContext();
    const user = await registerUser(ctx);
    const [owner] = await ctx.db.select().from(users).where(eq(users.telegramId, BigInt(user.telegramId)));
    let calls = 0;
    const unnamed = new WalletService(ctx.db, { mode: 'live', createAddress: async () => { calls++; return ADDRESS; } }, '5');
    await expect(unnamed.getDepositAddress(owner!.id, 'USDT', 'TRC20')).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(calls).toBe(0);
    const first = new WalletService(ctx.db, { mode: 'live', providerId: 'custody-first', createAddress: async () => ADDRESS }, '5');
    await first.getDepositAddress(owner!.id, 'USDT', 'TRC20');
    const second = new WalletService(ctx.db, { mode: 'live', providerId: 'custody-second', createAddress: async () => { calls++; return ADDRESS; } }, '5');
    await expect(second.getDepositAddress(owner!.id, 'USDT', 'TRC20')).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(calls).toBe(0);
    expect((await ctx.db.select().from(depositAddresses))[0]?.providerId).toBe('custody-first');
  });

  it('rejects deposits belonging to a different address owner or integration', async () => {
    ctx = await createTestContext();
    const owner = await registerUser(ctx), other = await registerUser(ctx);
    const allUsers = await ctx.db.select().from(users);
    const ownerId = allUsers.find(item => item.telegramId === BigInt(owner.telegramId))!.id;
    const otherId = allUsers.find(item => item.telegramId === BigInt(other.telegramId))!.id;
    const wallet = new WalletService(ctx.db, { mode: 'live', providerId: 'custody-fixture', createAddress: async () => ADDRESS }, '5');
    await wallet.getDepositAddress(ownerId, 'USDT', 'TRC20');
    await expect(wallet.recordDeposit({ userId: otherId, asset: 'USDT', network: 'TRC20', address: ADDRESS, externalId: 'fixture-external', amount: 10_000_000n })).rejects.toMatchObject({ code: 'validation' });
    await expect(ctx.services.wallet.recordDeposit({ userId: ownerId, asset: 'USDT', network: 'TRC20', address: ADDRESS, externalId: 'mock:foreign-provider', amount: 10_000_000n })).rejects.toMatchObject({ code: 'validation' });
    expect(await ctx.db.select().from(deposits)).toHaveLength(0);
  });

  it('never submits, looks up or refunds a queued mock withdrawal through a live provider', async () => {
    ctx = await createTestContext();
    const { client, telegramId } = await verifiedUserWithFunds(ctx, '100');
    const confirmation = await client.post('/v1/security/confirm', { pin: TEST_PIN });
    const created = await client.post('/v1/withdrawals', { asset: 'USDT', network: 'TRC20', address: ADDRESS, amount: '20', idempotencyKey: randomUUID() }, { 'x-confirmation-token': confirmation.body.confirmationToken });
    expect(created.status).toBe(202);
    expect((await ctx.db.select().from(withdrawals))[0]?.providerId).toBe('mock');
    let sends = 0, reads = 0;
    const config = loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'local-custody-fixture-secret' });
    const live = new WithdrawalService(ctx.db, config, { providerId: 'custody-fixture',
      send: async () => { sends++; return { txHash: 'not-sent' }; },
      findByReference: async () => { reads++; return { txHash: 'not-a-real-receipt' }; },
    });
    await live.handlers()['withdrawal.send']!.run({ withdrawalId: created.body.id }, undefined!);
    expect((await live.reconcileUnknown(created.body.id)).status).toBe('unknown');
    expect(sends).toBe(0); expect(reads).toBe(0);
    const [owner] = await ctx.db.select().from(users).where(eq(users.telegramId, BigInt(telegramId)));
    expect((await ctx.services.wallet.getWallet(owner!.id)).balances.find(balance => balance.asset === 'USDT')?.amount).toBe('80');
  });
});
