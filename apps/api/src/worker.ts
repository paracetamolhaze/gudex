import { createServices, jobHandlers } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { runMigrations } from './db/migrate';
import { enqueue, JobRunner } from './queue/queue';
import { createRuntimeDeps } from './runtime';
import { prepareRuntimeMode } from './runtime-mode';

// Persistent worker for a VPS/container. Uses the same DB and providers as the API.
// Vercel deployments can instead be woken by authenticated POST /v1/ops/queue/drain.
const config = loadConfig();
await runMigrations(config.DATABASE_URL_UNPOOLED ?? config.POSTGRES_URL_NON_POOLING ?? config.DATABASE_URL);
const { db, pool } = createDb(config.DATABASE_URL);
await prepareRuntimeMode(config, db);
const services = createServices(createRuntimeDeps(config, db));
const runner = new JobRunner(db, jobHandlers(services), (message, extra) => console.warn(message, extra ?? ''), config.JOB_POLL_MS);
runner.start();
const sync = () => enqueue(db, 'cards.sync_all', {}, { dedupeKey: 'cards.sync_all', maxAttempts: 1 }).catch(() => console.error('Failed to schedule card sync'));
await sync();
const timer = setInterval(sync, 60000);
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await runner.stop();
  await pool.end();
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
