import { createHash, createHmac } from 'node:crypto';
import { and, desc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import {
  CARD_TOPUP_ROUTES,
  type CardDto,
  type CardSensitiveDto,
  type CardIssueQuoteDto,
  type CardAdditionalAttemptInput,
  type CardAdditionalAttemptQuoteDto,
  convertMinor,
  fromMinor,
  type OperationDto,
  percentOf,
  toMinor,
  type TopupQuoteDto,
  type WalletAsset,
} from '@gudex/shared';
import type { Config } from '../config';
import type { Db, DbOrTx, Tx } from '../db/client';
import { adminAuditLog, cardBillingAddresses, cardIssueRetryConsents, cardIssueSponsorships, cardOperationRequestAliases, cardOperations, cards, cardTransactions, kycProfiles, ledgerAccounts, upaySubmissionAliases, upaySubmissions, users } from '../db/schema';
import { accounts, ensureAccount, getBalance, move, post } from '../ledger/ledger';
import { AppError, isUniqueViolation } from '../lib/errors';
import { PartnerBillingAddressRequiredError, PartnerCardRegionRestrictedError, PartnerError, PartnerPendingError, type CardPartner } from '../partner/types';
import { provenNotDispatched, UpayNotDispatchedError } from '../partner/upay/financial-partner';
import { enqueue, type JobContext, type JobHandler, PermanentJobError, RetryLater } from '../queue/queue';
import { notify } from './notify';
import { notifyAdmins } from './admin-notify';
import { CardBillingService } from './card-billing';
import { CardRequisitesVault } from './card-requisites';
import { rewardReferrer } from './referrals';
import { ADDITIONAL_ISSUE_ORIGINAL_ID, ADDITIONAL_ISSUE_TELEGRAM_ID, ADDITIONAL_ISSUE_TERMS, type AdditionalIssueSnapshot, signAdditionalIssueQuote, verifyAdditionalIssueQuote } from './additional-issue-quote';

type CardRow = typeof cards.$inferSelect;
type OperationRow = typeof cardOperations.$inferSelect;
type SponsorshipRow = typeof cardIssueSponsorships.$inferSelect;
type IssueInput = { asset: WalletAsset; idempotencyKey: string; expectedFundingSource?: 'wallet' | 'broker'; expectedCustomerCharge?: string };
const SPONSOR_BUDGET_USD = 1000n;

const LIVE_STATUSES = ['pending', 'active', 'frozen'] as const;
const TERMINAL = ['succeeded', 'failed'];
const SYNC_INTERVAL_MS = 60_000;
const ISSUE_RECEIPT_LOOKUP_MS = 30 * 60_000;
// A freeze or unfreeze moves no money: if the card list still shows the old state this long after, the change did not happen.
const STATUS_CONFIRM_MS = 10 * 60_000;
const STATUS_GIVE_UP_MS = 24 * 60 * 60_000;

function operationDto(op: OperationRow): OperationDto {
  const asset = op.asset as WalletAsset | null;
  const sponsored = Boolean(op.sponsorshipId);
  return {
    id: op.id,
    type: op.type,
    status: op.status,
    fulfillmentMode: op.fulfillmentMode === 'manual' ? 'manual' : 'automatic',
    cardId: op.cardId,
    asset,
    amount: sponsored ? '0' : asset && op.amount !== null ? fromMinor(op.amount, asset) : null,
    fee: sponsored ? '0' : asset && op.fee !== null ? fromMinor(op.fee, asset) : null,
    ...(op.type === 'issue' ? { fundingSource: sponsored ? 'broker' as const : 'wallet' as const } : {}),
    error: op.error,
    createdAt: op.createdAt.toISOString(),
  };
}

export class CardService {
  private readonly issueFeeUsd: bigint;
  private readonly minTopupUsd: bigint;
  private vault: CardRequisitesVault | undefined;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly partner: CardPartner,
  ) {
    this.issueFeeUsd = toMinor(config.CARD_ISSUE_FEE_USD, 'USD');
    this.minTopupUsd = toMinor(config.CARD_MIN_TOPUP_USD, 'USD');
  }

  // With manual issuance every client has exactly one card.
  private get maxCards(): number { return this.config.CARD_ISSUANCE_MODE === 'manual' ? 1 : this.config.MAX_CARDS_PER_USER; }

  private get requisites(): CardRequisitesVault { return this.vault ??= new CardRequisitesVault(this.config.appSecret); }

  // Manual issuance: staff perform every card action in the UPay panel; GUDEX only records and reads.
  private get manual(): boolean { return this.config.CARD_ISSUANCE_MODE === 'manual'; }

  // ─── Чтение ────────────────────────────────────────────────────────────

  async list(userId: string): Promise<CardDto[]> {
    const rows = await this.db
      .select()
      .from(cards)
      .where(and(eq(cards.userId, userId), inArray(cards.status, [...LIVE_STATUSES])))
      .orderBy(desc(cards.createdAt));
    // Без постоянно работающего сервера покупки подтягиваются, когда пользователь смотрит карты.
    const staleBefore = Date.now() - SYNC_INTERVAL_MS;
    for (const card of rows) {
      if (card.partnerCardId && (!card.lastSyncedAt || card.lastSyncedAt.getTime() < staleBefore)) {
        await enqueue(this.db, 'card.sync', { cardId: card.id }, { dedupeKey: `card.sync:${card.id}`, maxAttempts: 3 });
      }
    }
    return Promise.all(rows.map((card) => this.toDto(card)));
  }

  async get(userId: string, cardId: string): Promise<CardDto> {
    return this.toDto(await this.ownedCard(userId, cardId));
  }

  async getOperation(userId: string, operationId: string): Promise<OperationDto> {
    const [op] = await this.db
      .select()
      .from(cardOperations)
      .where(and(eq(cardOperations.id, operationId), eq(cardOperations.userId, userId)));
    if (!op) throw new AppError('not_found', 'Operation not found');
    await this.scheduleRecovery(op);
    return { ...operationDto(op), issueRestriction: await this.issueRestriction(op) };
  }

  // A known refusal describes this exact submission; it never authorizes a
  // replay/refund and must not be inferred for an older missing response.
  private async issueRestriction(op: OperationRow): Promise<'billing_phone_region_restricted' | null> {
    if (op.type !== 'issue' || op.status !== 'unknown' || op.partnerProvider !== 'upay') return null;
    const [submission] = await this.db.select({ kind: upaySubmissions.kind, state: upaySubmissions.state, evidence: upaySubmissions.evidence })
      .from(upaySubmissions).where(eq(upaySubmissions.reference, op.id));
    if (!submission || submission.kind !== 'issue' || submission.state !== 'unknown') return null;
    const evidence = submission.evidence as Record<string, unknown> | null;
    return evidence?.step === 'card_issue' && evidence.dispatchPhase === 'post_dispatched' && evidence.responseAck === 'rejected_envelope'
      && evidence.businessCategory === 'billing_phone_region_restricted' ? 'billing_phone_region_restricted' : null;
  }

  async getSensitive(userId: string, cardId: string): Promise<CardSensitiveDto> {
    const card = await this.ownedCard(userId, cardId);
    if (!card.partnerCardId || (card.status !== 'active' && card.status !== 'frozen')) {
      throw new AppError('card_not_active', 'Card is not issued yet');
    }
    const stored = this.requisites.open(userId, card.id, card);
    if (stored) return { pan: stored.pan, cvv: stored.cvv, expiryMonth: card.expiryMonth ?? 0, expiryYear: card.expiryYear ?? 0, holderName: card.holderName ?? '' };
    if (this.manual) throw new AppError('card_not_active', 'Card details are not available yet');
    return this.partner.getCardSensitive(card.partnerCardId);
  }

  private async ownedCard(userId: string, cardId: string): Promise<CardRow> {
    const [card] = await this.db.select().from(cards).where(and(eq(cards.id, cardId), eq(cards.userId, userId)));
    if (!card) throw new AppError('not_found', 'Card not found');
    return card;
  }

  private async toDto(card: CardRow): Promise<CardDto> {
    const [account] = await this.db
      .select({ balance: ledgerAccounts.balance })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.code, accounts.card(card.userId, card.id).code));
    const [pendingIssue] = card.status === 'pending'
      ? await this.db.select().from(cardOperations)
        .where(and(eq(cardOperations.cardId, card.id), eq(cardOperations.type, 'issue'), inArray(cardOperations.status, ['pending', 'processing', 'unknown'])))
        .orderBy(desc(cardOperations.createdAt)).limit(1)
      : [];
    if (pendingIssue) await this.scheduleRecovery(pendingIssue);
    return {
      id: card.id,
      status: card.status,
      productName: card.productName,
      last4: card.last4,
      holderName: card.holderName,
      expiryMonth: card.expiryMonth,
      expiryYear: card.expiryYear,
      currency: 'USD',
      balance: fromMinor(card.partnerBalance ?? account?.balance ?? 0n, 'USD'),
      failureReason: card.failureReason,
      topupAddresses: CARD_TOPUP_ROUTES.flatMap(route => card.topupAddresses?.[route.key]
        ? [{ asset: route.asset, network: route.network, address: card.topupAddresses[route.key]! }] : []),
      pendingOperationId: pendingIssue?.id ?? null,
      pendingFulfillmentMode: pendingIssue ? pendingIssue.fulfillmentMode === 'manual' ? 'manual' : 'automatic' : null,
      pendingOperationStatus: pendingIssue?.status === 'pending' || pendingIssue?.status === 'processing' || pendingIssue?.status === 'unknown' ? pendingIssue.status : null,
      issueRestriction: pendingIssue ? await this.issueRestriction(pendingIssue) : null,
      createdAt: card.createdAt.toISOString(),
    };
  }

  // ─── Действия пользователя ─────────────────────────────────────────────
  // Каждое действие: в одной транзакции резервируем деньги, создаём операцию и ставим задачу.
  // Партнёр вызывается уже из воркера — пользователь сразу видит статус «в обработке».

  private issueReceiptLookupOpen(op: OperationRow): boolean {
    const age = Date.now() - op.createdAt.getTime();
    return Number.isFinite(age) && age >= 0 && age < ISSUE_RECEIPT_LOOKUP_MS;
  }

  private async recoveryEvidence(op: OperationRow): Promise<'receipt' | 'not_dispatched' | null> {
    if (this.config.CARD_PARTNER !== 'upay' || op.partnerProvider !== 'upay' || !['issue', 'topup'].includes(op.type) ||
        !['unknown', 'processing'].includes(op.status)) return null;
    const [journal] = await this.db.select({ kind: upaySubmissions.kind, state: upaySubmissions.state,
      partnerReceiptId: upaySubmissions.partnerReceiptId, partnerCardId: upaySubmissions.partnerCardId, evidence: upaySubmissions.evidence })
      .from(upaySubmissions).where(eq(upaySubmissions.reference, op.id));
    if (!journal || journal.kind !== (op.type === 'topup' ? 'recharge' : 'issue')) return null;
    // A persisted proof that no POST was sent does not expire. The adapter must
    // independently return its typed proof before any reserved money is refunded.
    if (op.type === 'issue' && provenNotDispatched(journal)) return 'not_dispatched';
    if (!this.issueReceiptLookupOpen(op) || typeof journal.partnerReceiptId !== 'string') return null;
    const evidence = journal.evidence && typeof journal.evidence === 'object' && !Array.isArray(journal.evidence)
      ? journal.evidence as Record<string, unknown> : {};
    const identifier = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
    const receiptId = identifier(evidence.orderNo) ?? identifier(evidence.receiptRecordId);
    if (!receiptId || journal.partnerReceiptId !== receiptId) return null;
    return journal.state === 'acknowledged' || journal.state === 'confirmed' ||
      (journal.state === 'unknown' && evidence.dispatchPhase === 'post_dispatched' && evidence.responseAck === 'accepted_envelope') ? 'receipt' : null;
  }

  private async scheduleRecovery(op: OperationRow): Promise<void> {
    if (!await this.recoveryEvidence(op)) return;
    await enqueue(this.db, 'card.reconcile', { operationId: op.id }, { dedupeKey: `card.reconcile:${op.id}`, maxAttempts: 3 });
  }

  async grantIssueSponsorship(input: { telegramId: string; reason: string }) {
    if (this.config.CARD_PARTNER !== 'upay' || this.config.DEV_TOOLS) throw new AppError('provider_unavailable', 'Broker issuance coverage is available only for the live UPay provider');
    if (!/^[1-9]\d{0,18}$/.test(input.telegramId) || BigInt(input.telegramId) > 9223372036854775807n || !input.reason?.trim() || input.reason.trim().length > 500) {
      throw new AppError('validation', 'A valid Telegram ID and authorization reason are required');
    }
    const telegramId = BigInt(input.telegramId);
    return this.db.transaction(async tx => {
      const [user] = await tx.select().from(users).where(eq(users.telegramId, telegramId)).for('update');
      let [grant] = await tx.select().from(cardIssueSponsorships).where(and(eq(cardIssueSponsorships.telegramId, telegramId), isNull(cardIssueSponsorships.retryOfOperationId))).for('update');
      if (grant && (grant.partnerProvider !== 'upay' || grant.budgetUsd !== SPONSOR_BUDGET_USD)) throw new AppError('provider_unavailable', 'Existing issuance coverage requires review');
      if (!grant?.operationId && !grant?.consumedAt && user && await this.hasPriorIssuance(tx, user.id)) {
        throw new AppError('validation', 'Broker coverage is limited to the first successful issuance');
      }
      if (!grant) {
        [grant] = await tx.insert(cardIssueSponsorships).values({ telegramId, partnerProvider: 'upay', budgetUsd: SPONSOR_BUDGET_USD, reason: input.reason.trim() })
          .onConflictDoNothing({ target: cardIssueSponsorships.telegramId, where: isNull(cardIssueSponsorships.retryOfOperationId) }).returning();
        if (!grant) [grant] = await tx.select().from(cardIssueSponsorships).where(and(eq(cardIssueSponsorships.telegramId, telegramId), isNull(cardIssueSponsorships.retryOfOperationId))).for('update');
      }
      return { telegramId: grant!.telegramId.toString(), budgetUsd: fromMinor(grant!.budgetUsd, 'USD'), fundingSource: 'broker' as const,
        status: grant!.consumedAt ? 'consumed' as const : grant!.operationId ? 'reserved' as const : 'available' as const };
    });
  }

  async quoteIssue(userId: string, asset: WalletAsset): Promise<CardIssueQuoteDto> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new AppError('unauthorized', 'User not found');
    const [grant] = await this.db.select().from(cardIssueSponsorships).where(and(eq(cardIssueSponsorships.telegramId, user.telegramId), isNull(cardIssueSponsorships.retryOfOperationId)));
    const sponsored = await this.canSponsor(this.db, user.id, asset, grant);
    return { asset, fee: fromMinor(this.issueFeeUsd, 'USD'), customerCharge: sponsored ? '0' : fromMinor(convertMinor(this.issueFeeUsd, 'USD', asset), asset), fundingSource: sponsored ? 'broker' : 'wallet' };
  }

  private consentSnapshotHash(value: unknown): string {
    return createHmac('sha256', this.config.appSecret).update('gudex:additional-issue-snapshot:v1:')
      .update(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)).digest('hex');
  }

  private kycConsentHash(kyc: typeof kycProfiles.$inferSelect, billing?: typeof cardBillingAddresses.$inferSelect): string {
    return this.consentSnapshotHash({ kyc, billing: billing ? { marker: billing.marker, requestHash: billing.requestHash,
      customerNo: billing.customerNo, partnerAddressId: billing.partnerAddressId, status: billing.status } : null });
  }

  private async additionalAttemptContext(db: DbOrTx, userId: string, lock = false) {
    if (this.config.CARD_ISSUANCE_MODE === 'manual') return null;
    if (this.config.CARD_PARTNER !== 'upay' || this.config.DEV_TOOLS || this.issueFeeUsd <= 0n || this.issueFeeUsd > SPONSOR_BUDGET_USD) return null;
    const userQuery = db.select().from(users).where(eq(users.id, userId));
    const [user] = await (lock ? userQuery.for('update') : userQuery);
    if (user?.telegramId !== ADDITIONAL_ISSUE_TELEGRAM_ID) return null;
    const opQuery = db.select().from(cardOperations).where(eq(cardOperations.id, ADDITIONAL_ISSUE_ORIGINAL_ID));
    const [original] = await (lock ? opQuery.for('update') : opQuery);
    if (!original || original.userId !== userId || original.type !== 'issue' || original.status !== 'unknown' || original.partnerProvider !== 'upay'
      || original.asset !== 'USDT' || original.amount !== 10_000_000n || original.fee !== original.amount || !original.sponsorshipId) return null;
    const grantQuery = db.select().from(cardIssueSponsorships).where(eq(cardIssueSponsorships.id, original.sponsorshipId));
    const [grant] = await (lock ? grantQuery.for('update') : grantQuery);
    if (!grant || grant.retryOfOperationId || grant.telegramId !== user.telegramId || grant.partnerProvider !== 'upay'
      || grant.operationId !== original.id || grant.consumedAt || grant.budgetUsd !== SPONSOR_BUDGET_USD) return null;
    const cardQuery = db.select().from(cards).where(eq(cards.id, original.cardId));
    const [card] = await (lock ? cardQuery.for('update') : cardQuery);
    if (!card || card.userId !== userId || card.status !== 'pending' || card.partnerCardId) return null;
    const journalQuery = db.select().from(upaySubmissions).where(eq(upaySubmissions.reference, original.id));
    const [journal] = await (lock ? journalQuery.for('update') : journalQuery);
    if (!journal || journal.kind !== 'issue' || journal.state !== 'unknown' || journal.partnerReceiptId || journal.partnerCardId) return null;
    const aliases = await db.select().from(upaySubmissionAliases).where(eq(upaySubmissionAliases.reference, original.id));
    if (aliases.length) return null;
    const kycQuery = db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    const [kyc] = await (lock ? kycQuery.for('update') : kycQuery);
    if (!kyc || kyc.status !== 'approved' || kyc.partnerProvider !== 'upay' || !kyc.partnerCustomerId || !kyc.submissionId) return null;
    const evidence = journal.evidence && typeof journal.evidence === 'object' && !Array.isArray(journal.evidence) ? journal.evidence as Record<string, unknown> : {};
    if (evidence.customerNo !== kyc.partnerCustomerId || evidence.agentCardId !== this.config.UPAY_PRODUCT_ID
      || ['orderNo', 'receiptRecordId', 'agentCustomerCardId', 'accountCardId', 'brokerCardId'].some(key => evidence[key] !== undefined)) return null;
    const [otherIssue] = await db.select({ id: cardOperations.id }).from(cardOperations).where(and(eq(cardOperations.userId, userId),
      ne(cardOperations.id, original.id), eq(cardOperations.type, 'issue'), inArray(cardOperations.status, ['pending', 'processing', 'unknown', 'succeeded']))).limit(1);
    if (otherIssue) return null;
    const [billing] = await db.select().from(cardBillingAddresses).where(eq(cardBillingAddresses.userId, userId));
    const snapshot: AdditionalIssueSnapshot = { userId, authVersion: user.authVersion,
      kycHash: this.kycConsentHash(kyc, billing),
      originalHash: this.consentSnapshotHash({ original, grant, card, journal }),
      productId: this.config.UPAY_PRODUCT_ID, feeUsd: this.issueFeeUsd.toString() };
    return { user, original, grant, kyc, snapshot };
  }

  private async existingAdditionalAttempt(db: DbOrTx, userId: string) {
    const [consent] = await db.select().from(cardIssueRetryConsents).where(and(eq(cardIssueRetryConsents.userId, userId),
      eq(cardIssueRetryConsents.originalOperationId, ADDITIONAL_ISSUE_ORIGINAL_ID)));
    if (!consent) return null;
    const [operation] = await db.select().from(cardOperations).where(eq(cardOperations.id, consent.newOperationId));
    if (!operation || operation.userId !== userId || operation.sponsorshipId !== consent.sponsorshipId || operation.partnerProvider !== 'upay') {
      throw new AppError('provider_unavailable', 'The additional issuance requires reconciliation');
    }
    return operation;
  }

  private async validateAdditionalAttempt(customerNo: string): Promise<void> {
    this.partner.assertWriteReady?.();
    if (!this.partner.validateIssue) throw new AppError('provider_unavailable', 'Live issuance preflight is unavailable');
    try { await this.partner.validateIssue({ partnerCustomerId: customerNo, maxFeeUsd: SPONSOR_BUDGET_USD }); }
    catch (error) {
      if (error instanceof PartnerBillingAddressRequiredError) throw new AppError('billing_address_required', 'Complete the card billing address before requesting issuance');
      if (error instanceof PartnerCardRegionRestrictedError) throw new AppError('card_region_restricted', 'The phone calling code in your billing details is not supported for this card');
      if (error instanceof AppError) throw error;
      throw new AppError('provider_unavailable', 'Card issuance requirements could not be confirmed');
    }
  }

  async quoteAdditionalAttempt(userId: string): Promise<CardAdditionalAttemptQuoteDto> {
    const existing = await this.existingAdditionalAttempt(this.db, userId);
    if (existing) return { eligible: false, reason: 'already_requested', existingOperation: operationDto(existing) };
    const context = await this.additionalAttemptContext(this.db, userId);
    if (!context) return { eligible: false, reason: 'unavailable' };
    await this.validateAdditionalAttempt(context.kyc.partnerCustomerId!);
    const current = await this.additionalAttemptContext(this.db, userId);
    if (!current) return { eligible: false, reason: 'unavailable' };
    const quote = signAdditionalIssueQuote(this.config.appSecret, current.snapshot);
    return { eligible: true, quoteToken: quote.token, expiresAt: quote.expiresAt, termsVersion: ADDITIONAL_ISSUE_TERMS,
      asset: 'USDT', fundingSource: 'broker', customerCharge: '0', additionalBrokerCostUsd: '10', retainedBrokerReserveUsd: '10', maximumCumulativeCostUsd: '20' };
  }

  async confirmAdditionalAttempt(userId: string, input: CardAdditionalAttemptInput): Promise<{ card: CardDto; operation: OperationDto }> {
    if (input.acceptedRisk !== true || input.termsVersion !== ADDITIONAL_ISSUE_TERMS) throw new AppError('validation', 'Explicit acceptance of the additional issuance risk is required');
    const existing = await this.existingAdditionalAttempt(this.db, userId);
    if (existing) {
      if (existing.idempotencyKey !== input.idempotencyKey) throw new AppError('validation', 'The single additional attempt has already been requested');
      return { card: await this.get(userId, existing.cardId), operation: operationDto(existing) };
    }
    const quoted = verifyAdditionalIssueQuote(this.config.appSecret, input.quoteToken);
    const before = await this.additionalAttemptContext(this.db, userId);
    if (!before || JSON.stringify(quoted) !== JSON.stringify(before.snapshot)) throw new AppError('validation', 'The additional issuance quote changed; review it and explicitly confirm again');
    await this.validateAdditionalAttempt(before.kyc.partnerCustomerId!);
    const operation = await this.db.transaction(async tx => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      const replay = await this.existingAdditionalAttempt(tx, userId);
      if (replay) {
        if (replay.idempotencyKey !== input.idempotencyKey) throw new AppError('validation', 'The single additional attempt has already been requested');
        return replay;
      }
      const current = await this.additionalAttemptContext(tx, userId, true);
      if (!current || JSON.stringify(verifyAdditionalIssueQuote(this.config.appSecret, input.quoteToken)) !== JSON.stringify(current.snapshot)) {
        throw new AppError('validation', 'The additional issuance quote changed; review it and explicitly confirm again');
      }
      const duplicateKey = await this.findByKey(userId, input.idempotencyKey, tx);
      if (duplicateKey) throw new AppError('validation', 'Use a new key for the additional issuance');
      const liveCards = await tx.select({ id: cards.id }).from(cards).where(and(eq(cards.userId, userId), inArray(cards.status, [...LIVE_STATUSES])));
      if (liveCards.length >= this.config.MAX_CARDS_PER_USER) throw new AppError('card_limit', 'Card limit reached');
      await tx.execute(sql`select set_config('gudex.sponsorship_v1', 'true', true), set_config('gudex.sponsorship_v2', 'true', true)`);
      const [grant] = await tx.insert(cardIssueSponsorships).values({ telegramId: ADDITIONAL_ISSUE_TELEGRAM_ID, retryOfOperationId: current.original.id,
        partnerProvider: 'upay', budgetUsd: SPONSOR_BUDGET_USD, reason: 'Explicit in-app additional-issue-v1 risk acceptance; original outcome and reserve retained' }).returning();
      const [card] = await tx.insert(cards).values({ userId, productName: this.config.CARD_PRODUCT_NAME, status: 'pending', holderName: `${current.kyc.firstName} ${current.kyc.lastName}` }).returning();
      const [created] = await tx.insert(cardOperations).values({ userId, cardId: card!.id, type: 'issue', partnerProvider: 'upay', sponsorshipId: grant!.id,
        idempotencyKey: input.idempotencyKey, asset: 'USDT', amount: 10_000_000n, fee: 10_000_000n }).returning();
      // Persist the exact human acceptance before reserving any extra money.
      await tx.insert(cardIssueRetryConsents).values({ userId, originalOperationId: current.original.id, newOperationId: created!.id, sponsorshipId: grant!.id,
        termsVersion: ADDITIONAL_ISSUE_TERMS, quoteHash: createHash('sha256').update(input.quoteToken).digest('hex'), authVersion: current.user.authVersion,
        kycSnapshotHash: current.snapshot.kycHash, originalSnapshotHash: current.snapshot.originalHash, productId: this.config.UPAY_PRODUCT_ID,
        additionalBudgetUsd: SPONSOR_BUDGET_USD, cumulativeBudgetUsd: SPONSOR_BUDGET_USD * 2n });
      await post(tx, { kind: 'card_issue_hold', reference: `card_issue_hold:${created!.id}`,
        postings: move(accounts.brokerIssueExpense(), accounts.clearing('USDT'), 10_000_000n) });
      await tx.update(cardIssueSponsorships).set({ operationId: created!.id, updatedAt: new Date() }).where(eq(cardIssueSponsorships.id, grant!.id));
      await enqueue(tx, 'card.issue', { operationId: created!.id });
      return created!;
    });
    return { card: await this.get(userId, operation.cardId), operation: operationDto(operation) };
  }

  private async hasPriorIssuance(db: DbOrTx, userId: string): Promise<boolean> {
    const [existingCard] = await db.select({ id: cards.id }).from(cards).where(and(eq(cards.userId, userId), notInArray(cards.status, ['failed']))).limit(1);
    if (existingCard) return true;
    const [successful] = await db.select({ id: cardOperations.id }).from(cardOperations).where(and(eq(cardOperations.userId, userId), eq(cardOperations.type, 'issue'), inArray(cardOperations.status, ['pending', 'processing', 'unknown', 'succeeded']))).limit(1);
    return Boolean(successful);
  }

  private async canSponsor(db: DbOrTx, userId: string, asset: WalletAsset, grant?: SponsorshipRow): Promise<boolean> {
    if (this.config.CARD_PARTNER !== 'upay' || this.config.DEV_TOOLS || asset !== 'USDT' || !grant || grant.retryOfOperationId || grant.partnerProvider !== 'upay' ||
        grant.budgetUsd !== SPONSOR_BUDGET_USD || grant.consumedAt || this.issueFeeUsd <= 0n || this.issueFeeUsd > grant.budgetUsd) return false;
    if (grant.operationId) {
      const [bound] = await db.select().from(cardOperations).where(eq(cardOperations.id, grant.operationId));
      return Boolean(bound && bound.userId === userId && bound.type === 'issue' && bound.partnerProvider === 'upay' && bound.sponsorshipId === grant.id && ['pending', 'processing', 'unknown'].includes(bound.status));
    }
    return !(await this.hasPriorIssuance(db, userId));
  }

  private assertIssueConsent(input: IssueInput, source: 'wallet' | 'broker', charge: bigint): void {
    let matches = input.expectedFundingSource === undefined || input.expectedFundingSource === source;
    if (input.expectedCustomerCharge !== undefined) {
      try { matches &&= toMinor(input.expectedCustomerCharge, input.asset) === charge; } catch { matches = false; }
    }
    if (!matches) throw new AppError('provider_unavailable', 'The issuance quote changed; review the current payer and amount before confirming');
  }

  async issue(userId: string, input: IssueInput): Promise<{ card: CardDto; operation: OperationDto }> {
    const existing = await this.findByKey(userId, input.idempotencyKey);
    if (existing) return { card: await this.get(userId, existing.cardId), operation: operationDto(existing) };
    const manual = this.config.CARD_ISSUANCE_MODE === 'manual';
    if (!manual) this.partner.assertWriteReady?.();

    const [kyc] = await this.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    if (kyc?.status !== 'approved') throw new AppError('kyc_required', 'Identity verification required');
    if (this.config.CARD_PARTNER === 'upay' && kyc.partnerProvider !== 'upay') throw new AppError('kyc_required', 'Complete identity verification with UPay before issuing a live card');
    if (manual && this.config.CARD_PARTNER === 'upay' && !await new CardBillingService(this.db, this.config).getSavedForAdmin(userId)) {
      throw new AppError('billing_address_required', 'Complete your billing address before requesting a card');
    }

    // Native billing requirements are independent of KYC/needParams. Validate
    // the live form and its owned address before reserving any customer funds.
    if (!manual && this.partner.validateIssue) {
      if (!kyc.partnerCustomerId) throw new AppError('kyc_required', 'Verified customer binding is required');
      try { await this.partner.validateIssue({ partnerCustomerId: kyc.partnerCustomerId, maxFeeUsd: this.issueFeeUsd }); }
      catch (error) {
        if (error instanceof PartnerBillingAddressRequiredError) throw new AppError('billing_address_required', 'Complete the card billing address before requesting issuance');
        if (error instanceof PartnerCardRegionRestrictedError) throw new AppError('card_region_restricted', 'The phone calling code in your billing details is not supported for this card');
        if (error instanceof AppError) throw error;
        throw new AppError('provider_unavailable', 'Card issuance requirements could not be confirmed');
      }
    }

    try {
      const opId = await this.db.transaction(async (tx) => {
        // Сериализуем разные ключи выпуска одного пользователя перед проверкой лимита.
        const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
        if (!user) throw new AppError('unauthorized', 'User not found');
        // Пока ждали блокировку, такой же запрос мог уже занять последнее место.
        const replay = await this.findByKey(userId, input.idempotencyKey, tx);
        if (replay) return replay.id;
        const [grant] = await tx.select().from(cardIssueSponsorships).where(and(eq(cardIssueSponsorships.telegramId, user.telegramId), isNull(cardIssueSponsorships.retryOfOperationId))).for('update');
        if (this.config.CARD_PARTNER === 'upay' && grant?.partnerProvider === 'upay' && grant.operationId && !grant.consumedAt) {
          const [bound] = await tx.select().from(cardOperations).where(eq(cardOperations.id, grant.operationId));
          if (!bound || bound.userId !== userId || bound.sponsorshipId !== grant.id || bound.partnerProvider !== 'upay' || !['pending', 'processing', 'unknown'].includes(bound.status)) {
            throw new AppError('provider_unavailable', 'An earlier broker-paid issuance requires reconciliation');
          }
          this.assertIssueConsent(input, 'broker', 0n);
          return bound.id;
        }
        const [uncertain] = await tx.select({ id: cardOperations.id }).from(cardOperations).where(and(eq(cardOperations.userId, userId), eq(cardOperations.type, 'issue'), eq(cardOperations.status, 'unknown'))).limit(1);
        if (uncertain) throw new AppError('provider_unavailable', 'An earlier card issuance requires reconciliation before a new issuance');
        // A relock/remount may lose the client's key after a successful reserve.
        // Resume that durable intent before accepting another key or reserve.
        const [pending] = await tx.select().from(cardOperations).where(and(eq(cardOperations.userId, userId), eq(cardOperations.type, 'issue'),
          inArray(cardOperations.status, ['pending', 'processing']))).orderBy(cardOperations.createdAt).limit(1).for('update');
        if (pending) {
          if (pending.partnerProvider !== this.config.CARD_PARTNER || pending.asset !== input.asset || pending.amount === null) {
            throw new AppError('quote_changed', 'An issuance is already pending; resume its original asset and funding terms');
          }
          this.assertIssueConsent(input, pending.sponsorshipId ? 'broker' : 'wallet', pending.sponsorshipId ? 0n : pending.amount);
          if (!pending.sponsorshipId) await tx.insert(cardOperationRequestAliases).values({ userId, idempotencyKey: input.idempotencyKey, operationId: pending.id });
          return pending.id;
        }
        const op = await this.createIssueReservation(tx, userId, input, `${kyc.firstName} ${kyc.lastName}`, grant, manual);
        if (manual) await notifyAdmins(tx, this.config, { userId, eventKey: `issuance:${op.id}`, stage: 'issuance' });
        else await enqueue(tx, 'card.issue', { operationId: op.id });
        return op.id;
      });
      const op = await this.getOperation(userId, opId);
      return { card: await this.get(userId, op.cardId), operation: op };
    } catch (err) {
      if (isUniqueViolation(err)) {
        const op = await this.findByKey(userId, input.idempotencyKey);
        if (op) return { card: await this.get(userId, op.cardId), operation: operationDto(op) };
      }
      throw err;
    }
  }

  // Reserves the issuance fee (or the broker coverage) and creates the pending card and its operation.
  private async createIssueReservation(tx: Tx, userId: string, input: IssueInput, holderName: string,
    grant: SponsorshipRow | undefined, manual: boolean): Promise<OperationRow> {
    const fee = convertMinor(this.issueFeeUsd, 'USD', input.asset);
    const sponsored = await this.canSponsor(tx, userId, input.asset, grant);
    this.assertIssueConsent(input, sponsored ? 'broker' : 'wallet', sponsored ? 0n : fee);
    const reservedFee = sponsored ? convertMinor(grant!.budgetUsd, 'USD', 'USDT') : fee;
    if (sponsored) await tx.execute(sql`select set_config('gudex.sponsorship_v1', 'true', true), set_config('gudex.sponsorship_v2', 'true', true)`);
    const live = await tx
      .select({ id: cards.id })
      .from(cards)
      .where(and(eq(cards.userId, userId), inArray(cards.status, [...LIVE_STATUSES])));
    if (live.length >= this.maxCards) throw new AppError('card_limit', 'Card limit reached');

    const [card] = await tx
      .insert(cards)
      .values({
        userId,
        productName: this.config.CARD_PRODUCT_NAME,
        status: 'pending',
        holderName,
      })
      .returning();
    const [op] = await tx
      .insert(cardOperations)
      .values({
        userId,
        cardId: card!.id,
        type: 'issue',
        partnerProvider: this.config.CARD_PARTNER,
        fulfillmentMode: manual ? 'manual' : 'automatic',
        sponsorshipId: sponsored ? grant!.id : null,
        idempotencyKey: input.idempotencyKey,
        asset: input.asset,
        amount: reservedFee,
        fee: reservedFee,
      })
      .returning();
    await post(tx, {
      kind: 'card_issue_hold',
      reference: `card_issue_hold:${op!.id}`,
      postings: move(sponsored ? accounts.brokerIssueExpense() : accounts.userWallet(userId, input.asset), accounts.clearing(input.asset), reservedFee),
    });
    if (sponsored) {
      const [reserved] = await tx.update(cardIssueSponsorships).set({ operationId: op!.id, updatedAt: new Date() }).where(and(eq(cardIssueSponsorships.id, grant!.id), isNull(cardIssueSponsorships.operationId), isNull(cardIssueSponsorships.consumedAt))).returning({ id: cardIssueSponsorships.id });
      if (!reserved) throw new AppError('provider_unavailable', 'Broker issuance coverage is already reserved');
    }
    return op!;
  }

  /** Manual card application: reserves the fee in the caller's transaction, together with the new questionnaire.
   * Nothing is sent to the partner; an administrator issues the card and links it. */
  async reserveManualApplication(tx: Tx, userId: string, input: IssueInput, holderName: string): Promise<OperationRow> {
    if (this.config.CARD_ISSUANCE_MODE !== 'manual') throw new AppError('validation', 'Manual issuance is disabled');
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
    if (!user) throw new AppError('unauthorized', 'User not found');
    if (await this.findByKey(userId, input.idempotencyKey, tx)) throw new AppError('validation', 'Use a new key for a new card application');
    const [open] = await tx.select({ id: cardOperations.id }).from(cardOperations).where(and(eq(cardOperations.userId, userId),
      eq(cardOperations.type, 'issue'), inArray(cardOperations.status, ['pending', 'processing', 'unknown']))).limit(1);
    if (open) throw new AppError('validation', 'A card issuance is already in progress');
    const [grant] = await tx.select().from(cardIssueSponsorships).where(and(eq(cardIssueSponsorships.telegramId, user.telegramId), isNull(cardIssueSponsorships.retryOfOperationId))).for('update');
    if (grant?.operationId && !grant.consumedAt) throw new AppError('provider_unavailable', 'An earlier broker-paid issuance requires reconciliation');
    return this.createIssueReservation(tx, userId, input, holderName, grant, true);
  }

  /** Whether the fee can be reserved now (enough balance in this asset, or broker coverage), under the caller's user lock. */
  async canReserveManualApplication(tx: Tx, userId: string, asset: WalletAsset): Promise<boolean> {
    const [user] = await tx.select().from(users).where(eq(users.id, userId));
    if (!user) return false;
    const [open] = await tx.select({ id: cardOperations.id }).from(cardOperations).where(and(eq(cardOperations.userId, userId),
      eq(cardOperations.type, 'issue'), inArray(cardOperations.status, ['pending', 'processing', 'unknown']))).limit(1);
    if (open) return false;
    const live = await tx.select({ id: cards.id }).from(cards).where(and(eq(cards.userId, userId), inArray(cards.status, [...LIVE_STATUSES])));
    if (live.length >= this.maxCards) return false;
    const [grant] = await tx.select().from(cardIssueSponsorships).where(and(eq(cardIssueSponsorships.telegramId, user.telegramId), isNull(cardIssueSponsorships.retryOfOperationId)));
    if (await this.canSponsor(tx, userId, asset, grant)) return true;
    return await getBalance(tx, accounts.userWallet(userId, asset).code) >= convertMinor(this.issueFeeUsd, 'USD', asset);
  }

  /** Cancels this user's pending manual issuance in the caller's transaction and returns the reserve. */
  async cancelManualApplication(tx: Tx, userId: string, reason: string): Promise<{ operationId: string; amount: string; asset: string; sponsored: boolean }[]> {
    const pending = await tx.select().from(cardOperations).where(and(eq(cardOperations.userId, userId), eq(cardOperations.type, 'issue'),
      eq(cardOperations.fulfillmentMode, 'manual'), eq(cardOperations.status, 'pending'))).for('update');
    const refunds: { operationId: string; amount: string; asset: string; sponsored: boolean }[] = [];
    for (const op of pending) {
      if (op.sponsorshipId) await tx.execute(sql`select set_config('gudex.sponsorship_v1', 'true', true), set_config('gudex.sponsorship_v2', 'true', true)`);
      const refund = await this.refundInTx(tx, op, reason, false);
      if (refund) refunds.push({ operationId: op.id, ...refund });
    }
    return refunds;
  }

  /** The client's issuance that is still being prepared, if any. */
  async openIssueOperation(userId: string): Promise<OperationRow[]> {
    return this.db.select().from(cardOperations).where(and(eq(cardOperations.userId, userId), eq(cardOperations.type, 'issue'),
      inArray(cardOperations.status, ['pending', 'processing']))).orderBy(desc(cardOperations.createdAt)).limit(1);
  }

  async findIssueOperation(userId: string, idempotencyKey: string): Promise<OperationDto | null> {
    const op = await this.findByKey(userId, idempotencyKey);
    return op ? operationDto(op) : null;
  }

  async quoteTopup(asset: WalletAsset, amount: string, userId?: string, cardId?: string): Promise<TopupQuoteDto> {
    const minimum = await this.effectiveTopupMinimum(userId, cardId);
    const { amountMinor, fee, netUsd } = this.computeTopup(asset, amount, minimum);
    return {
      asset,
      amount: fromMinor(amountMinor, asset),
      fee: fromMinor(fee, asset),
      netUsd: fromMinor(netUsd, 'USD'),
      rate: '1',
      minAmount: fromMinor(convertMinor(minimum, 'USD', asset), asset),
    };
  }

  private async effectiveTopupMinimum(userId?: string, cardId?: string): Promise<bigint> {
    if (!userId || !cardId) return this.minTopupUsd;
    const card = await this.ownedCard(userId, cardId);
    if (!card.partnerCardId || card.status !== 'active') throw new AppError('card_not_active', 'Card is not active');
    if (!this.partner.getRechargeMinimum || this.manual) return this.minTopupUsd;
    const net = await this.partner.getRechargeMinimum(card.partnerCardId);
    const denominator = 10_000n - BigInt(this.config.CARD_TOPUP_FEE_BPS);
    if (net <= 0n || denominator <= 0n) throw new AppError('provider_unavailable', 'Card top-up tariff is unavailable');
    const minimum = (net * 10_000n + denominator - 1n) / denominator;
    return minimum > this.minTopupUsd ? minimum : this.minTopupUsd;
  }

  private computeTopup(asset: WalletAsset, amount: string, minimum = this.minTopupUsd) {
    let amountMinor: bigint;
    try {
      amountMinor = toMinor(amount, asset);
    } catch {
      throw new AppError('validation', 'Invalid amount');
    }
    if (convertMinor(amountMinor, asset, 'USD') < minimum) {
      const minAmount = fromMinor(convertMinor(minimum, 'USD', asset), asset);
      throw new AppError('amount_too_small', `Minimum top-up is ${minAmount} ${asset}`, { minAmount, asset });
    }
    const fee = percentOf(amountMinor, this.config.CARD_TOPUP_FEE_BPS);
    const netUsd = convertMinor(amountMinor - fee, asset, 'USD');
    return { amountMinor, fee, netUsd };
  }

  async topup(
    userId: string,
    cardId: string,
    input: { asset: WalletAsset; amount: string; idempotencyKey: string; expectedFee?: string; expectedNetUsd?: string },
  ): Promise<OperationDto> {
    const existing = await this.findByKey(userId, input.idempotencyKey);
    if (existing) return operationDto(existing);
    // Manual issuance: the client tops the card up from a personal wallet (not built yet), never through the bot.
    if (this.manual) throw new AppError('provider_unavailable', 'Card top-up will be available with the personal wallet');
    this.partner.assertWriteReady?.();

    const card = await this.ownedCard(userId, cardId);
    if (card.status !== 'active') throw new AppError('card_not_active', 'Card is not active');
    const { amountMinor, fee, netUsd } = this.computeTopup(input.asset, input.amount, await this.effectiveTopupMinimum(userId, cardId));
    if (input.expectedFee !== undefined || input.expectedNetUsd !== undefined) {
      let matches = false;
      try {
        matches = input.expectedFee !== undefined && input.expectedNetUsd !== undefined
          && toMinor(input.expectedFee, input.asset) === fee && toMinor(input.expectedNetUsd, 'USD') === netUsd;
      } catch { /* Invalid or changed quote terms cannot reserve money. */ }
      if (!matches) throw new AppError('quote_changed', 'The top-up quote changed; review the current fee and amount before confirming');
    }
    if (this.partner.validateRecharge && card.partnerCardId) {
      try { await this.partner.validateRecharge({ partnerCardId: card.partnerCardId, amountUsd: netUsd, maxDebitUsd: convertMinor(amountMinor, input.asset, 'USD') }); }
      catch (error) {
        if (error instanceof PartnerError && !error.retryable) throw new AppError('validation', error.message);
        throw error;
      }
    }

    return this.createOperation(userId, input.idempotencyKey, async (tx) => {
      await this.assertNoUnknownCardOperation(tx, cardId);
      const [op] = await tx
        .insert(cardOperations)
        .values({
          userId,
          cardId,
          type: 'topup',
          partnerProvider: this.config.CARD_PARTNER,
          idempotencyKey: input.idempotencyKey,
          asset: input.asset,
          amount: amountMinor,
          fee,
          netUsd,
        })
        .returning();
      await post(tx, {
        kind: 'card_topup_hold',
        reference: `card_topup_hold:${op!.id}`,
        postings: move(accounts.userWallet(userId, input.asset), accounts.clearing(input.asset), amountMinor),
      });
      await enqueue(tx, 'card.topup', { operationId: op!.id });
      return op!;
    });
  }

  async setFrozen(userId: string, cardId: string, frozen: boolean, idempotencyKey: string): Promise<OperationDto> {
    const existing = await this.findByKey(userId, idempotencyKey);
    if (existing) return operationDto(existing);
    // Freezing is done by the bot right away, also with manual issuance.
    this.partner.assertWriteReady?.();

    const card = await this.ownedCard(userId, cardId);
    if (card.status !== (frozen ? 'active' : 'frozen')) throw new AppError('card_not_active', `Card is ${card.status}`);

    return this.createOperation(userId, idempotencyKey, async (tx) => {
      await this.assertNoUnknownCardOperation(tx, cardId);
      // A change already on its way is followed, never sent to the partner a second time.
      const [inFlight] = await tx.select().from(cardOperations).where(and(eq(cardOperations.cardId, cardId),
        inArray(cardOperations.type, ['freeze', 'unfreeze']), inArray(cardOperations.status, ['pending', 'processing']))).limit(1);
      if (inFlight) {
        if (inFlight.type === (frozen ? 'freeze' : 'unfreeze')) return inFlight;
        throw new AppError('validation', 'The card status is already changing; try again in a minute');
      }
      // Read again under the card lock: another request may have changed the card meanwhile.
      const [locked] = await tx.select({ status: cards.status }).from(cards).where(eq(cards.id, cardId));
      if (locked?.status !== (frozen ? 'active' : 'frozen')) throw new AppError('card_not_active', `Card is ${locked?.status}`);
      const [op] = await tx
        .insert(cardOperations)
        .values({ userId, cardId, type: frozen ? 'freeze' : 'unfreeze', idempotencyKey, partnerProvider: this.config.CARD_PARTNER })
        .returning();
      await enqueue(tx, 'card.status', { operationId: op!.id });
      return op!;
    });
  }

  private async createOperation(userId: string, idempotencyKey: string, create: (tx: Tx) => Promise<OperationRow>) {
    try {
      return operationDto(await this.db.transaction(async (tx) => {
        await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
        const replay = await this.findByKey(userId, idempotencyKey, tx);
        return replay ?? create(tx);
      }));
    } catch (err) {
      if (isUniqueViolation(err)) {
        const op = await this.findByKey(userId, idempotencyKey);
        if (op) return operationDto(op);
      }
      throw err;
    }
  }

  private async assertNoUnknownCardOperation(tx: Tx, cardId: string): Promise<void> {
    await tx.select({ id: cards.id }).from(cards).where(eq(cards.id, cardId)).for('update');
    const [uncertain] = await tx.select({ id: cardOperations.id }).from(cardOperations).where(and(eq(cardOperations.cardId, cardId), eq(cardOperations.status, 'unknown'))).limit(1);
    if (uncertain) throw new AppError('provider_unavailable', 'An earlier card operation requires reconciliation before another change');
  }

  private async findByKey(userId: string, idempotencyKey: string, db: DbOrTx = this.db): Promise<OperationRow | undefined> {
    const [op] = await db
      .select()
      .from(cardOperations)
      .where(and(eq(cardOperations.userId, userId), eq(cardOperations.idempotencyKey, idempotencyKey)));
    if (op) return op;
    const [alias] = await db.select({ operation: cardOperations }).from(cardOperationRequestAliases)
      .innerJoin(cardOperations, and(eq(cardOperations.id, cardOperationRequestAliases.operationId), eq(cardOperations.userId, cardOperationRequestAliases.userId)))
      .where(and(eq(cardOperationRequestAliases.userId, userId), eq(cardOperationRequestAliases.idempotencyKey, idempotencyKey)));
    return alias?.operation;
  }

  // ─── Воркеры ───────────────────────────────────────────────────────────

  handlers(): Record<string, JobHandler> {
    type P = { operationId: string };
    return {
      'card.issue': {
        replaySafe: false,
        run: ({ operationId }: P, context) => this.runIssue(operationId, context),
        onExhausted: ({ operationId }: P) => this.markUnknown(operationId),
      },
      'card.topup': {
        replaySafe: false,
        run: ({ operationId }: P, context) => this.runTopup(operationId, context),
        onExhausted: ({ operationId }: P) => this.markUnknown(operationId),
      },
      'card.status': {
        replaySafe: false,
        run: ({ operationId }: P, context) => this.runStatus(operationId, context),
        onExhausted: ({ operationId }: P) => this.scheduleStatusCheck(operationId, 30),
      },
      'card.sync': { run: ({ cardId }: { cardId: string }) => this.syncTransactions(cardId) },
      'card.reconcile': { run: async ({ operationId }: P) => {
        const [current] = await this.db.select().from(cardOperations).where(eq(cardOperations.id, operationId));
        if (!current) throw new PermanentJobError('Card operation not found');
        if (TERMINAL.includes(current.status)) return;
        if ((current.type === 'issue' || current.type === 'topup') && current.partnerProvider === 'upay') {
          if (!['unknown', 'processing'].includes(current.status)) return;
          const recovery = await this.recoveryEvidence(current);
          if (!recovery) {
            if (current.status === 'processing') await this.markUnknown(operationId);
            return;
          }
          const result = await this.reconcileUnknown(operationId);
          if (result.status === 'unknown' || result.status === 'processing') {
            if (recovery === 'not_dispatched') throw new Error('Persisted UPay non-dispatch proof requires reconciliation');
            const age = Math.max(0, Date.now() - current.createdAt.getTime());
            if (age >= ISSUE_RECEIPT_LOOKUP_MS) { if (result.status === 'processing') await this.markUnknown(operationId); return; }
            throw new RetryLater(Math.min(30 * 2 ** Math.floor(age / (5 * 60_000)), 300));
          }
          return;
        }
        if (current.type === 'freeze' || current.type === 'unfreeze') return this.reconcileStatusChange(current);
        const op = await this.reconcileUnknown(operationId);
        if (op.status === 'processing') {
          if (Date.now() - new Date(op.createdAt).getTime() > 30 * 60_000) await this.markUnknown(operationId);
          else throw new RetryLater(30);
        }
      } },
      'cards.sync_all': { run: () => this.enqueueSyncAll() },
    };
  }

  // Берёт операцию в работу. null — операция уже завершена, делать нечего.
  private async startOperation(operationId: string): Promise<{ op: OperationRow; card: CardRow; canSubmit: boolean } | null> {
    return this.db.transaction(async (tx) => {
      const [op] = await tx.select().from(cardOperations).where(eq(cardOperations.id, operationId)).for('update');
      if (!op) throw new PermanentJobError(`Operation ${operationId} not found`);
      if (TERMINAL.includes(op.status)) return null;
      if (op.fulfillmentMode === 'manual') return null;
      if (op.sponsorshipId) await tx.execute(sql`select set_config('gudex.sponsorship_v1', 'true', true), set_config('gudex.sponsorship_v2', 'true', true)`);
      if (op.partnerProvider !== this.config.CARD_PARTNER) {
        await tx.update(cardOperations).set({ status: 'unknown', error: 'Operation provider differs from the active integration; manual reconciliation required', updatedAt: new Date() }).where(eq(cardOperations.id, op.id));
        return null;
      }
      const [card] = await tx.select().from(cards).where(eq(cards.id, op.cardId));
      const canSubmit = op.status === 'pending';
      if (canSubmit) {
        await tx.update(cardOperations).set({ status: 'processing', attempts: op.attempts + 1, updatedAt: new Date() }).where(eq(cardOperations.id, operationId));
      }
      return { op, card: card!, canSubmit };
    });
  }

  // Завершает операцию внутри транзакции, если её ещё никто не завершил.
  private async finish(operationId: string, apply: (tx: Tx, op: OperationRow) => Promise<void>): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [op] = await tx.select().from(cardOperations).where(eq(cardOperations.id, operationId)).for('update');
      if (!op || TERMINAL.includes(op.status)) return;
      if (op.sponsorshipId) await tx.execute(sql`select set_config('gudex.sponsorship_v1', 'true', true), set_config('gudex.sponsorship_v2', 'true', true)`);
      await apply(tx, op);
    });
  }

  private async runIssue(operationId: string, context?: JobContext): Promise<void> {
    const [intent] = await this.db.select({ mode: cardOperations.fulfillmentMode }).from(cardOperations).where(eq(cardOperations.id, operationId));
    if (intent?.mode === 'manual') return;
    if (this.config.CARD_ISSUANCE_MODE === 'manual') {
      await this.db.transaction(async tx => {
        const [op] = await tx.select().from(cardOperations).where(eq(cardOperations.id, operationId)).for('update');
        if (!op || op.type !== 'issue' || op.fulfillmentMode !== 'automatic' || op.status !== 'pending' || op.attempts !== 0) return;
        const [journal] = await tx.select({ reference: upaySubmissions.reference }).from(upaySubmissions).where(eq(upaySubmissions.reference, op.id));
        const [card] = await tx.select().from(cards).where(eq(cards.id, op.cardId)).for('update');
        if (journal || !card || card.userId !== op.userId || card.status !== 'pending' || card.partnerCardId) return;
        await tx.update(cardOperations).set({ fulfillmentMode: 'manual', updatedAt: new Date() }).where(eq(cardOperations.id, op.id));
        await notifyAdmins(tx, this.config, { userId: op.userId, eventKey: `issuance:${op.id}`, stage: 'issuance' });
      });
      return;
    }
    const started = await this.startOperation(operationId);
    if (!started) return;
    const { op } = started;
    if (!started.canSubmit) return this.recoverInterrupted(operationId);
    try {
      const [kyc] = await this.db.select().from(kycProfiles).where(eq(kycProfiles.userId, op.userId));
      const partnerCustomerId = kyc?.partnerCustomerId;
      if (!partnerCustomerId) {
        await this.failWithRefund(operationId, 'User has no partner customer');
        return;
      }
      let issued = await this.partner.findCardByExternalRef(op.id);
      if (!issued) {
        const beforeSubmit = async () => {
          await context?.assertActive();
          await this.assertAdditionalAttemptDispatch(op);
        };
        await beforeSubmit();
        issued = await this.partner.issueCard({ externalRef: op.id, partnerCustomerId, maxFeeUsd: convertMinor(op.fee!, op.asset as WalletAsset, 'USD'), beforeSubmit });
      }
      await this.completeIssue(operationId, issued);
    } catch (error) {
      await this.handleSubmitError(operationId, error);
    }
  }

  private async assertAdditionalAttemptDispatch(op: OperationRow): Promise<void> {
    if (!op.sponsorshipId) return;
    const [grant] = await this.db.select().from(cardIssueSponsorships).where(eq(cardIssueSponsorships.id, op.sponsorshipId));
    if (!grant?.retryOfOperationId) return;
    const [consent] = await this.db.select().from(cardIssueRetryConsents).where(eq(cardIssueRetryConsents.newOperationId, op.id));
    const [kyc] = await this.db.select().from(kycProfiles).where(eq(kycProfiles.userId, op.userId));
    const [billing] = await this.db.select().from(cardBillingAddresses).where(eq(cardBillingAddresses.userId, op.userId));
    if (!consent || !kyc || kyc.status !== 'approved' || kyc.partnerProvider !== 'upay'
      || grant.retryOfOperationId !== ADDITIONAL_ISSUE_ORIGINAL_ID || grant.telegramId !== ADDITIONAL_ISSUE_TELEGRAM_ID
      || grant.operationId !== op.id || grant.consumedAt || consent.userId !== op.userId || consent.sponsorshipId !== grant.id
      || consent.originalOperationId !== grant.retryOfOperationId || consent.productId !== this.config.UPAY_PRODUCT_ID
      || consent.termsVersion !== ADDITIONAL_ISSUE_TERMS || consent.additionalBudgetUsd !== SPONSOR_BUDGET_USD
      || consent.cumulativeBudgetUsd !== SPONSOR_BUDGET_USD * 2n || consent.kycSnapshotHash !== this.kycConsentHash(kyc, billing)) {
      throw new PartnerError('The additional issuance requirements changed before submission', false);
    }
  }

  // beforeSettle runs first in the same transaction (the combined application approves the questionnaire there).
  async completeManualIssue(actorUserId: string, userId: string, operationId: string,
    issued: Awaited<ReturnType<CardPartner['issueCard']>>, receipt: { grossUsd: bigint; orderNo: string;
      partnerCustomerId: string; submissionId: string; productId: string; operationUpdatedAt: string; receiptRecordId?: string },
    beforeSettle?: (tx: Tx) => Promise<void>): Promise<void> {
    const [actor] = await this.db.select({ telegramId: users.telegramId }).from(users).where(eq(users.id, actorUserId));
    if (!actor || !this.config.adminTelegramIds.includes(actor.telegramId.toString())) throw new AppError('forbidden', 'Administrator access required');
    if (this.config.CARD_ISSUANCE_MODE !== 'manual') throw new AppError('validation', 'Manual issuance is disabled');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(receipt.orderNo) || !/^[A-Za-z0-9_-]{1,128}$/.test(issued.partnerCardId)
      || receipt.receiptRecordId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.receiptRecordId)
      || typeof receipt.grossUsd !== 'bigint' || receipt.grossUsd < 0n) throw new AppError('validation', 'Invalid issuance receipt');
    await this.completeIssue(operationId, issued, { actorUserId, userId, ...receipt, beforeSettle });
  }

  /** An operator performed this top-up or freeze in the UPay panel (or declined it) and records the outcome. */
  async resolveManualRequest(actorUserId: string, userId: string, operationId: string,
    outcome: { done: true } | { done: false; reason: string }): Promise<void> {
    const [actor] = await this.db.select({ telegramId: users.telegramId }).from(users).where(eq(users.id, actorUserId));
    if (!actor || !this.config.adminTelegramIds.includes(actor.telegramId.toString())) throw new AppError('forbidden', 'Administrator access required');
    if (!this.manual) throw new AppError('validation', 'Manual card requests are disabled');
    const [op] = await this.db.select().from(cardOperations).where(and(eq(cardOperations.id, operationId), eq(cardOperations.userId, userId)));
    if (!op || op.fulfillmentMode !== 'manual' || op.status !== 'pending' || !['topup', 'freeze', 'unfreeze'].includes(op.type)) {
      throw new AppError('validation', 'Эта заявка уже обработана. Обновите страницу.');
    }
    if (!outcome.done) {
      const reason = outcome.reason.trim();
      if (!reason || reason.length > 300) throw new AppError('validation', 'Укажите причину отказа');
      await this.failWithRefund(op.id, reason);
    } else if (op.type === 'topup') await this.completeTopup(op.id, await this.ownedCard(userId, op.cardId), true);
    else await this.completeStatus(op.id, op.type === 'freeze');
    await this.db.insert(adminAuditLog).values({ actorUserId, targetUserId: userId, action: outcome.done ? 'card_request_done' : 'card_request_reject',
      reference: op.id, metadata: { type: op.type } }).onConflictDoNothing();
  }

  private async completeIssue(operationId: string, issued: Awaited<ReturnType<CardPartner['issueCard']>>,
    manual?: { actorUserId: string; userId: string; grossUsd: bigint; orderNo: string;
      partnerCustomerId: string; submissionId: string; productId: string; operationUpdatedAt: string; receiptRecordId?: string;
      beforeSettle?: (tx: Tx) => Promise<void> }): Promise<void> {
    const settlement = manual ?? await this.partner.getIssueSettlement?.(operationId);
    await this.finish(operationId, async (tx, op) => {
      if (manual) {
        if (op.userId === manual.userId) await manual.beforeSettle?.(tx);
        const [profile] = await tx.select().from(kycProfiles).where(eq(kycProfiles.userId, manual.userId)).for('update');
        if (op.userId !== manual.userId || op.type !== 'issue' || op.fulfillmentMode !== 'manual' || op.status !== 'pending' || op.attempts !== 0
          || op.partnerProvider !== this.config.CARD_PARTNER || profile?.status !== 'approved' || profile.partnerProvider !== this.config.CARD_PARTNER
          || !profile.partnerCustomerId || profile.partnerCustomerId !== manual.partnerCustomerId || profile.submissionId !== manual.submissionId
          || this.config.UPAY_PRODUCT_ID !== manual.productId || op.updatedAt.toISOString() !== manual.operationUpdatedAt) {
          throw new AppError('validation', 'Заявка или анкета изменилась. Обновите страницу и повторите.');
        }
        await tx.insert(adminAuditLog).values({ actorUserId: manual.actorUserId, targetUserId: manual.userId,
          action: 'card.linked', reference: manual.orderNo, metadata: { operationId, partnerCardId: issued.partnerCardId,
            customerNo: profile.partnerCustomerId, grossUsd: manual.grossUsd.toString() } });
        // Share the same order/record/card namespace as automatic fulfilment.
        // No receipt may settle both a manual and an automatic operation.
        const evidence = { operatorBound: true, customerNo: manual.partnerCustomerId, agentCardId: manual.productId,
          orderNo: manual.orderNo, ...(manual.receiptRecordId ? { receiptRecordId: manual.receiptRecordId } : {}),
          last4: issued.last4, expiryMonth: issued.expiryMonth, expiryYear: issued.expiryYear,
          actualIssueCostUsdt: fromMinor(manual.grossUsd, 'USD'),
          maxFeeBudgetUsdt: fromMinor(convertMinor(op.fee!, op.asset as WalletAsset, 'USD'), 'USD') };
        const conflicts = await tx.select({ reference: upaySubmissions.reference }).from(upaySubmissions)
          .where(and(eq(upaySubmissions.kind, 'issue'), ne(upaySubmissions.reference, op.id),
            sql`(${upaySubmissions.partnerReceiptId} = ${manual.orderNo} or ${upaySubmissions.partnerCardId} = ${issued.partnerCardId}
              ${manual.receiptRecordId ? sql`or ${upaySubmissions.partnerReceiptId} = ${manual.receiptRecordId}` : sql``})`)).for('update');
        if (conflicts.length) throw new AppError('validation', 'The issuance receipt already belongs to another operation');
        await tx.insert(upaySubmissions).values({ reference: op.id, kind: 'issue', state: 'confirmed',
          requestHash: createHash('sha256').update(JSON.stringify({ operationId, ...evidence })).digest('hex'),
          partnerReceiptId: manual.orderNo, partnerCardId: issued.partnerCardId, evidence });
        for (const alias of [`order:${manual.orderNo}`, `card:${issued.partnerCardId}`,
          ...(manual.receiptRecordId ? [`record:${manual.receiptRecordId}`] : [])].sort()) {
          await tx.insert(upaySubmissionAliases).values({ kind: 'issue', alias, reference: op.id }).onConflictDoNothing();
          const [owner] = await tx.select({ reference: upaySubmissionAliases.reference }).from(upaySubmissionAliases)
            .where(and(eq(upaySubmissionAliases.kind, 'issue'), eq(upaySubmissionAliases.alias, alias)));
          if (owner?.reference !== op.id) throw new AppError('validation', 'The issuance receipt or card already belongs to another operation');
        }
      } else if (op.fulfillmentMode === 'manual') throw new AppError('validation', 'Manual request requires administrator verification');
      const sponsor = op.sponsorshipId ? await this.requireSponsorship(tx, op) : null;
      if (sponsor && (!settlement || typeof settlement.grossUsd !== 'bigint')) throw new PartnerError('A confirmed issuance receipt is required for broker coverage', true);
      const asset = op.asset as WalletAsset;
      const cost = settlement ? convertMinor(settlement.grossUsd, 'USD', asset) : 0n;
      if (cost < 0n || cost > op.fee!) throw new PartnerError('UPay issue settlement exceeds the reserved fee', true);
      await tx
        .update(cards)
        .set({
          status: 'active',
          partnerCardId: issued.partnerCardId,
          last4: issued.last4,
          expiryMonth: issued.expiryMonth,
          expiryYear: issued.expiryYear,
          updatedAt: new Date(),
        })
        .where(eq(cards.id, op.cardId));
      await ensureAccount(tx, accounts.card(op.userId, op.cardId));
      const margin = op.fee! - cost;
      await post(tx, {
        kind: 'card_issue_settle',
        reference: `card_issue_settle:${op.id}`,
        postings: [ { account: accounts.clearing(asset), amount: -op.fee! },
          { account: accounts.partnerFunding(asset), amount: cost }, { account: sponsor ? accounts.brokerIssueExpense() : accounts.fees(asset), amount: margin } ],
      });
      if (sponsor) {
        const [consumed] = await tx.update(cardIssueSponsorships).set({ consumedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(cardIssueSponsorships.id, sponsor.id), eq(cardIssueSponsorships.operationId, op.id), isNull(cardIssueSponsorships.consumedAt))).returning({ id: cardIssueSponsorships.id });
        if (!consumed) throw new PartnerError('Broker issuance coverage no longer matches the confirmed operation', true);
      } else {
        await rewardReferrer(tx, this.config.REFERRAL_SHARE_BPS, { userId: op.userId, asset, fee: margin, source: `card_issue:${op.id}` });
      }
      await tx.update(cardOperations).set({ status: 'succeeded', error: null, updatedAt: new Date() }).where(eq(cardOperations.id, op.id));
      await notify(tx, op.userId, { type: 'card_issued', last4: issued.last4 });
    });
  }

  private async requireSponsorship(tx: Tx, op: OperationRow): Promise<SponsorshipRow> {
    const [sponsor] = await tx.select().from(cardIssueSponsorships).where(eq(cardIssueSponsorships.id, op.sponsorshipId!));
    const [owner] = await tx.select({ telegramId: users.telegramId }).from(users).where(eq(users.id, op.userId));
    if (!sponsor || !owner || this.config.CARD_PARTNER !== 'upay' || op.partnerProvider !== 'upay' || op.type !== 'issue' || op.asset !== 'USDT' ||
        sponsor.partnerProvider !== 'upay' || sponsor.telegramId !== owner.telegramId || sponsor.operationId !== op.id || sponsor.consumedAt ||
        sponsor.budgetUsd !== SPONSOR_BUDGET_USD || op.amount !== convertMinor(sponsor.budgetUsd, 'USD', 'USDT') || op.fee !== op.amount) {
      throw new PartnerError('Broker issuance coverage requires reconciliation with its exact reserved operation', true);
    }
    if (sponsor.retryOfOperationId) {
      const [consent] = await tx.select().from(cardIssueRetryConsents).where(eq(cardIssueRetryConsents.newOperationId, op.id));
      if (!consent || sponsor.retryOfOperationId !== ADDITIONAL_ISSUE_ORIGINAL_ID || owner.telegramId !== ADDITIONAL_ISSUE_TELEGRAM_ID
        || consent.userId !== op.userId || consent.originalOperationId !== sponsor.retryOfOperationId || consent.sponsorshipId !== sponsor.id
        || consent.termsVersion !== ADDITIONAL_ISSUE_TERMS || consent.additionalBudgetUsd !== SPONSOR_BUDGET_USD || consent.cumulativeBudgetUsd !== SPONSOR_BUDGET_USD * 2n) {
        throw new PartnerError('The additional issuance lacks its exact human consent', true);
      }
    }
    return sponsor;
  }

  private async runTopup(operationId: string, context?: JobContext): Promise<void> {
    const started = await this.startOperation(operationId);
    if (!started) return;
    const { op, card } = started;
    if (!started.canSubmit) return this.recoverInterrupted(operationId);
    try {
      if (!card.partnerCardId) {
        await this.failWithRefund(operationId, 'Card has no partner id');
        return;
      }
      if (!(await this.partner.isRechargeDone(op.id))) {
        await context?.assertActive();
        await this.partner.rechargeCard({ partnerCardId: card.partnerCardId, amountUsd: op.netUsd!, externalRef: op.id, maxDebitUsd: convertMinor(op.amount!, op.asset as WalletAsset, 'USD'), beforeSubmit: context ? () => context.assertActive() : undefined });
      }
      await this.completeTopup(operationId, card);
    } catch (error) {
      await this.handleSubmitError(operationId, error);
    }
  }

  private async completeTopup(operationId: string, card: CardRow, manual = false): Promise<void> {
    // An operator top-up has no partner receipt here: the reserved fee is the margin.
    const settlement = manual ? undefined : await this.partner.getRechargeSettlement?.(operationId);
    await this.finish(operationId, async (tx, op) => {
      const asset = op.asset as WalletAsset;
      const cost = settlement ? convertMinor(settlement.grossUsd, 'USD', asset) : op.amount! - op.fee!;
      if (cost < 0n || cost > op.amount!) throw new PartnerError('UPay recharge settlement exceeds the reserved debit', true);
      const margin = op.amount! - cost;
      await post(tx, {
        kind: 'card_topup_settle',
        reference: `card_topup_settle:${op.id}`,
        postings: [
          { account: accounts.clearing(asset), amount: -op.amount! },
          { account: accounts.fees(asset), amount: margin },
          { account: accounts.partnerFunding(asset), amount: cost },
          { account: accounts.cardIssuer(), amount: -op.netUsd! },
          { account: accounts.card(op.userId, op.cardId), amount: op.netUsd! },
        ],
      });
      await rewardReferrer(tx, this.config.REFERRAL_SHARE_BPS, { userId: op.userId, asset, fee: margin, source: `card_topup:${op.id}` });
      await tx.update(cardOperations).set({ status: 'succeeded', error: null, updatedAt: new Date() }).where(eq(cardOperations.id, op.id));
      await notify(tx, op.userId, { type: 'topup_succeeded', last4: card.last4 ?? '', netUsd: fromMinor(op.netUsd!, 'USD') });
    });
  }

  private async runStatus(operationId: string, context?: JobContext): Promise<void> {
    const started = await this.startOperation(operationId);
    if (!started) return;
    const { op, card } = started;
    if (!started.canSubmit) return this.scheduleStatusCheck(operationId, 0);
    if (!card.partnerCardId) {
      await this.failWithRefund(operationId, 'Card has no partner id');
      return;
    }
    const freeze = op.type === 'freeze';
    try {
      await context?.assertActive();
      const beforeSubmit = context ? () => context.assertActive() : undefined;
      // The card state is then confirmed from this customer's card list only.
      const [kyc] = await this.db.select({ customerNo: kycProfiles.partnerCustomerId }).from(kycProfiles).where(eq(kycProfiles.userId, op.userId));
      const customerNo = kyc?.customerNo ?? undefined;
      await (freeze ? this.partner.freezeCard(card.partnerCardId, op.id, beforeSubmit, customerNo) : this.partner.unfreezeCard(card.partnerCardId, op.id, beforeSubmit, customerNo));
      await this.completeStatus(operationId, freeze);
    } catch (error) {
      // An explicit refusal ends it; any other outcome is checked on the card list, the request is never sent again.
      if (error instanceof PartnerError && !error.retryable) await this.failWithRefund(operationId, error.message);
      else await this.scheduleStatusCheck(operationId, error instanceof PartnerPendingError ? error.delaySeconds : 30);
    }
  }

  private async scheduleStatusCheck(operationId: string, delaySeconds: number): Promise<void> {
    await this.finish(operationId, async (tx, op) => {
      await tx.update(cardOperations).set({ status: 'processing', error: null, updatedAt: new Date() }).where(eq(cardOperations.id, op.id));
      await enqueue(tx, 'card.reconcile', { operationId }, { runAt: new Date(Date.now() + delaySeconds * 1000), dedupeKey: `card.reconcile:${operationId}` });
    });
  }

  // The state as this customer's card list shows it: the only card read the bot may make with manual issuance.
  private async readCardState(op: OperationRow): Promise<'active' | 'frozen' | null> {
    const [card] = await this.db.select().from(cards).where(eq(cards.id, op.cardId));
    if (!card?.partnerCardId || !this.partner.getCardState) return null;
    const [kyc] = await this.db.select({ customerNo: kycProfiles.partnerCustomerId }).from(kycProfiles).where(eq(kycProfiles.userId, op.userId));
    return this.partner.getCardState(card.partnerCardId, kyc?.customerNo ?? undefined);
  }

  /** Time since the request was actually sent to the partner (or since the operation was created if it never was). */
  private async statusChangeAge(op: OperationRow): Promise<number> {
    const [sent] = await this.db.select({ createdAt: upaySubmissions.createdAt }).from(upaySubmissions).where(eq(upaySubmissions.reference, op.id));
    return Math.max(0, Date.now() - (sent?.createdAt ?? op.createdAt).getTime());
  }

  /** Completes a freeze or unfreeze when the card list shows it, ends it when the list still shows the old state
   * a while after sending (nothing to refund, the client may try again), and keeps checking while the list cannot be read.
   * After a day without any answer it ends as well, so the card is never blocked for good. */
  private async reconcileStatusChange(op: OperationRow): Promise<void> {
    const frozen = op.type === 'freeze';
    let state: 'active' | 'frozen' | null = null;
    try { state = await this.readCardState(op); } catch { state = null; }
    if (state === (frozen ? 'frozen' : 'active')) return this.completeStatus(op.id, frozen);
    const age = await this.statusChangeAge(op);
    if (state !== null && age >= STATUS_CONFIRM_MS) return this.failWithRefund(op.id, 'The card state did not change');
    if (age >= STATUS_GIVE_UP_MS) return this.failWithRefund(op.id, 'The card state could not be confirmed');
    throw new RetryLater(age < 5 * 60_000 ? 30 : 300);
  }

  private async completeStatus(operationId: string, frozen: boolean): Promise<void> {
    await this.finish(operationId, async (tx, op) => {
      await tx.update(cards).set({ status: frozen ? 'frozen' : 'active', updatedAt: new Date() }).where(eq(cards.id, op.cardId));
      await tx.update(cardOperations).set({ status: 'succeeded', error: null, updatedAt: new Date() }).where(eq(cardOperations.id, op.id));
    });
  }

  private async markUnknown(operationId: string): Promise<void> {
    await this.finish(operationId, async (tx, op) => {
      await tx.update(cardOperations).set({ status: 'unknown', error: 'Partner result is unconfirmed; funds remain reserved', updatedAt: new Date() }).where(eq(cardOperations.id, op.id));
    });
  }

  private async recoverInterrupted(operationId: string): Promise<void> {
    await this.markUnknown(operationId);
    await this.reconcileUnknown(operationId);
  }

  private async handleSubmitError(operationId: string, error: unknown): Promise<void> {
    if (error instanceof PartnerPendingError) {
      await this.finish(operationId, async (tx, op) => {
        await tx.update(cardOperations).set({ status: 'processing', error: null, updatedAt: new Date() }).where(eq(cardOperations.id, op.id));
        await enqueue(tx, 'card.reconcile', { operationId }, { runAt: new Date(Date.now() + error.delaySeconds * 1000), dedupeKey: `card.reconcile:${operationId}` });
      });
      return;
    }
    // Только явный отказ подтверждает, что деньги партнёром не потрачены.
    if (error instanceof PartnerError && !error.retryable) {
      await this.failWithRefund(operationId, error.message);
      return;
    }
    await this.recoverInterrupted(operationId);
  }

  async listUnknown(limit = 50): Promise<OperationDto[]> {
    const rows = await this.db.select().from(cardOperations).where(eq(cardOperations.status, 'unknown')).orderBy(desc(cardOperations.updatedAt)).limit(Math.max(1, Math.min(limit, 100)));
    return rows.map(operationDto);
  }

  // Сверка только читает партнёра. null/false после таймаута не разрешает повторную отправку.
  async reconcileUnknown(operationId: string): Promise<OperationDto> {
    const [op] = await this.db.select().from(cardOperations).where(eq(cardOperations.id, operationId));
    if (!op) throw new AppError('not_found', 'Operation not found');
    if (op.fulfillmentMode === 'manual') return this.getOperation(op.userId, op.id);
    if (!TERMINAL.includes(op.status) && op.partnerProvider !== this.config.CARD_PARTNER) {
      await this.markUnknown(op.id);
      return this.getOperation(op.userId, op.id);
    }
    if (op.status === 'unknown' || op.status === 'processing') {
      try {
        if (op.type === 'issue') {
          const issued = await this.partner.findCardByExternalRef(op.id);
          if (issued) await this.completeIssue(op.id, issued);
        } else if (op.type === 'topup' && (await this.partner.isRechargeDone(op.id))) {
          const [card] = await this.db.select().from(cards).where(eq(cards.id, op.cardId));
          if (card) await this.completeTopup(op.id, card);
        } else if (op.type === 'freeze' || op.type === 'unfreeze') {
          const frozen = op.type === 'freeze';
          const state = await this.readCardState(op);
          if (state === (frozen ? 'frozen' : 'active')) await this.completeStatus(op.id, frozen);
          // No money moves here: a change the card list still does not show long after sending is ended for a new try.
          else if (state !== null && await this.statusChangeAge(op) >= STATUS_CONFIRM_MS) await this.failWithRefund(op.id, 'The card state did not change');
        }
      } catch (error) {
        if (error instanceof UpayNotDispatchedError) await this.failWithRefund(op.id, error.message);
        // Даже отказ метода чтения не подтверждает отказ исходной финансовой операции.
      }
    }
    return this.getOperation(op.userId, op.id);
  }

  // Окончательный провал: возвращаем зарезервированные деньги, карта при выпуске — failed.
  // ВАЖНО для настоящего партнёра: сюда можно попасть только когда точно известно, что операция
  // у партнёра не прошла (иначе — ручной разбор). Адаптер должен отличать «отказ» от «неизвестно».
  private async failWithRefund(operationId: string, reason: string): Promise<void> {
    await this.finish(operationId, async (tx, op) => { await this.refundInTx(tx, op, reason, true); });
  }

  private async refundInTx(tx: Tx, op: OperationRow, reason: string, sendNotice: boolean): Promise<{ amount: string; asset: string; sponsored: boolean } | null> {
    const sponsor = op.sponsorshipId ? await this.requireSponsorship(tx, op) : null;
    // Заморозка/разморозка денег не резервирует — у них asset и amount пустые.
    if (op.asset && op.amount !== null) {
      const asset = op.asset as WalletAsset;
      await post(tx, {
        kind: `card_${op.type}_refund`,
        reference: `card_${op.type}_refund:${op.id}`,
        postings: move(accounts.clearing(asset), sponsor ? accounts.brokerIssueExpense() : accounts.userWallet(op.userId, asset), op.amount),
      });
    }
    if (sponsor) {
      const [released] = await tx.update(cardIssueSponsorships).set({ operationId: null, updatedAt: new Date() })
        .where(and(eq(cardIssueSponsorships.id, sponsor.id), eq(cardIssueSponsorships.operationId, op.id), isNull(cardIssueSponsorships.consumedAt))).returning({ id: cardIssueSponsorships.id });
      if (!released) throw new PartnerError('Broker issuance coverage no longer matches the rejected operation', true);
    }
    if (op.type === 'issue') {
      await tx.update(cards).set({ status: 'failed', failureReason: reason, updatedAt: new Date() }).where(eq(cards.id, op.cardId));
    }
    await tx
      .update(cardOperations)
      .set({ status: 'failed', error: reason, updatedAt: new Date() })
      .where(eq(cardOperations.id, op.id));
    if (!(op.type === 'issue' || op.type === 'topup') || !op.asset || op.amount === null) return null;
    const refund = { amount: sponsor ? '0' : fromMinor(op.amount, op.asset as WalletAsset), asset: op.asset };
    if (sendNotice) {
      await notify(tx, op.userId, op.type === 'issue' ? { type: 'card_failed', ...refund, ...(sponsor ? { sponsored: true, additionalAttempt: Boolean(sponsor.retryOfOperationId) } : {}) } : { type: 'topup_failed', ...refund });
    }
    return { ...refund, sponsored: Boolean(sponsor) };
  }

  // Подтягивает новые транзакции по карте у партнёра и проводит их по леджеру.
  async syncTransactions(cardId: string): Promise<void> {
    const [card] = await this.db.select().from(cards).where(eq(cards.id, cardId));
    if (!card?.partnerCardId) return;
    const transactions = await this.partner.listTransactions(card.partnerCardId);
    // UPay's own card balance is what the client sees; the local ledger stays an accounting estimate.
    const partnerBalance = await this.readPartnerBalance(card);
    await this.db.update(cards).set({ lastSyncedAt: new Date(),
      ...(partnerBalance !== null ? { partnerBalance, partnerBalanceAt: new Date() } : {}) }).where(eq(cards.id, card.id));
    for (const t of transactions) {
      await this.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(cardTransactions)
          .values({
            userId: card.userId,
            cardId: card.id,
            partnerTxId: t.partnerTxId,
            kind: t.kind,
            amountUsd: t.amountUsd,
            merchant: t.merchant,
            occurredAt: t.occurredAt,
          })
          .onConflictDoNothing({ target: cardTransactions.partnerTxId })
          .returning({ id: cardTransactions.id });
        if (!created) return;
        const cardAccount = accounts.card(card.userId, card.id);
        const postings =
          t.kind === 'purchase'
            ? move(cardAccount, accounts.cardIssuer(), t.amountUsd)
            : move(accounts.cardIssuer(), cardAccount, t.amountUsd);
        const { transactionId } = await post(tx, {
          kind: `card_${t.kind}`,
          reference: `card_tx:${t.partnerTxId}`,
          postings,
          metadata: { merchant: t.merchant },
        });
        // Purchases are shown in the Mini App (history and an in-app notice), not as Telegram messages.
        await tx.update(cardTransactions).set({ ledgerTransactionId: transactionId }).where(eq(cardTransactions.id, created.id));
      });
    }
  }

  private async readPartnerBalance(card: CardRow): Promise<bigint | null> {
    if (!this.partner.getCardBalance || !card.partnerCardId) return null;
    const [kyc] = await this.db.select({ customerNo: kycProfiles.partnerCustomerId }).from(kycProfiles).where(eq(kycProfiles.userId, card.userId));
    if (!kyc?.customerNo) return null;
    try { return await this.partner.getCardBalance(card.partnerCardId, kyc.customerNo); }
    catch { return null; }
  }

  private async enqueueSyncAll(): Promise<void> {
    const rows = await this.db
      .select({ id: cards.id })
      .from(cards)
      .where(notInArray(cards.status, ['pending', 'failed', 'closed']));
    for (const row of rows) await enqueue(this.db, 'card.sync', { cardId: row.id }, { dedupeKey: `card.sync:${row.id}`, maxAttempts: 3 });
  }
}
