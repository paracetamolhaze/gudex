import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client';
import { adminNotifications, users } from '../../src/db/schema';
import { AdminNotificationService, notifyAdmins } from '../../src/services/admin-notify';
import { LogBotApi } from '../../src/telegram/bot';

type OutboxRow = typeof adminNotifications.$inferSelect;
type Job = { queue: string; payload: { notificationId: string }; dedupeKey: string; maxAttempts: number };

function fixture(adminIds = ['999', '1001']) {
  const notifications = new Map<string, OutboxRow>();
  const jobs: Job[] = [];
  const user = { id: randomUUID(), telegramId: 42n, firstName: 'PRIVATE_NAME', email: 'PRIVATE_EMAIL',
    documentId: 'PRIVATE_PASSPORT', pan: 'PRIVATE_CARD', otp: 'PRIVATE_OTP' };
  const config = { adminTelegramIds: adminIds, publicUrl: 'https://gudex.test/' as string | null };
  const dialect = new PgDialect();
  let tail = Promise.resolve();
  let rowLocks = 0;
  const db = {
    transaction: async (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      const oldRows = structuredClone([...notifications]);
      const oldJobs = structuredClone(jobs);
      try { return await run(db); }
      catch (error) {
        notifications.clear();
        for (const [id, row] of oldRows) notifications.set(id, row);
        jobs.splice(0, jobs.length, ...oldJobs);
        throw error;
      } finally { release(); }
    },
    insert: (table: unknown) => ({ values: (input: Omit<OutboxRow, 'id' | 'createdAt' | 'sentAt'>) => ({
      onConflictDoNothing: () => ({ returning: async () => {
        if (table !== adminNotifications) throw new Error('Unexpected outbox table');
        if ([...notifications.values()].some(row => row.eventKey === input.eventKey && row.recipientTelegramId === input.recipientTelegramId)) return [];
        const row = { ...input, id: randomUUID(), createdAt: new Date(), sentAt: null };
        notifications.set(row.id, row);
        return [{ id: row.id }];
      } }),
    }) }),
    select: () => {
      let table: unknown;
      let id: unknown;
      const rows = () => table === adminNotifications ? [...notifications.values()].filter(row => row.id === id)
        : table === users ? user.id === id ? [user] : [] : (() => { throw new Error('Unexpected outbox query'); })();
      const query = {
        from: (value: unknown) => { table = value; return query; },
        where: (condition: SQL) => { id = dialect.sqlToQuery(condition).params[0]; return query; },
        for: async (mode: string) => { expect(mode).toBe('update'); rowLocks++; return rows(); },
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows()).then(resolve),
      };
      return query;
    },
    update: (table: unknown) => ({ set: (patch: Partial<OutboxRow>) => ({ where: async (condition: SQL) => {
      if (table !== adminNotifications) throw new Error('Unexpected outbox update');
      const row = notifications.get(String(dialect.sqlToQuery(condition).params[0]));
      if (row) Object.assign(row, patch);
    } }) }),
    execute: async (query: SQL) => {
      const { sql, params } = dialect.sqlToQuery(query);
      if (!sql.trim().startsWith('insert into jobs')) throw new Error('Only durable notification enqueue is permitted');
      jobs.push({ queue: String(params[0]), payload: JSON.parse(String(params[1])), maxAttempts: Number(params[3]), dedupeKey: String(params[4]) });
      return { rows: [] };
    },
  };
  const bot = new LogBotApi();
  const sendMessage = vi.spyOn(bot, 'sendMessage');
  const typedDb = db as unknown as Db;
  const service = new AdminNotificationService(typedDb, bot, config);
  const input = { userId: user.id, eventKey: `application:${randomUUID()}:verification`, stage: 'verification' as const };
  const submit = () => typedDb.transaction(tx => notifyAdmins(tx, config, input));
  const send = (notificationId: string) => service.handlers()['admin.notify']!.run({ notificationId });
  return { db: typedDb, config, input, user, notifications, jobs, bot, sendMessage, submit, send, rowLocks: () => rowLocks };
}

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in administrator notification tests'); })); });
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('administrator notification outbox', () => {
  it('creates one durable notification per distinct administrator and never re-enqueues the same event after delivery', async () => {
    const f = fixture(['999', '999', '1001']);
    await Promise.all([f.submit(), f.submit()]);
    expect(f.notifications.size).toBe(2);
    expect(f.jobs).toHaveLength(2);
    expect(f.jobs.every(job => job.queue === 'admin.notify' && job.maxAttempts === 5)).toBe(true);
    for (const job of f.jobs) {
      expect(Object.keys(job.payload)).toEqual(['notificationId']);
      await f.send(job.payload.notificationId);
    }
    await f.submit();
    expect(f.jobs).toHaveLength(2);
    expect(f.bot.sent).toHaveLength(2);
  });

  it('rolls back both outbox and jobs when the application transaction fails', async () => {
    const f = fixture();
    await expect(f.db.transaction(async tx => {
      await notifyAdmins(tx, f.config, f.input);
      throw new Error('Application did not commit');
    })).rejects.toThrow('Application did not commit');
    expect(f.notifications.size).toBe(0);
    expect(f.jobs).toHaveLength(0);
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it('sends only stable client identifiers and stage with an administrator link', async () => {
    const f = fixture(['999']);
    await f.submit();
    await f.send(f.jobs[0]!.payload.notificationId);
    const [recipient, text, button] = f.sendMessage.mock.calls[0] as unknown as [bigint, string, unknown];
    expect(recipient).toBe(999n);
    expect(text).toContain(f.user.id);
    expect(text).toContain('<code>42</code>');
    expect(text).toContain('Верификация');
    expect(button).toEqual({ text: 'Открыть админку', url: 'https://gudex.test/admin' });
    for (const privateValue of ['PRIVATE_NAME', 'PRIVATE_EMAIL', 'PRIVATE_PASSPORT', 'PRIVATE_CARD', 'PRIVATE_OTP', f.input.eventKey]) {
      expect(text).not.toContain(privateValue);
    }
    expect([...f.notifications.values()][0]!.sentAt).toBeInstanceOf(Date);
  });

  it('isolates a failed recipient and retries without resending to recipients already notified', async () => {
    const f = fixture();
    await f.submit();
    f.sendMessage.mockRejectedValueOnce(new Error('Telegram temporarily unavailable'));
    const [first, second] = f.jobs;
    await expect(f.send(first!.payload.notificationId)).rejects.toThrow('Telegram temporarily unavailable');
    expect(f.notifications.get(first!.payload.notificationId)!.sentAt).toBeNull();
    await f.send(second!.payload.notificationId);
    await f.send(first!.payload.notificationId);
    await f.send(second!.payload.notificationId);
    expect(f.bot.sent.map(message => message.chatId).sort()).toEqual(['1001', '999']);
    expect([...f.notifications.values()].every(row => row.sentAt instanceof Date)).toBe(true);
  });

  it('serializes duplicate workers on the outbox row and skips completed delivery', async () => {
    const f = fixture(['999']);
    await f.submit();
    const id = f.jobs[0]!.payload.notificationId;
    await Promise.all([f.send(id), f.send(id)]);
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.rowLocks()).toBe(2);
  });

  it('does not send queued notices to a recipient removed from the allowlist', async () => {
    const f = fixture(['999']);
    await f.submit();
    f.config.adminTelegramIds = [];
    await f.send(f.jobs[0]!.payload.notificationId);
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it('handles no administrators, a missing notification, and a missing client without sending', async () => {
    const f = fixture([]);
    await f.submit();
    expect(f.jobs).toHaveLength(0);
    await f.send(randomUUID());
    f.config.adminTelegramIds = ['999'];
    await f.submit();
    f.user.id = randomUUID();
    await f.send(f.jobs[0]!.payload.notificationId);
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it('labels issuance separately and can send without a public link', async () => {
    const f = fixture(['999']);
    f.config.publicUrl = null;
    await f.db.transaction(tx => notifyAdmins(tx, f.config, { ...f.input, stage: 'issuance' }));
    await f.send(f.jobs[0]!.payload.notificationId);
    expect(f.sendMessage).toHaveBeenCalledWith(999n, expect.stringContaining('Выпуск карты'), undefined);
  });
});
