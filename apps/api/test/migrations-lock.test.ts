import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate';
import { assertLocalTestDatabase } from './database-target';

describe('direct startup migration locking', () => {
  it('completes real migrations while an unrelated legacy session still holds lock 727274', async () => {
    const url = assertLocalTestDatabase(process.env.DATABASE_URL!);
    const legacy = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
    const observer = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
    await legacy.connect();
    await observer.connect();
    try {
      await legacy.query('select pg_advisory_lock(727274)');
      // This invokes the real Drizzle migrator on the already migrated local
      // test schema; it must not wait for or release the frozen legacy lock.
      await runMigrations(url);
      const result = await observer.query<{ acquired: boolean }>('select pg_try_advisory_lock(727274) as acquired');
      expect(result.rows[0]!.acquired).toBe(false);
      const migration = await observer.query('select count(*)::int as count from drizzle.__drizzle_migrations');
      expect(migration.rows[0].count).toBeGreaterThan(0);
      const current = await observer.query<{ acquired: boolean }>('select pg_try_advisory_lock(727277) as acquired');
      expect(current.rows[0]!.acquired).toBe(true);
      await observer.query('select pg_advisory_unlock(727277)');
    } finally {
      await legacy.end();
      await observer.end();
    }
  });
});
