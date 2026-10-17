import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config';
import { prepareLiveDatabase } from '../../src/ops/live-database';

const fixture = vi.hoisted(() => ({ calls: [] as string[], existingRole: false, owner: '', verifyFails: false, connections: 0,
  role: { rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, has_parent_roles: false },
}));
vi.mock('pg', () => ({ default: { Client: class {
  readonly instance = fixture.connections++;
  async connect() { if (this.instance > 0 && fixture.verifyFails) throw new Error('private-fixture-database-password'); }
  async end() {}
  async query(text: string) {
    fixture.calls.push(text);
    if (text.startsWith('select pg_get_userbyid')) return { rows: fixture.owner ? [{ owner: fixture.owner }] : [], rowCount: fixture.owner ? 1 : 0 };
    if (text.includes('from pg_roles')) return { rows: fixture.existingRole ? [fixture.role] : [], rowCount: fixture.existingRole ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  }
} } }));
const base = { DATABASE_URL: 'postgresql://fixture:fixture@ep-fixture-pooler.aws.neon.tech/demo',
  DATABASE_URL_UNPOOLED: 'postgresql://fixture:fixture@ep-fixture.aws.neon.tech/demo',
  JWT_SECRET: 'fixture-jwt-secret-long-enough', LIVE_DATABASE_SETUP_ENABLED: 'true' };
beforeEach(() => { Object.assign(fixture, { calls: [], existingRole: false, owner: '', verifyFails: false, connections: 0,
  role: { rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, has_parent_roles: false },
}); });
describe('isolated live database provisioning', () => {
  it('requires an explicit setup flag and refuses SQL-bearing credentials before connecting', async () => {
    await expect(prepareLiveDatabase(loadConfig({ ...base, LIVE_DATABASE_SETUP_ENABLED: 'false' }), 'a'.repeat(64))).rejects.toMatchObject({ code: 'not_found' });
    await expect(prepareLiveDatabase(loadConfig(base), "a'; drop database demo;--")).rejects.toMatchObject({ code: 'validation' });
    expect(fixture.connections).toBe(0);
  });
  it('creates only the fixed fresh database and a restricted role without returning any credential', async () => {
    const password = 'a'.repeat(64);
    const result = await prepareLiveDatabase(loadConfig(base), password);
    expect(result).toMatchObject({ database: 'gudex_live', role: 'gudex_live_owner', originalDataPreserved: true, created: true });
    expect(JSON.stringify(result)).not.toContain(password);
    expect(fixture.calls.join(' ')).not.toMatch(/drop\s|alter role|alter database/i);
    expect(fixture.calls.some(text => text.includes('nosuperuser nocreatedb nocreaterole noreplication nobypassrls'))).toBe(true);
  });
  it('refuses another owners database and never resets an existing role password', async () => {
    fixture.owner = 'another_owner';
    await expect(prepareLiveDatabase(loadConfig(base), 'a'.repeat(64))).rejects.toMatchObject({ code: 'validation' });
    expect(fixture.calls.some(text => /create role|create database/.test(text))).toBe(false);
  });
  it('does not replace an existing role password after an uncertain previous setup and sanitizes errors', async () => {
    fixture.owner = 'gudex_live_owner'; fixture.existingRole = true; fixture.verifyFails = true;
    const error = await prepareLiveDatabase(loadConfig(base), 'a'.repeat(64)).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'provider_unavailable', message: expect.stringContaining('original database, data and credentials were preserved') });
    expect(String(error)).not.toContain('private-fixture');
    expect(fixture.calls.some(text => /create role|create database|alter role/.test(text))).toBe(false);
  });
  it('reuses only an unprivileged standalone login role without changing its password', async () => {
    fixture.owner = 'gudex_live_owner'; fixture.existingRole = true;
    await expect(prepareLiveDatabase(loadConfig(base), 'a'.repeat(64))).resolves.toMatchObject({ created: false });
    expect(fixture.calls.some(text => /create role|create database|alter role/.test(text))).toBe(false);
  });
  it.each(['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls', 'has_parent_roles'] as const)(
    'refuses an existing role with %s before granting membership or creating a database', async attribute => {
      fixture.existingRole = true; fixture.role[attribute] = true;
      await expect(prepareLiveDatabase(loadConfig(base), 'a'.repeat(64))).rejects.toMatchObject({ code: 'validation' });
      expect(fixture.calls.some(text => /create role|create database|alter role|^grant /.test(text))).toBe(false);
      expect(fixture.connections).toBe(1);
    });
  it('refuses an existing role without LOGIN before modifying privileges', async () => {
    fixture.existingRole = true; fixture.role.rolcanlogin = false;
    await expect(prepareLiveDatabase(loadConfig(base), 'a'.repeat(64))).rejects.toMatchObject({ code: 'validation' });
    expect(fixture.calls.some(text => /^grant |create database/.test(text))).toBe(false);
  });
  it.each([
    'postgresql://fixture:fixture@ep-another-pooler.aws.neon.tech/demo',
    'postgresql://fixture:fixture@ep-fixture-pooler.other-region.neon.tech/demo',
  ])('rejects a pooled endpoint from a different Neon host before connecting: %s', async databaseUrl => {
    await expect(prepareLiveDatabase(loadConfig({ ...base, DATABASE_URL: databaseUrl }), 'a'.repeat(64))).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(fixture.connections).toBe(0);
  });
  it('does not connect to an unrelated database provider or pooled administrator URL', async () => {
    await expect(prepareLiveDatabase(loadConfig({ ...base, DATABASE_URL_UNPOOLED: 'postgresql://fixture@database.example/demo' }), 'a'.repeat(64))).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(fixture.connections).toBe(0);
  });
});
