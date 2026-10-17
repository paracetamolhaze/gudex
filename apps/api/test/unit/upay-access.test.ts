import { describe, expect, it } from 'vitest';
import { inspectUpayAccess } from '../../src/partner/upay/access-readiness';
import { UpayError } from '../../src/partner/upay/transport';

function fixture(options: { denied?: string[]; duplicate?: boolean; mismatchedId?: boolean; wallets?: boolean;
  permissions?: { id: string; checked?: number; route?: string }[] } = {}) {
  const calls: { method: string; endpoint: string; query?: object; body?: object }[] = [];
  const current = { id: 'private-member-id', email: 'private@example.test', roleId: 'private-role-id', name: 'private-name' };
  const catalog = [{ id: 'private-menu-id', route: 'card-manage' }, { id: 'private-wallet-id', route: 'wallet-manage' },
    { id: 'private-fund-id', route: 'funds-management' }, ...(options.wallets ? [{ id: 'private-address-id', route: 'wallet-address' }] : []),
    ...['quick-card', 'operation-log', 'card-list', 'recharge-records'].map(route => ({ id: `private-${route}-id`, route,
      name: 'private-permission-label', title: 'private-menu-title' }))];
  const client = { readRequest: async (method: 'GET' | 'POST', endpoint: string, args: { query?: object; body?: object } = {}) => {
    calls.push({ method, endpoint, ...args });
    if (options.denied?.includes(endpoint)) throw new UpayError('private upstream error', false, 10003);
    if (endpoint === '/sys/member/loginInfo') return { ...current, token: 'private-token', iv: 'private-iv' };
    if (endpoint === '/sys/member/list') return { list: [options.mismatchedId ? { ...current, id: 'different-private-id' } : current,
      ...(options.duplicate ? [current] : [])] };
    if (endpoint === '/sys/role/list') return { list: [{ id: current.roleId, name: 'private-role-name', status: 1 }] };
    if (endpoint === '/sys/permission/homeMenu') return catalog;
    if (endpoint === '/sys/permission/list') return ['private-action-code'];
    if (endpoint === '/sys/role/permissions/list') {
      expect(args.query).toEqual({ roleId: current.roleId });
      return options.permissions ?? catalog.map(item => ({ id: item.id, checked: item.route === 'card-manage' ? 1 : 0 }));
    }
    throw new Error('Unexpected administrative request');
  } };
  return { client, calls };
}

describe('current UPay account access inspection', () => {
  it('matches the authenticated member and role without exporting identities or changing permissions', async () => {
    const { client, calls } = fixture();
    const result = await inspectUpayAccess(client, { UPAY_LOGIN: 'private@example.test' });
    expect(result.currentAccount).toMatchObject({ authenticated: true, memberMatched: true, roleAssigned: true,
      roleFoundInCatalog: true, roleEnabled: true, rolePermissionsVerified: true });
    expect(result.availableMenu).toMatchObject({ 'wallet-manage': true, 'funds-management': true, 'wallet-address': false, 'deposit-list': false });
    expect(result.selectedRoleMenu).toMatchObject({ 'card-manage': true, 'wallet-manage': false });
    expect(result.customerWalletMenuPresent).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/private|different-/);
    expect(calls.filter(call => call.method === 'POST').map(call => call.endpoint)).toEqual(['/sys/member/list', '/sys/role/list']);
    expect(calls).toHaveLength(6);
  });
  it('reports catalog presence independently of whether that role selected the wallet permission', async () => {
    const { client } = fixture({ wallets: true });
    const result = await inspectUpayAccess(client, { UPAY_LOGIN: 'private@example.test' });
    expect(result.customerWalletMenuPresent).toBe(true);
    expect(result.availableMenu['wallet-address']).toBe(true);
    expect(result.selectedRoleMenu?.['wallet-address']).toBe(false);
  });
  it('reports verified financial and audit routes using exact selected permission IDs, without exporting labels', async () => {
    const { client } = fixture({ permissions: [
      { id: 'private-quick-card-id', checked: 1 }, { id: 'private-operation-log-id', checked: 0 },
      { id: 'private-card-list-id' }, { id: 'private-recharge-records-id', checked: 0 },
      // An arbitrary route string on an unrelated selected ID is not authorization.
      { id: 'private-unrelated-id', checked: 1, route: 'operation-log' },
    ] });
    const result = await inspectUpayAccess(client, { UPAY_LOGIN: 'private@example.test' });
    expect(result.availableMenu).toMatchObject({ 'quick-card': true, 'operation-log': true, 'card-list': true, 'recharge-records': true });
    expect(result.selectedRoleMenu).toMatchObject({ 'quick-card': true, 'operation-log': false, 'card-list': true, 'recharge-records': false });
    expect(JSON.stringify(result)).not.toMatch(/private|permission-label|menu-title|unrelated/);
  });
  it.each([{ duplicate: true }, { mismatchedId: true }])('never adopts an ambiguous member or an email with a different authenticated ID: %j', async options => {
    const { client, calls } = fixture(options);
    const result = await inspectUpayAccess(client, { UPAY_LOGIN: 'private@example.test' });
    expect(result.currentAccount.memberMatched).toBe(false);
    expect(result.currentAccount.roleAssigned).toBeNull();
    expect(calls.some(call => call.endpoint === '/sys/role/permissions/list')).toBe(false);
  });
  it('retains available menu evidence when team administration is inaccessible and sanitizes errors', async () => {
    const { client, calls } = fixture({ denied: ['/sys/member/list', '/sys/role/list'] });
    const result = await inspectUpayAccess(client, { UPAY_LOGIN: 'private@example.test' });
    expect(result.probes.members).toEqual({ ok: false, code: 10003 });
    expect(result.availableMenu['wallet-manage']).toBe(true);
    expect(result.selectedRoleMenu).toBeNull();
    expect(result.currentAccount.rolePermissionsVerified).toBe(false);
    expect(calls).toHaveLength(5);
    expect(JSON.stringify(result)).not.toContain('private');
  });
});
