import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ config: undefined as Record<string, unknown> | undefined, calls: [] as { sql: string; params?: unknown[] }[],
  connectFailure: false, migrationFailure: false, unlock: true, ended: 0, migrate: vi.fn() }));
vi.mock('pg', () => ({ default: { Client: class {
  constructor(config: Record<string, unknown>) { fixture.config = config; }
  async connect() { if (fixture.connectFailure) throw new Error('Fixture connection failed'); }
  async query(sql: string, params?: unknown[]) {
    fixture.calls.push({ sql, params });
    return { rows: sql.includes('pg_advisory_unlock') ? [{ unlocked: fixture.unlock }] : [] };
  }
  async end() { fixture.ended++; }
} } }));
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: (input: unknown) => input }));
vi.mock('drizzle-orm/node-postgres/migrator', () => ({ migrate: fixture.migrate }));
import { runMigrations } from '../../src/db/migrate';

beforeEach(() => {
  fixture.config = undefined; fixture.calls = []; fixture.connectFailure = false;
  fixture.migrationFailure = false; fixture.unlock = true; fixture.ended = 0;
  fixture.migrate.mockReset().mockResolvedValue(undefined);
});

describe('bounded direct migration connection and lock cleanup', () => {
  it('refuses a known Neon transaction-pooler before opening a socket or running SQL', async () => {
    await expect(runMigrations('postgres://fixture@ep-example-pooler.eu-central-1.aws.neon.tech/gudex')).rejects.toThrow('UNPOOLED');
    expect(fixture.config).toBeUndefined();
    expect(fixture.calls).toEqual([]);
    expect(fixture.migrate).not.toHaveBeenCalled();
  });

  it('uses one bounded dedicated client, a new lock and a verified unlock before closing', async () => {
    await runMigrations('postgres://fixture@localhost:5442/gudex_test', '/fixture/migrations');
    expect(fixture.config).toMatchObject({ connectionTimeoutMillis: 10_000, statement_timeout: 15_000,
      lock_timeout: 5_000, query_timeout: 20_000, application_name: 'gudex:migrations:v2' });
    expect(fixture.calls).toEqual([
      { sql: 'select pg_advisory_lock($1)', params: [727277] },
      { sql: 'select pg_advisory_unlock($1) as unlocked', params: [727277] },
    ]);
    expect(fixture.migrate).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Object) }), { migrationsFolder: '/fixture/migrations' });
    expect(fixture.ended).toBe(1);
  });

  it('unlocks and closes the same client when the real migrator fails', async () => {
    fixture.migrate.mockRejectedValue(new Error('Fixture SQL failed'));
    await expect(runMigrations('postgres://fixture@localhost:5442/gudex_test')).rejects.toThrow('Fixture SQL failed');
    expect(fixture.calls.at(-1)).toEqual({ sql: 'select pg_advisory_unlock($1) as unlocked', params: [727277] });
    expect(fixture.ended).toBe(1);
  });

  it('closes a failed connection without attempting an unowned lock release', async () => {
    fixture.connectFailure = true;
    await expect(runMigrations('postgres://fixture@localhost:5442/gudex_test')).rejects.toThrow('Fixture connection failed');
    expect(fixture.calls).toEqual([]);
    expect(fixture.ended).toBe(1);
  });

  it('does not silently accept a failed unlock and always closes the socket', async () => {
    fixture.unlock = false;
    await expect(runMigrations('postgres://fixture@localhost:5442/gudex_test')).rejects.toThrow('cleanup');
    expect(fixture.ended).toBe(1);
  });
});
