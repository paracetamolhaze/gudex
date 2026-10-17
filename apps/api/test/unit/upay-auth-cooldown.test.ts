import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config';
import { UpayClient } from '../../src/partner/upay/client';
import type { SessionAccess, UpaySession, UpaySessionStore } from '../../src/partner/upay/session-store';
import { UpayError, UpayTransport } from '../../src/partner/upay/transport';

interface AuthAttempt { fingerprint: string; retryAfter: number; }
type SharedAccess = SessionAccess & {
  getAuthAttempt(): Promise<AuthAttempt | null>;
  setAuthAttempt(attempt: AuthAttempt | null): Promise<void>;
};
const START = Date.UTC(2026, 9, 17, 0, 0, 0);

function fixture(mode: 'stable' | 'password_rejected' | 'totp_rejected' | 'invalid_login_session' | 'invalid_cached_session' = 'stable') {
  const config = loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'local-auth-cooldown-fixture-secret',
    UPAY_LOGIN: 'PRIVATE-login@example.test', UPAY_PASSWORD: 'PRIVATE-password', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ',
    UPAY_SESSION_TTL_SECONDS: '3600', UPAY_WRITES_ENABLED: 'true', UPAY_PAYMENT_PASSWORD: '123456' });
  let session: UpaySession | null = null, attempt: AuthAttempt | null = null, tail: Promise<unknown> = Promise.resolve();
  const access: SharedAccess = {
    get: async () => session ? structuredClone(session) : null,
    set: async value => { session = value ? structuredClone(value) : null; },
    getAuthAttempt: async () => attempt ? structuredClone(attempt) : null,
    setAuthAttempt: async value => { attempt = value ? structuredClone(value) : null; },
  };
  const store: UpaySessionStore = { withLock: fn => {
    const result = tail.then(() => fn(access));
    tail = result.then(() => undefined, () => undefined);
    return result;
  } };
  const calls: Array<{ path: string; method: string; at: number }> = [];
  let financialOutcome: 'session_expired' | 'business_rejected' | 'network' = 'session_expired';
  const transport = new UpayTransport({ baseUrl: 'https://fixture.invalid/api/v1', deviceId: 'WEB-local-unit-fixture', timeoutMs: 1000,
    fetch: async (url, options) => {
      const path = new URL(String(url)).pathname.replace('/api/v1', '');
      calls.push({ path, method: options?.method ?? 'GET', at: Date.now() });
      const ok = (data: unknown) => Response.json({ code: 200, data });
      const rejected = (code = 10003) => Response.json({ code, msg: 'PRIVATE upstream authentication context' });
      if (path === '/sys/member/login') return mode === 'password_rejected' ? rejected() : ok({ token: `PRIVATE-token-${calls.length}`, googleState: 1 });
      if (path === '/sys/member/validateGoogle') return mode === 'totp_rejected' ? rejected() : ok({});
      if (path === '/sys/member/loginInfo') return mode === 'invalid_login_session' ? rejected(10020) : ok({ id: 'fixture-member' });
      if (path === '/agent/info') return mode === 'invalid_cached_session' ? rejected(10020) : ok({});
      if (path === '/card/applyOpenCard') {
        if (financialOutcome === 'network') throw new Error('PRIVATE financial network response');
        return rejected(financialOutcome === 'session_expired' ? 10020 : 987654);
      }
      throw new Error('Unexpected fixed fixture endpoint');
    } });
  return {
    freshClient: () => new UpayClient(config, store, transport),
    calls,
    loginCalls: () => calls.filter(call => call.path === '/sys/member/login'),
    snapshot: () => ({ session, attempt }),
    setFinancialOutcome: (value: typeof financialOutcome) => { financialOutcome = value; },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(START);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real network is forbidden in authentication fixtures'); }));
});
afterEach(() => {
  try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
  finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
});

describe('durable UPay authentication throttling across fresh serverless clients', () => {
  it.each(['password_rejected', 'totp_rejected', 'invalid_login_session', 'invalid_cached_session'] as const)
    ('applies a five-minute cooldown for %s during sixty one-minute callbacks', async mode => {
      const f = fixture(mode);
      for (let minute = 0; minute < 60; minute++) {
        vi.setSystemTime(START + minute * 60_000);
        const failure = await f.freshClient().readRequest('GET', '/agent/info').catch(error => error);
        expect(failure).toBeInstanceOf(UpayError);
        expect((failure as Error).message).not.toContain('PRIVATE');
      }
      expect(f.loginCalls().length).toBeGreaterThan(0);
      expect(f.loginCalls().length).toBeLessThanOrEqual(12);
      const times = f.loginCalls().map(call => call.at);
      for (let index = 1; index < times.length; index++) expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(300_000);
      expect(JSON.stringify(f.snapshot().attempt)).not.toContain('PRIVATE');
    });

  it('reuses one valid token for sixty minutes of fresh instances without logging in every minute', async () => {
    const f = fixture();
    for (let minute = 0; minute < 60; minute++) {
      vi.setSystemTime(START + minute * 60_000);
      await expect(f.freshClient().readRequest('GET', '/agent/info')).resolves.toEqual({});
    }
    expect(f.loginCalls()).toHaveLength(1);
    expect(f.calls.filter(call => call.path === '/sys/member/validateGoogle')).toHaveLength(1);
  });

  it.each(['stable', 'password_rejected'] as const)('permits only one login claim among concurrent fresh instances: %s', async mode => {
    const f = fixture(mode);
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => f.freshClient().readRequest('GET', '/agent/info')));
    expect(f.loginCalls()).toHaveLength(1);
    expect(results.every(result => result.status === (mode === 'stable' ? 'fulfilled' : 'rejected'))).toBe(true);
  });

  it.each(['session_expired', 'business_rejected', 'network'] as const)('never logs in again or replays a dispatched financial POST after %s', async outcome => {
    const f = fixture(); f.setFinancialOutcome(outcome);
    await expect(f.freshClient().submitRequest('/card/applyOpenCard', { customerNo: 'PRIVATE-fixture', pinCode: 'PRIVATE-encrypted-pin' }))
      .rejects.toMatchObject({ retryable: true, metadata: { phase: 'post_dispatched' } });
    expect(f.loginCalls()).toHaveLength(1);
    expect(f.calls.filter(call => call.path === '/card/applyOpenCard')).toHaveLength(1);
  });
});
