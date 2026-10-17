import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { enqueue, JobLeaseLostError, JobRunner } from '../src/queue/queue';
import { createTestContext, type TestContext } from './helpers';

let ctx: TestContext;
afterEach(async () => { await ctx?.close(); });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('durable queue ownership and serverless bounds', () => {
  it('stops draining after the requested number of jobs', async () => {
    ctx = await createTestContext();
    let calls = 0;
    for (let i = 0; i < 3; i++) await enqueue(ctx.db, 'test.count', {});
    const runner = new JobRunner(ctx.db, { 'test.count': { run: async () => { calls++; } } });
    expect(await runner.drain({ maxJobs: 1 })).toBe(1);
    expect(calls).toBe(1);
    expect(await runner.drain()).toBe(2);
    expect(calls).toBe(3);
  });

  it('sends an expired financial job to reconciliation without replaying its handler', async () => {
    ctx = await createTestContext();
    let submissions = 0;
    let uncertain = 0;
    await enqueue(ctx.db, 'test.financial', {});
    await ctx.db.execute(sql`update jobs set status = 'running', lock_token = ${randomUUID()}::uuid, locked_until = now() - interval '1 second' where queue = 'test.financial'`);
    const runner = new JobRunner(ctx.db, { 'test.financial': { replaySafe: false, run: async () => { submissions++; }, onExhausted: async () => { uncertain++; } } });
    expect(await runner.drain()).toBe(1);
    expect(submissions).toBe(0);
    expect(uncertain).toBe(1);
    expect((await ctx.db.execute(sql`select status, lock_token from jobs where queue = 'test.financial'`)).rows[0]).toEqual({ status: 'failed', lock_token: null });
  });

  it('fences a stale owner from acknowledging a job or starting an external write', async () => {
    ctx = await createTestContext();
    const nextOwner = randomUUID();
    let submissions = 0;
    let exhausted = 0;
    await enqueue(ctx.db, 'test.fenced', {});
    const runner = new JobRunner(ctx.db, {
      'test.fenced': {
        replaySafe: false,
        run: async (_, context) => {
          await ctx.db.execute(sql`update jobs set lock_token = ${nextOwner}::uuid where queue = 'test.fenced'`);
          await expect(context!.assertActive()).rejects.toBeInstanceOf(JobLeaseLostError);
          if (!context!.signal.aborted) submissions++;
        },
        onExhausted: async () => { exhausted++; },
      },
    });
    await runner.drain({ maxJobs: 1 });
    expect(submissions).toBe(0);
    expect(exhausted).toBe(0);
    expect((await ctx.db.execute(sql`select status, lock_token from jobs where queue = 'test.fenced'`)).rows[0]).toEqual({ status: 'running', lock_token: nextOwner });
  });

  it('retries a failed financial cleanup hook without replaying the submission', async () => {
    ctx = await createTestContext();
    let submissions = 0;
    let cleanups = 0;
    await enqueue(ctx.db, 'test.cleanup', {});
    await ctx.db.execute(sql`update jobs set status = 'running', locked_until = now() - interval '1 second' where queue = 'test.cleanup'`);
    const runner = new JobRunner(ctx.db, {
      'test.cleanup': {
        replaySafe: false,
        run: async () => { submissions++; },
        onExhausted: async () => { cleanups++; if (cleanups === 1) throw new Error('temporary cleanup outage'); },
      },
    });
    await runner.drain();
    expect((await ctx.db.execute(sql`select status from jobs where queue = 'test.cleanup'`)).rows[0]).toEqual({ status: 'running' });
    await ctx.db.execute(sql`update jobs set locked_until = now() - interval '1 second' where queue = 'test.cleanup'`);
    await runner.drain();
    expect(submissions).toBe(0);
    expect(cleanups).toBe(2);
    expect((await ctx.db.execute(sql`select status from jobs where queue = 'test.cleanup'`)).rows[0]).toEqual({ status: 'failed' });
  });

  it('renews a live lease so another worker cannot claim the long task', async () => {
    ctx = await createTestContext();
    let submissions = 0;
    await enqueue(ctx.db, 'test.heartbeat', {});
    const handlers = { 'test.heartbeat': { replaySafe: false, run: async () => { submissions++; await delay(700); } } };
    const first = new JobRunner(ctx.db, handlers, undefined, 500, { leaseMs: 300, heartbeatMs: 40 });
    const second = new JobRunner(ctx.db, handlers);
    const completion = first.drain({ maxDurationMs: 2000 });
    await delay(450);
    expect(await second.drain()).toBe(0);
    await completion;
    expect(submissions).toBe(1);
    expect((await ctx.db.execute(sql`select status, attempts from jobs where queue = 'test.heartbeat'`)).rows[0]).toEqual({ status: 'done', attempts: 1 });
  });

  it('bounds the drain deadline and aborts a delayed external write', async () => {
    ctx = await createTestContext();
    let submissions = 0;
    let uncertain = 0;
    await enqueue(ctx.db, 'test.deadline', {});
    const runner = new JobRunner(ctx.db, {
      'test.deadline': {
        replaySafe: false,
        run: async (_, context) => { await delay(150); await context!.assertActive(); submissions++; },
        onExhausted: async () => { uncertain++; },
      },
    });
    const started = Date.now();
    await runner.drain({ maxDurationMs: 50 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(uncertain).toBe(1);
    await delay(200);
    expect(submissions).toBe(0);
    expect((await ctx.db.execute(sql`select status from jobs where queue = 'test.deadline'`)).rows[0]).toEqual({ status: 'failed' });
  });
});
