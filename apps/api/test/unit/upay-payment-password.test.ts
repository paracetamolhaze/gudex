import { createDecipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { UpayClient } from '../../src/partner/upay/client';
import type { SessionAccess, UpaySession, UpaySessionStore } from '../../src/partner/upay/session-store';
import { UpayError, UpayTransport } from '../../src/partner/upay/transport';

const fixturePin = '654321';
const fixtureId = 'fixture-payment-bot';
const fixtureIv = 'fixture-iv-1';

function fixture(options: { pin?: string; pinSet?: boolean; missingIv?: boolean; result?: 'wrong' | 'timeout' | 'expired' | 'false' } = {}) {
  const config = loadConfig({ DATABASE_URL: 'unused-payment-fixture', JWT_SECRET: 'payment-fixture-secret-at-least-32',
    UPAY_LOGIN: 'bot@example.test', UPAY_PASSWORD: 'fixture-only',
    UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', UPAY_PAYMENT_PASSWORD: options.pin ?? fixturePin });
  let session: UpaySession | null = null;
  const store: UpaySessionStore = { withLock: async <T>(fn: (access: SessionAccess) => Promise<T>) => fn({
    get: async () => session, set: async value => { session = value; },
  }) };
  const requests: { endpoint: string; method: string; body: unknown; token: string | null }[] = [];
  const transport = new UpayTransport({ baseUrl: config.UPAY_BASE_URL, deviceId: config.UPAY_DEVICE_ID, timeoutMs: 1000,
    fetch: async (url, init) => {
      const endpoint = new URL(String(url)).pathname.replace('/api/v1', '');
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({ endpoint, method: init?.method ?? 'GET', body, token: new Headers(init?.headers).get('Token') });
      const ok = (data: unknown) => Response.json({ code: 200, data });
      if (endpoint === '/sys/member/login') return ok({ token: 'fixture-session', googleState: 1 });
      if (endpoint === '/sys/member/validateGoogle') return ok({});
      if (endpoint === '/sys/member/loginInfo') return ok({ id: fixtureId, pinCodeSet: options.pinSet ?? true,
        ...(options.missingIv ? {} : { iv: fixtureIv }) });
      if (endpoint !== '/asset/checkPinCode') throw new Error('Unexpected endpoint: no financial call is allowed');
      expect(Object.keys(body!)).toEqual(['pinCode']);
      expect(body!.pinCode).not.toBe(fixturePin);
      const encrypted = Buffer.from(String(body!.pinCode), 'base64');
      const key = Buffer.from(createHash('md5').update(`${fixtureId}broker-manage`).digest('hex'), 'utf8');
      const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(fixtureIv));
      cipher.setAuthTag(encrypted.subarray(-16));
      expect(Buffer.concat([cipher.update(encrypted.subarray(0, -16)), cipher.final()]).toString()).toBe(fixturePin);
      if (options.result === 'timeout') throw new Error('Private upstream timeout text');
      if (options.result === 'wrong') return Response.json({ code: 40123, msg: 'Private payment password details' });
      if (options.result === 'expired') return Response.json({ code: 10020 });
      return ok(options.result === 'false' ? false : null);
    } });
  return { client: new UpayClient(config, store, transport), requests, config };
}

describe('UPay standalone payment password validation', () => {
  it('checks the encrypted PIN without enabling financial writes or calling any financial endpoint', async () => {
    const { client, requests, config } = fixture();
    expect(config.UPAY_WRITES_ENABLED).toBe(false);
    expect(config.UPAY_KYC_ENABLED).toBe(false);
    await expect(client.validatePaymentPassword()).resolves.toEqual({ valid: true });
    expect(requests.filter(request => request.endpoint === '/asset/checkPinCode')).toEqual([
      expect.objectContaining({ method: 'POST', token: 'fixture-session' }),
    ]);
    expect(requests.every(request => ['/sys/member/login', '/sys/member/validateGoogle', '/sys/member/loginInfo', '/asset/checkPinCode'].includes(request.endpoint))).toBe(true);
    expect(requests.filter(request => request.endpoint === '/sys/member/login')).toHaveLength(1);
  });

  it.each(['wrong', 'timeout', 'expired'] as const)('never retries or changes endpoints after %s', async result => {
    const { client, requests } = fixture({ result });
    const error = await client.validatePaymentPassword().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UpayError);
    expect(String(error)).not.toContain('Private');
    expect(requests.filter(request => request.endpoint === '/asset/checkPinCode')).toHaveLength(1);
    expect(requests.filter(request => request.endpoint === '/sys/member/login')).toHaveLength(1);
    expect(requests.every(request => ['/sys/member/login', '/sys/member/validateGoogle', '/sys/member/loginInfo', '/asset/checkPinCode'].includes(request.endpoint))).toBe(true);
  });

  it('does not treat an explicit false validation result as valid', async () => {
    const { client, requests } = fixture({ result: 'false' });
    await expect(client.validatePaymentPassword()).rejects.toBeInstanceOf(UpayError);
    expect(requests.filter(request => request.endpoint === '/asset/checkPinCode')).toHaveLength(1);
  });

  it('refuses malformed local credentials before authentication', async () => {
    const { client, requests } = fixture({ pin: 'invalid' });
    await expect(client.validatePaymentPassword()).rejects.toBeInstanceOf(UpayError);
    expect(requests).toHaveLength(0);
  });

  it.each([{ pinSet: false }, { missingIv: true }])('refuses incomplete remote payment metadata: %j', async options => {
    const { client, requests } = fixture(options);
    await expect(client.validatePaymentPassword()).rejects.toBeInstanceOf(UpayError);
    expect(requests.some(request => request.endpoint === '/asset/checkPinCode')).toBe(false);
  });
});
