import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { UpayClient } from '../../src/partner/upay/client';
import { UpayTransport } from '../../src/partner/upay/transport';
import type { SessionAccess, UpaySessionStore } from '../../src/partner/upay/session-store';

const store: UpaySessionStore = { withLock: async <T>(fn: (access: SessionAccess) => Promise<T>) => fn({ get: async () => null, set: async () => {} }) };
const body = { type: 'ADD', id: '', isDefault: false, tag: 'GDXB0123456789abcdef', countryId: 'fixture-country',
  postalCode: '050000', address: 'Synthetic Street 10', name: 'TEST USER', phone: '7771234567', email: 'synthetic@example.test', intlDialCode: '+7' };
function fixture(enabled = true, expired = false) {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const config = loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'test-fixture-secret-32-characters', UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture',
    UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', UPAY_KYC_ENABLED: String(enabled), UPAY_WRITES_ENABLED: 'false' });
  const transport = new UpayTransport({ baseUrl: config.UPAY_BASE_URL, deviceId: config.UPAY_DEVICE_ID, timeoutMs: 1000, fetch: async (url, init) => {
    const path = new URL(String(url)).pathname.replace('/api/v1', '');
    calls.push({ path, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === '/sys/member/login') return Response.json({ code: 200, data: { token: 'test-token', googleState: 1 } });
    if (path === '/sys/member/loginInfo') return Response.json({ code: 200, data: { id: 'fixture' } });
    if (path === '/address/edit' && expired) return Response.json({ code: 10020 });
    return Response.json({ code: 200, data: null });
  } });
  return { client: new UpayClient(config, store, transport), calls };
}

describe('UPay owned billing dispatch boundary', () => {
  it('rejects billing mutations through the replayable read seam', async () => {
    const f = fixture();
    await expect(f.client.readRequest('POST', '/address/edit', { body })).rejects.toThrow('approved read');
    expect(f.calls).toHaveLength(0);
  });
  it.each([{ ...body, type: 'EDIT' }, { ...body, id: 'GLOBAL-EXISTING' }, { ...body, isDefault: true }, { ...body, tag: 'GLOBAL' }])
    ('blocks editing shared rows or changing a global default before authentication', async unsafe => {
      const f = fixture();
      await expect(f.client.submitRequest('/address/edit', unsafe)).rejects.toMatchObject({ metadata: { phase: 'pre_dispatch' } });
      expect(f.calls).toHaveLength(0);
    });
  it('requires the separate nonfinancial capability and sends one explicit ADD without financial writes', async () => {
    const disabled = fixture(false);
    await expect(disabled.client.submitRequest('/address/edit', body)).rejects.toThrow('not enabled');
    expect(disabled.calls).toHaveLength(0);
    const enabled = fixture();
    await enabled.client.submitRequest('/address/edit', body);
    expect(enabled.calls.filter(call => call.path === '/address/edit')).toEqual([{ path: '/address/edit', method: 'POST', body }]);
    expect(enabled.calls.some(call => /card\/(?:applyOpenCard|recharge)/.test(call.path))).toBe(false);
  });
  it('never replays a dispatched billing ADD after a session-expired response', async () => {
    const f = fixture(true, true);
    await expect(f.client.submitRequest('/address/edit', body)).rejects.toMatchObject({ retryable: true, code: 10020, metadata: { phase: 'post_dispatched' } });
    expect(f.calls.filter(call => call.path === '/address/edit')).toHaveLength(1);
    expect(f.calls.filter(call => call.path === '/sys/member/login')).toHaveLength(1);
  });
});
