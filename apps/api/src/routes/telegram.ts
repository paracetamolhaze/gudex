import type { FastifyPluginAsync } from 'fastify';
import type { Deps } from '../app';
import { appSettings } from '../db/schema';
import { enqueue } from '../queue/queue';
import type { BotService } from '../telegram/bot-service';
import { requireOps } from './ops-auth';

export const CRON_HEARTBEAT_KEY = 'cron_heartbeat';
const DEFAULT_CRON_SCHEDULE = '0 4 * * *';

// Build Output and the API bundle use the same value (injected by build-vercel.mjs).
// This is public scheduling metadata, not an environment secret.
export function cronReadiness(value: unknown, now = Date.now(), schedule = process.env.GUDEX_CRON_SCHEDULE || DEFAULT_CRON_SCHEDULE) {
  const fixedMinute = '\\d{1,2}';
  const everyMinutes = schedule.match(/^\*\/([1-9]\d?) \* \* \* \*$/);
  const intervalSeconds = schedule === '* * * * *' ? 60 : everyMinutes && Number(everyMinutes[1]) <= 59 ? Number(everyMinutes[1]) * 60 :
    new RegExp(`^${fixedMinute} \\* \\* \\* \\*$`).test(schedule) ? 3600 :
    new RegExp(`^${fixedMinute} ${fixedMinute} \\* \\* \\*$`).test(schedule) ? 86400 : null;
  const maxAgeSeconds = intervalSeconds === null ? null : intervalSeconds + (intervalSeconds >= 86400 ? 7200 : 120);
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>).lastTickAt : undefined;
  const timestamp = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw) ? Date.parse(raw) : NaN;
  const valid = Number.isFinite(timestamp) && timestamp <= now + 60_000;
  const ageSeconds = valid ? Math.max(0, Math.floor((now - timestamp) / 1000)) : null;
  const status = !valid ? 'never_seen' : maxAgeSeconds === null ? 'unclassified_schedule' : ageSeconds! <= maxAgeSeconds ? 'healthy' : 'stale';
  return { schedule, lastTickAt: valid ? new Date(timestamp).toISOString() : null, ageSeconds, maxAgeSeconds,
    status, healthy: status === 'healthy', verifies: 'authorized_tick_and_sync_enqueue' };
}

export const telegramRoutes =
  (deps: Deps, botService: BotService): FastifyPluginAsync =>
  async (app) => {
    // Вебхук бота. Telegram присылает секрет в заголовке — без него запрос игнорируем.
    app.post('/telegram/webhook', async (request, reply) => {
      if (request.headers['x-telegram-bot-api-secret-token'] !== botService.webhookSecret) return reply.status(401).send();
      try {
        await botService.handleUpdate(request.body as Parameters<BotService['handleUpdate']>[0]);
      } catch (err) {
        // Ошибку логируем, но отвечаем 200: иначе Telegram будет бесконечно повторять апдейт.
        request.log.error(err, 'telegram update failed');
      }
      return { ok: true };
    });

    // Настройка бота: вебхук на этот сервер и кнопка меню, открывающая Mini App. Идемпотентна.
    app.post('/telegram/setup', async request => { requireOps(request, deps.config); return botService.setup(); });
    app.get('/telegram/status', async request => { requireOps(request, deps.config); return botService.status(); });

    // Периодическая сверка с партнёром (Vercel Cron) — подстраховка к синхронизации по запросам.
    app.get('/cron', async request => {
      requireOps(request, deps.config, true);
      await deps.db.transaction(async tx => {
        await enqueue(tx, 'cards.sync_all', {}, { dedupeKey: 'cards.sync_all', maxAttempts: 1 });
        if (deps.config.CARD_PARTNER === 'upay' && deps.depositInvoices?.configured && !deps.config.DEV_TOOLS) {
          await enqueue(tx, 'deposit.invoices.sync_all', {}, { dedupeKey: 'deposit.invoices.sync_all', maxAttempts: 1 });
        }
        const tick = new Date();
        await tx.insert(appSettings).values({ key: CRON_HEARTBEAT_KEY, value: { lastTickAt: tick.toISOString() }, updatedAt: tick })
          .onConflictDoUpdate({ target: appSettings.key, set: { value: { lastTickAt: tick.toISOString() }, updatedAt: tick } });
      });
      return { ok: true };
    });
  };
