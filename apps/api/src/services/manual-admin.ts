import { createHash, randomUUID } from 'node:crypto';
import { and, count, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { CARD_TOPUP_ROUTES, fromMinor, convertMinor, type CardTopupAddresses, type WalletAsset } from '@gudex/shared';
import type { Config } from '../config';
import type { Db, DbOrTx, Tx } from '../db/client';
import { adminAuditLog, cardOperations, cards, jobs, kycDocuments, kycProfiles, users } from '../db/schema';
import { DbKycDocumentStore, type KycDocumentKind } from '../kyc/document-store';
import { AppError, isUniqueViolation } from '../lib/errors';
import type { UpayClient } from '../partner/upay/client';
import { exactCents, identifier, object } from '../partner/upay/financial-protocol';
import type { PartnerCard } from '../partner/types';
import type { CardService } from './cards';
import { notify } from './notify';
import { CardBillingService } from './card-billing';
import { CardRequisitesVault, luhnValid } from './card-requisites';
import { assignMailAddress, checkMailAddress, clientMailAddress } from './mail';

type Profile = typeof kycProfiles.$inferSelect;
type ReadClient = Pick<UpayClient, 'readRequest' | 'loginInfo'>;
type KycApproval = { submissionId: string; customerId: string; customerNo: string; documentsMatch: true };
type CardBinding = { operationId: string; customerNo?: string; cardNumber: string; expiryMonth: number; expiryYear: number; cvv: string; email: string };
const validUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function conflict(message = 'Заявка изменилась. Обновите страницу и повторите.'): never { throw new AppError('validation', message); }
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
    const hasRequest = sql<boolean>`exists (select 1 from ${cardOperations} o where o.user_id = ${users.id} and o.fulfillment_mode = 'manual' and o.type <> 'issue' and o.status = 'pending')`;
    // A saved application appears only once paid (it then has a reserved issuance); before that there is nothing to do.
    const condition = or(eq(kycProfiles.status, 'unknown'), and(eq(kycProfiles.status, 'pending'), ne(kycProfiles.submissionState, 'manual_review')), hasCard, hasRequest);
    const [totalRows, list] = await Promise.all([
      this.db.select({ value: count() }).from(users).leftJoin(kycProfiles, eq(kycProfiles.userId, users.id)).where(condition),
      this.db.select({ userId: users.id, telegramId: users.telegramId, firstName: kycProfiles.firstName, lastName: kycProfiles.lastName,
        kycStatus: kycProfiles.status, submissionState: kycProfiles.submissionState, hasPendingCard: hasCard, hasCardRequest: hasRequest, createdAt: users.createdAt })
        .from(users).leftJoin(kycProfiles, eq(kycProfiles.userId, users.id)).where(condition).orderBy(desc(users.createdAt))
        .limit(limit).offset((page - 1) * limit),
    ]);
    return { items: list.map(row => ({ userId: row.userId, telegramId: String(row.telegramId), name: [row.firstName, row.lastName].filter(Boolean).join(' '),
      kycStatus: row.kycStatus ?? 'none', submissionState: row.submissionState ?? 'none', hasPendingCard: row.hasPendingCard, hasCardRequest: row.hasCardRequest, createdAt: row.createdAt.toISOString() })),
    page, limit, total: totalRows[0]?.value ?? 0 };
  }

  async client(actor: string, query: string) {
    await this.assertAdmin(actor);
    const byId = validUuid.test(query);
    if (!byId && (!/^[1-9]\d{0,18}$/.test(query) || BigInt(query) > 9223372036854775807n)) throw new AppError('validation', 'Enter an exact client ID or Telegram ID');
    const [user] = await this.db.select().from(users).where(byId ? eq(users.id, query) : eq(users.telegramId, BigInt(query)));
    if (!user) throw new AppError('not_found', 'Клиент не найден');
    const [profile] = await this.db.select().from(kycProfiles).where(eq(kycProfiles.userId, user.id));
    const operations = await this.db.select({ op: cardOperations, card: cards }).from(cardOperations).innerJoin(cards, eq(cards.id, cardOperations.cardId))
      .where(and(eq(cardOperations.userId, user.id), eq(cards.userId, user.id))).orderBy(desc(cardOperations.createdAt)).limit(100);
    const docIds = Object.values(profile?.documentIds ?? {});
    const documents = docIds.length ? await this.db.select({ id: kycDocuments.id, kind: kycDocuments.kind, mimeType: kycDocuments.mimeType,
      size: kycDocuments.size, expiresAt: kycDocuments.expiresAt }).from(kycDocuments)
      .where(and(eq(kycDocuments.userId, user.id), inArray(kycDocuments.id, docIds))) : [];
    const billingAddress = profile?.billingAddress ?? await new CardBillingService(this.db, this.config).getSavedForAdmin(user.id)
      .then(address => address ? { ...address, countryName: null } : null);
    const clientCards = await this.db.select({ id: cards.id, status: cards.status, last4: cards.last4, topupAddresses: cards.topupAddresses }).from(cards)
      .where(and(eq(cards.userId, user.id), inArray(cards.status, ['pending', 'active', 'frozen']))).orderBy(desc(cards.createdAt));
    const mail = await clientMailAddress(this.db, this.config.MAIL_DOMAIN, user.id);
    return { userId: user.id, telegramId: String(user.telegramId), username: user.username, createdAt: user.createdAt.toISOString(), billingAddress, mail,
      cards: clientCards.map(card => ({ id: card.id, status: card.status, last4: card.last4, topupAddresses: (card.topupAddresses ?? {}) as CardTopupAddresses })),
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
        netUsd: op.netUsd === null ? null : fromMinor(op.netUsd, 'USD'),
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
    if (!name(profile.firstName) || !name(profile.lastName) || !['id_card', 'passport', 'driving_license'].includes(profile.documentType ?? '')) conflict('В анкете не хватает имени, фамилии или типа документа');
  }

  private async currentDocuments(profile: Profile, db: DbOrTx) {
    const ids = profile.documentIds;
    if (!ids?.front || profile.documentType !== 'passport' && !ids.back) conflict('Current document photographs are required');
    for (const [role, id] of Object.entries(ids!)) await this.documents.getOwned(profile.userId, id, role as KycDocumentKind, db);
  }

  private async noActiveKycJobs(userId: string, db: DbOrTx) {
    const active = await db.select({ id: jobs.id }).from(jobs).where(sql`${jobs.payload}->>'userId' = ${userId} and ${jobs.queue} in ('kyc.submit','kyc.poll') and ${jobs.status} in ('queued','running')`);
    if (active.length) conflict('Дождитесь завершения автоматической проверки анкеты и повторите.');
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
      name(customer.givenName) !== name(before.firstName) || name(customer.lastName) !== name(before.lastName) || before.email !== null && email(customer.email) !== email(before.email) ||
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

  /** Declines the current application: the questionnaire (if under review) and any reserved manual issuance. */
  async rejectKyc(actor: string, userId: string, input: { submissionId?: string; reason: string }) {
    await this.assertAdmin(actor);
    const reason = input.reason.trim();
    if (!reason || reason.length > 500) conflict('Укажите причину отказа');
    await this.db.transaction(async tx => {
      await this.assertAdmin(actor, tx);
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      const [current] = await tx.select().from(kycProfiles).where(eq(kycProfiles.userId, userId)).for('update');
      const reviewing = current?.status === 'pending' && current.submissionState === 'manual_review';
      if (reviewing) {
        this.manualProfile(current, input.submissionId ?? '');
        await this.noActiveKycJobs(userId, tx);
      }
      const refunds = await this.cardService.cancelManualApplication(tx, userId, reason);
      if (!reviewing && !refunds.length) conflict('Нет заявки, которую можно отклонить. Обновите страницу.');
      for (const refund of refunds) {
        await tx.insert(adminAuditLog).values({ actorUserId: actor, targetUserId: userId, action: 'manual_application_cancel', reference: refund.operationId,
          metadata: { amount: refund.amount, asset: refund.asset, sponsored: refund.sponsored } });
      }
      if (reviewing) {
        await tx.insert(adminAuditLog).values({ actorUserId: actor, targetUserId: userId, action: 'manual_kyc_reject', reference: current.submissionId! });
        await tx.update(kycProfiles).set({ status: 'rejected', submissionState: 'none', rejectionReason: reason, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(kycProfiles.userId, userId));
        await this.documents.removeOwned(userId, Object.values(current.documentIds ?? {}), tx);
      }
      const refund = refunds.at(-1);
      await notify(tx, userId, { type: 'application_rejected', reason,
        ...(refund ? { amount: refund.amount, asset: refund.asset, sponsored: refund.sponsored } : {}) });
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
        page.totalPages === 0 && page.list.length !== 0 || page.list.length > 100) conflict('UPay вернул неполный список карт. Повторите позже.');
      expectedPages ??= Number(page.totalPages);
      rows.push(...page.list.map(item => object(item, 'provider row')));
      if (pageNo >= Number(page.totalPages)) return rows;
    }
    return conflict('UPay вернул неполный список карт. Повторите позже.');
  }

  // Cards of the stored verified customer, or of the customer the operator names for an application under review.
  async providerCards(actor: string, userId: string, requestedCustomerNo?: string) {
    await this.assertAdmin(actor);
    const [profile] = await this.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    const reviewing = profile?.status === 'pending' && profile.submissionState === 'manual_review' && profile.partnerProvider === 'upay';
    if (!reviewing && (profile?.status !== 'approved' || profile.partnerProvider !== 'upay' || !profile.partnerCustomerId)) conflict('Анкета клиента не готова к привязке карты');
    if (reviewing && !identifier(requestedCustomerNo)) conflict('Укажите Customer ID клиента в UPay');
    const customerNo = reviewing ? requestedCustomerNo! : profile!.partnerCustomerId!;
    if (reviewing) {
      const foreign = await this.db.select({ userId: kycProfiles.userId }).from(kycProfiles).where(and(eq(kycProfiles.partnerCustomerId, customerNo), ne(kycProfiles.userId, userId)));
      if (foreign.length) conflict('Этот клиент UPay уже привязан к другому пользователю GUDEX');
    }
    const read = this.reader();
    const rows = await this.pages(read, 'GET', '/card/list', { customerNo });
    const selected = rows.filter(row => identifier(row.customerNo) === customerNo && identifier(row.agentCustomerCardId));
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

  /** Links a card the operator issued in UPay. The operator types the card details; the server only finds
   * this card in the customer's UPay card list (the one read the bot may do) and checks holder and state.
   * When the questionnaire is still under review, its approval commits together with the card. */
  /** The crypto addresses UPay gives this card for top-ups, typed by the operator. An empty value removes that route. */
  async setTopupAddresses(actor: string, userId: string, cardId: string, input: CardTopupAddresses) {
    await this.assertAdmin(actor);
    const addresses: Record<string, string> = {};
    for (const route of CARD_TOPUP_ROUTES) {
      const value = input[route.key]?.trim() ?? '';
      if (!value) continue;
      const valid = route.network === 'TRC20' ? /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value) : /^0x[0-9a-fA-F]{40}$/.test(value);
      if (!valid) throw new AppError('validation', `Адрес ${route.asset} ${route.network} указан неверно`);
      addresses[route.key] = value;
    }
    await this.db.transaction(async tx => {
      await this.assertAdmin(actor, tx);
      const [card] = await tx.select().from(cards).where(and(eq(cards.id, cardId), eq(cards.userId, userId))).for('update');
      if (!card || !['pending', 'active', 'frozen'].includes(card.status)) throw new AppError('not_found', 'Карта не найдена');
      await tx.update(cards).set({ topupAddresses: Object.keys(addresses).length ? addresses : null, updatedAt: new Date() }).where(eq(cards.id, cardId));
      await tx.insert(adminAuditLog).values({ actorUserId: actor, targetUserId: userId, action: 'card_topup_addresses', reference: `${cardId}:${randomUUID()}`,
        metadata: { routes: Object.keys(addresses) } });
    });
    return this.client(actor, userId);
  }

  async bindCard(actor: string, userId: string, input: CardBinding) {
    await this.assertAdmin(actor);
    const pan = input.cardNumber.replace(/\s+/g, '');
    const year = input.expiryYear < 100 ? 2000 + input.expiryYear : input.expiryYear;
    const now = new Date();
    if (!luhnValid(pan)) conflict('Проверьте номер карты: он введён с ошибкой');
    if (!/^\d{3,4}$/.test(input.cvv)) conflict('CVV - это 3 или 4 цифры');
    if (!Number.isInteger(input.expiryMonth) || input.expiryMonth < 1 || input.expiryMonth > 12 || !Number.isInteger(year)
      || year > now.getUTCFullYear() + 15 || year * 12 + input.expiryMonth < now.getUTCFullYear() * 12 + now.getUTCMonth() + 1) conflict('Проверьте срок действия карты');
    if (input.customerNo !== undefined && !identifier(input.customerNo)) conflict('Проверьте Customer ID клиента в UPay');
    // The email the operator gave this client in UPay: codes sent there reach the client's Telegram.
    const mailAddress = await checkMailAddress(this.db, this.config.MAIL_DOMAIN, userId, input.email);
    const [profile] = await this.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    const [operation] = await this.db.select().from(cardOperations).where(and(eq(cardOperations.id, input.operationId), eq(cardOperations.userId, userId)));
    if (!operation || operation.type !== 'issue' || operation.fulfillmentMode !== 'manual' || operation.status !== 'pending' || operation.partnerProvider !== 'upay'
      || operation.fee === null || !operation.asset) conflict('Привязать можно только оплаченную заявку, которая ждёт ручного выпуска');
    const approving = profile?.status === 'pending' && profile.submissionState === 'manual_review';
    if (approving) {
      this.manualProfile(profile, profile.submissionId ?? '');
      if (!input.customerNo) conflict('Укажите Customer ID клиента в UPay');
      await this.noActiveKycJobs(userId, this.db);
      const foreign = await this.db.select({ userId: kycProfiles.userId }).from(kycProfiles)
        .where(and(eq(kycProfiles.partnerCustomerId, input.customerNo!), ne(kycProfiles.userId, userId)));
      if (foreign.length) conflict('Этот клиент UPay уже привязан к другому пользователю GUDEX');
    } else if (!profile || profile.status !== 'approved' || profile.partnerProvider !== 'upay' || !profile.partnerCustomerId || !profile.submissionId
      || input.customerNo !== undefined && input.customerNo !== profile.partnerCustomerId) {
      conflict('Анкета клиента не готова к привязке карты. Обновите страницу.');
    }
    const customerNo = approving ? input.customerNo! : profile!.partnerCustomerId!;
    const [localCard] = await this.db.select().from(cards).where(and(eq(cards.id, operation!.cardId), eq(cards.userId, userId)));
    if (!localCard || localCard.status !== 'pending' || localCard.partnerCardId) conflict('Эта заявка уже не ждёт карту. Обновите страницу.');
    const last4 = pan.slice(-4);
    // The bot looks only at this Customer ID's card list: the customer's active card is the one to link.
    const rows = await this.pages(this.reader(), 'GET', '/card/list', { customerNo });
    const active = rows.filter(row => identifier(row.customerNo) === customerNo && identifier(row.agentCustomerCardId) && Number(row.state ?? row.cardStatus) === 1);
    const linked = await this.db.select({ partnerCardId: cards.partnerCardId }).from(cards).where(inArray(cards.partnerCardId,
      active.map(row => identifier(row.agentCustomerCardId)!).concat(['-'])));
    const candidates = active.filter(row => !linked.some(card => card.partnerCardId === identifier(row.agentCustomerCardId)));
    if (!candidates.length) conflict(`У Customer ID ${customerNo} в UPay нет новой активной карты. Выпустите карту и повторите.`);
    const sameDigits = candidates.filter(row => typeof row.cardNumber === 'string' && row.cardNumber.replace(/\s+/g, '').endsWith(last4));
    if (candidates.length > 1 && sameDigits.length !== 1) conflict(`У Customer ID ${customerNo} несколько новых карт; проверьте номер карты`);
    const row = candidates.length === 1 ? candidates[0]! : sameDigits[0]!;
    if (typeof row.cardNumber === 'string' && /\d{4}$/.test(row.cardNumber) && !row.cardNumber.replace(/\s+/g, '').endsWith(last4)) {
      conflict(`Карта этого Customer ID в UPay заканчивается не на ${last4}. Проверьте номер карты.`);
    }
    const partnerCardId = identifier(row.agentCustomerCardId)!;
    let balance: bigint | null = null;
    try { balance = row.balance === undefined || row.symbol !== undefined && row.symbol !== 'USD' ? null : exactCents(row.balance, 'card balance'); } catch { balance = null; }
    const issued: PartnerCard = { partnerCardId, last4, expiryMonth: input.expiryMonth, expiryYear: year };
    const vault = new CardRequisitesVault(this.config.appSecret);
    const beforeSettle = async (tx: Tx) => {
      if (approving) {
        await this.assertAdmin(actor, tx);
        const [current] = await tx.select().from(kycProfiles).where(eq(kycProfiles.userId, userId)).for('update');
        this.manualProfile(current, profile!.submissionId!);
        if (fingerprint(current) !== fingerprint(profile)) conflict();
        await this.noActiveKycJobs(userId, tx);
        const foreign = await tx.select({ userId: kycProfiles.userId }).from(kycProfiles).where(and(eq(kycProfiles.partnerCustomerId, customerNo), ne(kycProfiles.userId, userId)));
        if (foreign.length) conflict('Этот клиент UPay уже привязан к другому пользователю GUDEX');
        await tx.insert(adminAuditLog).values({ actorUserId: actor, targetUserId: userId, action: 'manual_kyc_approve', reference: current.submissionId!,
          metadata: { submissionId: current.submissionId, customerNo, approvedWith: 'card_link', partnerCardId } });
        await tx.update(kycProfiles).set({ status: 'approved', submissionState: 'manual_verified', partnerCustomerId: customerNo,
          documentsSubmittedAt: now, reviewedAt: now, rejectionReason: null, updatedAt: now }).where(eq(kycProfiles.userId, userId));
        await this.documents.removeOwned(userId, Object.values(current.documentIds ?? {}), tx);
      }
      await assignMailAddress(tx, userId, mailAddress);
      await tx.update(cards).set({ ...vault.seal(userId, operation!.cardId, { pan, cvv: input.cvv }),
        ...(balance !== null ? { partnerBalance: balance, partnerBalanceAt: now } : {}) }).where(eq(cards.id, operation!.cardId));
    };
    try {
      // No UPay receipt is read: the reserved fee is recorded as the issuance cost.
      await this.cardService.completeManualIssue(actor, userId, operation!.id, issued, {
        grossUsd: convertMinor(operation!.fee!, operation!.asset as WalletAsset, 'USD'), orderNo: `manual-${operation!.id}`,
        partnerCustomerId: customerNo, submissionId: profile!.submissionId!, productId: this.config.UPAY_PRODUCT_ID,
        operationUpdatedAt: operation!.updatedAt.toISOString() }, beforeSettle);
    } catch (error) { if (isUniqueViolation(error)) conflict('Эта карта или клиент UPay уже привязаны к другой заявке'); throw error; }
    return this.client(actor, userId);
  }
}
