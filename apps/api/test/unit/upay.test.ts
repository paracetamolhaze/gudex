import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config';
import { UpayClient } from '../../src/partner/upay/client';
import type { SessionAccess, UpaySession, UpaySessionStore } from '../../src/partner/upay/session-store';
import { totp } from '../../src/partner/upay/totp';
import { UpayTransport } from '../../src/partner/upay/transport';

const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // RFC 6238 public test seed
const config = () => loadConfig({ DATABASE_URL: 'unused-in-unit-tests', JWT_SECRET: 'unit-test-secret-at-least-16',
  UPAY_LOGIN: 'automation@example.test', UPAY_PASSWORD: 'test-password', UPAY_TOTP_SECRET: seed });

class MemoryStore implements UpaySessionStore {
  value: UpaySession | null = null;
  private pending: Promise<unknown> = Promise.resolve();
  withLock<T>(fn: (access: SessionAccess) => Promise<T>): Promise<T> {
    const result = this.pending.then(() => fn({ get: async () => this.value, set: async session => { this.value = session; } }));
    this.pending = result.catch(() => {});
    return result;
  }
}

function fixture(options: { expireOnce?: boolean; googleState?: number; failGoogle?: boolean; merchantCode?: number; missingPaymentState?: boolean } = {}) {
  const requests: { path: string; method: string; body: any; token: string }[] = [];
  let logins = 0;
  let expired = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.replace('/api/v1', '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path: endpoint, method: init?.method ?? 'GET', body, token: new Headers(init?.headers).get('Token') ?? '' });
    const ok = (data: unknown) => Response.json({ code: 200, data });
    if (endpoint === '/sys/member/login') return ok({ token: `test-session-${++logins}`, googleState: options.googleState ?? 1 });
    if (endpoint === '/sys/member/validateGoogle') return options.failGoogle ? Response.json({ code: 40012 }) : ok({});
    if (endpoint === '/sys/member/loginInfo') return ok(options.missingPaymentState ? { id: 'test-bot' } : { id: 'test-bot', pinCodeSet: true });
    if (endpoint === '/agent/info') {
      if (options.merchantCode) return Response.json({ code: options.merchantCode });
      if (options.expireOnce && !expired) { expired = true; return Response.json({ code: 10020 }); }
      return ok({ merchantNo: 'TEST-MERCHANT', companyName: 'GUDEX test', email: 'private@example.test' });
    }
    if (['/card/list', '/customer/list', '/card/getPageToMayApplyCard'].includes(endpoint)) return ok({ pageNo: 1, pageSize: 20, totalSize: 0, totalPages: 0, list: [] });
    throw new Error('Unexpected endpoint in protocol test');
  };
  const store = new MemoryStore();
  const client = new UpayClient(config(), store, new UpayTransport({ baseUrl: config().UPAY_BASE_URL,
    deviceId: 'WEB-GUDEX-test', timeoutMs: 1000, fetch: fetcher }));
  return { client, store, requests, logins: () => logins };
}

describe('UPay TOTP', () => {
  it.each([[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'],
    [2000000000, '279037'], [20000000000, '353130']] as const)('matches RFC 6238 at %i', (seconds, code) => {
    expect(totp(seed, seconds * 1000)).toBe(code);
  });
  it('accepts a standard authenticator URI and rejects incompatible parameters', () => {
    expect(totp(`otpauth://totp/UPay:bot?secret=${seed}`, 59000)).toBe('287082');
    expect(() => totp(`otpauth://totp/UPay?secret=${seed}&algorithm=SHA256`)).toThrow('SHA1');
    expect(() => totp('123456')).toThrow('format');
  });
});

describe('UPay authentication and reads', () => {
  it('uses the actual panel password transform and completes TOTP before storing the session', async () => {
    const { client, requests, store } = fixture();
    expect(await client.check()).toMatchObject({ authenticated: true, merchant: { merchantNo: 'TEST-MERCHANT', companyName: 'GUDEX test' },
      paymentPasswordSet: true, financialWritesEnabled: false });
    expect(requests[0]!.body).toEqual({ email: 'automation@example.test',
      password: createHash('md5').update('test-passwordbroker-manage').digest('hex') });
    expect(requests[1]!.path).toBe('/sys/member/validateGoogle');
    expect(requests[1]!.body.googleCode).toMatch(/^\d{6}$/);
    expect(store.value?.token).toBe('test-session-1');
    expect(requests.every(r => !r.path.includes('applyOpenCard') && !r.path.includes('recharge'))).toBe(true);
  });
  it('reuses one session for concurrent reads', async () => {
    const { client, logins } = fixture();
    await Promise.all(Array.from({ length: 15 }, () => client.cards()));
    expect(logins()).toBe(1);
  });
  it('reports authentication and individual read access separately for a restricted bot account', async () => {
    const { client } = fixture({ merchantCode: 10003 });
    expect(await client.check()).toMatchObject({ authenticated: true, merchant: null, reads: {
      merchant: { ok: false, code: 10003 }, cards: { ok: true, total: 0 }, customers: { ok: true, total: 0 }, products: { ok: true, total: 0 },
    } });
  });
  it('does not report a missing payment-password status field as an unset password', async () => {
    expect((await fixture({ missingPaymentState: true }).client.check()).paymentPasswordSet).toBeNull();
  });
  it('renews an expired session once and repeats only the read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = Date.UTC(2026, 9, 17);
      vi.setSystemTime(start);
      const { client, requests, logins } = fixture({ expireOnce: true });
      await client.loginInfo();
      vi.setSystemTime(start + 300_000);
      expect((await client.merchant()).merchantNo).toBe('TEST-MERCHANT');
      expect(logins()).toBe(2);
      expect(requests.filter(r => r.path === '/agent/info').map(r => r.token)).toEqual(['test-session-1', 'test-session-2']);
    } finally { vi.useRealTimers(); }
  });
  it('does not store a session after rejected 2FA and never binds a new authenticator automatically', async () => {
    const denied = fixture({ failGoogle: true });
    await expect(denied.client.check()).rejects.toThrow('request rejected');
    expect(denied.store.value).toBeNull();
    const unbound = fixture({ googleState: 2 });
    await expect(unbound.client.check()).rejects.toThrow('Enable Google 2FA');
    expect(unbound.requests.map(r => r.path)).toEqual(['/sys/member/login']);
  });
  it('does not return upstream response bodies or token-bearing error text', async () => {
    const transport = new UpayTransport({ baseUrl: config().UPAY_BASE_URL, deviceId: 'WEB-test', timeoutMs: 1000,
      fetch: async () => Response.json({ code: 123, msg: 'private session-token-and-customer-data' }) });
    await expect(transport.request('GET', '/agent/info')).rejects.toThrow('request rejected (code 123)');
    try { await transport.request('GET', '/agent/info'); } catch (err) { expect(String(err)).not.toContain('private'); }
  });
  it('rejects arbitrary endpoints and redirects instead of sending credentials elsewhere', async () => {
    let invoked = false;
    const transport = new UpayTransport({ baseUrl: config().UPAY_BASE_URL, deviceId: 'WEB-test', timeoutMs: 1000,
      fetch: async (_url, init) => { invoked = true; expect(init?.redirect).toBe('error'); throw new Error('redirected'); } });
    await expect(transport.request('GET', '//attacker.example')).rejects.toThrow('Invalid UPay endpoint');
    expect(invoked).toBe(false);
    await expect(transport.request('GET', '/agent/info')).rejects.toThrow('connection failed');
  });
});
