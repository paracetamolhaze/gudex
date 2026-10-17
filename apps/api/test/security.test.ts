import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { cards, users } from '../src/db/schema';
import { deriveSecret } from '../src/services/auth';
import { api, createTestContext, makeInitData, registerUser, TEST_BOT_TOKEN, TEST_PIN, telegramLogin, type TestContext } from './helpers';

let ctx: TestContext;
afterEach(async () => {
  await ctx.close();
});

describe('telegram login', () => {
  it('accepts only init data signed with our bot token and not expired', async () => {
    ctx = await createTestContext();
    const forged = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/telegram',
      payload: { initData: makeInitData(42, { botToken: '999:someone-else' }) },
    });
    expect(forged.json().error.code).toBe('telegram_auth_failed');

    const stale = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/telegram',
      payload: { initData: makeInitData(42, { authDate: Math.floor(Date.now() / 1000) - 2 * 24 * 3600 }) },
    });
    expect(stale.json().error.code).toBe('telegram_auth_failed');

    const tampered = makeInitData(42).replace('user42', 'user43');
    const res = await ctx.app.inject({ method: 'POST', url: '/v1/auth/telegram', payload: { initData: tampered } });
    expect(res.json().error.code).toBe('telegram_auth_failed');

    const session = await telegramLogin(ctx, 42);
    expect(session).toMatchObject({ unlocked: false, hasPin: false });
    const me = (await api(ctx, session.accessToken).get('/v1/me')).body;
    expect(me.telegram).toMatchObject({ id: '42', username: 'user42', firstName: 'Ivan' });
    expect(me.locale).toBe('ru');
  });

  it('keeps money endpoints closed until the passcode is entered', async () => {
    ctx = await createTestContext();
    const { telegramId } = await registerUser(ctx);

    const locked = await telegramLogin(ctx, telegramId);
    expect(locked).toMatchObject({ unlocked: false, hasPin: true });
    const client = api(ctx, locked.accessToken);
    expect((await client.get('/v1/wallet')).body.error.code).toBe('unlock_required');
    expect((await client.get('/v1/me')).status).toBe(200);

    const unlocked = await client.post('/v1/security/unlock', { pin: TEST_PIN });
    expect(unlocked.body.unlocked).toBe(true);
    expect((await api(ctx, unlocked.body.accessToken).get('/v1/wallet')).status).toBe(200);
  });
});

describe('passcode', () => {
  it('locks for 15 minutes after five wrong attempts', async () => {
    ctx = await createTestContext();
    const { telegramId } = await registerUser(ctx);
    const client = api(ctx, (await telegramLogin(ctx, telegramId)).accessToken);

    for (let left = 4; left >= 1; left--) {
      const res = await client.post('/v1/security/unlock', { pin: '0000' });
      expect(res.body.error).toMatchObject({ code: 'pin_invalid', attemptsLeft: left });
    }
    const fifth = await client.post('/v1/security/unlock', { pin: '0000' });
    expect(fifth.status).toBe(423);
    expect(fifth.body.error.code).toBe('pin_locked');
    expect(new Date(fifth.body.error.lockedUntil).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    // Даже верный код не проходит, пока блокировка не снята.
    expect((await client.post('/v1/security/unlock', { pin: TEST_PIN })).body.error.code).toBe('pin_locked');
  });

  it('counts concurrent wrong passcodes against the same five-attempt limit', async () => {
    ctx = await createTestContext();
    const { telegramId } = await registerUser(ctx);
    const client = api(ctx, (await telegramLogin(ctx, telegramId)).accessToken);

    const attempts = await Promise.all(Array.from({ length: 20 }, () => client.post('/v1/security/unlock', { pin: '0000' })));
    expect(attempts.filter((result) => result.body.error.code === 'pin_invalid')).toHaveLength(4);
    expect(attempts.filter((result) => result.body.error.code === 'pin_locked')).toHaveLength(16);
    expect((await client.post('/v1/security/unlock', { pin: TEST_PIN })).body.error.code).toBe('pin_locked');
  });

  it('requires the current passcode to change it and accepts simple codes', async () => {
    ctx = await createTestContext();
    const { token } = await registerUser(ctx);
    const client = api(ctx, token);
    expect((await client.post('/v1/security/pin', { pin: '0000' })).body.error.code).toBe('pin_required');
    expect((await client.post('/v1/security/pin', { pin: '0000', currentPin: '9999' })).body.error.code).toBe('pin_invalid');
    const changed = await client.post('/v1/security/pin', { pin: '0000', currentPin: TEST_PIN });
    expect(changed.status).toBe(200);
    expect((await api(ctx, changed.body.accessToken).post('/v1/security/confirm', { pin: '0000' })).status).toBe(200);
  });

  it('revokes previous sessions and action confirmations when the passcode changes', async () => {
    ctx = await createTestContext();
    const { token, telegramId } = await registerUser(ctx);
    const previous = api(ctx, token);
    const locked = api(ctx, (await telegramLogin(ctx, telegramId)).accessToken);
    const confirmation = await previous.post('/v1/security/confirm', { pin: TEST_PIN });

    const changed = await previous.post('/v1/security/pin', { pin: '5555', currentPin: TEST_PIN });
    expect(changed.status).toBe(200);
    expect((await previous.get('/v1/wallet')).body.error.code).toBe('unauthorized');
    expect((await locked.post('/v1/security/unlock', { pin: '5555' })).body.error.code).toBe('unauthorized');
    expect((await previous.post('/v1/security/biometric', { pin: '5555' })).body.error.code).toBe('unauthorized');

    const current = api(ctx, changed.body.accessToken);
    expect((await current.get('/v1/wallet')).status).toBe(200);
    const sensitive = await current.get('/v1/cards/00000000-0000-4000-8000-000000000001/sensitive', {
      'x-confirmation-token': confirmation.body.confirmationToken,
    });
    expect(sensitive.body.error.code).toBe('unlock_required');
    expect((await current.post('/v1/security/confirm', { pin: '5555' })).status).toBe(200);
  });

  it('unlocks with a biometric token until the passcode changes', async () => {
    ctx = await createTestContext();
    const { token, telegramId } = await registerUser(ctx);
    const { biometricToken } = (await api(ctx, token).post('/v1/security/biometric', { pin: TEST_PIN })).body;

    const locked = api(ctx, (await telegramLogin(ctx, telegramId)).accessToken);
    expect((await locked.post('/v1/security/biometric')).body.error.code).toBe('unlock_required');
    const unlocked = await locked.post('/v1/security/unlock', { biometricToken });
    expect(unlocked.body.unlocked).toBe(true);

    await api(ctx, unlocked.body.accessToken).post('/v1/security/pin', { pin: '5555', currentPin: TEST_PIN });
    const again = api(ctx, (await telegramLogin(ctx, telegramId)).accessToken);
    expect((await again.post('/v1/security/unlock', { biometricToken })).body.error.code).toBe('pin_invalid');
  });

  it('requires a fresh credential before creating a biometric unlock token', async () => {
    ctx = await createTestContext();
    const { token, telegramId } = await registerUser(ctx);
    const client = api(ctx, token);

    expect((await client.post('/v1/security/biometric')).status).toBe(400);
    expect((await client.post('/v1/security/biometric', { pin: '0000' })).body.error.code).toBe('pin_invalid');
    const enrolled = await client.post('/v1/security/biometric', { pin: TEST_PIN });
    expect(enrolled.status).toBe(200);

    const locked = api(ctx, (await telegramLogin(ctx, telegramId)).accessToken);
    expect((await locked.post('/v1/security/unlock', { biometricToken: enrolled.body.biometricToken })).body.unlocked).toBe(true);
  });
});

describe('bot', () => {
  it('welcomes on /start, reminds about the card once and rejects foreign webhooks', async () => {
    ctx = await createTestContext();
    const update = { message: { chat: { id: 77 }, from: { id: 77, language_code: 'ru', first_name: 'Ivan' }, text: '/start' } };
    const foreign = await ctx.app.inject({ method: 'POST', url: '/v1/telegram/webhook', payload: update });
    expect(foreign.statusCode).toBe(401);
    expect(ctx.bot.sent).toHaveLength(0);

    const secret = deriveSecret(TEST_BOT_TOKEN, 'gudex:webhook').toString('hex').slice(0, 48);
    const send = (text: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/v1/telegram/webhook',
        payload: { message: { ...update.message, text } },
        headers: { 'x-telegram-bot-api-secret-token': secret },
      });
    expect((await send('/start')).statusCode).toBe(200);
    expect(ctx.bot.sent).toEqual([{ chatId: '77', text: expect.stringContaining('Добро пожаловать в GUDEX') }]);

    await send('привет');
    expect(ctx.bot.sent.at(-1)).toEqual({ chatId: '77', text: expect.stringContaining('в приложении GUDEX') });

    // Карту так и не выпустил — одно напоминание (повторный /start второго не добавит).
    await send('/start');
    await ctx.settle();
    await send('/start');
    await ctx.settle();
    const reminders = ctx.bot.sent.filter((m) => m.text.includes('карта GUDEX почти готова'));
    expect(reminders).toHaveLength(1);
  });

  it('does not remind users who already have a card', async () => {
    ctx = await createTestContext();
    const { telegramId } = await registerUser(ctx);
    const [user] = await ctx.db.select().from(users).where(eq(users.telegramId, BigInt(telegramId)));
    await ctx.db.insert(cards).values({ userId: user!.id, productName: 'GUDEX Visa' });
    await ctx.settle();
    expect(ctx.bot.sent.some((m) => m.text.includes('почти готова'))).toBe(false);
  });
});
