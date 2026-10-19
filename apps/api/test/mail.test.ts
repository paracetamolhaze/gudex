import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inboundEmails, users } from '../src/db/schema';
import { TelegramApiError } from '../src/telegram/bot';
import { api, createTestContext, registerUser, type TestContext } from './helpers';

const SECRET = 'synthetic-mail-inbound-secret-0123456789';
const DOMAIN = 'mail.gudex.test';
let ctx: TestContext;
let messageNo = 0;

beforeEach(async () => {
  ctx = await createTestContext(undefined, { env: { MAIL_DOMAIN: DOMAIN, MAIL_INBOUND_SECRET: SECRET, MAIL_ALLOWED_SENDERS: 'upay.test', CARD_REMINDER_MINUTES: '0' } });
});
afterEach(async () => { await ctx.close(); vi.restoreAllMocks(); });

function mime(body: string, options: { from?: string; subject?: string; date?: Date; messageId?: string; to?: string } = {}) {
  return [`From: UPay <${options.from ?? 'noreply@upay.test'}>`, `To: ${options.to ?? `c1@${DOMAIN}`}`, `Subject: ${options.subject ?? 'Verification'}`,
    `Message-ID: <${options.messageId ?? `m${++messageNo}`}@upay.test>`, `Date: ${(options.date ?? new Date()).toUTCString()}`,
    'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
}

async function deliver(raw: string, letter: { to?: string; from?: string } = {}, secret = SECRET) {
  const payload = JSON.stringify({ from: letter.from ?? 'bounce@amazonses.test', to: letter.to ?? `c1@${DOMAIN}`, rawSize: raw.length,
    raw: Buffer.from(raw).toString('base64') });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await ctx.app.inject({ method: 'POST', url: '/v1/mail/inbound', payload, headers: { 'content-type': 'application/json',
    'x-gudex-timestamp': timestamp, 'x-gudex-signature': createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex') } });
  return { status: response.statusCode, body: response.json() as { result?: string } };
}

async function setup() {
  const [admin] = await ctx.db.insert(users).values({ telegramId: 999n }).returning();
  const client = await registerUser(ctx);
  const [owner] = await ctx.db.select().from(users).where(eq(users.telegramId, BigInt(client.telegramId)));
  await ctx.services.mail.setClientAddress(admin!.id, owner!.id, `c1@${DOMAIN}`);
  return { admin: admin!, owner: owner!, client };
}

const rows = () => ctx.db.select().from(inboundEmails);
const codes = (telegramId: number) => ctx.bot.sent.filter(item => item.chatId === String(telegramId) && item.text.includes('<code>'));

describe('client mail codes', () => {
  it('sends a UPay 3DS code only to the owner, once, and keeps no readable code', async () => {
    const { client } = await setup();
    const raw = mime(['3DS Verification', 'Your card number ends with 4466********1175. The binding process has been initiated.',
      'Your OTP (one-time password) is as follows: 378346. This OTP will expire in 2 minutes.'].join('\r\n'), { subject: '3DS Verification' });
    expect(await deliver(raw)).toEqual({ status: 200, body: { result: 'accepted' } });
    const [queued] = await rows();
    expect(JSON.stringify(queued)).not.toContain('378346');
    const jobs = await ctx.db.execute(sql`select payload::text as payload from jobs`);
    expect(JSON.stringify(jobs.rows)).not.toContain('378346');
    await ctx.settle();
    expect(codes(client.telegramId)).toEqual([{ chatId: String(client.telegramId),
      text: '🔐 <b>Код 3DS</b>: <code>378346</code>\nКарта •• 1175 · действует 2 мин.\nНикому не сообщайте этот код.' }]);
    expect((await rows())[0]).toMatchObject({ status: 'delivered', hasCode: true, codeCiphertext: null, codeIv: null, codeTag: null });

    // The Worker may post the same letter twice (direct post and its retry queue).
    expect(await deliver(raw)).toEqual({ status: 200, body: { result: 'duplicate' } });
    await ctx.settle();
    expect(codes(client.telegramId)).toHaveLength(1);
  });

  it('bounces unknown recipients and refuses forged posts without storing anything', async () => {
    await setup();
    expect(await deliver(mime('Your code is 111222', { to: `nobody@${DOMAIN}` }), { to: `nobody@${DOMAIN}` })).toEqual({ status: 200, body: { result: 'reject' } });
    expect(await deliver(mime('Your code is 111222'), { to: 'c1@other.test' })).toEqual({ status: 200, body: { result: 'reject' } });
    expect((await deliver(mime('Your code is 111222'), {}, 'forged-secret-forged-secret-forged-secret')).status).toBe(401);
    expect(await rows()).toEqual([]);
  });

  it('forwards nothing but codes from UPay', async () => {
    const { client } = await setup();
    const sent = ctx.bot.sent.length;
    await deliver(mime('Your code is 777888', { from: 'promo@shop.test', subject: 'Order 12345678 code 777888' }));
    await deliver(mime('Welcome to UPay! Your account is ready.'));
    await deliver(mime('Your code 111111 or maybe 222222'));
    await deliver('\u0000\u0001 not a letter at all \r\n--', { from: 'noreply@upay.test' });
    await ctx.settle();
    expect(ctx.bot.sent.length).toBe(sent);
    expect(codes(client.telegramId)).toEqual([]);
    const stored = await rows();
    expect(stored.map(row => row.status).sort()).toEqual(['no_code', 'no_code', 'no_code', 'unknown_sender']);
    expect(stored.find(row => row.status === 'unknown_sender')).toMatchObject({ sender: 'promo@shop.test', hasCode: false, subject: 'Order •••••••• code ••••••' });
  });

  it('skips stale letters, expired codes and floods', async () => {
    const { client } = await setup();
    await deliver(mime('Your code is 101010', { date: new Date(Date.now() - 2 * 3600_000) }));
    expect((await rows())[0]!.status).toBe('stale');
    await deliver(mime('Your code is 202020'));
    await ctx.db.update(inboundEmails).set({ codeExpiresAt: new Date(Date.now() - 1000) }).where(eq(inboundEmails.status, 'queued'));
    await ctx.settle();
    expect((await rows()).find(row => row.status === 'expired')).toMatchObject({ codeCiphertext: null });
    // A code that lives 2 minutes, delivered 4 minutes after the letter was sent, is not sent as still valid.
    await deliver(mime('Your OTP is 303030. This OTP will expire in 2 minutes.', { date: new Date(Date.now() - 4 * 60_000) }));
    await ctx.settle();
    expect((await rows()).filter(row => row.status === 'expired')).toHaveLength(2);
    expect(ctx.bot.sent.some(item => /101010|202020|303030/.test(item.text))).toBe(false);
    for (let index = 0; index < 11; index++) await deliver(mime(`Your code is ${300000 + index}`));
    const statuses = (await rows()).map(row => row.status);
    expect(statuses.filter(status => status === 'rate_limited')).toHaveLength(1);
    await ctx.settle();
    expect(codes(client.telegramId)).toHaveLength(10);
    expect(codes(client.telegramId)[0]!.text).toContain('Код подтверждения');
  });

  it('retries while Telegram is unavailable and gives up when the client blocked the bot', async () => {
    await setup();
    const send = vi.spyOn(ctx.bot, 'sendMessage').mockRejectedValueOnce(new Error('fetch failed'));
    await deliver(mime('Your code is 404040'));
    await ctx.settle();
    expect(send).toHaveBeenCalledTimes(2);
    expect((await rows())[0]!.status).toBe('delivered');
    send.mockRejectedValue(new TelegramApiError('sendMessage', 'Forbidden: bot was blocked by the user', 403));
    await deliver(mime('Your code is 505050'));
    await ctx.settle();
    expect((await rows()).find(row => row.status === 'failed')).toMatchObject({ codeCiphertext: null, error: expect.stringContaining('blocked') });
  });

  it('lets only administrators bind a mail address and never gives one address to two clients', async () => {
    const { admin, owner } = await setup();
    const outsider = await registerUser(ctx);
    const response = await api(ctx, outsider.token).post(`/v1/admin/clients/${owner.id}/mail`, { address: `x@${DOMAIN}` });
    expect(response.status).toBe(403);
    const [other] = await ctx.db.select().from(users).where(eq(users.telegramId, BigInt(outsider.telegramId)));
    await expect(ctx.services.mail.setClientAddress(admin.id, other!.id, `c1@${DOMAIN}`)).rejects.toMatchObject({ code: 'validation' });
    await expect(ctx.services.mail.setClientAddress(admin.id, other!.id, 'c2@other.test')).rejects.toMatchObject({ code: 'validation' });
    await ctx.services.mail.setClientAddress(admin.id, other!.id, `any.name-2@${DOMAIN}`);
    expect((await ctx.services.manualAdmin.client(admin.id, other!.id)).mail).toMatchObject({ address: `any.name-2@${DOMAIN}`, domain: DOMAIN });
  });
});
