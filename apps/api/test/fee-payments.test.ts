import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { adminAuditLog, adminNotifications, cardOperations, feePayments, jobs, kycProfiles, users, walletTransfers } from '../src/db/schema';
import { FeePaymentService } from '../src/services/fee-payments';
import { api, assertLedgerConsistent, createTestContext, registerUser, telegramLogin, TEST_BOT_TOKEN, TEST_PIN, type TestContext } from './helpers';

let ctx: TestContext | undefined;
afterEach(async () => { if (ctx) { await assertLedgerConsistent(ctx.db); await ctx.close(); ctx = undefined; } });

const tron = ['TQ1TkHLPYPKn9wBRUySxD3pXZt4sb5bhZx', 'TCEFkBL1jaUDZv2fRshwwhaGBKc2dZtFwn'];
const evm = ['0x27ABFbd775d68b692fdF1e15B87d915C3E458404', '0x46FDf83EC403a822468b25Cb771F200A65a8a5CF'];
const env = { CARD_ISSUANCE_MODE: 'manual', ADMIN_TELEGRAM_IDS: '999', CARD_REMINDER_MINUTES: '0',
  APP_WALLET_TRON: tron.join(','), APP_WALLET_EVM: evm.join(','), FEE_ADDRESS_LEASE_MINUTES: '60', FEE_ADDRESS_COOLDOWN_MINUTES: '60' };
const config = () => loadConfig({ ...process.env, ...env, TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN });
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');

async function client() {
  const user = await registerUser(ctx!);
  const http = api(ctx!, user.token);
  const me = await http.get('/v1/me');
  return { ...user, id: me.body.id as string, http };
}
type Client = Awaited<ReturnType<typeof client>>;
const usdt = async (user: Client) => (await user.http.get('/v1/wallet')).body.balances.find((b: { asset: string }) => b.asset === 'USDT').amount as string;

async function apply(user: Client) {
  const photo = await user.http.post('/v1/kyc/documents', { kind: 'front', mimeType: 'image/png', base64: png });
  return user.http.post('/v1/card-application', { kyc: { firstName: 'Ivan', lastName: 'Petrov', email: 'ivan@test.dev', birthDate: '1990-05-01',
    citizenship: 'KZ', phone: '2025550100', globalCode: '+1', documentType: 'passport', documentCountry: 'KZ', documentIds: { front: photo.body.id } },
    billing: { countryId: 'KZ', postalCode: '050000', address: 'Abay Ave 10' }, asset: 'USDT', idempotencyKey: randomUUID() });
}

// TronGrid answering with confirmed USDT transfers to whichever address is asked.
function tronGrid(rows: { to: string; amount: string; hash: string; at?: number }[]): typeof fetch {
  return (async (url: string) => {
    const address = new URL(url).pathname.split('/')[3];
    return Response.json({ success: true, data: rows.filter(row => row.to === address).map(row => ({ transaction_id: row.hash, type: 'Transfer',
      from: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', to: row.to, value: String(Math.round(Number(row.amount) * 1e6)), block_timestamp: row.at ?? Date.now(),
      token_info: { address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 } })) });
  }) as unknown as typeof fetch;
}

describe('issuance fee on lent app wallet addresses', () => {
  it('saves an unpaid application, then the payment to the lent address sends it to the operator by itself', async () => {
    ctx = await createTestContext(undefined, { env });
    const user = await client();
    const saved = await apply(user);
    expect(saved.status).toBe(202);
    expect(saved.body).toMatchObject({ kyc: { status: 'pending', submissionState: 'manual_review' }, card: null, operation: null });
    expect(await ctx.db.select().from(adminNotifications)).toEqual([]);

    const lease = await user.http.post('/v1/fee-payments', { asset: 'USDT', network: 'TRC20' });
    expect(lease.body).toMatchObject({ status: 'awaiting', amount: '10', received: '0', missing: '10', address: tron[0] });
    expect((await user.http.post('/v1/fee-payments', { asset: 'USDT', network: 'TRC20' })).body.id).toBe(lease.body.id);

    // Nobody is paying on BNB Chain or Ethereum: the watcher reads only Tron, and only the lent address.
    const asked: string[] = [];
    const fetcher = tronGrid([{ to: tron[0]!, amount: '6', hash: 'a'.repeat(64) }]);
    const watcher = new FeePaymentService(ctx.db, config(), (async (url: string) => { asked.push(String(url)); return fetcher(url as never); }) as unknown as typeof fetch);
    watcher.setCreditedHook((tx, input) => ctx!.services.cardApplications.afterFeeCredited(tx, input));
    await watcher.scan();
    expect(asked.every(url => url.includes(`/accounts/${tron[0]}/`))).toBe(true);
    expect((await user.http.get('/v1/fee-payments/current')).body).toMatchObject({ status: 'awaiting', received: '6', missing: '4' });
    expect(await ctx.db.select().from(cardOperations)).toEqual([]);

    const rest = new FeePaymentService(ctx.db, config(), tronGrid([{ to: tron[0]!, amount: '6', hash: 'a'.repeat(64) }, { to: tron[0]!, amount: '4', hash: 'b'.repeat(64) }]));
    rest.setCreditedHook((tx, input) => ctx!.services.cardApplications.afterFeeCredited(tx, input));
    await rest.scan();
    expect((await user.http.get('/v1/fee-payments/current')).body).toMatchObject({ status: 'paid', received: '10' });
    expect(await ctx.db.select({ status: cardOperations.status, fulfillmentMode: cardOperations.fulfillmentMode }).from(cardOperations))
      .toEqual([{ status: 'pending', fulfillmentMode: 'manual' }]);
    expect(await usdt(user)).toBe('0');
    // The history shows both payments with their chain transactions, then the card fee itself.
    const history = (await user.http.get('/v1/activity')).body as { kind: string; amount: string; txHash: string | null; explorerUrl: string | null }[];
    expect(history.filter(item => item.kind === 'deposit').map(({ amount, txHash, explorerUrl }) => ({ amount, txHash, explorerUrl })).sort((a, b) => a.amount.localeCompare(b.amount)))
      .toEqual([{ amount: '+4', txHash: 'b'.repeat(64), explorerUrl: `https://tronscan.org/#/transaction/${'b'.repeat(64)}` },
        { amount: '+6', txHash: 'a'.repeat(64), explorerUrl: `https://tronscan.org/#/transaction/${'a'.repeat(64)}` }]);
    // The card waiting for issue has no last digits yet: its operations are tied to it by card id, other operations to none.
    const [pending] = await ctx.db.select({ cardId: cardOperations.cardId }).from(cardOperations);
    expect(history.find(item => item.kind === 'card_issue')).toMatchObject({ amount: '-10', txHash: null, explorerUrl: null, cardLast4: null, cardId: pending!.cardId });
    expect(history.filter(item => item.kind === 'deposit').every(item => (item as unknown as { cardId: string | null }).cardId === null)).toBe(true);
    await ctx.settle();
    const toClient = ctx.bot.sent.filter(message => message.chatId === String(user.telegramId)).map(message => message.text);
    expect(toClient.some(text => text.includes('не хватает 4 USDT'))).toBe(true);
    expect(toClient.some(text => text.includes('Оплата получена') && text.includes('Ожидайте проверки'))).toBe(true);
    expect(toClient.some(text => /специалист|вручную/i.test(text))).toBe(false);
    expect(ctx.bot.sent.filter(message => message.chatId === '999')).toHaveLength(1);
  });

  it('an approved client with an address on file has the card request moving as soon as the fee arrives', async () => {
    ctx = await createTestContext(undefined, { env });
    const [ready, noAddress] = [await client(), await client()];
    for (const [user, billingAddress] of [[ready, { countryId: 'KZ', countryName: 'Kazakhstan', postalCode: '050000', address: 'Abay Ave 10' }], [noAddress, null]] as const) {
      const values = { status: 'approved' as const, partnerProvider: 'mock', partnerCustomerId: `customer-${user.id.slice(0, 8)}`, submissionId: randomUUID(),
        submissionState: 'submitted', firstName: 'ALMAZ', lastName: 'AZAMATOV', billingAddress };
      await ctx.db.insert(kycProfiles).values({ userId: user.id, ...values }).onConflictDoUpdate({ target: kycProfiles.userId, set: values });
    }
    await ready.http.post('/v1/fee-payments', { asset: 'USDT', network: 'TRC20' });
    await noAddress.http.post('/v1/fee-payments', { asset: 'USDT', network: 'TRC20' });
    const watcher = new FeePaymentService(ctx.db, config(), tronGrid([{ to: tron[0]!, amount: '10', hash: 'e'.repeat(64) }, { to: tron[1]!, amount: '10', hash: 'f'.repeat(64) }]));
    watcher.setCreditedHook((tx, input) => ctx!.services.cardApplications.afterFeeCredited(tx, input));
    await watcher.scan();
    expect(await ctx.db.select({ userId: cardOperations.userId, status: cardOperations.status, fulfillmentMode: cardOperations.fulfillmentMode }).from(cardOperations))
      .toEqual([{ userId: ready.id, status: 'pending', fulfillmentMode: 'manual' }]);
    expect(await usdt(ready)).toBe('0');
    expect(await usdt(noAddress)).toBe('10');
    await ctx.settle();
    expect(ctx.bot.sent.filter(message => message.chatId === '999')).toHaveLength(1);
    expect(ctx.bot.sent.some(message => message.chatId === String(ready.telegramId) && message.text.includes('Ожидайте проверки'))).toBe(true);
    expect(ctx.bot.sent.some(message => message.chatId === String(noAddress.telegramId) && message.text.includes('чтобы продолжить'))).toBe(true);
  });

  it('lends each address to one client at a time and refuses when the pool is busy', async () => {
    ctx = await createTestContext(undefined, { env });
    const [a, b, c] = [await client(), await client(), await client()];
    const first = await a.http.post('/v1/fee-payments', { asset: 'USDT', network: 'BEP20' });
    const second = await b.http.post('/v1/fee-payments', { asset: 'USDC', network: 'POLYGON' });
    expect(first.body.address).toBe(evm[0]);
    expect(second.body.address).toBe(evm[1]);
    const busy = await c.http.post('/v1/fee-payments', { asset: 'USDT', network: 'ERC20' });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('payment_addresses_busy');
    expect((await c.http.post('/v1/fee-payments', { asset: 'USDT', network: 'TRC20' })).body.address).toBe(tron[0]);
    // Switching to another chain of the same family keeps the client's address.
    expect((await a.http.post('/v1/fee-payments', { asset: 'USDT', network: 'ERC20' })).body).toMatchObject({ id: first.body.id, address: evm[0], network: 'ERC20' });
    // A cancelled lease rests for the cooldown before anyone else gets that address.
    await a.http.post('/v1/fee-payments', { asset: 'USDT', network: 'TRC20' });
    expect((await ctx.db.select().from(feePayments).where(eq(feePayments.id, first.body.id)))[0]!.status).toBe('cancelled');
    expect((await c.http.post('/v1/fee-payments', { asset: 'USDT', network: 'BEP20' })).status).toBe(409);
    // The client who just left an address may take it back at once; others wait for the cooldown.
    expect((await a.http.post('/v1/fee-payments', { asset: 'USDT', network: 'BEP20' })).body.address).toBe(evm[0]);
    // By default an address is lent for 10 minutes.
    expect(loadConfig({ ...process.env, TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN }).FEE_ADDRESS_LEASE_MINUTES).toBe(10);
  });

  it('credits a late transfer to the last borrower during the cooldown and leaves unclaimed ones to the operator', async () => {
    ctx = await createTestContext(undefined, { env });
    const user = await client();
    const lease = await user.http.post('/v1/fee-payments', { asset: 'USDT', network: 'TRC20' });
    const lentAt = Date.now() - 3 * 60 * 60_000;
    await ctx.db.update(feePayments).set({ createdAt: new Date(lentAt), expiresAt: new Date(lentAt + 60 * 60_000) }).where(eq(feePayments.id, lease.body.id));
    const watcher = new FeePaymentService(ctx.db, config(), tronGrid([
      { to: tron[0]!, amount: '10', hash: 'c'.repeat(64), at: lentAt + 90 * 60_000 },
      // Sent before anybody borrowed the address: nobody can claim it automatically.
      { to: tron[0]!, amount: '3', hash: 'd'.repeat(64), at: lentAt - 30 * 60_000 },
    ]));
    // The lease expired 2 h ago, so with a 60 min cooldown the watcher has gone back to sleep: nothing is read.
    await watcher.scan();
    expect(await ctx.db.select().from(walletTransfers)).toEqual([]);
    expect((await ctx.db.select().from(feePayments))[0]!.status).toBe('expired');

    await ctx.db.update(feePayments).set({ endedAt: new Date(Date.now() - 30 * 60_000) }).where(eq(feePayments.id, lease.body.id));
    await watcher.scan();
    const rows = await ctx.db.select().from(walletTransfers);
    expect(rows.map(row => [row.txHash[0], row.status]).sort()).toEqual([['c', 'matched'], ['d', 'unmatched']]);
    expect(await usdt(user)).toBe('10');

    const locked = await telegramLogin(ctx, 999);
    await api(ctx, locked.accessToken).post('/v1/security/pin', { pin: TEST_PIN });
    const [admin] = await ctx.db.select().from(users).where(eq(users.telegramId, 999n));
    const [late] = await watcher.unmatched();
    expect(late).toMatchObject({ amount: '3', to: tron[0], status: 'unmatched' });
    await watcher.assign(admin!.id, late!.id, user.id);
    expect(await usdt(user)).toBe('13');
    await expect(watcher.assign(admin!.id, late!.id, user.id)).rejects.toMatchObject({ code: 'validation' });
    expect((await ctx.db.select().from(adminAuditLog)).map(row => row.action)).toEqual(['wallet_transfer_assign']);
  });

  it('does not read any chain while nobody is paying', async () => {
    ctx = await createTestContext(undefined, { env });
    const asked: string[] = [];
    const watcher = new FeePaymentService(ctx.db, config(), (async (url: string) => { asked.push(String(url)); throw new Error('unexpected'); }) as unknown as typeof fetch);
    await watcher.scan();
    await ctx.db.transaction(tx => watcher.enqueueScan(tx));
    expect(asked).toEqual([]);
    expect((await ctx.db.select().from(jobs)).filter(job => job.queue === 'fee_wallet.scan')).toEqual([]);
  });

  it('credits a payment even when its application cannot move on, and a stuck transfer does not hold back the others', async () => {
    ctx = await createTestContext(undefined, { env });
    const first = await client();
    const second = await client();
    await apply(first);
    await apply(second);
    const a = await first.http.post('/v1/fee-payments', { asset: 'USDT', network: 'TRC20' });
    const b = await second.http.post('/v1/fee-payments', { asset: 'USDT', network: 'TRC20' });
    const at = Date.now();
    const db = ctx.db;
    class StuckFirst extends FeePaymentService {
      override async match(transferId: string): Promise<void> {
        const [row] = await db.select().from(walletTransfers).where(eq(walletTransfers.id, transferId));
        if (row?.txHash === 'c'.repeat(64)) throw new Error('stuck transfer');
        return super.match(transferId);
      }
    }
    const watcher = new StuckFirst(ctx.db, config(), tronGrid([{ to: a.body.address, amount: '1', hash: 'c'.repeat(64), at: at - 1000 },
      { to: a.body.address, amount: '10', hash: 'a'.repeat(64), at }, { to: b.body.address, amount: '10', hash: 'b'.repeat(64), at }]));
    watcher.setCreditedHook(async (tx, input) => {
      if (input.userId === first.id) throw new Error('application cannot move now');
      return ctx!.services.cardApplications.afterFeeCredited(tx, input);
    });
    await watcher.scan();

    const transfers = await ctx.db.select({ txHash: walletTransfers.txHash, status: walletTransfers.status }).from(walletTransfers);
    expect(Object.fromEntries(transfers.map(row => [row.txHash[0], row.status]))).toEqual({ c: 'new', a: 'matched', b: 'matched' });
    expect(await usdt(first)).toBe('10');
    expect((await first.http.get('/v1/fee-payments/current')).body).toMatchObject({ status: 'paid', received: '10' });
    expect(await ctx.db.select().from(cardOperations).where(eq(cardOperations.userId, first.id))).toEqual([]);
    expect(await usdt(second)).toBe('0');
    expect(await ctx.db.select({ status: cardOperations.status }).from(cardOperations).where(eq(cardOperations.userId, second.id))).toEqual([{ status: 'pending' }]);

    // The money the first client already has pays for the saved application from the app.
    const paid = await first.http.post('/v1/card-application/pay', { asset: 'USDT' });
    expect(paid.status).toBe(200);
    expect(paid.body.operation).toMatchObject({ status: 'pending' });
    expect(await usdt(first)).toBe('0');
    const again = await first.http.post('/v1/card-application/pay', { asset: 'USDT' });
    expect(again.status).toBe(422);
    expect(await ctx.db.select().from(cardOperations).where(eq(cardOperations.userId, first.id))).toHaveLength(1);
  });

  it('after a partial payment the next address asks only for the rest, and another coin never counts toward a lease', async () => {
    ctx = await createTestContext(undefined, { env });
    const user = await client();
    await apply(user);
    const lease = await user.http.post('/v1/fee-payments', { asset: 'USDT', network: 'TRC20' });
    await ctx.db.update(feePayments).set({ createdAt: new Date(Date.now() - 11 * 60_000), expiresAt: new Date(Date.now() - 1000) }).where(eq(feePayments.id, lease.body.id));
    const watcher = new FeePaymentService(ctx.db, config(), tronGrid([{ to: lease.body.address, amount: '6', hash: 'e'.repeat(64), at: Date.now() - 5000 }]));
    watcher.setCreditedHook((tx, input) => ctx!.services.cardApplications.afterFeeCredited(tx, input));
    await watcher.scan();
    expect((await user.http.get('/v1/fee-payments/current')).body).toMatchObject({ status: 'expired', received: '6', missing: '4' });
    await ctx.settle();
    const notice = ctx.bot.sent.filter(message => message.chatId === String(user.telegramId)).map(message => message.text).find(text => text.includes('не хватает'));
    expect(notice).toContain('не хватает 4 USDT - откройте приложение, чтобы доплатить.');
    const rest = await user.http.post('/v1/fee-payments', { asset: 'USDT', network: 'TRC20' });
    expect(rest.body).toMatchObject({ status: 'awaiting', amount: '4', missing: '4' });

    // 10 USDC sent to a USDT lease: credited and enough for the card in USDC, but the USDT lease stays unpaid.
    const evmLease = await user.http.post('/v1/fee-payments', { asset: 'USDT', network: 'BEP20' });
    const [transfer] = await ctx.db.insert(walletTransfers).values({ network: 'BEP20', asset: 'USDC', txHash: 'f'.repeat(64), fromAddress: evm[1]!,
      toAddress: evmLease.body.address, amount: 10_000_000n, exact: true, blockNumber: 1n, blockTime: new Date() }).returning();
    await watcher.match(transfer!.id);
    expect((await ctx.db.select().from(feePayments).where(eq(feePayments.id, evmLease.body.id)))[0]).toMatchObject({ status: 'awaiting', received: 0n });
    expect(await ctx.db.select({ asset: cardOperations.asset, status: cardOperations.status }).from(cardOperations).where(eq(cardOperations.userId, user.id)))
      .toEqual([{ asset: 'USDC', status: 'pending' }]);
  });

  it('a payment sent before the time ran out but confirmed after it still pays the lease, and the client sees the ended lease', async () => {
    ctx = await createTestContext(undefined, { env });
    const user = await client();
    await apply(user);
    const lease = await user.http.post('/v1/fee-payments', { asset: 'USDT', network: 'TRC20' });
    const sentAt = Date.now() - 2 * 60_000;
    await ctx.db.update(feePayments).set({ createdAt: new Date(sentAt - 60_000), expiresAt: new Date(sentAt + 30_000) }).where(eq(feePayments.id, lease.body.id));
    expect((await user.http.get('/v1/fee-payments/current')).body).toMatchObject({ id: lease.body.id, status: 'expired', secondsLeft: 0 });
    const watcher = new FeePaymentService(ctx.db, config(), tronGrid([{ to: lease.body.address, amount: '10', hash: 'd'.repeat(64), at: sentAt }]));
    watcher.setCreditedHook((tx, input) => ctx!.services.cardApplications.afterFeeCredited(tx, input));
    await watcher.scan();
    expect((await user.http.get('/v1/fee-payments/current')).body).toMatchObject({ id: lease.body.id, status: 'paid', received: '10' });
    expect(await ctx.db.select({ status: cardOperations.status }).from(cardOperations).where(eq(cardOperations.userId, user.id))).toEqual([{ status: 'pending' }]);
  });
});
