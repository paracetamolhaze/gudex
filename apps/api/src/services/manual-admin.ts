import { createHash } from 'node:crypto';
import { and, count, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { fromMinor, convertMinor, type WalletAsset } from '@gudex/shared';
import type { Config } from '../config';
import type { Db, DbOrTx } from '../db/client';
import { adminAuditLog, cardOperations, cards, jobs, kycDocuments, kycProfiles, users } from '../db/schema';
import { DbKycDocumentStore, type KycDocumentKind } from '../kyc/document-store';
import { AppError, isUniqueViolation } from '../lib/errors';
import type { UpayClient } from '../partner/upay/client';
import { decryptCardField, exactCents, expiry, identifier, object } from '../partner/upay/financial-protocol';
import type { PartnerCard } from '../partner/types';
import type { CardService } from './cards';
import { notify } from './notify';
import { CardBillingService } from './card-billing';

type Profile = typeof kycProfiles.$inferSelect;
type ReadClient = Pick<UpayClient, 'readRequest' | 'loginInfo'>;
type KycApproval = { submissionId: string; customerId: string; customerNo: string; documentsMatch: true };
type CardBinding = { operationId: string; partnerCardId: string; orderNo: string };
const validUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function conflict(message = 'The application changed; refresh it before continuing'): never { throw new AppError('validation', message); }
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const name = (value: unknown) => typeof value === 'string' && value.trim() && !/[*•]/.test(value) ? value.trim().toUpperCase() : null;
const contact = (value: unknown) => value === null || value === undefined || value === '' ? '' : typeof value === 'string' && !/[*•]/.test(value) ? value.trim() : null;
const email = (value: unknown) => contact(value)?.toLowerCase() ?? null;

/** Operator-assisted fulfilment. This module exposes only provider reads: it
 * never creates a customer, uploads KYC, issues a card or changes provider data. */
export class ManualAdminService {
  private readonly documents: DbKycDocumentStore;
  constructor(private readonly db: Db, private readonly config: Config, private readonly upay: ReadClient | undefined,
    private readonly cardService: CardService) {
    this.documents = new DbKycDocumentStore(db, config.appSecret, config.KYC_DOCUMENT_TTL_SECONDS);
  }

  async assertAdmin(actorUserId: string, db: DbOrTx = this.db): Promise<void> {
    const [actor] = await db.select({ telegramId: users.telegramId }).from(users).where(eq(users.id, actorUserId));
    if (!actor || !this.config.adminTelegramIds.includes(String(actor.telegramId))) throw new AppError('forbidden', 'Administrator access required');
  }

  async me(actor: string) { await this.assertAdmin(actor); return { isAdmin: true as const }; }

  async applications(actor: string, input: { page: number; limit: number }) {
    await this.assertAdmin(actor);
    const { page, limit } = input;
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) conflict('Invalid application page');
    const hasCard = sql<boolean>`exists (select 1 from ${cardOperations} o where o.user_id = ${users.id} and o.type = 'issue' and o.status in ('pending','processing','unknown'))`;
    const condition = or(inArray(kycProfiles.status, ['pending', 'unknown']), hasCard);
    const [totalRows, list] = await Promise.all([
      this.db.select({ value: count() }).from(users).leftJoin(kycProfiles, eq(kycProfiles.userId, users.id)).where(condition),
      this.db.select({ userId: users.id, telegramId: users.telegramId, firstName: kycProfiles.firstName, lastName: kycProfiles.lastName,
        kycStatus: kycProfiles.status, submissionState: kycProfiles.submissionState, hasPendingCard: hasCard, createdAt: users.createdAt })
        .from(users).leftJoin(kycProfiles, eq(kycProfiles.userId, users.id)).where(condition).orderBy(desc(users.createdAt))
        .limit(limit).offset((page - 1) * limit),
    ]);
    return { items: list.map(row => ({ userId: row.userId, telegramId: String(row.telegramId), name: [row.firstName, row.lastName].filter(Boolean).join(' '),
      kycStatus: row.kycStatus ?? 'none', submissionState: row.submissionState ?? 'none', hasPendingCard: row.hasPendingCard, createdAt: row.createdAt.toISOString() })),
    page, limit, total: totalRows[0]?.value ?? 0 };
  }

  async client(actor: string, query: string) {
    await this.assertAdmin(actor);
    const byId = validUuid.test(query);
    if (!byId && (!/^[1-9]\d{0,18}$/.test(query) || BigInt(query) > 9223372036854775807n)) throw new AppError('validation', 'Enter an exact client ID or Telegram ID');
    const [user] = await this.db.select().from(users).where(byId ? eq(users.id, query) : eq(users.telegramId, BigInt(query)));
    if (!user) throw new AppError('not_found', 'Client not found');
    const [profile] = await this.db.select().from(kycProfiles).where(eq(kycProfiles.userId, user.id));
    const operations = await this.db.select({ op: cardOperations, card: cards }).from(cardOperations).innerJoin(cards, eq(cards.id, cardOperations.cardId))
      .where(and(eq(cardOperations.userId, user.id), eq(cards.userId, user.id))).orderBy(desc(cardOperations.createdAt)).limit(100);
    const docIds = Object.values(profile?.documentIds ?? {});
    const documents = docIds.length ? await this.db.select({ id: kycDocuments.id, kind: kycDocuments.kind, mimeType: kycDocuments.mimeType,
      size: kycDocuments.size, expiresAt: kycDocuments.expiresAt }).from(kycDocuments)
      .where(and(eq(kycDocuments.userId, user.id), inArray(kycDocuments.id, docIds))) : [];
    const billingAddress = await new CardBillingService(this.db, this.config).getSavedForAdmin(user.id);
    return { userId: user.id, telegramId: String(user.telegramId), username: user.username, createdAt: user.createdAt.toISOString(), billingAddress,
      kyc: profile ? { status: profile.status, submissionState: profile.submissionState, submissionId: profile.submissionId, firstName: profile.firstName,
        lastName: profile.lastName, email: profile.email, phone: profile.phone, globalCode: profile.globalCode, birthDate: profile.birthDate,
        citizenship: profile.citizenship, documentType: profile.documentType, documentCountry: profile.documentCountry,
        partnerCustomerId: profile.partnerCustomerId, updatedAt: profile.updatedAt.toISOString(),
        documents: documents.filter(doc => doc.expiresAt > new Date() && profile.documentIds?.[doc.kind as KycDocumentKind] === doc.id)
          .map(doc => ({ ...doc, expiresAt: doc.expiresAt.toISOString() })) } : null,
      operations: operations.map(({ op, card }) => ({ id: op.id, cardId: op.cardId, type: op.type, status: op.status,
        fulfillmentMode: op.fulfillmentMode as 'automatic' | 'manual', asset: op.asset,
        amount: op.amount === null ? null : fromMinor(op.sponsorshipId ? 0n : op.amount, op.asset as WalletAsset),
        fee: op.fee === null ? null : fromMinor(op.sponsorshipId ? 0n : op.fee, op.asset as WalletAsset),
        createdAt: op.createdAt.toISOString(), partnerCardId: card.partnerCardId, last4: card.last4 })) };
  }

  async document(actor: string, userId: string, documentId: string) {
    await this.assertAdmin(actor);
    return this.db.transaction(async tx => {
      await this.assertAdmin(actor, tx);
      const [profile] = await tx.select().from(kycProfiles).where(eq(kycProfiles.userId, userId)).for('update');
      if (!profile || profile.status !== 'pending' || profile.submissionState !== 'manual_review') conflict('There are no active documents for manual review');
      const role = Object.entries(profile.documentIds ?? {}).find(([, id]) => id === documentId)?.[0] as KycDocumentKind | undefined;
      if (!role) throw new AppError('not_found', 'Document not found in the current application');
      const doc = await this.documents.getOwned(userId, documentId, role, tx);
      await tx.insert(adminAuditLog).values({ actorUserId: actor, targetUserId: userId, action: 'manual_document_view', reference: `${profile.submissionId}:${documentId}` })
        .onConflictDoNothing();
      return { id: doc.id, kind: doc.kind, mimeType: doc.mimeType, base64: doc.bytes.toString('base64') };
    });
  }

  private manualProfile(profile: Profile | undefined, submissionId: string): asserts profile is Profile {
    if (!profile || profile.submissionId !== submissionId || profile.partnerProvider !== 'upay' || profile.status !== 'pending' ||
      profile.submissionState !== 'manual_review' || profile.documentsSubmittedAt !== null) conflict();
    if (!name(profile.firstName) || !name(profile.lastName) || !email(profile.email) || !['id_card', 'passport'].includes(profile.documentType ?? '')) conflict('Complete identity details are required');
  }

  private async currentDocuments(profile: Profile, db: DbOrTx) {
    const ids = profile.documentIds;
    if (!ids?.front || profile.documentType === 'id_card' && !ids.back) conflict('Current document photographs are required');
    for (const [role, id] of Object.entries(ids!)) await this.documents.getOwned(profile.userId, id, role as KycDocumentKind, db);
  }

  private async noActiveKycJobs(userId: string, db: DbOrTx) {
    const active = await db.select({ id: jobs.id }).from(jobs).where(sql`${jobs.payload}->>'userId' = ${userId} and ${jobs.queue} in ('kyc.submit','kyc.poll') and ${jobs.status} in ('queued','running')`);
    if (active.length) conflict('An automatic verification task must finish before manual review');
  }

  private reader() {
    if (!this.upay || this.config.CARD_PARTNER !== 'upay') throw new AppError('provider_unavailable', 'UPay read access is required for verification');
    const client = this.upay, deadline = Date.now() + 15_000;
    const bounded = async <T>(run: () => Promise<T>): Promise<T> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AppError('provider_unavailable', 'Provider verification timed out; no changes were made');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([run(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppError('provider_unavailable', 'Provider verification timed out; no changes were made')), remaining); })]); }
      catch (error) { if (error instanceof AppError) throw error; throw new AppError('provider_unavailable', 'Provider verification could not be completed; no changes were made'); }
      finally { if (timer) clearTimeout(timer); }
    };
    return { read: <T>(method: 'GET' | 'POST', path: string, options?: { query?: Record<string, string | number>; body?: object }) => bounded(() => client.readRequest<T>(method, path, options)),
      loginInfo: () => bounded(() => client.loginInfo()) };
  }

  async approveKyc(actor: string, userId: string, input: KycApproval) {
    await this.assertAdmin(actor);
    if (input.documentsMatch !== true || !identifier(input.customerId) || !identifier(input.customerNo)) conflict('Explicit document review and exact customer identifiers are required');
    const [before] = await this.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    this.manualProfile(before, input.submissionId);
    await this.currentDocuments(before, this.db);
    await this.noActiveKycJobs(userId, this.db);
    const read = this.reader();
    const customer = object(await read.read('GET', '/customer/get', { query: { customerId: input.customerId } }), 'customer');
    const customerId = identifier(customer.customerId ?? customer.id), customerNo = identifier(customer.no ?? customer.customerNo);
    if (customerId !== input.customerId || customerNo !== input.customerNo ||
      customer.id !== undefined && identifier(customer.id) !== input.customerId || customer.customerNo !== undefined && identifier(customer.customerNo) !== input.customerNo ||
      name(customer.givenName) !== name(before.firstName) || name(customer.lastName) !== name(before.lastName) || email(customer.email) !== email(before.email) ||
      contact(customer.phone) !== contact(before.phone) || contact(customer.globalCode) !== contact(before.globalCode)) conflict('The provider customer does not match this client identity');
    const info = object(await read.read('GET', '/kyc/info', { query: { customerNo: input.customerNo } }), 'customer verification');
    const documentType = before.documentType === 'id_card' ? 1 : 2;
    const selected = Array.isArray(info.items) ? info.items.filter(item => item && typeof item === 'object' && (item as Record<string, unknown>).documentType === documentType) as Record<string, unknown>[] : [];
    if (selected.length !== 1 || selected[0]!.level !== 1 || selected[0]!.status !== 1 || info.authResult !== 1 ||
      !Number.isSafeInteger(info.primaryApprovedNum) || Number(info.primaryApprovedNum) < 1) conflict('UPay has not confirmed approval of the current identity document');
    try {
      await this.db.transaction(async tx => {
        await this.assertAdmin(actor, tx);
        await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
        const [current] = await tx.select().from(kycProfiles).where(eq(kycProfiles.userId, userId)).for('update');
        this.manualProfile(current, input.submissionId);
        if (fingerprint(current) !== fingerprint(before)) conflict();
        await this.currentDocuments(current, tx);
        await this.noActiveKycJobs(userId, tx);
        const foreign = await tx.select({ userId: kycProfiles.userId }).from(kycProfiles).where(and(eq(kycProfiles.partnerCustomerId, input.customerNo), ne(kycProfiles.userId, userId)));
        if (foreign.length) conflict('This provider customer is already assigned to another client');
        await tx.insert(adminAuditLog).values({ actorUserId: actor, targetUserId: userId, action: 'manual_kyc_approve', reference: input.submissionId,
          metadata: { submissionId: input.submissionId, customerId: input.customerId, customerNo: input.customerNo, documentsMatch: true, identityProofHash: fingerprint(customer) } });
        const now = new Date();
        await tx.update(kycProfiles).set({ status: 'approved', submissionState: 'manual_verified', partnerCustomerId: input.customerNo,
          documentsSubmittedAt: now, reviewedAt: now, rejectionReason: null, updatedAt: now }).where(eq(kycProfiles.userId, userId));
        await this.documents.removeOwned(userId, Object.values(current.documentIds ?? {}), tx);
        await notify(tx, userId, { type: 'kyc_approved' });
      });
    } catch (error) { if (isUniqueViolation(error)) conflict('This verification or provider customer is already assigned'); throw error; }
    return this.client(actor, userId);
  }

  async rejectKyc(actor: string, userId: string, input: { submissionId: string; reason: string }) {
    await this.assertAdmin(actor);
    const reason = input.reason.trim();
    if (!reason || reason.length > 500) conflict('A rejection reason is required');
    await this.db.transaction(async tx => {
      await this.assertAdmin(actor, tx);
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      const [current] = await tx.select().from(kycProfiles).where(eq(kycProfiles.userId, userId)).for('update');
      this.manualProfile(current, input.submissionId);
      await this.noActiveKycJobs(userId, tx);
      await tx.insert(adminAuditLog).values({ actorUserId: actor, targetUserId: userId, action: 'manual_kyc_reject', reference: input.submissionId });
      await tx.update(kycProfiles).set({ status: 'rejected', submissionState: 'none', rejectionReason: reason, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(kycProfiles.userId, userId));
      await this.documents.removeOwned(userId, Object.values(current.documentIds ?? {}), tx);
      await notify(tx, userId, { type: 'kyc_rejected' });
    });
    return this.client(actor, userId);
  }

  private async pages(read: ReturnType<ManualAdminService['reader']>, method: 'GET' | 'POST', path: string, filter: Record<string, string | number>) {
    const rows: Record<string, unknown>[] = [];
    let expectedPages: number | undefined;
    for (let pageNo = 1; pageNo <= 20; pageNo++) {
      const params = { ...filter, pageNo, pageSize: 100 };
      const page = object(await read.read(method, path, method === 'GET' ? { query: params } : { body: params }), 'provider page');
      if (!Array.isArray(page.list) || !Number.isSafeInteger(page.totalPages) || Number(page.totalPages) < 0 || Number(page.totalPages) > 20 ||
        page.pageNo !== undefined && page.pageNo !== pageNo || expectedPages !== undefined && page.totalPages !== expectedPages ||
        page.totalPages === 0 && page.list.length !== 0 || page.list.length > 100) conflict('Provider pagination is incomplete');
      expectedPages ??= Number(page.totalPages);
      rows.push(...page.list.map(item => object(item, 'provider row')));
      if (pageNo >= Number(page.totalPages)) return rows;
    }
    return conflict('Provider pagination is incomplete');
  }

  async providerCards(actor: string, userId: string) {
    await this.assertAdmin(actor);
    const [profile] = await this.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    if (profile?.status !== 'approved' || profile.partnerProvider !== 'upay' || !profile.partnerCustomerId) conflict('A verified provider customer is required');
    const read = this.reader();
    const rows = await this.pages(read, 'GET', '/card/list', { customerNo: profile.partnerCustomerId });
    const selected = rows.filter(row => identifier(row.customerNo) === profile.partnerCustomerId && identifier(row.agentCustomerCardId));
    if (new Set(selected.map(row => identifier(row.agentCustomerCardId))).size !== selected.length) conflict('Provider card list contains conflicting identifiers');
    const [current] = await this.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    if (!current || fingerprint(current) !== fingerprint(profile)) conflict();
    return selected.map(row => {
      const masked = typeof row.cardNumber === 'string' && /[*xX]/.test(row.cardNumber) ? /\d{4}$/.exec(row.cardNumber)?.[0] ?? null : null;
      const state = Number(row.state ?? row.cardStatus);
      return { id: identifier(row.agentCustomerCardId)!, brokerCardId: identifier(row.brokerCardId), last4: masked,
        state: Number.isSafeInteger(state) ? state : 0, holderName: typeof row.cardSignatureName === 'string' && row.cardSignatureName.length <= 120 ? row.cardSignatureName : null };
    });
  }

  async bindCard(actor: string, userId: string, input: CardBinding) {
    await this.assertAdmin(actor);
    if (!identifier(input.partnerCardId) || !identifier(input.orderNo)) conflict('Exact card and receipt identifiers are required');
    const [profile] = await this.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    const [operation] = await this.db.select().from(cardOperations).where(and(eq(cardOperations.id, input.operationId), eq(cardOperations.userId, userId)));
    if (!profile || profile.status !== 'approved' || profile.partnerProvider !== 'upay' || !profile.partnerCustomerId || !profile.submissionId ||
      !operation || operation.type !== 'issue' || operation.fulfillmentMode !== 'manual' || operation.status !== 'pending' || operation.partnerProvider !== 'upay' || operation.fee === null || !operation.asset) conflict('Only a pending manual application with a verified customer can be fulfilled');
    const [localCard] = await this.db.select().from(cards).where(and(eq(cards.id, operation.cardId), eq(cards.userId, userId)));
    if (!localCard || localCard.status !== 'pending' || localCard.partnerCardId) conflict('The local card is no longer awaiting manual fulfilment');
    const read = this.reader();
    const detail = object(await read.read('GET', '/card/getAgentCustomerCardDetail', { query: { agentCustomerCardId: input.partnerCardId } }), 'card detail');
    if (identifier(detail.agentCustomerCardId) !== input.partnerCardId || identifier(detail.customerNo) !== profile.partnerCustomerId ||
      Number(detail.cardStatus ?? detail.state) !== 1) conflict('The provider card is not an active card of this verified customer');
    let product = identifier(detail.agentCardId ?? detail.typeId), holder = name(detail.cardSignatureName);
    if (!product || !holder) {
      const list = await this.pages(read, 'GET', '/card/list', { customerNo: profile.partnerCustomerId });
      const matches = list.filter(row => identifier(row.agentCustomerCardId) === input.partnerCardId && identifier(row.customerNo) === profile.partnerCustomerId);
      if (matches.length !== 1) conflict('The provider card/product binding cannot be verified');
      product ??= identifier(matches[0]!.agentCardId ?? matches[0]!.typeId);
      holder ??= name(matches[0]!.cardSignatureName);
    }
    if (product !== this.config.UPAY_PRODUCT_ID || holder !== name(`${profile.firstName ?? ''} ${profile.lastName ?? ''}`)) conflict('The card product or cardholder does not match the application');
    const records = await this.pages(read, 'POST', '/card/getPageToCardOperateRecord', { operateType: 5, orderNo: input.orderNo });
    const matches = records.filter(row => identifier(row.orderNo) === input.orderNo);
    if (matches.length !== 1) conflict('The exact issuance receipt cannot be verified');
    const receipt = matches[0]!;
    const receiptCardId = identifier(receipt.agentCustomerCardId), receiptBrokerId = identifier(receipt.brokerCardId ?? receipt.cardId);
    const detailBrokerId = identifier(detail.brokerCardId);
    if (receipt.agentCustomerCardId !== undefined && receiptCardId !== input.partnerCardId ||
      receipt.brokerCardId !== undefined && identifier(receipt.brokerCardId) !== detailBrokerId ||
      receipt.cardId !== undefined && identifier(receipt.cardId) !== detailBrokerId) conflict('The receipt card identifiers conflict');
    if (Number(receipt.status) !== 1 || identifier(receipt.customerNo) !== profile.partnerCustomerId || receipt.currency !== 'USDT' ||
      !(receiptCardId === input.partnerCardId || receiptBrokerId !== null && receiptBrokerId === detailBrokerId)) conflict('The receipt does not prove issuance of this customer card');
    let actualCost: bigint;
    try {
      const budget = convertMinor(operation.fee, operation.asset as WalletAsset, 'USD');
      actualCost = exactCents(receipt.paymentAmount, 'manual issuance payment');
      if (actualCost > budget || exactCents(receipt.openCardAmount, 'manual issuance fee') > budget || exactCents(receipt.rechargeAmount, 'manual initial recharge') !== 0n) conflict('The actual issuance cost exceeds the reserved fee or contains a recharge');
    } catch (error) { if (error instanceof AppError) throw error; conflict('The receipt amounts cannot be verified'); }
    const info = await read.loginInfo();
    const accountId = identifier(detail.accountCardId);
    if (!accountId || !info.iv) conflict('Authenticated card display metadata is unavailable');
    let issued: PartnerCard;
    try {
      const expiryText = typeof detail.expirationTime === 'string' && /^(?:\d{2}\/\d{2,4}|\d{4}-\d{2}(?:-\d{2})?)$/.test(detail.expirationTime)
        ? detail.expirationTime : decryptCardField(detail.expirationTime, accountId, info.iv);
      const cardNumber = typeof detail.cardNumber === 'string' ? detail.cardNumber : '';
      const visible = /[*xX]/.test(cardNumber) && /\d{4}$/.test(cardNumber) ? cardNumber : decryptCardField(cardNumber, accountId, info.iv);
      const last4 = /\d{4}$/.exec(visible)?.[0];
      if (!last4) conflict('The verified card display cannot be read');
      issued = { partnerCardId: input.partnerCardId, last4, ...expiry(expiryText) };
    } catch (error) { if (error instanceof AppError) throw error; conflict('The verified card display cannot be read'); }
    try {
      await this.cardService.completeManualIssue(actor, userId, operation.id, issued!, { grossUsd: actualCost!, orderNo: input.orderNo,
        partnerCustomerId: profile.partnerCustomerId, submissionId: profile.submissionId, productId: this.config.UPAY_PRODUCT_ID, operationUpdatedAt: operation.updatedAt.toISOString(),
        ...(identifier(receipt.id) ? { receiptRecordId: identifier(receipt.id)! } : {}) });
    } catch (error) { if (isUniqueViolation(error)) conflict('This card or receipt is already assigned'); throw error; }
    return this.client(actor, userId);
  }
}
