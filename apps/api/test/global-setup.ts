import pg from 'pg';
import { runMigrations } from '../src/db/migrate';
import { assertLocalTestDatabase } from './database-target';

// Перед прогоном: чистая тестовая база с актуальными миграциями.
export default async function setup(): Promise<void> {
  const url = assertLocalTestDatabase(process.env.TEST_DATABASE_URL ?? 'postgres://gudex:gudex@localhost:5442/gudex_test');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;');
  await client.end();
  await runMigrations(url);
}
