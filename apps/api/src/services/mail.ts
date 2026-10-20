import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, gte, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import PostalMime from 'postal-mime';
import type { Config } from '../config';
import type { Db, DbOrTx } from '../db/client';
import { adminAuditLog, inboundEmails, kycProfiles, mailAddresses, users } from '../db/schema';
import { AppError, isUniqueViolation } from '../lib/errors';
import { codeContext, extractCode } from '../mail/extract-code';
import { enqueue, PermanentJobError, RetryLater, type JobHandler } from '../queue/queue';
import { type BotApi, TelegramApiError } from '../telegram/bot';

// Client mail addresses on our domain. Cloudflare Email Routing hands every letter to the mail Worker,
// which signs it and posts it here. Only a one-time code from MAIL_ALLOWED_SENDERS (UPay) is forwarded,
// and only to the Telegram chat of the client who owns the address; other letters are recorded and dropped.
// The letter itself is never stored, the code is sealed and wiped once sent.

export const MAX_RAW_BYTES = 1024 * 1024;
const CODE_TTL_MS = 15 * 60_000;
const MAX_LETTER_AGE_MS = 30 * 60_000;
const SIGNATURE_WINDOW_MS = 5 * 60_000;
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT = 10;
const KEEP_DAYS = 30;
const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const SUGGEST_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export interface InboundLetter {
  from: string;
  to: string;
  rawSize: number;
  /** Base64 MIME source; absent when the letter was larger than MAX_RAW_BYTES. */
  raw?: string;
  messageId?: string;
  subject?: string;
  date?: string;
}
export type InboundResult = { result: 'accepted' | 'duplicate' | 'reject' };
type Otp = { code: string; threeDs: boolean; last4: string | null; minutes: number | null };

/** Lowercase address, or null. With a domain, only addresses on that domain are accepted. */
export function normalizeMailAddress(value: string, domain?: string): string | null {
  const address = value.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 1 || address.length > 254) return null;
  const local = address.slice(0, at), host = address.slice(at + 1);
  if (!LOCAL.test(local) || local.includes('..') || !HOST.test(host)) return null;
  return domain && host !== domain ? null : address;
}

// Envelope recipients may carry a +tag (sub-addressing); the client is the address without it.
function recipientAddress(value: string): string | null {
  const address = value.trim().toLowerCase().replace(/^<|>$/g, '');
  const at = address.lastIndexOf('@');
  return at < 1 ? null : normalizeMailAddress(`${address.slice(0, at).replace(/\+.*$/, '')}${address.slice(at)}`);
}

export function suggestMailAddress(domain: string): string {
  let local = 'c';
  for (let index = 0; index < 7; index++) local += SUGGEST_ALPHABET[randomInt(SUGGEST_ALPHABET.length)];
  return `${local}@${domain}`;
}

/** Gives the client this address (replacing an older one) and keeps the questionnaire email in step. */
export async function assignMailAddress(tx: DbOrTx, userId: string, address: string): Promise<void> {
  const [taken] = await tx.select({ userId: mailAddresses.userId }).from(mailAddresses).where(and(eq(mailAddresses.address, address), ne(mailAddresses.userId, userId)));
  if (taken) throw new AppError('validation', 'Эта почта уже привязана к другому клиенту');
  await tx.delete(mailAddresses).where(and(eq(mailAddresses.userId, userId), ne(mailAddresses.address, address)));
  // Two operators saving one address at once: the later insert must fail, never take over the other client's row.
  const kept = await tx.insert(mailAddresses).values({ address, userId }).onConflictDoUpdate({ target: mailAddresses.address, set: { updatedAt: new Date() },
    setWhere: sql`${mailAddresses.userId} = excluded.user_id` }).returning({ address: mailAddresses.address });
  if (!kept[0]) throw new AppError('validation', 'Эта почта уже привязана к другому клиенту');
  await tx.update(kycProfiles).set({ email: address, updatedAt: new Date() }).where(eq(kycProfiles.userId, userId));
}

/** Automatic verification needs an email for UPay: the client's address on our domain, created once. */
export async function ensureMailAddress(tx: DbOrTx, userId: string, domain: string): Promise<string> {
  const [existing] = await tx.select({ address: mailAddresses.address }).from(mailAddresses).where(eq(mailAddresses.userId, userId));
  if (existing) return existing.address;
  for (let attempt = 0; attempt < 5; attempt++) {
    const address = suggestMailAddress(domain);
    const inserted = await tx.insert(mailAddresses).values({ address, userId }).onConflictDoNothing().returning({ address: mailAddresses.address });
    if (inserted[0]) return inserted[0].address;
  }
  throw new AppError('internal', 'Could not allocate a mail address');
}

/** Validates an address the operator typed for a client: our domain when it is configured, and not another client's. */
export async function checkMailAddress(db: DbOrTx, domain: string | undefined, userId: string, value: string): Promise<string> {
  const address = normalizeMailAddress(value, domain);
  if (!address) throw new AppError('validation', domain ? `Почта должна быть на домене ${domain}: латиница, цифры, точка, - и _` : 'Проверьте почту');
  const [taken] = await db.select({ userId: mailAddresses.userId }).from(mailAddresses).where(and(eq(mailAddresses.address, address), ne(mailAddresses.userId, userId)));
  if (taken) throw new AppError('validation', 'Эта почта уже привязана к другому клиенту');
  return address;
}

export async function clientMailAddress(db: DbOrTx, domain: string | undefined, userId: string) {
  const [row] = await db.select({ address: mailAddresses.address }).from(mailAddresses).where(eq(mailAddresses.userId, userId));
  return { address: row?.address ?? null, suggested: row || !domain ? null : suggestMailAddress(domain), domain: domain ?? null };
}

// Digits in a stored subject are hidden: a subject may itself carry the code.
const maskSubject = (subject: string | undefined | null) => subject?.replace(/\s+/g, ' ').trim().slice(0, 200).replace(/\d{4,}/g, match => '•'.repeat(match.length)) || null;
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class MailService {
  private readonly key: Buffer;
  constructor(private readonly db: Db, private readonly config: Config, private readonly bot: BotApi) {
    this.key = createHmac('sha256', config.appSecret).update('gudex:mail-code:v1').digest();
  }

  get domain(): string | null { return this.config.MAIL_DOMAIN ?? null; }

  /** HMAC-SHA256 of `${timestamp}.${body}` with MAIL_INBOUND_SECRET; a timestamp older than five minutes is refused. */
  verify(timestamp: string | undefined, signature: string | undefined, body: string, now = Date.now()): void {
    const secret = this.config.MAIL_INBOUND_SECRET;
    if (!secret) throw new AppError('provider_unavailable', 'Mail intake is not configured');
    const seconds = Number(timestamp);
    if (!timestamp || !/^\d{9,11}$/.test(timestamp) || Math.abs(now - seconds * 1000) > SIGNATURE_WINDOW_MS) throw new AppError('unauthorized', 'Stale or missing timestamp');
    const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
    const given = /^[0-9a-f]{64}$/.test(signature ?? '') ? Buffer.from(signature!, 'hex') : null;
    if (!given || !timingSafeEqual(given, expected)) throw new AppError('unauthorized', 'Invalid signature');
  }

  async receive(letter: InboundLetter, now = new Date()): Promise<InboundResult> {
    const recipient = recipientAddress(letter.to);
    if (!recipient || (this.domain && !recipient.endsWith(`@${this.domain}`))) return { result: 'reject' };
    const [owner] = await this.db.select({ userId: mailAddresses.userId }).from(mailAddresses).where(eq(mailAddresses.address, recipient));
    if (!owner) return { result: 'reject' };

    const bytes = letter.raw ? Buffer.from(letter.raw, 'base64') : null;
    let parsed: Awaited<ReturnType<typeof PostalMime.parse>> | null = null;
    // A broken or hostile letter only loses its code; attachments are never read.
    if (bytes && bytes.length <= MAX_RAW_BYTES) {
      try { parsed = await PostalMime.parse(bytes, { maxNestingDepth: 20, maxHeadersSize: 256 * 1024, attachmentEncoding: 'arraybuffer' }); }
      catch { parsed = null; }
    }
    const headerFrom = parsed?.from && 'address' in parsed.from && parsed.from.address ? parsed.from.address : undefined;
    const sender = normalizeMailAddress(headerFrom ?? '') ?? normalizeMailAddress(letter.from) ?? letter.from.trim().toLowerCase().slice(0, 254);
    const messageId = (parsed?.messageId ?? letter.messageId)?.trim().slice(0, 998);
    const dedupeKey = createHash('sha256').update(`${recipient}\n${messageId || (bytes ? createHash('sha256').update(bytes).digest('hex')
      : `${sender}\n${letter.subject ?? ''}\n${letter.date ?? ''}\n${letter.rawSize}`)}`).digest('hex');
    const sentAt = (() => { const value = Date.parse(parsed?.date ?? letter.date ?? ''); return Number.isFinite(value) ? new Date(value) : null; })();
    const subject = parsed?.subject ?? letter.subject;

    const id = randomUUID();
    let status: 'queued' | 'no_code' | 'unknown_sender' | 'stale' | 'rate_limited' = 'queued';
    let otp: Otp | null = null;
    if (!this.allowed(sender)) status = 'unknown_sender';
    else if (sentAt && now.getTime() - sentAt.getTime() > MAX_LETTER_AGE_MS) status = 'stale';
    else {
      const letterText = { subject, text: parsed?.text, html: parsed?.html };
      const code = parsed ? extractCode(letterText) : null;
      if (code) otp = { code, ...codeContext(letterText) };
      else status = 'no_code';
    }

    return this.db.transaction(async tx => {
      if (status === 'queued') {
        const [recent] = await tx.select({ value: sql<number>`count(*)::int` }).from(inboundEmails).where(and(eq(inboundEmails.userId, owner.userId),
          inArray(inboundEmails.status, ['queued', 'delivered']), gte(inboundEmails.createdAt, new Date(now.getTime() - RATE_WINDOW_MS))));
        if ((recent?.value ?? 0) >= RATE_LIMIT) { status = 'rate_limited'; otp = null; }
      }
      const inserted = await tx.insert(inboundEmails).values({ id, dedupeKey, recipient, userId: owner.userId, sender, subject: maskSubject(subject), sentAt, status,
        hasCode: otp !== null, ...(otp ? { ...this.seal(id, JSON.stringify(otp)), codeExpiresAt: this.expiry(otp, sentAt, now) } : {}), createdAt: now })
        .onConflictDoNothing({ target: inboundEmails.dedupeKey }).returning({ id: inboundEmails.id });
      if (!inserted[0]) return { result: 'duplicate' as const };
      if (status === 'queued') await enqueue(tx, 'mail.notify', { id }, { dedupeKey: `mail.notify:${id}`, maxAttempts: 6 });
      return { result: 'accepted' as const };
    });
  }

  // The letter's own lifetime ("expire in 2 minutes", counted from its Date, plus a minute for clock skew) caps ours:
  // a code delayed by a retry is marked expired instead of being sent as still valid.
  private expiry(otp: Otp, sentAt: Date | null, now: Date): Date {
    const own = otp.minutes ? Math.min(sentAt?.getTime() ?? now.getTime(), now.getTime()) + (otp.minutes + 1) * 60_000 : Infinity;
    return new Date(Math.min(now.getTime() + CODE_TTL_MS, own));
  }

  // An exact address, its domain, or a parent domain (mail.upay.com matches upay.com).
  private allowed(sender: string): boolean {
    const at = sender.lastIndexOf('@');
    if (at < 1) return false;
    const labels = sender.slice(at + 1).split('.');
    const candidates = [sender, ...labels.slice(0, -1).map((_, index) => labels.slice(index).join('.'))];
    return candidates.some(candidate => this.config.MAIL_ALLOWED_SENDERS.includes(candidate));
  }

  private seal(id: string, value: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { codeCiphertext: ciphertext.toString('base64'), codeIv: iv.toString('base64'), codeTag: cipher.getAuthTag().toString('base64') };
  }

  private open(row: typeof inboundEmails.$inferSelect): Otp | null {
    if (!row.codeCiphertext || !row.codeIv || !row.codeTag) return null;
    try {
      const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.codeIv, 'base64'));
      cipher.setAAD(Buffer.from(row.id));
      cipher.setAuthTag(Buffer.from(row.codeTag, 'base64'));
      const otp = JSON.parse(Buffer.concat([cipher.update(Buffer.from(row.codeCiphertext, 'base64')), cipher.final()]).toString('utf8')) as Otp;
      return typeof otp.code === 'string' && otp.code ? otp : null;
    } catch { return null; }
  }

  handlers(): Record<string, JobHandler> {
    return {
      'mail.notify': { run: (payload: { id: string }) => this.deliver(payload.id),
        onExhausted: (payload: { id: string }, error: Error) => this.fail(payload.id, error.message) },
      'mail.cleanup': { run: () => this.cleanup() },
    };
  }

  async enqueueCleanup(tx: DbOrTx): Promise<void> {
    await enqueue(tx, 'mail.cleanup', {}, { dedupeKey: 'mail.cleanup', maxAttempts: 1 });
  }

  // Lock, send, mark delivered and wipe the code in one transaction: a failed send rolls back and is retried.
  private async deliver(id: string, now = new Date()): Promise<void> {
    await this.db.transaction(async tx => {
      const [row] = await tx.select().from(inboundEmails).where(eq(inboundEmails.id, id)).for('update');
      if (!row || row.status !== 'queued' || !row.userId) return;
      const wipe = { codeCiphertext: null, codeIv: null, codeTag: null };
      if (!row.hasCode) {
        await tx.update(inboundEmails).set({ status: 'no_code', ...wipe }).where(eq(inboundEmails.id, id));
        return;
      }
      if (!row.codeExpiresAt || row.codeExpiresAt <= now) {
        await tx.update(inboundEmails).set({ status: 'expired', ...wipe }).where(eq(inboundEmails.id, id));
        return;
      }
      const otp = this.open(row);
      if (!otp) {
        await tx.update(inboundEmails).set({ status: 'failed', error: 'Sealed code cannot be read', ...wipe }).where(eq(inboundEmails.id, id));
        return;
      }
      const [user] = await tx.select({ telegramId: users.telegramId, locale: users.locale }).from(users).where(eq(users.id, row.userId));
      if (!user) throw new PermanentJobError('Recipient user is missing');
      try { await this.bot.sendMessage(user.telegramId, this.message(user.locale === 'en' ? 'en' : 'ru', otp)); }
      catch (error) {
        if (error instanceof TelegramApiError && error.errorCode === 429) throw new RetryLater(Math.min(Math.max(error.retryAfter ?? 5, 1), 300));
        // The client blocked the bot or never opened it: repeating will not help.
        if (error instanceof TelegramApiError && (error.errorCode === 403 || error.errorCode === 400)) throw new PermanentJobError(error.message);
        throw error;
      }
      await tx.update(inboundEmails).set({ status: 'delivered', deliveredAt: now, ...wipe }).where(eq(inboundEmails.id, id));
    });
  }

  private async fail(id: string, error: string): Promise<void> {
    await this.db.update(inboundEmails).set({ status: 'failed', error: error.slice(0, 300), codeCiphertext: null, codeIv: null, codeTag: null })
      .where(and(eq(inboundEmails.id, id), eq(inboundEmails.status, 'queued')));
  }

  // Only the code and what helps to use it: «Код 3DS: 378346 · Карта •• 1175 · действует 2 мин.»
  private message(locale: 'ru' | 'en', otp: Otp): string {
    const code = `<code>${escape(otp.code)}</code>`;
    if (locale === 'en') {
      const details = [otp.last4 ? `Card •• ${otp.last4}` : null, otp.minutes ? `valid for ${otp.minutes} min` : null].filter(Boolean).join(' · ');
      return [`🔐 <b>${otp.threeDs ? '3DS code' : 'Confirmation code'}</b>: ${code}`, ...(details ? [details] : []), 'Never share this code with anyone.'].join('\n');
    }
    const details = [otp.last4 ? `Карта •• ${otp.last4}` : null, otp.minutes ? `действует ${otp.minutes} мин.` : null].filter(Boolean).join(' · ');
    return [`🔐 <b>${otp.threeDs ? 'Код 3DS' : 'Код подтверждения'}</b>: ${code}`, ...(details ? [details] : []), 'Никому не сообщайте этот код.'].join('\n');
  }

  private async cleanup(now = new Date()): Promise<void> {
    await this.db.update(inboundEmails).set({ codeCiphertext: null, codeIv: null, codeTag: null })
      .where(and(isNotNull(inboundEmails.codeCiphertext), lt(inboundEmails.codeExpiresAt, now)));
    await this.db.delete(inboundEmails).where(lt(inboundEmails.createdAt, new Date(now.getTime() - KEEP_DAYS * 86400_000)));
  }

  async setClientAddress(actor: string, userId: string, value: string): Promise<void> {
    const address = await checkMailAddress(this.db, this.config.MAIL_DOMAIN, userId, value);
    try {
      await this.db.transaction(async tx => {
        const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
        if (!user) throw new AppError('not_found', 'Клиент не найден');
        await assignMailAddress(tx, userId, address);
        await tx.insert(adminAuditLog).values({ actorUserId: actor, targetUserId: userId, action: 'mail_address_set', reference: `${address}:${randomUUID()}`,
          metadata: { address } });
      });
    } catch (error) { if (isUniqueViolation(error)) throw new AppError('validation', 'Эта почта уже привязана к другому клиенту'); throw error; }
  }
}
