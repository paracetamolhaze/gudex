import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import type { UpayClient } from '../../src/partner/upay/client';
import { inspectUpayContracts } from '../../src/partner/upay/contracts';
import { UpayError } from '../../src/partner/upay/transport';

function groupFixture(groups: unknown, configuredGroup?: string, fails = false) {
  const calls: string[] = [];
  const client = {
    customers: async () => ({ list: [] }), cards: async () => ({ list: [] }),
    readRequest: async (method: string, endpoint: string) => {
      calls.push(`${method} ${endpoint}`);
      if (endpoint === '/customer/group/all') {
        if (fails) throw new UpayError('private-group-error', false, 10003);
        return groups;
      }
      return { list: [] };
    },
    submitRequest: () => { throw new Error('Mutation is forbidden'); },
  } as unknown as UpayClient;
  const config = loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'local-test-secret-16', UPAY_CUSTOMER_GROUP_ID: configuredGroup });
  return { run: () => inspectUpayContracts(client, config), calls };
}

describe('operator protocol inspection', () => {
  it('uses only reads and returns schemas, allowed quotes and ID equalities without PII', async () => {
    const calls: string[] = [];
    const fixture = {
      customers: async () => ({ list: [{ no: 'private-customer-id', email: 'private@example.test' }] }),
      cards: async () => ({ list: [{ agentCustomerCardId: 'private-card-id', brokerCardId: 'private-broker-id', accountCardId: 'private-account-id', cardNumber: 'private-pan' }] }),
      readRequest: async (method: string, endpoint: string, options: { body?: { operateType: number } }) => {
        calls.push(`${method} ${endpoint}`);
        if (endpoint === '/card/getPageToCardOperateRecord') return { list: [options.body?.operateType === 5
          ? { cardId: 'private-broker-id', orderNo: 'private-order-id' }
          : { accountCardId: 'private-account-id', orderNo: 'private-order-id' }] };
        return { currency: 'USD', openFee: '10.00', balance: '987654.00', email: 'private@example.test',
          needParams: ['lastName', 'givenName', 'documentType'], uri: 'private-photo-uri' };
      },
      submitRequest: () => { throw new Error('Mutation is forbidden'); },
    } as unknown as UpayClient;
    const result = await inspectUpayContracts(fixture, loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'local-test-secret-16' }));
    expect(result).toMatchObject({ mutationsPerformed: false,
      product: { quote: { currency: 'USD', openFee: '10.00' }, needParams: ['lastName', 'givenName', 'documentType'] },
      issuanceRecords: { verifiedIdRelations: ['cardId=brokerCardId'] }, rechargeRecords: { verifiedIdRelations: ['accountCardId=accountCardId'] } });
    expect(JSON.stringify(result)).not.toMatch(/private-|private@|987654/);
    expect(calls.filter(call => call.startsWith('POST'))).toEqual(['POST /card/getPageToCardOperateRecord', 'POST /card/getPageToCardOperateRecord']);
  });

  it.each([
    { groups: [{ id: 42, isDefault: 1 }], ready: true, defaults: 1, validDefaults: 1 },
    { groups: { list: [{ id: 'private-default', isDefault: '1' }] }, ready: true, defaults: 1, validDefaults: 1 },
    { groups: [{ id: 42, isDefault: 1 }, { id: 43, isDefault: 1 }], ready: false, defaults: 2, validDefaults: 2 },
    { groups: [{ id: Number.MAX_SAFE_INTEGER + 1, isDefault: 1 }], ready: false, defaults: 1, validDefaults: 0 },
    { groups: [{ id: 'unsafe group/id', isDefault: 1 }], ready: false, defaults: 1, validDefaults: 0 },
    { groups: [{ id: 0, isDefault: 1 }], ready: false, defaults: 1, validDefaults: 0 },
    { groups: [{ id: 42, isDefault: 1 }, { id: 'unsafe group/id', isDefault: 1 }], ready: false, defaults: 2, validDefaults: 1 },
  ])('reports default group readiness using the KYC identifier rules: $ready/$defaults/$validDefaults', async entry => {
    const { run, calls } = groupFixture(entry.groups);
    const result = await run();
    expect(result.groupReadiness).toMatchObject({ ok: true, ready: entry.ready, configured: false, configuredGroupMatches: false,
      defaultGroupCount: entry.defaults, validDefaultGroupCount: entry.validDefaults });
    expect(calls.filter(call => call === 'GET /customer/group/all')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/private-default|unsafe group\/id/);
    expect(result).toMatchObject({ mutationsPerformed: false, groupFields: { ok: true }, product: { ok: true } });
  });

  it('accepts an explicit matching group despite ambiguous defaults without returning its identifier or name', async () => {
    const { run } = groupFixture([{ id: 'private-selected', name: 'private-group-name', isDefault: 1 }, { id: 'private-other', isDefault: 1 }], 'private-selected');
    const result = await run();
    expect(result.groupReadiness).toMatchObject({ ok: true, ready: true, configured: true, configuredGroupMatches: true, groupCount: 2 });
    expect(JSON.stringify(result)).not.toMatch(/private-selected|private-other|private-group-name/);
  });

  it('matches a safe numeric group ID to configured text and refuses an invalid explicit group without fallback', async () => {
    expect((await groupFixture([{ id: 42, isDefault: 1 }], '42').run()).groupReadiness).toMatchObject({ ready: true, configuredGroupMatches: true });
    expect((await groupFixture([{ id: 42, isDefault: 1 }], 'private-missing').run()).groupReadiness).toMatchObject({ ready: false, configured: true, configuredGroupMatches: false });
  });

  it('keeps diagnostics available after a group read failure without claiming readiness or leaking the error', async () => {
    const { run, calls } = groupFixture([], undefined, true);
    const result = await run();
    expect(result).toMatchObject({ groupFields: { ok: false, code: 10003 }, groupReadiness: { ok: false, ready: false }, product: { ok: true } });
    expect(JSON.stringify(result)).not.toContain('private-group-error');
    expect(calls.filter(call => call === 'GET /customer/group/all')).toHaveLength(1);
  });
});
