import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TERMS_VERSION } from '@gudex/shared';
import { users } from '../src/db/schema';
import { api, createTestContext, telegramLogin, TEST_PIN, type TestContext } from './helpers';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(async () => { await ctx.close(); });

const kyc = { firstName: 'Ivan', lastName: 'Petrov', birthDate: '1990-05-01', citizenship: 'KZ' };

describe('Terms of Use and Privacy Policy', () => {
  it('are accepted on the first screen and recorded once per version', async () => {
    const locked = await telegramLogin(ctx, 4242);
    const client = api(ctx, locked.accessToken);
    expect((await client.get('/v1/me')).body.termsAccepted).toBe(false);
    expect((await client.post('/v1/me/terms', { version: 'old-version' })).status).toBe(400);

    const accepted = await client.post('/v1/me/terms', { version: TERMS_VERSION });
    expect(accepted.status).toBe(200);
    expect(accepted.body.termsAccepted).toBe(true);
    const [first] = await ctx.db.select().from(users).where(eq(users.telegramId, 4242n));
    expect(first).toMatchObject({ termsVersion: TERMS_VERSION });

    await client.post('/v1/me/terms', { version: TERMS_VERSION });
    const [again] = await ctx.db.select().from(users).where(eq(users.telegramId, 4242n));
    expect(again!.termsAcceptedAt).toEqual(first!.termsAcceptedAt);
  });

  it('are required before documents or a payment are taken', async () => {
    const locked = await telegramLogin(ctx, 4343);
    const unlocked = (await api(ctx, locked.accessToken).post('/v1/security/pin', { pin: TEST_PIN })).body.accessToken as string;
    const client = api(ctx, unlocked);
    const refused = await client.post('/v1/kyc', kyc);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/Terms of Use/);
    expect((await client.post('/v1/card-application/pay', { asset: 'USDT' })).status).toBe(400);

    await client.post('/v1/me/terms', { version: TERMS_VERSION });
    expect((await client.post('/v1/kyc', kyc)).status).toBe(200);
  });
});
