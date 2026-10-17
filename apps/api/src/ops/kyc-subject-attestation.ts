import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { jobs, kycProfiles, upaySubmissions, users } from '../db/schema';
import { AppError } from '../lib/errors';
import type { UpayClient } from '../partner/upay/client';

type Reader = Pick<UpayClient, 'readRequest'>;
type Row = Record<string, unknown>;
type Profile = typeof kycProfiles.$inferSelect;
type Journal = typeof upaySubmissions.$inferSelect;
const TARGET = '514468501';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MARKER = /^GUDEX-KYC:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const ATTESTATION_KEYS = ['primaryInitialStatus', 'primaryReviewObserved', 'primaryObservationSource',
  'primaryInitialObservedAt', 'primaryReviewObservedAt', 'primaryAttestedAt'] as const;
const CONFIRMATION = 'RECORD_MY_OBSERVED_PRIMARY_KYC_TRANSITION';
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function invalid(reason: string): never { throw new AppError('validation', `Subject attestation blocked: ${reason}`); }
function identifier(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value
    : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}
function customerNo(row: Row): string | null {
  const value = identifier(row.no ?? row.customerNo);
  return value && (row.no === undefined || identifier(row.no) === value) &&
    (row.customerNo === undefined || identifier(row.customerNo) === value) ? value : null;
}
function authorize(telegramId: string, productId: string): void {
  if (telegramId !== TARGET || !identifier(productId)) invalid('account or product is outside this recovery');
}

export interface KycSubjectAttestationSnapshot { userId: string; submissionId: string; requestHash: string; }
export interface KycSubjectAttestationInput {
  expected: KycSubjectAttestationSnapshot;
  observedBeforeAt: string;
  observedReviewAt: string;
  confirmation: typeof CONFIRMATION;
}
interface LocalState { profile: Profile; submission: Journal; binding: Journal; uploads: Journal[]; fingerprint: string; }

async function localState(tx: Tx, telegramId: string, expected?: KycSubjectAttestationSnapshot, legacySubmissionId?: string): Promise<LocalState> {
  await tx.execute(sql`set local lock_timeout = '3s'`);
  const [user] = await tx.select().from(users).where(eq(users.telegramId, BigInt(telegramId))).for('update');
  if (!user) invalid('account not found');
  const [profile] = await tx.select().from(kycProfiles).where(eq(kycProfiles.userId, user.id)).for('update');
  if (!profile || profile.partnerProvider !== 'upay' || profile.status !== 'unknown' || profile.submissionState !== 'unknown'
    || !profile.submissionId || !UUID.test(profile.submissionId) || !identifier(profile.partnerCustomerId)
    || !profile.submittedAt || !profile.documentsSubmittedAt || profile.reviewedAt !== null
    || !profile.firstName || !profile.lastName || !profile.email || !profile.phone || !profile.globalCode
    || !['id_card', 'passport'].includes(profile.documentType ?? '')) invalid('generation is not an accepted unknown primary submission');
  const sid = profile.submissionId, no = profile.partnerCustomerId!;
  const ownJobs = await tx.select().from(jobs).where(eq(sql`${jobs.payload}->>'userId'`, user.id)).for('update');
  if (ownJobs.some(job => job.status === 'running' || (['kyc.submit', 'kyc.poll'].includes(job.queue) && job.status === 'queued'))) invalid('verification job is active');
  const sharedJobs = await tx.execute(sql`select payload from jobs where payload->>'submissionId' = ${sid} for update`);
  if (sharedJobs.rows.some(row => object(row.payload).userId !== user.id)) invalid('shared submission job');
  const journals = await tx.select().from(upaySubmissions).where(sql`${upaySubmissions.evidence}->>'submissionId' = ${sid}
    or ${upaySubmissions.reference} in (${`kyc:${sid}`}, ${`customer-binding:${sid}`}, ${`customer:${sid}`},
      ${`upload:${sid}:front`}, ${`upload:${sid}:back`}, ${`upload:${sid}:selfie`})`).orderBy(upaySubmissions.reference).for('update');
  const submission = journals.find(row => row.reference === `kyc:${sid}`), binding = journals.find(row => row.reference === `customer-binding:${sid}`);
  const e = object(submission?.evidence), b = object(binding?.evidence), documentType = profile.documentType === 'id_card' ? 1 : 2;
  if (!submission || submission.kind !== 'kyc' || submission.state !== 'acknowledged' || !HASH.test(submission.requestHash)
    || submission.partnerReceiptId !== null || submission.partnerCardId !== null || e.submissionId !== sid || e.customerNo !== no
    || e.documentType !== documentType || e.kycProtocol !== 'customer_primary' || e.step !== 'kyc_submit'
    || e.dispatchPhase !== 'post_dispatched' || e.responseAck !== 'accepted_envelope'
    || ['nationalityCodeHash', 'documentFrontHash', 'documentBackHash'].some(key => typeof e[key] !== 'string' || !HASH.test(String(e[key])))
    || (documentType === 2 && e.documentBackHash !== hash('*')) || ATTESTATION_KEYS.some(key => Object.hasOwn(e, key))
    || e.approvalBasis !== undefined || e.photoReceiptMatched !== undefined) invalid('acknowledged primary receipt is missing or already attested');
  if (!binding || binding.kind !== 'customer_binding' || binding.state !== 'confirmed' || !HASH.test(binding.requestHash)
    || binding.partnerReceiptId !== null || binding.partnerCardId !== null || b.operatorBound !== true || b.submissionId !== sid || b.customerNo !== no) invalid('operator subject binding is missing');
  const roles = documentType === 1 ? ['front', 'back'] : ['front'];
  const uploads = roles.map(role => journals.find(row => row.reference === `upload:${sid}:${role}`));
  if (uploads.some((upload, index) => !upload || upload.kind !== 'upload' || upload.state !== 'confirmed'
    || object(upload.evidence).customerNo !== no || object(upload.evidence).submissionId !== sid
    || object(upload.evidence).documentRole !== roles[index] || upload.createdAt > submission.createdAt)) invalid('current upload receipts are incomplete');
  const customer = journals.find(row => row.reference === `customer:${sid}`);
  if (!customer || customer.kind !== 'customer' || customer.state !== 'unknown' || customer.partnerReceiptId !== null || customer.partnerCardId !== null
    || object(customer.evidence).customerNo !== undefined || journals.length !== roles.length + 3) invalid('unexpected generation journal');
  if (expected && (expected.userId !== user.id || expected.submissionId !== sid || expected.requestHash !== submission.requestHash)) invalid('expected generation changed');
  const otherBindings = await tx.execute(sql`select user_id from kyc_profiles where user_id <> ${user.id}::uuid
    and (partner_customer_id = ${no} or submission_id = ${sid}::uuid)`);
  const otherJournals = await tx.execute(sql`select reference from upay_submissions where evidence->>'customerNo' = ${no}
    and reference not in (${sql.join(journals.map(row => sql`${row.reference}`), sql`, `)}) for update`);
  const aliases = await tx.execute(sql`select reference from upay_submission_aliases where reference in
    (${sql.join(journals.map(row => sql`${row.reference}`), sql`, `)}) for update`);
  if (otherBindings.rows.length || otherJournals.rows.length || aliases.rows.length) invalid('subject has another local binding');
  if (legacySubmissionId) {
    const oldBindings = await tx.execute(sql`select user_id from kyc_profiles where user_id <> ${user.id}::uuid and submission_id = ${legacySubmissionId}::uuid`);
    const oldJournals = await tx.execute(sql`select reference from upay_submissions where evidence->>'submissionId' = ${legacySubmissionId} for update`);
    const oldJobs = await tx.execute(sql`select id from jobs where payload->>'submissionId' = ${legacySubmissionId} for update`);
    if (oldBindings.rows.length || oldJournals.rows.length || oldJobs.rows.length) invalid('legacy marker belongs to another local generation');
  }
  const financial = await tx.execute(sql`select (
    (select count(*) from cards where user_id = ${user.id}::uuid) +
    (select count(*) from card_operations where user_id = ${user.id}::uuid) +
    (select count(*) from card_transactions where user_id = ${user.id}::uuid) +
    (select count(*) from ledger_accounts where user_id = ${user.id}::uuid and balance <> 0) +
    (select count(*) from ledger_entries e join ledger_accounts a on a.id = e.account_id where a.user_id = ${user.id}::uuid) +
    (select count(*) from deposits where user_id = ${user.id}::uuid) +
    (select count(*) from deposit_addresses where user_id = ${user.id}::uuid) +
    (select count(*) from withdrawals where user_id = ${user.id}::uuid) +
    (select count(*) from transfers where from_user_id = ${user.id}::uuid or to_user_id = ${user.id}::uuid) +
    (select count(*) from referral_rewards where referrer_id = ${user.id}::uuid or referee_id = ${user.id}::uuid)
  )::int as count`);
  if (financial.rows[0]?.count !== 0) invalid('financial history exists');
  return { profile, submission, binding, uploads: uploads as Journal[],
    fingerprint: JSON.stringify({ profile, journals, ownJobs }, (_key, value) => typeof value === 'bigint' ? value.toString() : value) };
}

async function pages(client: Reader, endpoint: '/customer/list' | '/card/list', query: Record<string, string> = {}): Promise<Row[]> {
  const rows: Row[] = [];
  for (let pageNo = 1; pageNo <= 20; pageNo++) {
    const page = object(await client.readRequest('GET', endpoint, { query: { ...query, pageNo, pageSize: 100 } }));
    if (!Array.isArray(page.list) || page.list.some(row => !row || typeof row !== 'object' || Array.isArray(row))
      || (page.totalPages !== undefined && (!Number.isSafeInteger(page.totalPages) || Number(page.totalPages) < 0))) invalid('unverified remote pagination');
    rows.push(...page.list as Row[]);
    if (typeof page.totalPages === 'number' ? pageNo >= page.totalPages : page.list.length < 100) return rows;
  }
  return invalid('incomplete remote ownership scan');
}

async function remoteProof(client: Reader, state: LocalState, productId: string): Promise<string> {
  const p = state.profile, sid = p.submissionId!, no = p.partnerCustomerId!;
  const candidates = await pages(client, '/customer/list', { email: p.email! });
  if (candidates.length !== 1) invalid('customer search is not unique');
  const candidate = candidates[0]!, id = identifier(candidate.customerId), marker = candidate.remark;
  const oldSid = typeof marker === 'string' ? MARKER.exec(marker)?.[1] : undefined;
  if (!id || customerNo(candidate) !== no || !oldSid || oldSid.toLowerCase() === sid.toLowerCase()) invalid('customer marker does not match');
  const detail = object(await client.readRequest('GET', '/customer/get', { query: { customerId: id } }));
  if (identifier(detail.customerId) !== id || customerNo(detail) !== no || detail.remark !== marker
    || typeof detail.email !== 'string' || detail.email.toLowerCase() !== p.email!.toLowerCase()
    || typeof detail.givenName !== 'string' || detail.givenName.toUpperCase() !== p.firstName!.toUpperCase()
    || typeof detail.lastName !== 'string' || detail.lastName.toUpperCase() !== p.lastName!.toUpperCase()
    || detail.phone !== p.phone || detail.globalCode !== p.globalCode) invalid('fresh customer identity does not match');
  const bindingHash = hash(JSON.stringify({ userId: p.userId, submissionId: sid, customerId: id, customerNo: no, legacyMarker: marker }));
  if (bindingHash !== state.binding.requestHash) invalid('operator customer proof changed');
  const allCustomers = await pages(client, '/customer/list');
  const marked = allCustomers.filter(row => row.remark === marker);
  if (marked.length !== 1 || identifier(marked[0]!.customerId) !== id || customerNo(marked[0]!) !== no) invalid('customer marker is not globally unique');
  const allCards = await pages(client, '/card/list');
  if (allCards.some(row => !identifier(row.customerNo) || identifier(row.customerNo) === no)) invalid('remote card ownership conflicts');
  const [infoValue, productValue, mirrorValue] = await Promise.all([
    client.readRequest('GET', '/kyc/info', { query: { customerNo: no } }),
    client.readRequest('GET', '/card/getMayApplyCardDetail', { query: { agentCardId: productId } }),
    client.readRequest('GET', '/card/get/kyc', { query: { customerNo: no, agentCardId: productId } }),
  ]);
  const info = object(infoValue), product = object(productValue), mirror = object(mirrorValue), type = p.documentType === 'id_card' ? 1 : 2;
  const selected = Array.isArray(info.items) ? info.items.map(object).filter(item => item.documentType === type) : [];
  if (selected.length !== 1 || selected[0]!.level !== 1 || selected[0]!.status !== 1 || info.authResult !== 1
    || !Number.isSafeInteger(info.primaryApprovedNum) || Number(info.primaryApprovedNum) < 1 || Number(product.kycLevel) !== 1
    || !['nationalityCode', 'frontPhoto', 'backPhoto'].every(key => Object.hasOwn(selected[0]!, key) && selected[0]![key] === null)
    || mirror.customerNo !== no || !Array.isArray(mirror.certifiedDocumentType) || !mirror.certifiedDocumentType.includes(type)) invalid('native subject approval is not proven');
  return oldSid;
}

function snapshot(state: LocalState): KycSubjectAttestationSnapshot {
  return { userId: state.profile.userId, submissionId: state.profile.submissionId!, requestHash: state.submission.requestHash };
}
function observedTimes(input: KycSubjectAttestationInput, state: LocalState, now: number) {
  const parse = (value: string) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
  const before = parse(input.observedBeforeAt), review = parse(input.observedReviewAt);
  const created = state.submission.createdAt.getTime(), uploaded = Math.min(...state.uploads.map(row => row.createdAt.getTime()));
  if (![before, review, now].every(Number.isSafeInteger) || before < state.profile.submittedAt!.getTime()
    || before >= uploaded || before >= created || review < created || review < state.profile.documentsSubmittedAt!.getTime()
    || before >= review || review > now || review - before > 3600000 || now - before > 3600000) invalid('observation timestamps are outside the accepted submission window');
  return { primaryInitialStatus: 4, primaryReviewObserved: true, primaryObservationSource: 'operator_observed_transition',
    primaryInitialObservedAt: before, primaryReviewObservedAt: review, primaryAttestedAt: now };
}

export async function inspectKycSubjectAttestation(db: Db, client: Reader, telegramId: string, productId: string) {
  authorize(telegramId, productId);
  const before = await db.transaction(tx => localState(tx, telegramId));
  const legacySubmissionId = await remoteProof(client, before, productId);
  await db.transaction(async tx => {
    const after = await localState(tx, telegramId, snapshot(before), legacySubmissionId);
    if (after.fingerprint !== before.fingerprint) invalid('verification changed during lookup');
  });
  return { eligible: true as const, status: 'eligible' as const, remoteMutationsPerformed: false as const,
    checks: { nativeSubjectApproved: true, currentAcceptedSubmission: true, currentUploadsConfirmed: true,
      exactCustomerIdentity: true, uniqueOperatorBinding: true, noFinancialHistory: true }, snapshot: snapshot(before) };
}

// Records the operator's observed 4 -> 3 transition. Only the ordinary read-only
// reconciliation may later derive issuer subject approval; this never approves a profile.
export async function recordKycSubjectAttestation(db: Db, client: Reader, telegramId: string, productId: string, input: KycSubjectAttestationInput) {
  authorize(telegramId, productId);
  if (input.confirmation !== CONFIRMATION || !UUID.test(input.expected?.userId ?? '') || !UUID.test(input.expected?.submissionId ?? '')
    || !HASH.test(input.expected?.requestHash ?? '')) invalid('invalid operator confirmation');
  const before = await db.transaction(tx => localState(tx, telegramId, input.expected));
  observedTimes(input, before, Date.now());
  const legacySubmissionId = await remoteProof(client, before, productId);
  return db.transaction(async tx => {
    const after = await localState(tx, telegramId, input.expected, legacySubmissionId);
    if (after.fingerprint !== before.fingerprint) invalid('verification changed during lookup');
    const observation = observedTimes(input, after, Date.now());
    await tx.update(upaySubmissions).set({ evidence: { ...object(after.submission.evidence), ...observation }, updatedAt: new Date() })
      .where(eq(upaySubmissions.reference, after.submission.reference));
    return { recorded: true as const, status: 'unknown' as const, remoteMutationsPerformed: false as const };
  });
}
