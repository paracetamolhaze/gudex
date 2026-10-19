import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inboundEmails, users } from '../src/db/schema';
import { TelegramApiError } from '../src/telegram/bot';
import { api, createTestContext, registerUser, telegramLogin, TEST_PIN, type TestContext } from './helpers';

const SECRET = 'synthetic-mail-inbound-secret-0123456789';
const DOMAIN = 'mail.gudex.test';
let ctx: TestContext;
let messageNo = 0;

beforeEach(async () => { ctx = await createTestContext(undefined, { env: { MAIL_DOMAIN: DOMAIN, MAIL_INBOUND_SECRET: SECRET, CARD_REMINDER_MINUTES: '0' } }); });
afterEach(async () => { await ctx.close(); vi.restoreAllMocks(); });

function mime(body: string, options: { from?: string; subject?: string; date?: Date; messageId?: string; to?: string } = {}) {
  return [`From: UPay <${options.from ?? 'noreply@upay.test'}>`, `To: ${options.to ?? `c1@${DOMAIN}`}`, `Subject: ${options.subject ?? 'Verification'}`,
    `Message-ID: <${options.messageId ?? `m${++messageNo}`}@upay.test>`, `Date: ${(options.date ?? new Date()).toUTCString()}`,
    'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
}

async function deliver(raw: string, letter: { to?: string; from?: string } = {}, secret = SECRET) {
  const payload = JSON.stringify({ from: letter.from ?? 'bounce@upay.test', to: letter.to ?? `c1@${DOMAIN}`, rawSize: raw.length,
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
  await ctx.services.mail.addSender(admin!.id, { pattern: 'upay.test', label: 'UPay' });
  return { admin: admin!, owner: owner!, client };
}

const rows = () => ctx.db.select().from(inboundEmails);

describe('client mail codes', () => {
  it('sends an allowed code only to the owner, once, and keeps no readable code', async () => {
    const { client } = await setup();
    const raw = mime('Your verification code is 482913.');
    expect(await deliver(raw)).toEqual({ status: 200, body: { result: 'accepted' } });
    const [queued] = await rows();
    expect(JSON.stringify(queued)).not.toContain('482913');
    const jobs = await ctx.db.execute(sql`select payload::text as payload from jobs`);
    expect(JSON.stringify(jobs.rows)).not.toContain('482913');
    await ctx.settle();
    const codes = ctx.bot.sent.filter(item => item.text.includes('482913'));
    expect(codes).toEqual([{ chatId: String(client.telegramId), text: expect.stringContaining('Код от UPay') }]);
    expect((await rows())[0]).toMatchObject({ status: 'delivered', hasCode: true, codeCiphertext: null, codeIv: null, codeTag: null });

    // The Worker may post the same letter twice (direct post and its retry queue).
    expect(await deliver(raw)).toEqual({ status: 200, body: { result: 'duplicate' } });
    await ctx.settle();
    expect(ctx.bot.sent.filter(item => item.text.includes('482913'))).toHaveLength(1);
  });

  it('bounces unknown recipients and refuses forged posts without storing anything', async () => {
    await setup();
    expect(await deliver(mime('Your code is 111222', { to: `nobody@${DOMAIN}` }), { to: `nobody@${DOMAIN}` })).toEqual({ status: 200, body: { result: 'reject' } });
    expect(await deliver(mime('Your code is 111222'), { to: 'c1@other.test' })).toEqual({ status: 200, body: { result: 'reject' } });
    expect((await deliver(mime('Your code is 111222'), {}, 'forged-secret-forged-secret-forged-secret')).status).toBe(401);
    expect(await rows()).toEqual([]);
  });

  it('keeps letters from senders that are not allowed away from the client', async () => {
    await setup();
    const sent = ctx.bot.sent.length;
    expect((await deliver(mime('Your code is 777888', { from: 'promo@shop.test', subject: 'Order 12345678 code 777888' }))).body.result).toBe('accepted');
    await ctx.settle();
    expect(ctx.bot.sent.length).toBe(sent);
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'unknown_sender', sender: 'promo@shop.test', hasCode: false, subject: 'Order •••••••• code ••••••' });
  });

  it('tells the owner about a letter whose code is uncertain or whose MIME is broken, without guessing a code', async () => {
    const { client } = await setup();
    await deliver(mime('Your code 111111 or maybe 222222'));
    await deliver('\u0000\u0001 not a letter at all \r\n--', { from: 'noreply@upay.test' });
    await ctx.settle();
    const notices = ctx.bot.sent.filter(item => item.chatId === String(client.telegramId) && item.text.includes('Новое письмо от UPay'));
    expect(notices).toHaveLength(2);
    expect(notices.map(item => item.text).join()).not.toMatch(/111111|222222/);
  });

  it('skips stale letters, expired codes and floods', async () => {
    const { client } = await setup();
    await deliver(mime('Your code is 101010', { date: new Date(Date.now() - 2 * 3600_000) }));
    expect((await rows())[0]!.status).toBe('stale');
    await deliver(mime('Your code is 202020'));
    await ctx.db.update(inboundEmails).set({ codeExpiresAt: new Date(Date.now() - 1000) }).where(eq(inboundEmails.status, 'queued'));
    await ctx.settle();
    expect((await rows()).find(row => row.status === 'expired')).toMatchObject({ codeCiphertext: null });
    expect(ctx.bot.sent.some(item => /101010|202020/.test(item.text))).toBe(false);
    for (let index = 0; index < 11; index++) await deliver(mime(`Your code is ${300000 + index}`));
    const statuses = (await rows()).map(row => row.status);
    expect(statuses.filter(status => status === 'rate_limited')).toHaveLength(1);
    await ctx.settle();
    expect(ctx.bot.sent.filter(item => item.chatId === String(client.telegramId) && item.text.includes('Код от UPay'))).toHaveLength(10);
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

  it('lets only administrators see letters or change mail settings, and never gives one address to two clients', async () => {
    const { admin, owner } = await setup();
    const outsider = await registerUser(ctx);
    for (const [method, url] of [['GET', '/v1/admin/mail'], ['POST', '/v1/admin/mail/senders'], ['POST', `/v1/admin/clients/${owner.id}/mail`]] as const) {
      const response = method === 'GET' ? await api(ctx, outsider.token).get(url) : await api(ctx, outsider.token).post(url, { pattern: 'evil.test', label: 'X', address: `x@${DOMAIN}` });
      expect(response.status, url).toBe(403);
    }
    const [other] = await ctx.db.select().from(users).where(eq(users.telegramId, BigInt(outsider.telegramId)));
    await expect(ctx.services.mail.setClientAddress(admin.id, other!.id, `c1@${DOMAIN}`)).rejects.toMatchObject({ code: 'validation' });
    await expect(ctx.services.mail.setClientAddress(admin.id, other!.id, 'c2@other.test')).rejects.toMatchObject({ code: 'validation' });
    const login = await telegramLogin(ctx, 999);
    const adminToken = (await api(ctx, login.accessToken).post('/v1/security/pin', { pin: TEST_PIN })).body.accessToken as string;
    const overview = await api(ctx, adminToken).get('/v1/admin/mail');
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({ domain: DOMAIN, configured: true, senders: [{ pattern: 'upay.test', label: 'UPay' }] });
  });
});
