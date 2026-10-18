import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { UpayClient } from '../../src/partner/upay/client';
import type { SessionAccess, UpaySession, UpaySessionStore } from '../../src/partner/upay/session-store';
import { UpayTransport } from '../../src/partner/upay/transport';

const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

class MemoryStore implements UpaySessionStore {
  value: UpaySession | null = null;
  private pending: Promise<unknown> = Promise.resolve();
  withLock<T>(fn: (access: SessionAccess) => Promise<T>): Promise<T> {
    const result = this.pending.then(() => fn({ get: async () => this.value, set: async session => { this.value = session; } }));
    this.pending = result.catch(() => {});
    return result;
  }
}

function fixture(mode: 'manual' | 'automatic') {
  const config = loadConfig({ DATABASE_URL: 'unused-in-unit-tests', JWT_SECRET: 'unit-test-secret-at-least-16', UPAY_LOGIN: 'automation@example.test',
    UPAY_PASSWORD: 'test-password', UPAY_TOTP_SECRET: seed, CARD_ISSUANCE_MODE: mode, ADMIN_TELEGRAM_IDS: '999',
    UPAY_WRITES_ENABLED: 'true', UPAY_PAYMENT_PASSWORD: '123456', UPAY_INVOICE_DEPOSITS_ENABLED: 'true' });
  const sent: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const endpoint = new URL(String(input)).pathname.replace('/api/v1', '');
    sent.push(`${init?.method ?? 'GET'} ${endpoint}`);
    const ok = (data: unknown) => Response.json({ code: 200, data });
    if (endpoint === '/sys/member/login') return ok({ token: 'test-session', googleState: 1 });
    if (endpoint === '/sys/member/validateGoogle') return ok({});
    if (endpoint === '/sys/member/loginInfo') return ok({ id: 'test-bot', pinCodeSet: true });
    return ok({ pageNo: 1, totalPages: 0, list: [] });
  };
  const client = new UpayClient(config, new MemoryStore(), new UpayTransport({ baseUrl: config.UPAY_BASE_URL, deviceId: 'WEB-GUDEX-test', timeoutMs: 1000, fetch: fetcher }));
  return { client, sent };
}

describe('UPay bot limited to card balances, operations and freezing in manual issuance', () => {
  it('sends only login, the card list, card operations and the freeze command', async () => {
    const { client, sent } = fixture('manual');
    await client.readRequest('GET', '/card/list', { query: { customerNo: 'customer', pageNo: 1, pageSize: 100 } });
    await client.readRequest('POST', '/card/getPageToTransaction', { body: { agentCustomerCardId: 'card', pageNo: 1, pageSize: 100 } });
    await client.loginInfo();
    await client.submitRequest('/card/thawFrozen', { pinCode: 'encrypted', agentCustomerCardIds: ['card'], state: 1 });
    const refused = [
      () => client.readRequest('GET', '/customer/list'),
      () => client.readRequest('GET', '/card/getAgentCustomerCardDetail', { query: { agentCustomerCardId: 'card' } }),
      () => client.readRequest('POST', '/card/getBrokerCardDetailDecrypt', { body: { agentCustomerCardId: 'card' } }),
      () => client.readRequest('GET', '/asset/coin/list'),
      () => client.submitRequest('/card/recharge', { amount: 1 }),
      () => client.submitRequest('/card/applyOpenCard', {}),
      () => client.createDepositInvoice({ coinId: 'c', chainId: 'n', amount: 10, ditchCode: 'PTF' }),
      () => client.validatePaymentPassword(),
    ];
    for (const call of refused) await expect(call()).rejects.toMatchObject({ metadata: { phase: 'pre_dispatch' } });
    expect(sent.filter(request => !/\/sys\/member\/(login|validateGoogle|loginInfo)$/.test(request)))
      .toEqual(['GET /card/list', 'POST /card/getPageToTransaction', 'POST /card/thawFrozen']);
  });

  it('keeps the full read set when issuance is automatic', async () => {
    const { client, sent } = fixture('automatic');
    await client.readRequest('GET', '/customer/list');
    expect(sent).toContain('GET /customer/list');
  });
});
