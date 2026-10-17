import { buildApp, createServices, jobHandlers } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { runMigrations } from './db/migrate';
import { enqueue, JobRunner } from './queue/queue';
import { createRuntimeDeps } from './runtime';
import { prepareRuntimeMode } from './runtime-mode';

// Локальный сервер для разработки. На Vercel вместо него — src/serverless.ts.
const config = loadConfig();
await runMigrations(config.DATABASE_URL_UNPOOLED ?? config.POSTGRES_URL_NON_POOLING ?? config.DATABASE_URL);

const { db, pool } = createDb(config.DATABASE_URL);
await prepareRuntimeMode(config, db);
const deps = createRuntimeDeps(config, db);
const services = createServices(deps);
const runner = new JobRunner(db, jobHandlers(services), (msg, extra) => console.warn(msg, extra ?? ''), config.JOB_POLL_MS);
const app = await buildApp(deps, services, { drainJobs: () => runner.drain({ maxDurationMs: config.JOB_DRAIN_MS, maxJobs: 50 }) });
runner.start();

// Периодическая сверка транзакций по картам с партнёром.
const syncTimer = setInterval(() => {
  enqueue(db, 'cards.sync_all', {}, { dedupeKey: 'cards.sync_all', maxAttempts: 1 }).catch((err) =>
    app.log.error(err, 'failed to schedule card sync'),
  );
}, 60_000);

await app.listen({ port: config.PORT, host: config.HOST });

const shutdown = async () => {
  clearInterval(syncTimer);
  await app.close();
  await runner.stop();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
