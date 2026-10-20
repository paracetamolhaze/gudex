import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { SupportMessageDto, SupportThreadDto } from '@gudex/shared';
import type { Config } from '../config';
import type { Db, Tx } from '../db/client';
import { kycProfiles, supportMessages, supportThreads, users } from '../db/schema';
import { AppError } from '../lib/errors';
import { notifyAdmins } from './admin-notify';
import { notify } from './notify';

// In-app support: one conversation per client. The client writes in the Mini App, the operator answers in the admin;
// Telegram only says that something new arrived — the text stays in the app.

const MAX_TEXT = 2000;
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT = 10;
const HISTORY = 200;

type Thread = typeof supportThreads.$inferSelect;
type Message = typeof supportMessages.$inferSelect;

function clean(value: string): string {
  // Plain text: no control characters except line breaks, at most two empty lines in a row.
  const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new AppError('validation', 'Напишите сообщение');
  if (text.length > MAX_TEXT) throw new AppError('validation', `Сообщение длиннее ${MAX_TEXT} символов`);
  return text;
}

const toMessage = (row: Message): SupportMessageDto => ({ id: row.id, author: row.author as SupportMessageDto['author'], text: row.text, createdAt: row.createdAt.toISOString() });
const newer = (at: Date | null, read: Date | null) => at !== null && (read === null || at > read);

export class SupportService {
  constructor(private readonly db: Db, private readonly config: Config) {}

  private async messages(userId: string, db: Db | Tx = this.db): Promise<SupportMessageDto[]> {
    const rows = await db.select().from(supportMessages).where(eq(supportMessages.userId, userId))
      .orderBy(desc(supportMessages.createdAt), desc(supportMessages.id)).limit(HISTORY);
    return rows.reverse().map(toMessage);
  }

  private dto(thread: Thread | undefined, messages: SupportMessageDto[], side: 'client' | 'support'): SupportThreadDto {
    return { status: (thread?.status ?? 'open') as SupportThreadDto['status'], messages,
      unread: thread ? side === 'client' ? newer(thread.lastSupportMessageAt, thread.clientReadAt) : newer(thread.lastClientMessageAt, thread.supportReadAt) : false };
  }

  // ─── Client ─────────────────────────────────────────────────────────

  /** Opening the conversation marks the answers read. The marker never falls behind the newest answer on the locked row,
   * so an answer committed while this request waited for the row is not left unread forever. */
  async clientThread(userId: string): Promise<SupportThreadDto> {
    const now = new Date();
    const [thread] = await this.db.update(supportThreads)
      .set({ clientReadAt: sql`greatest(${now.toISOString()}::timestamptz, coalesce(${supportThreads.lastSupportMessageAt}, ${now.toISOString()}::timestamptz))` })
      .where(eq(supportThreads.userId, userId)).returning();
    return this.dto(thread, thread ? await this.messages(userId) : [], 'client');
  }

  async hasUnreadAnswer(userId: string): Promise<boolean> {
    const [thread] = await this.db.select().from(supportThreads).where(eq(supportThreads.userId, userId));
    return Boolean(thread && newer(thread.lastSupportMessageAt, thread.clientReadAt));
  }

  async clientWrite(userId: string, value: string): Promise<SupportThreadDto> {
    const text = clean(value);
    await this.db.transaction(async tx => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      const [before] = await tx.select().from(supportThreads).where(eq(supportThreads.userId, userId)).for('update');
      // The time is taken once the row is locked, so it is later than any read marker already written.
      const now = new Date();
      const [recent] = await tx.select({ value: count() }).from(supportMessages).where(and(eq(supportMessages.userId, userId),
        eq(supportMessages.author, 'client'), gte(supportMessages.createdAt, new Date(now.getTime() - RATE_WINDOW_MS))));
      if ((recent?.value ?? 0) >= RATE_LIMIT) throw new AppError('rate_limited', 'Too many messages in a row. Please wait a few minutes.');
      await tx.insert(supportThreads).values({ userId, status: 'open', lastMessageAt: now, lastClientMessageAt: now, clientReadAt: now })
        .onConflictDoUpdate({ target: supportThreads.userId, set: { status: 'open', lastMessageAt: now, lastClientMessageAt: now, clientReadAt: now } });
      const [message] = await tx.insert(supportMessages).values({ userId, author: 'client', text, createdAt: now }).returning({ id: supportMessages.id });
      // One notice per waiting question: a client writing several messages in a row does not ring every time.
      const waiting = before && before.status === 'open' && newer(before.lastClientMessageAt, before.supportReadAt);
      if (!waiting) await notifyAdmins(tx, this.config, { userId, eventKey: `support:${message!.id}`, stage: 'support' });
    });
    return this.clientThread(userId);
  }

  // ─── Administrator ──────────────────────────────────────────────────

  async inbox(input: { status: 'open' | 'all' }) {
    const unread = sql<boolean>`${supportThreads.lastClientMessageAt} is not null and (${supportThreads.supportReadAt} is null or ${supportThreads.lastClientMessageAt} > ${supportThreads.supportReadAt})`;
    const rows = await this.db.select({ thread: supportThreads, telegramId: users.telegramId, username: users.username, firstName: users.firstName,
      kycFirstName: kycProfiles.firstName, kycLastName: kycProfiles.lastName, unread })
      .from(supportThreads).innerJoin(users, eq(users.id, supportThreads.userId)).leftJoin(kycProfiles, eq(kycProfiles.userId, supportThreads.userId))
      .where(input.status === 'open' ? eq(supportThreads.status, 'open') : undefined)
      .orderBy(desc(unread), desc(supportThreads.lastMessageAt)).limit(100);
    const last = rows.length ? await this.db.selectDistinctOn([supportMessages.userId], { userId: supportMessages.userId, text: supportMessages.text, author: supportMessages.author })
      .from(supportMessages).where(inArray(supportMessages.userId, rows.map(row => row.thread.userId)))
      .orderBy(supportMessages.userId, desc(supportMessages.createdAt), desc(supportMessages.id)) : [];
    return rows.map(row => {
      const preview = last.find(item => item.userId === row.thread.userId);
      return { userId: row.thread.userId, telegramId: String(row.telegramId), username: row.username,
        name: [row.kycFirstName, row.kycLastName].filter(Boolean).join(' ') || row.firstName || null,
        status: row.thread.status as 'open' | 'closed', unread: Boolean(row.unread), lastMessageAt: row.thread.lastMessageAt.toISOString(),
        preview: preview ? { author: preview.author as 'client' | 'support', text: preview.text.slice(0, 140) } : null };
    });
  }

  /** Opening a conversation in the admin marks the client's messages read. */
  async adminThread(userId: string): Promise<SupportThreadDto> {
    const now = new Date();
    const [thread] = await this.db.update(supportThreads)
      .set({ supportReadAt: sql`greatest(${now.toISOString()}::timestamptz, coalesce(${supportThreads.lastClientMessageAt}, ${now.toISOString()}::timestamptz))` })
      .where(eq(supportThreads.userId, userId)).returning();
    if (!thread) throw new AppError('not_found', 'Обращение не найдено');
    return this.dto(thread, await this.messages(userId), 'support');
  }

  async adminReply(actor: string, userId: string, value: string): Promise<SupportThreadDto> {
    const text = clean(value);
    await this.db.transaction(async tx => {
      const [before] = await tx.select().from(supportThreads).where(eq(supportThreads.userId, userId)).for('update');
      if (!before) throw new AppError('not_found', 'Обращение не найдено');
      const now = new Date();
      await tx.update(supportThreads).set({ status: 'open', lastMessageAt: now, lastSupportMessageAt: now, supportReadAt: now }).where(eq(supportThreads.userId, userId));
      await tx.insert(supportMessages).values({ userId, author: 'support', adminUserId: actor, text, createdAt: now });
      // The client hears about the first unread answer only; the text itself is read in the app.
      if (!newer(before.lastSupportMessageAt, before.clientReadAt)) await notify(tx, userId, { type: 'support_reply' });
    });
    return this.adminThread(userId);
  }

  async adminSetStatus(userId: string, status: 'open' | 'closed'): Promise<SupportThreadDto> {
    const updated = await this.db.update(supportThreads).set({ status }).where(eq(supportThreads.userId, userId)).returning({ userId: supportThreads.userId });
    if (!updated[0]) throw new AppError('not_found', 'Обращение не найдено');
    return this.adminThread(userId);
  }
}
