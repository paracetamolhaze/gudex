import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { Services } from '../../src/app';
import type { Config } from '../../src/config';
import type { Db } from '../../src/db/client';
import type { DbKycDocumentStore } from '../../src/kyc/document-store';
import { AppError } from '../../src/lib/errors';
import { codeContext, extractCode, htmlToText } from '../../src/mail/extract-code';
import { mailRoutes } from '../../src/routes/mail';
import { KycService, type KycInput } from '../../src/services/kyc';
import { MailService, normalizeMailAddress, suggestMailAddress } from '../../src/services/mail';
import { LogBotApi } from '../../src/telegram/bot';
import { type Env, handleEmail, handleQueue, sign } from '../../../../infra/mail-worker/src/index';

const SECRET = 'synthetic-mail-inbound-secret-0123456789';
const service = (overrides: Partial<Config> = {}) => new MailService({} as Db,
  { appSecret: 'synthetic-app-secret', MAIL_DOMAIN: 'mail.gudex.test', MAIL_INBOUND_SECRET: SECRET, ...overrides } as Config, new LogBotApi());

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('confirmation code extraction', () => {
  it.each([
    ['Your verification code is 482913.', '482913'],
    ['Ваш код подтверждения: 5521', '5521'],
    ['Code: A7K2Q9 — valid for 10 minutes', 'A7K2Q9'],
    ['Never share it. 739104 is your one-time password', '739104'],
    ['Your order 12345678 is ready. Verification code 4821', '4821'],
    ['Card **** 1234 payment of $1500.00 on 2026-10-19 14:32. Your code: 998877', '998877'],
    ['© 2026 UPay. Your security code is 310577', '310577'],
  ])('finds the one code in %j', (text, code) => {
    expect(extractCode({ text })).toBe(code);
  });

  it.each([
    'Your balance is 12345 USD',
    'Payment code 100.50 USD',
    'Verification on 19.10.2026 at 14:32',
    'Code 111111 or code 222222',
    'Call +7 701 123 4567 about the verification',
    'Your verification code for card ••4567 is pending',
    'Order number 99887766, code sent separately',
  ])('does not guess a code in %j', text => {
    expect(extractCode({ text })).toBeNull();
  });

  it('reads HTML when there is no plain text and ignores styles, scripts and entities', () => {
    const html = '<html><head><style>.a{width:123456px}</style></head><body><table><tr><td>Your verification code</td></tr>'
      + '<tr><td><b>&#56;41&#x32;07</b></td></tr></table><script>var x = 777777;</script><p>&copy; 2026</p></body></html>';
    expect(htmlToText(html)).toContain('841207');
    expect(extractCode({ html })).toBe('841207');
  });

  it('reads the UPay 3DS letter: the code, the card digits and how long it lives', () => {
    const letter = { subject: '3DS Verification', html: '<h2>3DS Verification</h2><p>Your card number ends with 4466********1175. The binding process has been '
      + 'initiated. Your OTP (one-time password) is as follows: 378346. This OTP will expire in 2 minutes.</p><p>Thank you for choosing UPay!</p>' };
    expect(extractCode(letter)).toBe('378346');
    expect(codeContext(letter)).toEqual({ threeDs: true, last4: '1175', minutes: 2 });
    expect(codeContext({ text: 'Ваш код подтверждения 5521, действует 5 мин.' })).toEqual({ threeDs: false, last4: null, minutes: 5 });
  });

  it('finds a code in the subject and survives broken input', () => {
    expect(extractCode({ subject: '612345 — код подтверждения UPay', text: '' })).toBe('612345');
    expect(extractCode({ html: '<<<>>>&#99999999;&#xD800;<div' })).toBeNull();
    expect(extractCode({ text: 'code '.repeat(20_000) + '123456' })).toBeNull();
  });
});

describe('client mail addresses', () => {
  it('accepts only clean lowercase addresses on the configured domain', () => {
    expect(normalizeMailAddress(' C7k3M9q2@Mail.Gudex.Test ', 'mail.gudex.test')).toBe('c7k3m9q2@mail.gudex.test');
    expect(normalizeMailAddress('client@other.test', 'mail.gudex.test')).toBeNull();
    for (const value of ['a+b@mail.gudex.test', '.a@mail.gudex.test', 'a..b@mail.gudex.test', 'a@b', '@mail.gudex.test', 'a b@mail.gudex.test']) {
      expect(normalizeMailAddress(value, 'mail.gudex.test'), value).toBeNull();
    }
    expect(normalizeMailAddress('client@other.test')).toBe('client@other.test');
  });

  it('suggests unguessable addresses on the domain', () => {
    const values = new Set(Array.from({ length: 50 }, () => suggestMailAddress('mail.gudex.test')));
    expect(values.size).toBe(50);
    for (const value of values) expect(value).toMatch(/^c[a-z2-9]{7}@mail\.gudex\.test$/);
  });
});

describe('signed letters from the mail Worker', () => {
  it('accepts the Worker signature and refuses forged, replayed or unconfigured requests', async () => {
    const body = JSON.stringify({ from: 'noreply@upay.test', to: 'c1@mail.gudex.test', rawSize: 1 });
    const now = Date.now(), timestamp = String(Math.floor(now / 1000));
    const signature = await sign(SECRET, timestamp, body);
    expect(() => service().verify(timestamp, signature, body, now)).not.toThrow();
    expect(() => service().verify(timestamp, signature, `${body} `, now)).toThrow(AppError);
    expect(() => service().verify(timestamp, signature.replace(/.$/, c => (c === '0' ? '1' : '0')), body, now)).toThrow(AppError);
    expect(() => service().verify(timestamp, signature, body, now + 6 * 60_000)).toThrow(/Stale/);
    expect(() => service().verify(undefined, signature, body, now)).toThrow(/Stale/);
    expect(() => service({ MAIL_INBOUND_SECRET: undefined }).verify(timestamp, signature, body, now)).toThrow(/not configured/);
  });

  it('checks the signature on the exact body before reading it', async () => {
    const receive = vi.fn(async () => ({ result: 'accepted' as const }));
    const mail = service();
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.status(error instanceof AppError ? error.status : 500).send({ error: (error as Error).message }));
    await app.register(mailRoutes({ mail: { verify: mail.verify.bind(mail), receive } } as unknown as Services), { prefix: '/v1/mail' });
    try {
      const payload = JSON.stringify({ from: 'noreply@upay.test', to: 'c1@mail.gudex.test', rawSize: 3, raw: 'YWJj' });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const good = await app.inject({ method: 'POST', url: '/v1/mail/inbound', payload,
        headers: { 'content-type': 'application/json', 'x-gudex-timestamp': timestamp, 'x-gudex-signature': await sign(SECRET, timestamp, payload) } });
      expect(good.statusCode, good.body).toBe(200);
      expect(receive).toHaveBeenCalledWith({ from: 'noreply@upay.test', to: 'c1@mail.gudex.test', rawSize: 3, raw: 'YWJj' });
      const forged = await app.inject({ method: 'POST', url: '/v1/mail/inbound', payload,
        headers: { 'content-type': 'application/json', 'x-gudex-timestamp': timestamp, 'x-gudex-signature': '0'.repeat(64) } });
      expect(forged.statusCode).toBe(401);
      expect(receive).toHaveBeenCalledOnce();
      // A database timeout is a 5xx: the Worker keeps the letter in its retry queue.
      receive.mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'));
      const retryLater = await app.inject({ method: 'POST', url: '/v1/mail/inbound', payload,
        headers: { 'content-type': 'application/json', 'x-gudex-timestamp': timestamp, 'x-gudex-signature': await sign(SECRET, timestamp, payload) } });
      expect(retryLater.statusCode).toBe(500);
      const invalid = JSON.stringify({ from: 'x', to: 'c1@mail.gudex.test', rawSize: 1, raw: 'not base64!', extra: true });
      const rejected = await app.inject({ method: 'POST', url: '/v1/mail/inbound', payload: invalid,
        headers: { 'content-type': 'application/json', 'x-gudex-timestamp': timestamp, 'x-gudex-signature': await sign(SECRET, timestamp, invalid) } });
      expect(rejected.statusCode).toBe(400);
    } finally { await app.close(); }
  });
});

function letter(raw: string, overrides: Record<string, unknown> = {}) {
  const bytes = new TextEncoder().encode(raw);
  const setReject = vi.fn();
  return { setReject, message: { from: 'bounce@upay.test', to: 'c1@mail.gudex.test', rawSize: bytes.length, setReject,
    headers: new Headers({ 'message-id': '<m1@upay.test>', subject: 'Code', date: 'Mon, 19 Oct 2026 10:00:00 +0000' }),
    raw: new Response(bytes).body!, ...overrides } };
}

describe('mail Worker', () => {
  const env = (queue = vi.fn(async (_body: string) => {})): Env & { queue: typeof queue } => ({ API_URL: 'https://api.gudex.test/v1/mail/inbound', MAIL_INBOUND_SECRET: SECRET,
    RETRY_QUEUE: { send: queue }, queue });

  it('posts a signed letter the API accepts and bounces unknown recipients', async () => {
    const seen: { body: string; headers: Headers }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push({ body: String(init.body), headers: new Headers(init.headers) });
      return Response.json({ result: 'reject' });
    }));
    const { message, setReject } = letter('Subject: Code\r\n\r\nYour code is 123456');
    await handleEmail(message as never, env());
    expect(setReject).toHaveBeenCalledWith('Unknown recipient');
    const sent = JSON.parse(seen[0]!.body);
    expect(Buffer.from(sent.raw, 'base64').toString()).toContain('123456');
    expect(sent).toMatchObject({ from: 'bounce@upay.test', to: 'c1@mail.gudex.test', messageId: '<m1@upay.test>', subject: 'Code' });
    expect(() => service().verify(seen[0]!.headers.get('x-gudex-timestamp')!, seen[0]!.headers.get('x-gudex-signature')!, seen[0]!.body)).not.toThrow();
  });

  it('keeps the letter in the retry queue while the API is down, without the body when it is too big for a queue message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const small = env();
    await handleEmail(letter('Your code is 123456').message as never, small);
    expect(small.queue).toHaveBeenCalledOnce();
    expect(JSON.parse(String(small.queue.mock.calls[0]![0])).raw).toBeTruthy();
    const big = env();
    await handleEmail(letter(`Your code is 123456 ${'x'.repeat(200_000)}`).message as never, big);
    const queued = JSON.parse(String(big.queue.mock.calls[0]![0]));
    expect(queued.raw).toBeUndefined();
    expect(queued.rawSize).toBeGreaterThan(200_000);
  });

  it('acks delivered or unrecoverable queue messages and retries the rest with growing pauses', async () => {
    const statuses = [200, 400, 503, 401];
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: statuses.shift()! })));
    const messages = [0, 1, 2, 3].map(attempts => ({ body: '{}', attempts, ack: vi.fn(), retry: vi.fn() }));
    await handleQueue({ messages }, env());
    expect(messages.map(item => item.ack.mock.calls.length)).toEqual([1, 1, 0, 0]);
    expect(messages[2]!.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(messages[3]!.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
  });
});

describe('verification without a client email', () => {
  const identity: KycInput = { firstName: 'ANNE', lastName: 'NEIL', birthDate: '1990-01-01', citizenship: 'KZ',
    phone: '7771234567', globalCode: '+7', documentType: 'id_card', documentCountry: 'KZ', documentIds: { front: 'front', back: 'back' } };
  const kyc = (options: object) => new KycService({} as Db, {} as never, 2, {} as DbKycDocumentStore, { live: true, enabled: true, requireSelfie: false, ...options });

  it('needs no email with manual issuance and uses the mail domain for automatic verification', async () => {
    await expect(kyc({ manual: true }).validateSubmission(identity)).resolves.toBeUndefined();
    await expect(kyc({ mailDomain: 'mail.gudex.test' }).validateSubmission(identity)).resolves.toBeUndefined();
    await expect(kyc({}).validateSubmission(identity)).rejects.toMatchObject({ code: 'validation' });
  });
});
