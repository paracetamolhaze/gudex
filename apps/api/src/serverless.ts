import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitUntil } from '@vercel/functions';
import type { FastifyInstance } from 'fastify';
import { buildApp, createServices, jobHandlers } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { runMigrations } from './db/migrate';
import { JobRunner } from './queue/queue';
import { createRuntimeDeps } from './runtime';
import { prepareRuntimeMode } from './runtime-mode';

// Точка входа для Vercel Functions. Постоянного воркера нет, поэтому очередь задач
// разбирается после каждого ответа (waitUntil) — пока клиент опрашивает статус, задачи продвигаются.

let ready: Promise<FastifyInstance> | null = null;

async function init(): Promise<FastifyInstance> {
  const config = loadConfig();
  // Миграции лежат рядом с собранной функцией (см. scripts/build-vercel.mjs).
  await runMigrations(config.DATABASE_URL_UNPOOLED ?? config.POSTGRES_URL_NON_POOLING ?? config.DATABASE_URL,
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'drizzle'));
  const { db } = createDb(config.DATABASE_URL);
  await prepareRuntimeMode(config, db);
  const deps = createRuntimeDeps(config, db);
  const services = createServices(deps);
  const runner = new JobRunner(db, jobHandlers(services), (msg, extra) => console.warn(msg, extra ?? ''));
  const app = await buildApp(deps, services, {
    drainJobs: () => runner.drain({ maxDurationMs: config.JOB_DRAIN_MS, maxJobs: 50 }),
    onResponse: () => waitUntil(runner.drain({ maxDurationMs: config.JOB_DRAIN_MS, maxJobs: 50 }).catch(() => console.error('job drain failed'))),
  });
  await app.ready();
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ready ??= init().catch((err) => {
    ready = null;
    throw err;
  });
  let app: FastifyInstance;
  try { app = await ready; }
  catch {
    res.statusCode = 503;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: { code: 'provider_unavailable', message: 'Service is starting; try again shortly' } }));
    return;
  }
  app.server.emit('request', req, res);
}
