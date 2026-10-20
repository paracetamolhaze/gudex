import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, createTestContext, registerUser, telegramLogin, TEST_PIN, type TestContext } from './helpers';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(async () => { await ctx.close(); });

async function admin() {
  const locked = await telegramLogin(ctx, 999);
  const token = (await api(ctx, locked.accessToken).post('/v1/security/pin', { pin: TEST_PIN })).body.accessToken as string;
  return api(ctx, token);
}

const adminNotices = () => ctx.bot.sent.filter(item => item.chatId === '999' && item.text.includes('Новое обращение в поддержку'));

describe('in-app support', () => {
  it('keeps each conversation to its client and tells the operator once per waiting question', async () => {
    const alice = await registerUser(ctx);
    const bob = await registerUser(ctx);
    const a = api(ctx, alice.token), b = api(ctx, bob.token);
    expect((await a.get('/v1/support')).body).toEqual({ status: 'open', unread: false, messages: [] });

    expect((await a.post('/v1/support/messages', { text: '  ' })).status).toBe(400);
    expect((await a.post('/v1/support/messages', { text: 'x'.repeat(2001) })).status).toBe(400);
    const first = await a.post('/v1/support/messages', { text: 'Где моя карта?\r\n\r\n\r\n\r\nСпасибо' });
    expect(first.status).toBe(200);
    expect(first.body.messages).toEqual([expect.objectContaining({ author: 'client', text: 'Где моя карта?\n\nСпасибо' })]);
    await a.post('/v1/support/messages', { text: 'Ещё вопрос' });
    expect((await b.get('/v1/support')).body.messages).toEqual([]);

    await ctx.settle();
    expect(adminNotices()).toHaveLength(1);
    expect(adminNotices()[0]!.text).not.toContain('Где моя карта');
  });

  it('lets only administrators read and answer, without a passcode per answer, and tells the client once', async () => {
    const alice = await registerUser(ctx);
    const a = api(ctx, alice.token);
    await a.post('/v1/support/messages', { text: 'Помогите с оплатой' });
    const userId = (await a.get('/v1/me')).body.id as string;

    expect((await a.get('/v1/admin/support')).status).toBe(403);
    expect((await a.post(`/v1/admin/support/${userId}/messages`, { text: 'hi' })).status).toBe(403);

    const op = await admin();
    const inbox = await op.get('/v1/admin/support');
    expect(inbox.body).toEqual([expect.objectContaining({ userId, unread: true, status: 'open', preview: { author: 'client', text: 'Помогите с оплатой' } })]);
    expect((await op.get(`/v1/admin/support/${userId}`)).body.unread).toBe(false);

    expect((await op.post(`/v1/admin/support/${userId}/messages`, { text: 'Отправьте сумму ещё раз' })).status).toBe(200);
    await op.post(`/v1/admin/support/${userId}/messages`, { text: 'И напишите, когда отправите' });
    // Other admin actions still ask for the passcode confirmation.
    expect([401, 403]).toContain((await op.post(`/v1/admin/clients/${userId}/mail`, { address: 'a@b.test' })).status);

    await ctx.settle();
    const replies = ctx.bot.sent.filter(item => item.chatId === String(alice.telegramId) && item.text.includes('Поддержка GUDEX ответила'));
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).not.toContain('Отправьте сумму');

    expect((await a.get('/v1/me')).body.supportUnread).toBe(true);
    const seen = await a.get('/v1/support');
    expect(seen.body.messages.map((m: { author: string }) => m.author)).toEqual(['client', 'support', 'support']);
    expect((await a.get('/v1/me')).body.supportUnread).toBe(false);
  });

  it('reopens a closed conversation when the client writes again and limits floods', async () => {
    const alice = await registerUser(ctx);
    const a = api(ctx, alice.token);
    await a.post('/v1/support/messages', { text: 'Вопрос' });
    const userId = (await a.get('/v1/me')).body.id as string;
    const op = await admin();
    await op.get(`/v1/admin/support/${userId}`);
    expect((await op.post(`/v1/admin/support/${userId}/status`, { status: 'closed' })).body.status).toBe('closed');
    expect((await op.get('/v1/admin/support')).body).toEqual([]);
    expect((await op.get('/v1/admin/support?status=all')).body).toHaveLength(1);

    expect((await a.post('/v1/support/messages', { text: 'Снова я' })).body.status).toBe('open');
    await ctx.settle();
    expect(adminNotices()).toHaveLength(2);

    for (let index = 0; index < 8; index++) expect((await a.post('/v1/support/messages', { text: `m${index}` })).status).toBe(200);
    const flood = await a.post('/v1/support/messages', { text: 'too many' });
    expect(flood.status).toBe(429);
    expect(flood.body.error.code).toBe('rate_limited');
  });
});
