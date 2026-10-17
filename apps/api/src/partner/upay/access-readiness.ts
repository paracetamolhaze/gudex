import type { Config } from '../../config';
import { UpayError } from './transport';

type Row = Record<string, unknown>;
type AccessReadClient = { readRequest(method: 'GET' | 'POST', endpoint: string,
  options?: { body?: object; query?: Record<string, string | number> }): Promise<unknown> };
type Probe = { ok: true; data: unknown } | { ok: false; code?: number };
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => {
  const source = Array.isArray(value) ? value : object(value).list;
  return Array.isArray(source) ? source.filter(value => value && typeof value === 'object' && !Array.isArray(value)) as Row[] : [];
};
const id = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && value.length <= 128 ? value :
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
const ROUTES = ['wallet-manage', 'funds-management', 'wallet-address', 'deposit-list', 'fund', 'flow',
  'wallet-address-manage', 'recharge-list', 'withdraw-list', 'team-manage', 'user-manage', 'role-info',
  'card-manage', 'customer-manage', 'account-manage', 'quick-card', 'operation-log', 'card-list', 'recharge-records'] as const;
const routeFlags = (items: Row[]) => Object.fromEntries(ROUTES.map(route => [route, items.some(item => item.route === route)]));
const summary = (probe: Probe) => probe.ok ? { ok: true, count: rows(probe.data).length } : probe;

// Compare current-account identities in memory only. Never return names, emails,
// IDs, tokens, IVs, permission IDs or arbitrary values from the administrative API.
export async function inspectUpayAccess(client: AccessReadClient, config: Pick<Config, 'UPAY_LOGIN'>) {
  const read = async (method: 'GET' | 'POST', endpoint: string, options: { body?: object; query?: Record<string, string | number> } = {}): Promise<Probe> => {
    try { return { ok: true, data: await client.readRequest(method, endpoint, options) }; }
    catch (error) { return { ok: false, ...(error instanceof UpayError && error.code !== undefined ? { code: error.code } : {}) }; }
  };
  const [login, menu, permissions, members, roles] = await Promise.all([
    read('GET', '/sys/member/loginInfo'), read('GET', '/sys/permission/homeMenu'), read('GET', '/sys/permission/list'),
    read('POST', '/sys/member/list', { body: { pageNo: 1, pageSize: 1000 } }),
    read('POST', '/sys/role/list', { body: { pageNo: 1, pageSize: 1000 } }),
  ]);
  const info = login.ok ? object(login.data) : {};
  const loginId = id(info.id);
  const configuredEmail = config.UPAY_LOGIN?.trim().toLowerCase();
  const matches = (members.ok ? rows(members.data) : []).filter(member => {
    if (!login.ok) return false;
    const memberId = id(member.id);
    // A row with the configured email but a different authenticated member ID must never be adopted.
    return loginId !== null && memberId !== null ? memberId === loginId :
      Boolean(configuredEmail && typeof member.email === 'string' && member.email.trim().toLowerCase() === configuredEmail);
  });
  const member = matches.length === 1 ? matches[0] : undefined;
  const roleId = member ? id(member.roleId) : null;
  const matchingRoles = roleId && roles.ok ? rows(roles.data).filter(role => id(role.id) === roleId) : [];
  const rolePermissions = roleId ? await read('GET', '/sys/role/permissions/list', { query: { roleId } }) : null;
  const catalog = menu.ok ? rows(menu.data) : [];
  const selectedIds = new Set((rolePermissions?.ok ? rows(rolePermissions.data) : [])
    .filter(item => item.checked === undefined || Number(item.checked) === 1).map(item => id(item.id)).filter(value => value !== null));
  const selected = catalog.filter(item => { const key = id(item.id); return key !== null && selectedIds.has(key); });
  return {
    mutationsPerformed: false,
    probes: { login: { ok: login.ok }, menu: summary(menu), permissions: summary(permissions), members: summary(members), roles: summary(roles),
      rolePermissions: rolePermissions ? summary(rolePermissions) : { skipped: true } },
    currentAccount: { authenticated: login.ok, memberMatched: Boolean(member), ambiguousMemberMatch: matches.length > 1,
      roleAssigned: member ? Boolean(roleId) : null, roleFoundInCatalog: roleId && roles.ok ? matchingRoles.length === 1 : null,
      roleEnabled: matchingRoles.length === 1 ? Number(matchingRoles[0]!.status) === 1 : null,
      rolePermissionsVerified: Boolean(rolePermissions?.ok) },
    availableMenu: routeFlags(catalog), selectedRoleMenu: rolePermissions?.ok ? routeFlags(selected) : null,
    customerWalletMenuPresent: catalog.some(item => ['wallet-address', 'deposit-list'].includes(String(item.route))),
    rejectionCodeMeaning: 'unverified',
  };
}
