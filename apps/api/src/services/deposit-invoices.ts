import { createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, getTableColumns, inArray, isNotNull, ne, or, gte, sql } from 'drizzle-orm';
import { fromMinor, isWalletAsset, NETWORK_IDS, toMinor, type DepositInvoiceDto, type DepositInvoiceInput, type DepositInvoiceOptionDto, type Network, type WalletAsset } from '@gudex/shared';
import type { Db, DbOrTx, Tx } from '../db/client';
import { appSettings, depositInvoices, users } from '../db/schema';
import { AppError } from '../lib/errors';
import type { NativeDepositInvoices, UpayInvoiceReceipt } from '../partner/upay/deposit-invoices';
import { UpayError } from '../partner/upay/transport';
import { enqueue, type JobHandler, RetryLater } from '../queue/queue';

type InvoiceRow = typeof depositInvoices.$inferSelect;
export interface InvoiceCreditInput { userId: string; invoiceId: string; orderNo: string; receiptId: string; asset: WalletAsset; network: Network; amount: bigint; }
export type InvoiceCredit = (tx: Tx, input: InvoiceCreditInput) => Promise<void>;
const OPEN_STATES = ['prepared', 'sending', 'awaiting_payment', 'confirming', 'unknown'];
const EXPIRED_AUTO_CHECK_MS = 7 * 24 * 60 * 60_000;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const unavailable = () => new AppError('provider_unavailable', 'Payment invoice verification is temporarily unavailable');

export function validInvoiceCheckoutUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'quick.upay.best' && !url.port && !url.username && !url.password;
  } catch { return false; }
}

export class DepositInvoiceService {
  private readonly key: Buffer;
  constructor(private readonly db: Db, appSecret: string, private readonly provider: NativeDepositInvoices | undefined,
    private readonly credit: InvoiceCredit, private readonly optionsConfig: { enabled: boolean; live: boolean }) {
    this.key = createHmac('sha256', appSecret).update('gudex:deposit-invoice:v1').digest();
  }
  get canReconcile(): boolean { return this.optionsConfig.live && this.provider?.configured === true; }
  get ready(): boolean { return this.optionsConfig.enabled && this.canReconcile; }
  private async assertLive(db: DbOrTx = this.db, creation = false): Promise<void> {
    if (!(creation ? this.ready : this.canReconcile)) throw unavailable();
    const [mode] = await db.select().from(appSettings).where(eq(appSettings.key, 'financial_mode'));
    if (mode?.value !== 'live') throw unavailable();
  }
  private hash(userId: string, asset: WalletAsset, network: Network, amount: bigint): string {
    return createHmac('sha256', this.key).update(JSON.stringify([userId, asset, network, amount.toString()])).digest('hex');
  }
  private seal(invoice: Pick<InvoiceRow, 'id' | 'userId'>, url: string) {
    if (!validInvoiceCheckoutUrl(url)) throw unavailable();
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${invoice.id}:${invoice.userId}`));
    return { urlCiphertext: Buffer.concat([cipher.update(url, 'utf8'), cipher.final()]).toString('base64'),
      urlIv: iv.toString('base64'), urlTag: cipher.getAuthTag().toString('base64') };
  }
  private open(invoice: InvoiceRow): string | null {
    try {
      if (!invoice.urlCiphertext || !invoice.urlIv || !invoice.urlTag) return null;
      const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(invoice.urlIv, 'base64'));
      cipher.setAAD(Buffer.from(`${invoice.id}:${invoice.userId}`));
      cipher.setAuthTag(Buffer.from(invoice.urlTag, 'base64'));
      const url = Buffer.concat([cipher.update(Buffer.from(invoice.urlCiphertext, 'base64')), cipher.final()]).toString('utf8');
      return validInvoiceCheckoutUrl(url) ? url : null;
    } catch { return null; }
  }
  private dto(invoice: InvoiceRow, unpaidConfirmed = false): DepositInvoiceDto {
    return { id: invoice.id, state: invoice.state as DepositInvoiceDto['state'], asset: invoice.asset as WalletAsset, network: invoice.network as Network,
      requestedAmount: fromMinor(invoice.requestedAmount, invoice.asset as WalletAsset),
      creditedAmount: invoice.state === 'credited' && invoice.creditedAmount !== null ? fromMinor(invoice.creditedAmount, invoice.asset as WalletAsset) : null,
      paymentUrl: unpaidConfirmed && invoice.state === 'awaiting_payment' && (!invoice.expiresAt || invoice.expiresAt.getTime() > Date.now()) ? this.open(invoice) : null,
      expiresAt: invoice.expiresAt?.toISOString() ?? null, createdAt: invoice.createdAt.toISOString() };
  }
  private async owned(userId: string, id: string): Promise<InvoiceRow> {
    const [invoice] = await this.db.select().from(depositInvoices).where(and(eq(depositInvoices.id, id), eq(depositInvoices.userId, userId)));
    if (!invoice) throw new AppError('not_found', 'Payment invoice not found');
    return invoice;
  }
  async options(): Promise<DepositInvoiceOptionDto[]> {
    await this.assertLive(this.db, true);
    try { return await this.provider!.options(); } catch { throw unavailable(); }
  }
  async active(userId: string): Promise<DepositInvoiceDto | null> {
    const [invoice] = await this.db.select().from(depositInvoices).where(and(eq(depositInvoices.userId, userId), inArray(depositInvoices.state, OPEN_STATES)))
      .orderBy(desc(depositInvoices.createdAt)).limit(1);
    return invoice ? this.get(userId, invoice.id) : null;
  }
  async create(userId: string, input: DepositInvoiceInput): Promise<DepositInvoiceDto> {
    await this.assertLive(this.db, true);
    if (!isWalletAsset(input.asset) || !(NETWORK_IDS as readonly string[]).includes(input.network)
      || typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 100) throw new AppError('validation', 'Invalid payment invoice request');
    let amount: bigint;
    try { amount = toMinor(input.amount, input.asset); } catch { throw new AppError('validation', 'Invalid payment amount'); }
    if (amount <= 0n) throw new AppError('validation', 'Payment amount must be positive');
    const requestHash = this.hash(userId, input.asset, input.network, amount);
    const [replay] = await this.db.select().from(depositInvoices).where(and(eq(depositInvoices.userId, userId), eq(depositInvoices.idempotencyKey, input.idempotencyKey)));
    if (replay) {
      if (replay.requestHash !== requestHash) throw new AppError('validation', 'This invoice key belongs to another payment amount or network');
      if (replay.state !== 'prepared') return this.get(userId, replay.id);
    }
    const supported = (await this.options()).filter(option => option.asset === input.asset && option.network === input.network);
    if (supported.length !== 1 || !Number.isInteger(supported[0]!.decimals) || supported[0]!.decimals < 0 || supported[0]!.decimals > 6
      || amount % (10n ** BigInt(6 - supported[0]!.decimals)) !== 0n
      || amount < toMinor(supported[0]!.minAmount, input.asset) || amount > toMinor(supported[0]!.maxAmount, input.asset)) {
      throw new AppError('validation', 'Select a supported payment amount and network');
    }
    const claim = await this.db.transaction(async tx => {
      const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      if (!user) throw new AppError('unauthorized', 'User not found');
      await this.assertLive(tx, true);
      const [existingKey] = await tx.select().from(depositInvoices).where(and(eq(depositInvoices.userId, userId), eq(depositInvoices.idempotencyKey, input.idempotencyKey)));
      if (existingKey) {
        if (existingKey.requestHash !== requestHash) throw new AppError('validation', 'This invoice key belongs to another payment');
        if (existingKey.state === 'prepared') {
          const [claimed] = await tx.update(depositInvoices).set({ state: 'sending', updatedAt: new Date() })
            .where(and(eq(depositInvoices.id, existingKey.id), eq(depositInvoices.state, 'prepared'))).returning();
          if (!claimed) throw unavailable();
          await enqueue(tx, 'deposit.invoice.reconcile', { invoiceId: claimed.id }, { runAt: new Date(Date.now() + 60_000), dedupeKey: `deposit.invoice:${claimed.id}` });
          return { created: true, invoice: claimed };
        }
        return { created: false, invoice: existingKey };
      }
      const [existing] = await tx.select().from(depositInvoices).where(and(eq(depositInvoices.userId, userId), inArray(depositInvoices.state, OPEN_STATES)))
        .orderBy(desc(depositInvoices.createdAt)).limit(1).for('update');
      if (existing) {
        if (existing.requestHash !== requestHash) throw new AppError('validation', 'An earlier payment invoice requires verification before another payment');
        if (existing.state === 'prepared') {
          const [claimed] = await tx.update(depositInvoices).set({ state: 'sending', updatedAt: new Date() })
            .where(and(eq(depositInvoices.id, existing.id), eq(depositInvoices.state, 'prepared'))).returning();
          if (!claimed) throw unavailable();
          await enqueue(tx, 'deposit.invoice.reconcile', { invoiceId: claimed.id }, { runAt: new Date(Date.now() + 60_000), dedupeKey: `deposit.invoice:${claimed.id}` });
          return { created: true, invoice: claimed };
        }
        return { created: false, invoice: existing };
      }
      const [invoice] = await tx.insert(depositInvoices).values({ userId, idempotencyKey: input.idempotencyKey, requestHash,
        asset: input.asset, network: input.network, requestedAmount: amount, state: 'sending' }).returning();
      await enqueue(tx, 'deposit.invoice.reconcile', { invoiceId: invoice!.id }, { runAt: new Date(Date.now() + 60_000), dedupeKey: `deposit.invoice:${invoice!.id}` });
      return { created: true, invoice: invoice! };
    });
    if (!claim.created) return this.get(userId, claim.invoice.id);
    try {
      const result = await this.provider!.create({ asset: input.asset, network: input.network, amount, beforeDispatch: async () => {
        await this.db.transaction(async tx => {
          await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
          await this.assertLive(tx, true);
          const [current] = await tx.select().from(depositInvoices).where(eq(depositInvoices.id, claim.invoice.id)).for('update');
          if (!current || current.userId !== userId || current.requestHash !== requestHash || current.state !== 'sending' || current.orderNo) throw unavailable();
        });
      } });
      if (!identifier(result.orderNo) || !validInvoiceCheckoutUrl(result.url) || result.expiresAt !== null && !Number.isFinite(result.expiresAt.getTime())) throw unavailable();
      const saved = await this.db.transaction(async tx => {
        const [current] = await tx.select().from(depositInvoices).where(eq(depositInvoices.id, claim.invoice.id)).for('update');
        if (!current || current.userId !== userId || current.requestHash !== requestHash || current.orderNo || !['sending', 'unknown'].includes(current.state)) throw unavailable();
        const [updated] = await tx.update(depositInvoices).set({ orderNo: result.orderNo, ...this.seal(current, result.url), expiresAt: result.expiresAt,
          state: result.expiresAt && result.expiresAt.getTime() <= Date.now() ? 'expired' : 'awaiting_payment', updatedAt: new Date() })
          .where(eq(depositInvoices.id, current.id)).returning();
        return updated!;
      });
      return this.dto(saved, true);
    } catch (error) {
      const state = error instanceof UpayError && error.metadata?.phase === 'pre_dispatch' ? 'prepared' : 'unknown';
      await this.db.update(depositInvoices).set({ state, updatedAt: new Date() }).where(and(eq(depositInvoices.id, claim.invoice.id), eq(depositInvoices.state, 'sending')));
      return this.dto(await this.owned(userId, claim.invoice.id));
    }
  }

  async retry(userId: string, id: string): Promise<DepositInvoiceDto> {
    const invoice = await this.owned(userId, id);
    if (invoice.state !== 'prepared') return this.get(userId, id);
    return this.create(userId, { asset: invoice.asset as WalletAsset, network: invoice.network as Network,
      amount: fromMinor(invoice.requestedAmount, invoice.asset as WalletAsset), idempotencyKey: invoice.idempotencyKey });
  }

  async get(userId: string, id: string): Promise<DepositInvoiceDto> {
    return this.reconcile(await this.owned(userId, id));
  }
  private validReceipt(invoice: InvoiceRow, receipt: UpayInvoiceReceipt): boolean {
    return identifier(receipt.receiptId) && receipt.orderNo === invoice.orderNo && receipt.asset === invoice.asset && receipt.network === invoice.network
      && typeof receipt.amount === 'bigint' && receipt.amount > 0n;
  }
  private async reconcile(invoice: InvoiceRow): Promise<DepositInvoiceDto> {
    if (invoice.state === 'credited' || !invoice.orderNo || !this.canReconcile) return this.dto(invoice);
    let paidObserved = false;
    try {
      await this.assertLive();
      const inspected = await this.provider!.inspect({ orderNo: invoice.orderNo, asset: invoice.asset as WalletAsset, network: invoice.network as Network });
      paidObserved = inspected.state === 'paid';
      const updated = await this.db.transaction(async tx => {
        await tx.select({ id: users.id }).from(users).where(eq(users.id, invoice.userId)).for('update');
        const [current] = await tx.select().from(depositInvoices).where(eq(depositInvoices.id, invoice.id)).for('update');
        if (!current || current.userId !== invoice.userId || current.orderNo !== invoice.orderNo || current.requestHash !== invoice.requestHash) throw unavailable();
        if (current.state === 'credited') return current;
        await this.assertLive(tx);
        if (inspected.state === 'paid' && inspected.receipt && this.validReceipt(current, inspected.receipt)) {
          await this.credit(tx, { userId: current.userId, invoiceId: current.id, orderNo: current.orderNo!, receiptId: inspected.receipt.receiptId,
            asset: inspected.receipt.asset, network: inspected.receipt.network, amount: inspected.receipt.amount });
          const [credited] = await tx.update(depositInvoices).set({ state: 'credited', receiptId: inspected.receipt.receiptId, creditedAmount: inspected.receipt.amount,
            creditedAt: new Date(), updatedAt: new Date() }).where(eq(depositInvoices.id, current.id)).returning();
          return credited!;
        }
        const state = inspected.state === 'paid' ? 'confirming' : inspected.state === 'expired' || current.state === 'expired'
          || current.expiresAt && current.expiresAt.getTime() <= Date.now() ? 'expired' : current.state === 'confirming' ? 'confirming' : 'awaiting_payment';
        const [pending] = await tx.update(depositInvoices).set({ state, updatedAt: new Date() }).where(eq(depositInvoices.id, current.id)).returning();
        return pending!;
      });
      return this.dto(updated, inspected.state === 'processing');
    } catch {
      // A failed read never proves payment, expiry or permission to create again.
      // A known paid invoice with conflicting bookkeeping must not invite a
      // second payment. The failed credit transaction remains fully rolled back.
      await this.db.update(depositInvoices).set({ ...(paidObserved ? { state: 'confirming' } : {}), updatedAt: new Date() })
        .where(and(eq(depositInvoices.id, invoice.id), eq(depositInvoices.userId, invoice.userId), ne(depositInvoices.state, 'credited')));
      return this.dto(await this.owned(invoice.userId, invoice.id));
    }
  }
  handlers(): Record<string, JobHandler> {
    return { 'deposit.invoices.sync_all': { run: async () => {
      if (!this.canReconcile) return;
      const pending = await this.db.select({ id: depositInvoices.id }).from(depositInvoices).where(and(ne(depositInvoices.state, 'credited'), isNotNull(depositInvoices.orderNo),
        or(ne(depositInvoices.state, 'expired'), gte(sql`coalesce(${depositInvoices.expiresAt}, ${depositInvoices.createdAt})`, new Date(Date.now() - EXPIRED_AUTO_CHECK_MS)))))
        .orderBy(asc(depositInvoices.updatedAt)).limit(100);
      for (const invoice of pending) await enqueue(this.db, 'deposit.invoice.reconcile', { invoiceId: invoice.id }, { dedupeKey: `deposit.invoice:${invoice.id}` });
    } }, 'deposit.invoice.reconcile': { run: async ({ invoiceId }: { invoiceId: string }) => {
      const [invoice] = await this.db.select({ ...getTableColumns(depositInvoices),
        updatedAtExact: sql<string>`${depositInvoices.updatedAt}::text` }).from(depositInvoices).where(eq(depositInvoices.id, invoiceId));
      if (!invoice || invoice.state === 'credited') return;
      if (!invoice.orderNo) {
        if (invoice.state === 'sending') {
          const age = Math.max(0, Date.now() - invoice.updatedAt.getTime());
          if (age < 60_000) throw new RetryLater(Math.max(1, Math.ceil((60_000 - age) / 1000)));
          // Keep the captured PostgreSQL precision: a stale watchdog must not
          // overwrite a newer explicit send claim between its read and update.
          await this.db.update(depositInvoices).set({ state: 'unknown', updatedAt: new Date() }).where(and(eq(depositInvoices.id, invoice.id),
            eq(depositInvoices.state, 'sending'), eq(depositInvoices.updatedAt, sql`${invoice.updatedAtExact}::timestamptz`)));
        }
        return;
      }
      if (invoice.state === 'expired' && (invoice.expiresAt ?? invoice.createdAt).getTime() < Date.now() - EXPIRED_AUTO_CHECK_MS) return;
      const status = await this.reconcile(invoice);
      // Expired invoices also remain readable for a genuinely late settlement.
      if (status.state !== 'credited' && !(status.state === 'expired' && (invoice.expiresAt ?? invoice.createdAt).getTime() < Date.now() - EXPIRED_AUTO_CHECK_MS)) throw new RetryLater(60);
    } } };
  }
}
