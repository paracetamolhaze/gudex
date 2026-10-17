import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { cardBillingAddresses, cardIssueSponsorships, cardOperations, cards, jobs, kycProfiles, upaySubmissions, users } from '../db/schema';
import { AppError } from '../lib/errors';

const AUTHORIZED_OWNER = 514468501n;
const EVIDENCE_KEYS = ['customerNo', 'agentCardId', 'agentCustomerCardId', 'accountCardId', 'brokerCardId', 'orderNo', 'receiptRecordId',
  'grossUsdt', 'netUsd', 'partnerFeeUsdt', 'exchangeRate', 'rechargeRate', 'openFeeUsdt', 'defaultOpenUsdt', 'actualIssueCostUsdt',
  'maxFeeBudgetUsdt', 'status', 'step', 'dispatchPhase', 'responseAck', 'upstreamCode', 'httpStatus', 'businessCategory'] as const;
const JOURNAL_KINDS = ['issue', 'recharge', 'freeze', 'unfreeze', 'customer', 'kyc', 'upload', 'customer_binding'];
const JOURNAL_STATES = ['sending', 'acknowledged', 'unknown', 'confirmed', 'rejected'];
const CARD_QUEUES = ['card.issue', 'card.topup', 'card.status', 'card.reconcile'];
const BILLING_STATES = ['prepared', 'sending', 'acknowledged', 'unknown', 'ready', 'rejected'];
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function errorCategory(value: string | null): string {
  if (value === null || value === '') return 'none';
  if (value === 'Partner result is unconfirmed; funds remain reserved') return 'partner_unconfirmed';
  if (value === 'Operation provider differs from the active integration; manual reconciliation required') return 'provider_mismatch';
  if (['Job lease lost', 'Job execution deadline or lease lost', 'Financial job lease expired; reconcile before any further submission'].includes(value)) return 'lease_lost';
  if (value === 'Failure cleanup requires retry') return 'cleanup_retry';
  return 'unclassified';
}

function dispatchDiagnostic(evidence: Record<string, unknown>) {
  return {
    ...(evidence.dispatchPhase === 'pre_dispatch' || evidence.dispatchPhase === 'post_dispatched' ? { dispatchPhase: evidence.dispatchPhase } : {}),
    ...(['accepted_envelope', 'rejected_envelope', 'http_error', 'unconfirmed'].includes(String(evidence.responseAck)) ? { responseAck: evidence.responseAck as string } : {}),
    ...(typeof evidence.upstreamCode === 'number' && Number.isSafeInteger(evidence.upstreamCode) ? { upstreamCode: evidence.upstreamCode } : {}),
    ...(typeof evidence.httpStatus === 'number' && Number.isInteger(evidence.httpStatus) && evidence.httpStatus >= 100 && evidence.httpStatus <= 599 ? { httpStatus: evidence.httpStatus } : {}),
    ...(evidence.businessCategory === 'billing_phone_region_restricted' ? { businessCategory: evidence.businessCategory } : {}),
  };
}

// Pure database observation. Never calls the card service, provider, queue or partner.
export async function inspectCardOperationStatus(db: Db, operationId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) throw new AppError('validation', 'Invalid operation ID');
  return db.transaction(async tx => {
    const [selected] = await tx.select({ operation: cardOperations, userTelegramId: users.telegramId }).from(cardOperations)
      .innerJoin(users, eq(users.id, cardOperations.userId))
      .where(and(eq(cardOperations.id, operationId), eq(users.telegramId, AUTHORIZED_OWNER)));
    if (!selected) throw new AppError('not_found', 'Card operation not found');
    const op = selected.operation;
    const [[card], [profile], [journal], relatedJobs, aliases, [billing]] = await Promise.all([
      tx.select({ userId: cards.userId, status: cards.status, partnerCardId: cards.partnerCardId, createdAt: cards.createdAt, updatedAt: cards.updatedAt })
        .from(cards).where(eq(cards.id, op.cardId)),
      tx.select({ status: kycProfiles.status, submissionState: kycProfiles.submissionState, partnerCustomerId: kycProfiles.partnerCustomerId })
        .from(kycProfiles).where(eq(kycProfiles.userId, op.userId)),
      tx.select({ kind: upaySubmissions.kind, state: upaySubmissions.state, partnerReceiptId: upaySubmissions.partnerReceiptId,
        partnerCardId: upaySubmissions.partnerCardId, evidence: upaySubmissions.evidence, createdAt: upaySubmissions.createdAt, updatedAt: upaySubmissions.updatedAt })
        .from(upaySubmissions).where(eq(upaySubmissions.reference, op.id)),
      tx.select({ queue: jobs.queue, status: jobs.status, attempts: jobs.attempts, maxAttempts: jobs.maxAttempts, runAt: jobs.runAt,
        lockedUntil: jobs.lockedUntil, lastError: jobs.lastError, createdAt: jobs.createdAt, updatedAt: jobs.updatedAt }).from(jobs)
        .where(sql`${jobs.payload}->>'operationId' = ${op.id} and ${jobs.queue} in ('card.issue','card.topup','card.status','card.reconcile')`)
        .orderBy(jobs.createdAt, jobs.id).limit(51),
      tx.execute(sql`select count(*)::int as total, count(*) filter (where alias like 'order:%')::int as orders,
        count(*) filter (where alias like 'record:%')::int as records, count(*) filter (where alias like 'card:%')::int as cards,
        count(*) filter (where alias not like 'order:%' and alias not like 'record:%' and alias not like 'card:%')::int as other
        from upay_submission_aliases where reference = ${op.id}`),
      tx.select({ status: cardBillingAddresses.status, customerNo: cardBillingAddresses.customerNo,
        partnerAddressId: cardBillingAddresses.partnerAddressId, updatedAt: cardBillingAddresses.updatedAt })
        .from(cardBillingAddresses).where(eq(cardBillingAddresses.userId, op.userId)),
    ]);
    const [grant] = op.sponsorshipId ? await tx.select({ operationId: cardIssueSponsorships.operationId, consumedAt: cardIssueSponsorships.consumedAt,
      telegramId: cardIssueSponsorships.telegramId, provider: cardIssueSponsorships.partnerProvider }).from(cardIssueSponsorships)
      .where(eq(cardIssueSponsorships.id, op.sponsorshipId)) : [];
    const evidence = object(journal?.evidence);
    const expectedKind = op.type === 'topup' ? 'recharge' : op.type;
    const counts = aliases.rows[0] as { total: number; orders: number; records: number; cards: number; other: number };
    return {
      matchingUser: selected.userTelegramId === AUTHORIZED_OWNER,
      operation: { type: op.type, status: op.status, provider: op.partnerProvider === 'upay' || op.partnerProvider === 'mock' ? op.partnerProvider : 'other',
        attempts: op.attempts, createdAt: op.createdAt.toISOString(), updatedAt: op.updatedAt.toISOString(), errorCategory: errorCategory(op.error) },
      card: card ? { status: card.status, partnerLinked: Boolean(card.partnerCardId), matchingUser: card.userId === op.userId,
        createdAt: card.createdAt.toISOString(), updatedAt: card.updatedAt.toISOString() } : null,
      sponsorship: { fundingSource: op.sponsorshipId ? 'broker' : 'wallet',
        status: !op.sponsorshipId ? 'not_applicable' : !grant ? 'not_found' : grant.consumedAt ? 'consumed' : grant.operationId ? 'reserved' : 'available',
        bindingMatches: !op.sponsorshipId || Boolean(grant && grant.operationId === op.id && grant.telegramId === AUTHORIZED_OWNER && grant.provider === op.partnerProvider) },
      kyc: profile ? { status: profile.status, submissionState: ['none', 'queued', 'submitted', 'unknown'].includes(profile.submissionState) ? profile.submissionState : 'other' } : null,
      billing: { exists: Boolean(billing), status: billing ? BILLING_STATES.includes(billing.status) ? billing.status : 'unknown' : null,
        customerMatchesKyc: Boolean(billing && profile?.partnerCustomerId && billing.customerNo === profile.partnerCustomerId),
        hasPartnerAddressId: Boolean(billing?.partnerAddressId), updatedAt: billing?.updatedAt.toISOString() ?? null },
      journal: { exists: Boolean(journal), kind: journal ? JOURNAL_KINDS.includes(journal.kind) ? journal.kind : 'other' : null,
        state: journal ? JOURNAL_STATES.includes(journal.state) ? journal.state : 'other' : null,
        kindMatchesOperation: Boolean(journal && journal.kind === expectedKind), hasReceiptId: Boolean(journal?.partnerReceiptId), hasCardId: Boolean(journal?.partnerCardId),
        customerMatchesKyc: Boolean(profile?.partnerCustomerId && evidence.customerNo === profile.partnerCustomerId),
        evidenceKeys: EVIDENCE_KEYS.filter(key => Object.hasOwn(evidence, key)), diagnostic: dispatchDiagnostic(evidence),
        createdAt: journal?.createdAt.toISOString() ?? null, updatedAt: journal?.updatedAt.toISOString() ?? null },
      aliases: { total: counts.total, order: counts.orders, record: counts.records, card: counts.cards, other: counts.other },
      jobs: { truncated: relatedJobs.length > 50, items: relatedJobs.slice(0, 50).map(job => ({
        queue: CARD_QUEUES.includes(job.queue) ? job.queue : 'other', status: job.status, attempts: job.attempts, maxAttempts: job.maxAttempts,
        runAt: job.runAt.toISOString(), lockedUntil: job.lockedUntil?.toISOString() ?? null, createdAt: job.createdAt.toISOString(), updatedAt: job.updatedAt.toISOString(),
        errorCategory: errorCategory(job.lastError),
      })) },
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
