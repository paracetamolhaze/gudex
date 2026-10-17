import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';

// Очередь задач на PostgreSQL. Задача ставится в той же транзакции, что и бизнес-запись,
// поэтому «деньги зарезервированы, а задача потерялась» невозможно.

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
  // Пока задача с таким ключом в очереди или выполняется, дубликат не создаётся.
  dedupeKey?: string;
}

export async function enqueue(db: DbOrTx, queue: string, payload: object, options: EnqueueOptions = {}): Promise<void> {
  const runAt = options.runAt ?? new Date();
  const maxAttempts = options.maxAttempts ?? 8;
  await db.execute(sql`
    insert into jobs (queue, payload, run_at, max_attempts, dedupe_key)
    values (${queue}, ${JSON.stringify(payload)}::jsonb, ${runAt.toISOString()}::timestamptz, ${maxAttempts}, ${options.dedupeKey ?? null})
    on conflict (dedupe_key) where status in ('queued', 'running') do nothing
  `);
}

// Ошибка, после которой повторять бессмысленно.
export class PermanentJobError extends Error {}

export class JobLeaseLostError extends Error {}

export interface JobContext {
  signal: AbortSignal;
  // Проверяется непосредственно перед внешней записью. Просроченный владелец не отправляет новую операцию.
  assertActive(): Promise<void>;
}

// Не ошибка: «рано, проверь позже» (например, KYC ещё на проверке). Попытка не засчитывается.
export class RetryLater extends Error {
  constructor(readonly delaySeconds: number) {
    super(`retry in ${delaySeconds}s`);
  }
}

export interface JobHandler {
  run(payload: any, context?: JobContext): Promise<void>;
  // Финансовые задачи нельзя запускать заново после потери lease или неизвестного результата.
  replaySafe?: boolean;
  // Идемпотентный хук окончательного сбоя или прерванной финансовой задачи.
  onExhausted?(payload: any, error: Error): Promise<void>;
}

interface ClaimedJob {
  id: string;
  queue: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  lock_token: string;
  expired: boolean;
}

export interface DrainOptions {
  maxDurationMs?: number;
  maxJobs?: number;
}

export interface RunnerOptions extends DrainOptions {
  leaseMs?: number;
  heartbeatMs?: number;
}

export class JobRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;

  constructor(
    private readonly db: Db,
    private readonly handlers: Record<string, JobHandler>,
    private readonly log: (msg: string, extra?: object) => void = () => {},
    private readonly pollMs = 500,
    private readonly options: RunnerOptions = {},
  ) {}

  start(): void {
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.drain({ maxDurationMs: this.options.maxDurationMs ?? 300_000, maxJobs: this.options.maxJobs });
      } catch (err) {
        this.log('job runner tick failed', { err: String(err) });
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.pollMs);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 20));
  }

  // Ограничиваем и количество задач, и время одного serverless-вызова.
  async drain(options: DrainOptions = {}): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let processed = 0;
    const deadline = Date.now() + Math.max(1, options.maxDurationMs ?? 45_000);
    const maxJobs = Math.max(1, options.maxJobs ?? 100);
    try {
      while (processed < maxJobs && Date.now() < deadline) {
        const job = await this.claim();
        if (!job) break;
        await this.execute(job, deadline);
        processed++;
      }
    } finally {
      this.running = false;
    }
    return processed;
  }

  private async claim(): Promise<ClaimedJob | null> {
    const token = randomUUID();
    const leaseSeconds = (this.options.leaseMs ?? 120_000) / 1000;
    const result = await this.db.execute(sql`
      with candidate as (
        select id, status = 'running' as expired from jobs
        where (status = 'queued' and run_at <= now())
           or (status = 'running' and locked_until < now())
        order by run_at
        for update skip locked
        limit 1
      )
      update jobs j
      set status = 'running', attempts = attempts + 1,
          locked_until = now() + make_interval(secs => ${leaseSeconds}), lock_token = ${token}::uuid, updated_at = now()
      from candidate c where j.id = c.id
      returning j.id, j.queue, j.payload, j.attempts, j.max_attempts, j.lock_token, c.expired
    `);
    return (result.rows[0] as unknown as ClaimedJob | undefined) ?? null;
  }

  private async execute(job: ClaimedJob, deadline: number): Promise<void> {
    const handler = this.handlers[job.queue];
    const controller = new AbortController();
    const leaseSeconds = (this.options.leaseMs ?? 120_000) / 1000;
    const ownership = sql`id = ${job.id} and lock_token = ${job.lock_token}::uuid and status = 'running'`;
    const context: JobContext = {
      signal: controller.signal,
      assertActive: async () => {
        if (controller.signal.aborted) throw new JobLeaseLostError('Job execution deadline or lease lost');
        const result = await this.db.execute(sql`select id from jobs where ${ownership} and locked_until > now()`);
        if (!result.rows[0] || controller.signal.aborted) {
          controller.abort();
          throw new JobLeaseLostError('Job lease lost');
        }
      },
    };
    let heartbeatRunning = false;
    const heartbeat = setInterval(() => {
      if (heartbeatRunning || controller.signal.aborted) return;
      heartbeatRunning = true;
      void this.db.execute(sql`
        update jobs set locked_until = now() + make_interval(secs => ${leaseSeconds}), updated_at = now()
        where ${ownership} and locked_until > now() returning id
      `).then((result) => {
        if (!result.rows[0]) controller.abort();
      }).catch(() => controller.abort()).finally(() => { heartbeatRunning = false; });
    }, this.options.heartbeatMs ?? 30_000);
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    let rejectOnAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectOnAbort = () => reject(new JobLeaseLostError('Job execution deadline or lease lost'));
      controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
    });
    try {
      if (!handler) throw new PermanentJobError(`No handler for queue ${job.queue}`);
      if (job.expired && handler.replaySafe === false) throw new JobLeaseLostError('Financial job lease expired; reconcile before any further submission');
      await Promise.race([handler.run(job.payload, context), aborted]);
      await context.assertActive();
      await this.db.execute(sql`update jobs set status = 'done', locked_until = null, lock_token = null, updated_at = now() where ${ownership}`);
    } catch (err) {
      if (err instanceof RetryLater && !controller.signal.aborted) {
        await this.db.execute(sql`
          update jobs set status = 'queued', attempts = attempts - 1, locked_until = null, lock_token = null,
                 run_at = now() + make_interval(secs => ${err.delaySeconds}), updated_at = now()
          where ${ownership}
        `);
        return;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      const permanent = handler?.replaySafe === false || error instanceof PermanentJobError || job.attempts >= job.max_attempts;
      this.log(`job ${job.queue}#${job.id} failed (attempt ${job.attempts}/${job.max_attempts})`, {
        error: error.message,
        permanent,
      });
      if (permanent) {
        await this.db.transaction(async (tx) => {
          // Блокировка защищает и acknowledgement, и бизнес-хук от устаревшего владельца.
          const owner = await tx.execute(sql`select id from jobs where ${ownership} for update`);
          if (!owner.rows[0]) return;
          try {
            await handler?.onExhausted?.(job.payload, error);
          } catch (hookErr) {
            this.log(`job ${job.queue}#${job.id} onExhausted failed`, { error: String(hookErr) });
            // Финансовая задача при следующем claim попадёт только в хук, без повторной отправки.
            await tx.execute(sql`update jobs set last_error = 'Failure cleanup requires retry', locked_until = now() + interval '5 seconds', updated_at = now() where ${ownership}`);
            return;
          }
          await tx.execute(sql`
            update jobs set status = 'failed', last_error = ${error.message}, locked_until = null, lock_token = null, updated_at = now()
            where ${ownership}
          `);
        });
      } else {
        const delaySeconds = Math.min(2 ** job.attempts * 2, 300);
        await this.db.execute(sql`
          update jobs set status = 'queued', last_error = ${error.message}, locked_until = null, lock_token = null,
                 run_at = now() + make_interval(secs => ${delaySeconds}), updated_at = now()
          where ${ownership}
        `);
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timer);
      if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort);
    }
  }
}
