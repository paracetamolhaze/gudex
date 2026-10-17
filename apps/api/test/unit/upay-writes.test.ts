import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { UpayClient } from '../../src/partner/upay/client';
import { UpayTransport } from '../../src/partner/upay/transport';
import type { SessionAccess, UpaySessionStore } from '../../src/partner/upay/session-store';

const env = { DATABASE_URL: 'unused', JWT_SECRET: 'test-fixture-secret-32-characters', UPAY_LOGIN: 'bot@example.test', UPAY_PASSWORD: 'test-only',
  UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', UPAY_PAYMENT_PASSWORD: '654321' };
const store: UpaySessionStore = { withLock: async <T>(fn: (access: SessionAccess) => Promise<T>) => fn({
  get: async () => null, set: async () => {},
}) };

function setup(extra: Record<string, string> = {}, failure: 'timeout' | 'expired' | 'none' = 'none') {
  const requests: { endpoint: string; init?: RequestInit }[] = [];
  const config = loadConfig({ ...env, ...extra });
  const transport = new UpayTransport({ baseUrl: config.UPAY_BASE_URL, deviceId: config.UPAY_DEVICE_ID, timeoutMs: 1000,
    fetch: async (url, init) => {
      const endpoint = new URL(String(url)).pathname.replace('/api/v1', '');
      requests.push({ endpoint, init });
      const ok = (data: unknown) => Response.json({ code: 200, data });
      if (endpoint === '/sys/member/login') return ok({ token: 'fixture-token', googleState: 1 });
      if (endpoint === '/sys/member/validateGoogle') return ok({});
      if (endpoint === '/sys/member/loginInfo') return ok({ id: 'fixture', iv: 'test-vector-iv', pinCodeSet: true });
      if (failure === 'timeout') throw new Error('connection ended after request dispatch');
      if (failure === 'expired') return Response.json({ code: 10020 });
      if (endpoint === '/file/upload') return ok({ uri: '/test-only/photo.jpg' });
      return ok({ orderNo: 'fixture-receipt' });
    },
  });
  return { client: new UpayClient(config, store, transport), requests };
}

describe('UPay real mutation dispatch boundary', () => {
  it('does not allow an issuance or recharge through the replayable read API', async () => {
    const { client, requests } = setup();
    await expect(client.readRequest('POST', '/card/recharge', { body: { amount: '50' } })).rejects.toThrow('approved read');
    await expect(client.readRequest('POST', '/card/applyOpenCard', { body: {} })).rejects.toThrow('approved read');
    expect(requests).toHaveLength(0);
  });
  it('does not dispatch any write while capabilities are disabled', async () => {
    const { client, requests } = setup();
    await expect(client.submitRequest('/card/recharge', { amount: '50' })).rejects.toThrow('not enabled');
    await expect(client.submitRequest('/customer/add', {})).rejects.toThrow('not enabled');
    expect(requests).toHaveLength(0);
  });
  it.each(['timeout', 'expired'] as const)('never replays a dispatched financial POST after %s', async failure => {
    const { client, requests } = setup({ UPAY_WRITES_ENABLED: 'true' }, failure);
    await expect(client.submitRequest('/card/recharge', { amount: '50' })).rejects.toMatchObject({ retryable: true });
    expect(requests.filter(r => r.endpoint === '/card/recharge')).toHaveLength(1);
    expect(requests.filter(r => r.endpoint === '/sys/member/login')).toHaveLength(1);
  });
  it('uses multipart file upload without serializing a FormData object as JSON', async () => {
    const { client, requests } = setup({ UPAY_KYC_ENABLED: 'true' });
    expect(await client.uploadRequest(new Uint8Array([255, 216, 255, 224]), 'image/jpeg', 1)).toEqual({ uri: '/test-only/photo.jpg' });
    const upload = requests.find(r => r.endpoint === '/file/upload')!;
    expect(upload.init!.body).toBeInstanceOf(FormData);
    expect(new Headers(upload.init!.headers).has('Content-Type')).toBe(false);
    expect((upload.init!.body as FormData).get('fileType')).toBe('1');
  });
  it('checks the active queue lease after authentication immediately before a mutation', async () => {
    const { client, requests } = setup({ UPAY_WRITES_ENABLED: 'true' });
    let checked = false;
    await expect(client.submitRequest('/card/recharge', { amount: '50' }, { beforeDispatch: async () => {
      checked = true;
      expect(requests.some(r => r.endpoint === '/sys/member/loginInfo')).toBe(true);
      throw new Error('Lease expired during authentication');
    } })).rejects.toMatchObject({ metadata: { phase: 'pre_dispatch', ack: 'unconfirmed' } });
    expect(checked).toBe(true);
    expect(requests.some(r => r.endpoint === '/card/recharge')).toBe(false);
  });
  it('does not allow account-security changes through the mutation client', async () => {
    const { client, requests } = setup({ UPAY_KYC_ENABLED: 'true', UPAY_WRITES_ENABLED: 'true' });
    await expect(client.submitRequest('/sys/member/setPinCode', {})).rejects.toThrow('not enabled');
    expect(requests).toHaveLength(0);
  });
});
