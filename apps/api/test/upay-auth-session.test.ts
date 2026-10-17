import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../src/config';
import { appSettings } from '../src/db/schema';
import { UpayClient } from '../src/partner/upay/client';
import { DbUpaySessionStore } from '../src/partner/upay/session-store';
import { UpayTransport } from '../src/partner/upay/transport';
import { inspectUpayAuthStatus } from '../src/ops/upay-auth-status';
import { createTestContext, type TestContext } from './helpers';

let ctx: TestContext | undefined;
const START = Date.UTC(2026, 9, 17, 0, 0, 0);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  ctx = await createTestContext();
  const config = loadConfig({ DATABASE_URL: process.env.DATABASE_URL, JWT_SECRET: 'local-durable-upay-auth-fixture-key',
    UPAY_LOGIN: 'PRIVATE-bot@example.test', UPAY_PASSWORD: 'PRIVATE-password', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ',
    UPAY_SESSION_TTL_SECONDS: '3600' });
  const store = (cfg = config) => new DbUpaySessionStore(ctx!.db, cfg.appSecret);
  const calls: string[] = [];
  let loginCount = 0;
  let beforeLogin: ((number: number) => Promise<void>) | undefined;
  const transport = new UpayTransport({ baseUrl: 'https://fixture.invalid/api/v1', deviceId: 'local-durable-test', timeoutMs: 1000,
    fetch: async (url) => {
      const endpoint = new URL(String(url)).pathname.replace('/api/v1', '');
      calls.push(endpoint);
      const ok = (data: unknown) => Response.json({ code: 200, data });
      if (endpoint === '/sys/member/login') {
        const number = ++loginCount;
        await beforeLogin?.(number);
        return ok({ token: `PRIVATE-fixture-token-${number}`, googleState: 1 });
      }
      if (endpoint === '/sys/member/validateGoogle') return ok({});
      if (endpoint === '/sys/member/loginInfo') return ok({ id: 'fixture-bot' });
      if (endpoint === '/agent/info') return ok({});
      throw new Error('Unexpected endpoint in local authentication fixture');
    } });
  const client = (cfg: Config = config) => new UpayClient(cfg, store(cfg), transport);
  return { config, store, client, calls, logins: () => loginCount,
    beforeLogin: (hook: (number: number) => Promise<void>) => { beforeLogin = hook; } };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(START);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real external requests are forbidden in these tests'); }));
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    if (ctx) await ctx.close();
  } finally { ctx = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); }
});

describe('durable UPay login attempts across database-backed serverless instances', () => {
  it('shares one committed login between twenty concurrent database-backed clients', async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 20 }, () => f.client().merchant()));
    expect(results).toEqual(Array.from({ length: 20 }, () => ({})));
    expect(f.logins()).toBe(1);
  });

  it('fails closed on a corrupt stored throttle without attempting a new login or exposing private state', async () => {
    const f = await fixture();
    await ctx!.db.insert(appSettings).values({ key: 'upay:auth-attempt:v1', value: {
      fingerprint: 'PRIVATE-invalid-fingerprint', retryAfter: null, state: 'PRIVATE-invalid-state',
    } });
    await expect(f.client().merchant()).rejects.not.toThrow('PRIVATE');
    expect(f.logins()).toBe(0);
    expect(await inspectUpayAuthStatus(ctx!.db, f.config)).toMatchObject({ available: false, minimumLoginIntervalSeconds: 300 });
  });

  it('commits the attempt before the login POST and retains it when the network fails', async () => {
    const f = await fixture();
    let claimObserved = false;
    f.beforeLogin(async () => {
      const attempt = await f.store().withLock(access => access.getAuthAttempt!());
      claimObserved = Boolean(attempt && attempt.retryAfter >= START + 300_000);
      throw new Error('PRIVATE simulated lost authentication response');
    });
    await expect(f.client().merchant()).rejects.toThrow();
    expect(claimObserved).toBe(true);
    for (let minute = 1; minute < 5; minute++) {
      vi.setSystemTime(START + minute * 60_000);
      await expect(f.client().merchant()).rejects.toThrow();
    }
    expect(f.logins()).toBe(1);
    const attempt = await f.store().withLock(access => access.getAuthAttempt!());
    expect(attempt?.retryAfter).toBeGreaterThanOrEqual(START + 300_000);
    expect(JSON.stringify(attempt)).not.toContain('PRIVATE');
    const status = await inspectUpayAuthStatus(ctx!.db, f.config);
    expect(status).toMatchObject({ available: true, hasCachedSession: false, hasAuthAttempt: true,
      minimumLoginIntervalSeconds: 300, cooldownActive: true, cooldownSecondsRemaining: 60 });
    expect(JSON.stringify(status)).not.toContain('PRIVATE');
    expect(JSON.stringify(status)).not.toContain(attempt!.fingerprint);
  });

  it('keeps the global cooldown after credentials change or the session cannot be decrypted', async () => {
    const f = await fixture();
    await expect(f.client().merchant()).resolves.toEqual({});
    vi.setSystemTime(START + 60_000);
    const rotated = loadConfig({ DATABASE_URL: process.env.DATABASE_URL, JWT_SECRET: 'rotated-local-durable-upay-auth-key',
      UPAY_LOGIN: 'PRIVATE-new@example.test', UPAY_PASSWORD: 'PRIVATE-new-password', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ' });
    await expect(f.client(rotated).merchant()).rejects.toThrow();
    expect(f.logins()).toBe(1);
    await expect(f.client().merchant()).resolves.toEqual({});
    expect(f.logins()).toBe(1);
    vi.setSystemTime(START + 300_000);
    await expect(f.client(rotated).merchant()).resolves.toEqual({});
    expect(f.logins()).toBe(2);
  });

  it('never lets an old delayed login overwrite a newer committed authenticated session', async () => {
    const f = await fixture();
    const started = deferred(), release = deferred();
    f.beforeLogin(async number => {
      if (number === 1) { started.resolve(); await release.promise; }
    });
    const older = f.client().merchant().then(() => null, error => error);
    await started.promise;
    try {
      const persisted = await f.store().withLock(access => access.getAuthAttempt!());
      expect(persisted?.retryAfter).toBeGreaterThanOrEqual(START + 300_000);
      vi.setSystemTime(START + 300_001);
      await expect(f.client().merchant()).resolves.toEqual({});
    } finally { release.resolve(); }
    expect(await older).toBeInstanceOf(Error);
    const session = await f.store().withLock(access => access.get());
    expect(session?.token).toBe('PRIVATE-fixture-token-2');
    expect(f.logins()).toBe(2);
  });
});
