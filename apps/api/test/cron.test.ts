import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { appSettings, jobs } from '../src/db/schema';
import { CRON_HEARTBEAT_KEY } from '../src/routes/telegram';
import { createTestContext, type TestContext } from './helpers';

const opsToken = 'fixture-operator-secret-at-least-thirty-two-characters';
const cronToken = 'fixture-dedicated-cron-secret-at-least-thirty-two-characters';
let ctx: TestContext | undefined;
afterEach(async () => { await ctx?.close(); ctx = undefined; });

describe('cron scheduler heartbeat', () => {
  it('records only authorized ticks with a deduplicated sync job and exposes read-only readiness', async () => {
    let wakeups = 0;
    ctx = await createTestContext(undefined, { env: { OPS_API_TOKEN: opsToken, CRON_SECRET: cronToken }, onResponse: () => { wakeups++; } });
    const status = () => ctx!.app.inject({ method: 'GET', url: '/v1/ops/status', headers: { authorization: `Bearer ${opsToken}` } });
    expect((await status()).json().cron).toMatchObject({ lastTickAt: null, healthy: false, status: 'never_seen' });
    for (const secret of ['', opsToken]) {
      expect((await ctx.app.inject({ method: 'GET', url: '/v1/cron', headers: { authorization: `Bearer ${secret}` } })).statusCode).toBe(401);
    }
    expect(await ctx.db.select().from(appSettings).where(eq(appSettings.key, CRON_HEARTBEAT_KEY))).toHaveLength(0);
    expect(await ctx.db.select().from(jobs)).toHaveLength(0);
    expect(wakeups).toBe(0);
    wakeups = 0;
    for (let i = 0; i < 2; i++) {
      expect((await ctx.app.inject({ method: 'GET', url: '/v1/cron', headers: { authorization: `Bearer ${cronToken}` } })).statusCode).toBe(200);
    }
    expect(wakeups).toBe(2);
    expect(await ctx.db.select().from(jobs)).toEqual([expect.objectContaining({ queue: 'cards.sync_all', status: 'queued' })]);
    const [heartbeat] = await ctx.db.select().from(appSettings).where(eq(appSettings.key, CRON_HEARTBEAT_KEY));
    expect(heartbeat?.value).toEqual({ lastTickAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    const ready = (await status()).json().cron;
    expect(ready).toMatchObject({ healthy: true, status: 'healthy', verifies: 'authorized_tick_and_sync_enqueue' });
    expect(wakeups).toBe(2);
    expect(JSON.stringify(ready)).not.toContain(opsToken);
    expect(JSON.stringify(ready)).not.toContain(cronToken);
    expect((await ctx.db.select().from(jobs))[0]?.status).toBe('queued');
  });
});
