import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { jobs, kycDocuments, kycProfiles, upaySubmissions, users } from '../db/schema';
import { AppError } from '../lib/errors';
import type { UpayClient } from '../partner/upay/client';
import { enqueue } from '../queue/queue';

type Reader = Pick<UpayClient, 'readRequest'>;
type ObjectRow = Record<string, unknown>;
type Profile = typeof kycProfiles.$inferSelect;
const TARGET = '514468501';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARKER = /^GUDEX-KYC:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
function invalid(reason: string): never { throw new AppError('validation', `Existing customer recovery blocked: ${reason}`); }
const object = (value: unknown): ObjectRow => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectRow : {};
const identifier = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value
  : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
const customerNumber = (row: ObjectRow): string | null => {
  const value = identifier(row.no ?? row.customerNo);
  return value && (row.no === undefined || identifier(row.no) === value) && (row.customerNo === undefined || identifier(row.customerNo) === value) ? value : null;
};

export interface ExistingKycCustomerSnapshot {
  userId: string;
  submissionId: string;
  customerId: string;
  customerNo: string;
  legacyMarker: string;
}

function snapshotHash(snapshot: ExistingKycCustomerSnapshot): string {
  // Keep the original binding format stable, regardless of request property order.
  return createHash('sha256').update(JSON.stringify({ userId: snapshot.userId, submissionId: snapshot.submissionId,
    customerId: snapshot.customerId, customerNo: snapshot.customerNo, legacyMarker: snapshot.legacyMarker })).digest('hex');
}

function authorize(telegramId: string): void {
  if (telegramId !== TARGET) invalid('not authorized for this account');
}

function identityMatches(row: ObjectRow, profile: Profile): boolean {
  return typeof row.email === 'string' && row.email.toLowerCase() === profile.email!.toLowerCase()
    && typeof row.givenName === 'string' && row.givenName.toUpperCase() === profile.firstName!.toUpperCase()
    && typeof row.lastName === 'string' && row.lastName.toUpperCase() === profile.lastName!.toUpperCase()
    && typeof row.phone === 'string' && row.phone === profile.phone
    && typeof row.globalCode === 'string' && row.globalCode === profile.globalCode;
}

// The completed scan is required even after finding a candidate. A short page does
// not prove completion when the server advertises additional pages.
async function pages(client: Reader, endpoint: '/customer/list' | '/card/list', query: Record<string, string> = {}): Promise<ObjectRow[]> {
  const result: ObjectRow[] = [];
  for (let pageNo = 1; pageNo <= 20; pageNo++) {
    const page = object(await client.readRequest('GET', endpoint, { query: { ...query, pageNo, pageSize: 100 } }));
    if (!Array.isArray(page.list) || page.list.some(row => !row || typeof row !== 'object' || Array.isArray(row))) invalid('unverified remote page');
    if (page.totalPages !== undefined && (!Number.isSafeInteger(page.totalPages) || Number(page.totalPages) < 0)) invalid('unverified remote pagination');
    result.push(...page.list as ObjectRow[]);
    if ((typeof page.totalPages === 'number' && pageNo >= page.totalPages) || (page.totalPages === undefined && page.list.length < 100)) return result;
  }
  return invalid('incomplete remote scan');
}

function fingerprint(profile: Profile): string {
  return JSON.stringify([profile.submissionId, profile.firstName, profile.lastName, profile.email, profile.phone, profile.globalCode,
    profile.birthDate, profile.citizenship, profile.documentType, profile.documentCountry, profile.documentIds, profile.submittedAt]);
}

async function localState(tx: Tx, telegramId: string, proof?: ExistingKycCustomerSnapshot): Promise<Profile> {
  await tx.execute(sql`set local lock_timeout = '3s'`);
  const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.telegramId, BigInt(telegramId))).for('update');
  if (!user) invalid('account not found');
  const [profile] = await tx.select().from(kycProfiles).where(eq(kycProfiles.userId, user.id)).for('update');
  if (!profile || profile.partnerProvider !== 'upay' || profile.documentsSubmittedAt !== null || !profile.submissionId
    || !UUID.test(profile.submissionId) || !profile.firstName || !profile.lastName || !profile.email || !profile.phone || !profile.globalCode
    || !profile.birthDate || !profile.citizenship || !profile.documentCountry || !['id_card', 'passport'].includes(profile.documentType ?? '')) invalid('verification generation is not recoverable');
  const alreadyBound = profile.partnerCustomerId !== null;
  if (alreadyBound ? (!identifier(profile.partnerCustomerId) || !['unknown', 'rejected'].includes(profile.status)
      || !['unknown', 'none'].includes(profile.submissionState) || profile.reviewedAt !== null)
    : (profile.status !== 'unknown' || profile.submissionState !== 'unknown')) invalid('verification generation is not recoverable');
  if (proof && (proof.userId !== user.id || proof.submissionId !== profile.submissionId)) invalid('account generation changed');
  const sid = profile.submissionId;
  const ownJobs = await tx.select().from(jobs).where(eq(sql`${jobs.payload}->>'userId'`, user.id)).for('update');
  if (ownJobs.some(job => job.status === 'running' || (['kyc.submit', 'kyc.poll'].includes(job.queue) && job.status === 'queued'))) invalid('unfinished verification job');
  const referencedJobs = await tx.execute(sql`select payload from jobs where payload->>'submissionId' = ${sid} for update`);
  if (referencedJobs.rows.some(row => object(row.payload).userId !== user.id)) invalid('shared submission job');

  const documentIds = object(profile.documentIds);
  const entries = Object.entries(documentIds);
  if (!documentIds.front || (profile.documentType === 'id_card' && !documentIds.back) || !entries.length
    || entries.some(([role, value]) => !['front', 'back', 'selfie'].includes(role) || typeof value !== 'string' || !UUID.test(value))
    || new Set(entries.map(([, value]) => value)).size !== entries.length) invalid('invalid current document references');
  const ids = entries.map(([, value]) => value as string);
  const documents = await tx.select().from(kycDocuments).where(inArray(kycDocuments.id, ids)).for('update');
  if (entries.some(([role, value]) => !documents.some(doc => doc.id === value && doc.userId === user.id && doc.kind === role
    && doc.expiresAt > new Date() && doc.size > 0 && ['image/png', 'image/jpeg'].includes(doc.mimeType)))) invalid('document missing, expired or foreign');

  const journal = await tx.execute(sql`select reference, kind, state, request_hash, partner_receipt_id, partner_card_id, evidence from upay_submissions
    where reference in (${`customer:${sid}`}, ${`kyc:${sid}`}, ${`customer-binding:${sid}`}, ${`upload:${sid}:front`}, ${`upload:${sid}:back`}, ${`upload:${sid}:selfie`})
      or evidence->>'submissionId' = ${sid} for update`);
  if (journal.rows.length !== (alreadyBound ? 2 : 1)) invalid('verification journal already advanced or missing');
  const customer = journal.rows.find(row => row.reference === `customer:${sid}`);
  if (!customer) invalid('customer creation journal is missing');
  if (customer.reference !== `customer:${sid}` || customer.kind !== 'customer' || customer.state !== 'unknown'
    || customer.partner_receipt_id !== null || customer.partner_card_id !== null || object(customer.evidence).submissionId !== sid
    || object(customer.evidence).customerNo !== undefined) invalid('customer creation has a conflicting receipt');
  if (alreadyBound) {
    const binding = journal.rows.find(row => row.reference === `customer-binding:${sid}`);
    const evidence = object(binding?.evidence);
    if (!binding || binding.kind !== 'customer_binding' || binding.state !== 'confirmed' || binding.partner_receipt_id !== null
      || binding.partner_card_id !== null || evidence.operatorBound !== true || evidence.submissionId !== sid
      || evidence.customerNo !== profile.partnerCustomerId || typeof binding.request_hash !== 'string' || !/^[0-9a-f]{64}$/.test(binding.request_hash)
      || (proof && (proof.customerNo !== profile.partnerCustomerId || binding.request_hash !== snapshotHash(proof)))) invalid('operator customer binding does not match');
  }
  const aliases = await tx.execute(sql`select reference from upay_submission_aliases where reference in (${`customer:${sid}`}, ${`customer-binding:${sid}`}) for update`);
  if (aliases.rows.length) invalid('customer creation has a conflicting alias');
  const shared = await tx.execute(sql`select user_id from kyc_profiles where user_id <> ${user.id}::uuid and (submission_id = ${sid}::uuid
    or exists (select 1 from jsonb_each_text(coalesce(document_ids, '{}'::jsonb)) d where d.value in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})))`);
  if (shared.rows.length) invalid('shared local verification binding');

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

  if (proof) {
    const oldSid = MARKER.exec(proof.legacyMarker)?.[1];
    if (!oldSid || oldSid.toLowerCase() === sid.toLowerCase()) invalid('invalid legacy marker');
    const foreign = await tx.execute(sql`select user_id from kyc_profiles where user_id <> ${user.id}::uuid and
      (partner_customer_id = ${proof.customerNo} or submission_id = ${oldSid}::uuid)`);
    const boundJournal = await tx.execute(sql`select reference from upay_submissions where reference <> ${`customer:${sid}`}
      ${alreadyBound ? sql`and reference <> ${`customer-binding:${sid}`}` : sql``} and (
      evidence->>'customerNo' = ${proof.customerNo} or evidence->>'submissionId' = ${oldSid}
      or (kind in ('customer', 'customer_binding') and partner_receipt_id = ${proof.customerNo})
      or reference in (${`customer:${oldSid}`}, ${`customer-binding:${oldSid}`}, ${`kyc:${oldSid}`}, ${`upload:${oldSid}:front`}, ${`upload:${oldSid}:back`}, ${`upload:${oldSid}:selfie`})) for update`);
    const oldJobs = await tx.execute(sql`select id from jobs where payload->>'submissionId' = ${oldSid} for update`);
    if (foreign.rows.length || boundJournal.rows.length || oldJobs.rows.length) invalid('existing customer has another local binding');
  }
  return profile;
}

async function proveCustomer(client: Reader, profile: Profile): Promise<ExistingKycCustomerSnapshot> {
  const candidates = await pages(client, '/customer/list', { email: profile.email! });
  if (candidates.length !== 1) invalid('email search is not an exact single candidate');
  const candidate = candidates[0]!;
  const customerId = identifier(candidate.customerId), customerNo = customerNumber(candidate);
  const oldSid = typeof candidate.remark === 'string' ? MARKER.exec(candidate.remark)?.[1] : undefined;
  if (!customerId || !customerNo || !oldSid || oldSid.toLowerCase() === profile.submissionId!.toLowerCase()) invalid('candidate is not a marked older customer');
  const legacyMarker = candidate.remark as string;
  const detail = object(await client.readRequest('GET', '/customer/get', { query: { customerId } }));
  if (identifier(detail.customerId) !== customerId || customerNumber(detail) !== customerNo || detail.remark !== legacyMarker || !identityMatches(detail, profile)) invalid('customer identity does not match');
  const complete = await pages(client, '/customer/list');
  const marked = complete.filter(row => row.remark === legacyMarker);
  if (marked.length !== 1 || identifier(marked[0]!.customerId) !== customerId || customerNumber(marked[0]!) !== customerNo) invalid('legacy marker is not unique');
  const cards = await pages(client, '/card/list');
  if (cards.some(card => !identifier(card.customerNo))) invalid('card ownership cannot be verified');
  if (cards.some(card => identifier(card.customerNo) === customerNo)) invalid('existing customer already has cards');
  return { userId: profile.userId, submissionId: profile.submissionId!, customerId, customerNo, legacyMarker };
}

export async function inspectExistingKycCustomer(db: Db, client: Reader, telegramId: string) {
  authorize(telegramId);
  const before = await db.transaction(tx => localState(tx, telegramId));
  const snapshot = await proveCustomer(client, before);
  await db.transaction(async tx => {
    const after = await localState(tx, telegramId, snapshot);
    if (fingerprint(after) !== fingerprint(before)) invalid('verification changed during lookup');
  });
  return { status: 'eligible' as const, eligible: true, remoteMutationsPerformed: false as const,
    checks: { identityMatches: true, legacyMarkerUnique: true, noRemoteCards: true, noForeignBinding: true, currentDocumentsReady: true }, snapshot };
}

// This is an operator-authorized continuation of the existing user submission.
// It never calls an external POST and does not reinterpret an old receipt as a new creation.
export async function resumeExistingKycCustomer(db: Db, client: Reader, telegramId: string, expected: ExistingKycCustomerSnapshot) {
  authorize(telegramId);
  if (!UUID.test(expected.userId) || !UUID.test(expected.submissionId) || !identifier(expected.customerId)
    || !identifier(expected.customerNo) || !MARKER.test(expected.legacyMarker)) invalid('invalid recovery snapshot');
  const before = await db.transaction(tx => localState(tx, telegramId, expected));
  const actual = await proveCustomer(client, before);
  if (Object.keys(actual).some(key => actual[key as keyof ExistingKycCustomerSnapshot] !== expected[key as keyof ExistingKycCustomerSnapshot])) invalid('customer snapshot changed');
  return db.transaction(async tx => {
    const after = await localState(tx, telegramId, actual);
    if (fingerprint(after) !== fingerprint(before)) invalid('verification changed during lookup');
    if (after.partnerCustomerId === null) {
      await tx.insert(upaySubmissions).values({ reference: `customer-binding:${actual.submissionId}`, kind: 'customer_binding', state: 'confirmed',
        requestHash: snapshotHash(actual), partnerReceiptId: null,
        evidence: { submissionId: actual.submissionId, customerNo: actual.customerNo, operatorBound: true } });
    }
    await tx.update(kycProfiles).set({ partnerCustomerId: actual.customerNo, status: 'pending', submissionState: 'queued', rejectionReason: null, updatedAt: new Date() })
      .where(and(eq(kycProfiles.userId, actual.userId), eq(kycProfiles.submissionId, actual.submissionId)));
    await enqueue(tx, 'kyc.submit', { userId: actual.userId, submissionId: actual.submissionId }, { dedupeKey: `kyc.submit:${actual.submissionId}` });
    return { status: 'pending' as const, submissionState: 'queued' as const, queued: true as const, remoteMutationsPerformed: false as const };
  });
}
