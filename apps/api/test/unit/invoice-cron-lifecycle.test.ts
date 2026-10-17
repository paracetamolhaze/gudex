import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Deps } from '../../src/app';
import { loadConfig } from '../../src/config';
import { telegramRoutes } from '../../src/routes/telegram';
import type { BotService } from '../../src/telegram/bot-service';

const fixture = vi.hoisted(() => ({ enqueue: vi.fn(async () => {}) }));
vi.mock('../../src/queue/queue', () => ({ enqueue: fixture.enqueue }));
beforeEach(() => { fixture.enqueue.mockClear(); });

describe('existing native invoice reads remain scheduled independently of invoice creation', () => {
  it.each([true, false])('schedules read reconciliation with creation disabled only if live credentials remain available: %s', async configured => {
    const secret = 'fixture-ops-secret-at-least-32-characters';
    const config = loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'fixture-jwt-secret-at-least-16', OPS_API_TOKEN: secret,
      CARD_PARTNER: 'upay', DEV_TOOLS: 'false', UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture',
      UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ', UPAY_INVOICE_DEPOSITS_ENABLED: 'false' });
    const tx = { insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }) };
    const deps = { config, depositInvoices: { configured }, db: { transaction: async (fn: (value: typeof tx) => Promise<void>) => fn(tx) } } as unknown as Deps;
    const app = Fastify({ logger: false });
    try {
      await app.register(telegramRoutes(deps, {} as BotService), { prefix: '/v1' });
      const result = await app.inject({ method: 'GET', url: '/v1/cron', headers: { authorization: `Bearer ${secret}` } });
      expect(result.statusCode).toBe(200);
      const invoiceCalls = fixture.enqueue.mock.calls.filter(call => (call as unknown[])[1] === 'deposit.invoices.sync_all');
      expect(invoiceCalls).toHaveLength(configured ? 1 : 0);
    } finally { await app.close(); }
  });
});
