import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { PartnerError } from '../types';

export type UpaySubmissionKind = 'issue' | 'recharge' | 'freeze' | 'unfreeze' | 'customer' | 'kyc' | 'upload';
export type UpaySubmissionState = 'sending' | 'acknowledged' | 'unknown' | 'confirmed' | 'rejected';
export type SubmissionEvidence = Record<string, string | number | boolean | null>;
export interface UpaySubmission {
  reference: string; kind: UpaySubmissionKind; requestHash: string; state: UpaySubmissionState;
  partnerReceiptId: string | null; partnerCardId: string | null; evidence: SubmissionEvidence;
}
export interface BeginSubmission { reference: string; kind: UpaySubmissionKind; requestHash: string; evidence?: SubmissionEvidence; }
export interface RecordSubmission { state: Exclude<UpaySubmissionState, 'sending'>; partnerReceiptId?: string; partnerCardId?: string; evidence?: SubmissionEvidence; }
export interface UpaySubmissionStore {
  get(reference: string): Promise<UpaySubmission | null>;
  begin(input: BeginSubmission): Promise<{ created: boolean; submission: UpaySubmission }>;
  record(reference: string, update: RecordSubmission): Promise<void>;
  claimAliases(reference: string, aliases: string[]): Promise<void>;
}

// Never persist request/response objects: these can contain payment PINs, PAN/CVV or documents.
const EVIDENCE_KEYS = new Set(['customerNo', 'customerId', 'submissionId', 'documentType', 'documentRole', 'documentFrontHash', 'documentBackHash', 'faceHash', 'status', 'agentCardId',
  'agentCustomerCardId', 'accountCardId', 'brokerCardId', 'orderNo', 'receiptRecordId', 'grossUsdt', 'netUsd', 'partnerFeeUsdt',
  'exchangeRate', 'rechargeRate', 'openFeeUsdt', 'defaultOpenUsdt', 'actualIssueCostUsdt', 'maxFeeBudgetUsdt', 'operatorBound', 'last4', 'expiryMonth', 'expiryYear',
  'step', 'dispatchPhase', 'responseAck', 'upstreamCode', 'httpStatus', 'businessCategory', 'kycProtocol', 'nationalityCodeHash',
  'primaryInitialStatus', 'primaryReviewObserved', 'primaryObservationSource', 'primaryInitialObservedAt', 'primaryReviewObservedAt', 'primaryAttestedAt',
  'approvalBasis', 'photoReceiptMatched']);
function evidence(value: SubmissionEvidence = {}): SubmissionEvidence {
  const result: SubmissionEvidence = {};
  for (const [key, item] of Object.entries(value)) {
    if (!EVIDENCE_KEYS.has(key) || (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) || (typeof item === 'string' && item.length > 256) || (typeof item === 'number' && !Number.isFinite(item))) {
      throw new PartnerError('Unsafe UPay journal evidence', true);
    }
    if ((key === 'step' && !['customer_add', 'file_upload', 'kyc_submit', 'card_issue', 'card_recharge', 'card_freeze', 'card_unfreeze'].includes(String(item))) ||
      (key === 'dispatchPhase' && item !== 'pre_dispatch' && item !== 'post_dispatched') ||
      (key === 'responseAck' && !['accepted_envelope', 'rejected_envelope', 'http_error', 'unconfirmed'].includes(String(item))) ||
      (key === 'upstreamCode' && (typeof item !== 'number' || !Number.isSafeInteger(item))) ||
      (key === 'httpStatus' && (typeof item !== 'number' || !Number.isInteger(item) || item < 100 || item > 599)) ||
      (key === 'businessCategory' && item !== 'billing_phone_region_restricted') ||
      (key === 'kycProtocol' && item !== 'customer_primary' && item !== 'card') ||
      (key === 'nationalityCodeHash' && (typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item))) ||
      (key === 'primaryInitialStatus' && item !== 2 && item !== 4) ||
      (key === 'primaryReviewObserved' && item !== true) ||
      (key === 'primaryObservationSource' && item !== 'live_response' && item !== 'operator_observed_transition') ||
      (['primaryInitialObservedAt', 'primaryReviewObservedAt', 'primaryAttestedAt'].includes(key) &&
        (typeof item !== 'number' || !Number.isSafeInteger(item) || item <= 0 || item > 8640000000000000)) ||
      (key === 'approvalBasis' && item !== 'document_hashes' && item !== 'issuer_subject_status') ||
      (key === 'photoReceiptMatched' && typeof item !== 'boolean')) {
      throw new PartnerError('Unsafe UPay journal evidence', true);
    }
    result[key] = item;
  }
  if ((result.approvalBasis !== undefined || result.photoReceiptMatched !== undefined) &&
    !((result.approvalBasis === 'document_hashes' && result.photoReceiptMatched === true) ||
      (result.approvalBasis === 'issuer_subject_status' && result.photoReceiptMatched === false))) throw new PartnerError('Unsafe UPay journal evidence', true);
  return result;
}
function sameRequest(row: UpaySubmission, input: BeginSubmission): void {
  if (row.kind !== input.kind || row.requestHash !== input.requestHash) throw new PartnerError('UPay reference already belongs to another request', true);
}
function updated(row: UpaySubmission, update: RecordSubmission): UpaySubmission {
  const safeEvidence = evidence(update.evidence);
  if (row.partnerReceiptId && update.partnerReceiptId && row.partnerReceiptId !== update.partnerReceiptId) throw new PartnerError('UPay receipt binding is immutable', true);
  if (row.partnerCardId && update.partnerCardId && row.partnerCardId !== update.partnerCardId) throw new PartnerError('UPay card binding is immutable', true);
  for (const key of ['orderNo', 'receiptRecordId', 'agentCustomerCardId', 'accountCardId', 'brokerCardId', 'customerNo', 'submissionId', 'documentType',
    'kycProtocol', 'nationalityCodeHash', 'documentFrontHash', 'documentBackHash', 'primaryInitialStatus', 'primaryReviewObserved', 'primaryObservationSource',
    'primaryInitialObservedAt', 'primaryReviewObservedAt', 'primaryAttestedAt', 'approvalBasis', 'photoReceiptMatched']) {
    if (row.evidence[key] !== undefined && safeEvidence[key] !== undefined && row.evidence[key] !== safeEvidence[key]) throw new PartnerError('UPay evidence identity is immutable', true);
  }
  if (row.state === 'confirmed' || row.state === 'rejected') return row;
  return { ...row, state: update.state, partnerReceiptId: update.partnerReceiptId ?? row.partnerReceiptId,
    partnerCardId: update.partnerCardId ?? row.partnerCardId, evidence: { ...row.evidence, ...safeEvidence } };
}
const columns = sql`reference, kind, request_hash as "requestHash", state, partner_receipt_id as "partnerReceiptId", partner_card_id as "partnerCardId", coalesce(evidence, '{}'::jsonb) as evidence`;

export class DbUpaySubmissionStore implements UpaySubmissionStore {
  constructor(private readonly db: Db) {}
  async get(reference: string): Promise<UpaySubmission | null> {
    const result = await this.db.execute(sql`select ${columns} from upay_submissions where reference = ${reference}`);
    return (result.rows[0] as unknown as UpaySubmission | undefined) ?? null;
  }
  async begin(input: BeginSubmission): Promise<{ created: boolean; submission: UpaySubmission }> {
    const safe = evidence(input.evidence);
    const result = await this.db.execute(sql`insert into upay_submissions (reference, kind, request_hash, state, evidence)
      values (${input.reference}, ${input.kind}, ${input.requestHash}, 'sending', ${JSON.stringify(safe)}::jsonb)
      on conflict (reference) do nothing returning ${columns}`);
    const inserted = result.rows[0] as unknown as UpaySubmission | undefined;
    const submission = inserted ?? await this.get(input.reference);
    if (!submission) throw new PartnerError('UPay submission journal is unavailable', true);
    sameRequest(submission, input);
    return { created: Boolean(inserted), submission };
  }
  async record(reference: string, update: RecordSubmission): Promise<void> {
    await this.db.transaction(async (tx) => {
      const result = await tx.execute(sql`select ${columns} from upay_submissions where reference = ${reference} for update`);
      const row = result.rows[0] as unknown as UpaySubmission | undefined;
      if (!row) throw new PartnerError('UPay submission journal entry is missing', true);
      const next = updated(row, update);
      await tx.execute(sql`update upay_submissions set state = ${next.state}, partner_receipt_id = ${next.partnerReceiptId},
        partner_card_id = ${next.partnerCardId}, evidence = ${JSON.stringify(next.evidence)}::jsonb, updated_at = now() where reference = ${reference}`);
    });
  }
  async claimAliases(reference: string, aliases: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await tx.execute(sql`select kind from upay_submissions where reference = ${reference} for update`);
      const kind = row.rows[0]?.kind;
      if (typeof kind !== 'string') throw new PartnerError('UPay journal entry is missing', true);
      for (const alias of [...new Set(aliases)].sort()) {
        if (!/^(?:order|record|card):[A-Za-z0-9_-]{1,128}$/.test(alias)) throw new PartnerError('Invalid UPay receipt alias', true);
        await tx.execute(sql`insert into upay_submission_aliases (kind, alias, reference) values (${kind}, ${alias}, ${reference}) on conflict (kind, alias) do nothing`);
        const owner = await tx.execute(sql`select reference from upay_submission_aliases where kind = ${kind} and alias = ${alias}`);
        if (owner.rows[0]?.reference !== reference) throw new PartnerError('UPay receipt or card already belongs to another operation', true);
      }
    });
  }
}

export class MemoryUpaySubmissionStore implements UpaySubmissionStore {
  private readonly rows = new Map<string, UpaySubmission>();
  private readonly aliases = new Map<string, string>();
  async get(reference: string): Promise<UpaySubmission | null> { return structuredClone(this.rows.get(reference) ?? null); }
  async begin(input: BeginSubmission): Promise<{ created: boolean; submission: UpaySubmission }> {
    const existing = this.rows.get(input.reference);
    if (existing) { sameRequest(existing, input); return { created: false, submission: structuredClone(existing) }; }
    const row: UpaySubmission = { ...input, state: 'sending', partnerReceiptId: null, partnerCardId: null, evidence: evidence(input.evidence) };
    this.rows.set(input.reference, row);
    return { created: true, submission: structuredClone(row) };
  }
  async record(reference: string, update: RecordSubmission): Promise<void> {
    const row = this.rows.get(reference);
    if (!row) throw new PartnerError('UPay submission journal entry is missing', true);
    const next = updated(row, update);
    if (next.partnerReceiptId && [...this.rows.values()].some((other) => other.reference !== reference && other.kind === next.kind && other.partnerReceiptId === next.partnerReceiptId)) throw new PartnerError('UPay receipt is already bound', true);
    this.rows.set(reference, next);
  }
  async claimAliases(reference: string, aliases: string[]): Promise<void> {
    const row = this.rows.get(reference);
    if (!row) throw new PartnerError('UPay journal entry is missing', true);
    for (const alias of aliases) {
      if (!/^(?:order|record|card):[A-Za-z0-9_-]{1,128}$/.test(alias)) throw new PartnerError('Invalid UPay receipt alias', true);
      const owner = this.aliases.get(`${row.kind}:${alias}`);
      if (owner && owner !== reference) throw new PartnerError('UPay receipt or card already belongs to another operation', true);
    }
    for (const alias of aliases) this.aliases.set(`${row.kind}:${alias}`, reference);
  }
}
