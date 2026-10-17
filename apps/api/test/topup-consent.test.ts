import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { api, assertLedgerConsistent, createTestContext, registerUser, type TestContext, verifiedUserWithFunds } from './helpers';

let ctx: TestContext;
afterEach(async () => {
  if (!ctx) return;
  await assertLedgerConsistent(ctx.db);
  await ctx.close();
});

it('rejects changed top-up terms through the API without reserving funds, then accepts a reviewed quote exactly once', async () => {
  ctx = await createTestContext();
  const { client } = await verifiedUserWithFunds(ctx, '100');
  const issued = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: randomUUID() });
  expect(issued.status, JSON.stringify(issued.body)).toBe(202);
  await ctx.settle();
  const cardId = issued.body.card.id;
  const quote = await client.get(`/v1/cards/topup-quote?asset=USDT&amount=50&cardId=${cardId}`);
  expect(quote.status).toBe(200);
  const idempotencyKey = randomUUID();
  const rejected = await client.post(`/v1/cards/${cardId}/topup`, {
    asset: 'USDT', amount: '50', idempotencyKey, expectedFee: '0.50', expectedNetUsd: '49.50',
  });
  expect(rejected.status).toBe(409);
  expect(rejected.body.error.code).toBe('quote_changed');
  expect((await client.get('/v1/wallet')).body.balances[0].amount).toBe('90');
  const terms = { asset: 'USDT', amount: '50', idempotencyKey, expectedFee: quote.body.fee, expectedNetUsd: quote.body.netUsd };
  const accepted = await client.post(`/v1/cards/${cardId}/topup`, terms);
  expect(accepted.status).toBe(202);
  const replay = await client.post(`/v1/cards/${cardId}/topup`, terms);
  expect(replay.body.id).toBe(accepted.body.id);
  expect((await client.get('/v1/wallet')).body.balances[0].amount).toBe('40');
  await ctx.settle();
  expect((await client.get(`/v1/cards/${cardId}`)).body.balance).toBe('49.25');
  const stranger = api(ctx, (await registerUser(ctx)).token);
  expect((await stranger.get(`/v1/cards/topup-quote?asset=USDT&amount=50&cardId=${cardId}`)).status).toBe(404);
});
