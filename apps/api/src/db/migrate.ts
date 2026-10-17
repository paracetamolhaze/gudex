import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

// Legacy session lock 727274 could have been left on a transaction-pooler
// backend. Never wait on that namespace again; migrations use a direct socket.
const MIGRATION_LOCK_ID = 727277;

// Папка с SQL-миграциями рядом с исходниками. В сборке для Vercel путь передаётся явно.
export function defaultMigrationsFolder(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
}

// Под advisory lock: на Vercel несколько холодных стартов могут прийти одновременно.
export async function runMigrations(databaseUrl: string, migrationsFolder = defaultMigrationsFolder()): Promise<void> {
  let hostname: string;
  try { hostname = new URL(databaseUrl).hostname.toLowerCase(); }
  catch { throw new Error('Migrations require a valid direct PostgreSQL connection'); }
  if (hostname.endsWith('.neon.tech') && hostname.split('.')[0]!.endsWith('-pooler')) {
    throw new Error('Migrations require DATABASE_URL_UNPOOLED or POSTGRES_URL_NON_POOLING');
  }
  const client = new pg.Client({ connectionString: databaseUrl, application_name: 'gudex:migrations:v2',
    connectionTimeoutMillis: 10_000, statement_timeout: 15_000, lock_timeout: 5_000, query_timeout: 20_000 });
  let locked = false;
  try {
    await client.connect();
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    locked = true;
    await migrate(drizzle({ client }), { migrationsFolder });
  } finally {
    try {
      if (locked) {
        const result = await client.query<{ unlocked: boolean }>('select pg_advisory_unlock($1) as unlocked', [MIGRATION_LOCK_ID]);
        if (result.rows[0]?.unlocked !== true) throw new Error('Migration lock cleanup could not be verified');
      }
    } finally {
      // Closing the dedicated direct connection also releases a lock if a
      // failed query made its explicit unlock impossible.
      await client.end();
    }
  }
}
