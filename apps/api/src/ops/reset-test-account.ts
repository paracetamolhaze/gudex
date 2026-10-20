import { sql, type SQL } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { AppError } from '../lib/errors';

// One explicitly authorized launch-test reset, not a general account-deletion API.
const AUTHORIZED_TELEGRAM_ID = '514468501';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Row = Record<string, unknown>;
type Counts = Record<string, number>;
export interface ResetTestAccountInspection {
  status: 'eligible' | 'blocked' | 'not_found' | 'reset';
  userId: string | null;
  submissionId: string | null;
  blockedReasons: string[];
  counts: Counts;
  remoteCustomerRetained: boolean;
}
const rows = async <T extends Row = Row>(tx: Tx, query: SQL) => (await tx.execute(query)).rows as T[];
const oneOf = (column: SQL, values: string[]) => values.length ? sql`${column} in (${sql.join(values.map(value => sql`${value}`), sql`, `)})` : sql`false`;
function authorize(telegramId: string): void {
  if (telegramId !== AUTHORIZED_TELEGRAM_ID) throw new AppError('validation', 'This one-time test reset is not authorized for this account');
}

interface Scope {
  result: ResetTestAccountInspection;
  jobIds: string[];
  references: string[];
  documentIds: string[];
  submissionIds: string[];
}

async function inspectLocked(tx: Tx, telegramId: string): Promise<Scope> {
  await tx.execute(sql`set local lock_timeout = '3s'`);
  const [user] = await rows(tx, sql`select id::text from users where telegram_id = ${telegramId}::bigint for update`);
  const empty = { status: 'not_found' as const, userId: null, submissionId: null, blockedReasons: [], counts: {}, remoteCustomerRetained: false };
  if (!user) return { result: empty, jobIds: [], references: [], documentIds: [], submissionIds: [] };
  const userId = String(user.id);
  const [profile] = await rows(tx, sql`select * from kyc_profiles where user_id = ${userId}::uuid for update`);
  const sponsors = await rows(tx, sql`select * from card_issue_sponsorships where telegram_id = ${telegramId}::bigint for update`);
  const documents = await rows(tx, sql`select id::text from kyc_documents where user_id = ${userId}::uuid for update`);
  // Lock queued work before a runner can claim it. A running job is a blocker even if its lease expired.
  const initialJobs = await rows(tx, sql`select id::text, queue, payload, status, dedupe_key from jobs where payload->>'userId' = ${userId} for update`);
  const reasons = new Set<string>();
  const submissionIds = new Set<string>();
  if (typeof profile?.submission_id === 'string') submissionIds.add(profile.submission_id);
  for (const job of initialJobs) {
    const value = (job.payload as Row).submissionId;
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !uuid.test(value)) reasons.add('invalid_job_submission_reference');
    else submissionIds.add(value);
  }
  const documentIds = new Set(documents.map(document => String(document.id)));
  if (profile?.document_ids && typeof profile.document_ids === 'object' && !Array.isArray(profile.document_ids)) {
    for (const value of Object.values(profile.document_ids)) {
      if (typeof value !== 'string' || !uuid.test(value)) reasons.add('invalid_profile_document_reference');
      else documentIds.add(value);
    }
  }
  const sids = [...submissionIds];
  const docs = [...documentIds];
  const references = sids.flatMap(sid => [`customer:${sid}`, `kyc:${sid}`, ...['front', 'back', 'selfie'].map(role => `upload:${sid}:${role}`)]);
  const dedupeKeys = [`reminder.card:${userId}`, ...sids.flatMap(sid => [`kyc.submit:${sid}`, `kyc.poll:${sid}`]), ...docs.map(id => `kyc.cleanup:${id}`)];
  const jobs = await rows(tx, sql`select id::text, queue, payload, status, dedupe_key from jobs where payload->>'userId' = ${userId}
    or ${oneOf(sql`payload->>'submissionId'`, sids)} or ${oneOf(sql`dedupe_key`, dedupeKeys)} for update`);
  for (const job of jobs) {
    const payload = job.payload as Row;
    if (payload.userId !== undefined && payload.userId !== userId) reasons.add('shared_job_binding');
    if (payload.submissionId !== undefined && payload.userId !== userId) reasons.add('shared_job_binding');
    if (!['kyc.submit', 'kyc.poll', 'kyc.cleanup', 'notify', 'reminder.card'].includes(String(job.queue))) reasons.add('unsupported_user_job');
    if (job.queue === 'kyc.cleanup' && !docs.some(id => job.dedupe_key === `kyc.cleanup:${id}`)) reasons.add('unverified_cleanup_job');
    if (job.status === 'running') reasons.add('running_user_job');
    if (['kyc.submit', 'kyc.poll'].includes(String(job.queue)) && !['done', 'failed'].includes(String(job.status))) reasons.add('unfinished_kyc_job');
  }
  const journal = await rows(tx, sql`select * from upay_submissions where ${oneOf(sql`reference`, references)} for update`);
  const actualReferences = journal.map(entry => String(entry.reference));
  const aliases = await rows(tx, sql`select kind, alias, reference from upay_submission_aliases where ${oneOf(sql`reference`, actualReferences)} for update`);
  if (aliases.some(alias => alias.kind !== 'customer')) reasons.add('conflicting_journal_alias');
  const customerNumbers = new Set<string>();
  if (typeof profile?.partner_customer_id === 'string') customerNumbers.add(profile.partner_customer_id);
  for (const entry of journal) {
    const evidence = entry.evidence && typeof entry.evidence === 'object' ? entry.evidence as Row : {};
    if (entry.kind !== 'customer' || !String(entry.reference).startsWith('customer:')) reasons.add('remote_documents_or_financial_journal');
    if (entry.state !== 'confirmed') reasons.add('unconfirmed_partner_journal');
    if (typeof evidence.submissionId !== 'string' || !submissionIds.has(evidence.submissionId)) reasons.add('conflicting_journal_submission');
    if (typeof evidence.customerNo === 'string') customerNumbers.add(evidence.customerNo);
    if (typeof entry.partner_receipt_id === 'string') customerNumbers.add(entry.partner_receipt_id);
    if (!entry.partner_receipt_id || entry.partner_receipt_id !== evidence.customerNo) reasons.add('unverified_customer_receipt');
  }
  const customerNos = [...customerNumbers];
  const sharedProfiles = await rows(tx, sql`select user_id from kyc_profiles where user_id <> ${userId}::uuid and (
    ${oneOf(sql`submission_id::text`, sids)} or ${oneOf(sql`partner_customer_id`, customerNos)} or
    exists (select 1 from jsonb_each_text(coalesce(document_ids, '{}'::jsonb)) d where ${oneOf(sql`d.value`, docs)}))`);
  const sharedDocuments = await rows(tx, sql`select id from kyc_documents where user_id <> ${userId}::uuid and ${oneOf(sql`id::text`, docs)}`);
  const extraJournal = await rows(tx, sql`select reference from upay_submissions where not (${oneOf(sql`reference`, actualReferences)}) and (
    ${oneOf(sql`evidence->>'submissionId'`, sids)} or ${oneOf(sql`evidence->>'customerNo'`, customerNos)} or
    (kind = 'customer' and ${oneOf(sql`partner_receipt_id`, customerNos)}))`);
  if (sharedProfiles.length || sharedDocuments.length) reasons.add('shared_kyc_binding');
  if (extraJournal.length) reasons.add('unscoped_partner_journal');
  if (profile && (profile.partner_provider !== 'upay' || !['none', 'rejected'].includes(String(profile.status)) ||
      profile.submission_state !== 'none' || profile.documents_submitted_at !== null)) reasons.add('kyc_not_idle_customer_only');
  if (profile?.partner_customer_id && !journal.some(entry => entry.kind === 'customer' && entry.state === 'confirmed' && entry.partner_receipt_id === profile.partner_customer_id)) {
    reasons.add('customer_binding_has_no_owned_receipt');
  }
  if (sponsors.some(grant => grant.operation_id !== null || grant.consumed_at !== null)) reasons.add('sponsorship_reserved_or_consumed');

  const [counts] = await rows<Counts>(tx, sql`select
    (select count(*)::int from biometric_tokens where user_id = ${userId}::uuid) as "biometricTokens",
    (select count(*)::int from ledger_accounts where user_id = ${userId}::uuid) as "ledgerAccounts",
    (select count(*)::int from ledger_accounts where user_id = ${userId}::uuid and balance <> 0) as "nonzeroAccounts",
    (select count(*)::int from ledger_entries e join ledger_accounts a on a.id = e.account_id where a.user_id = ${userId}::uuid) as "ledgerEntries",
    (select count(*)::int from deposit_addresses where user_id = ${userId}::uuid) as "depositAddresses",
    (select count(*)::int from deposits where user_id = ${userId}::uuid) as deposits,
    (select count(*)::int from withdrawals where user_id = ${userId}::uuid) as withdrawals,
    (select count(*)::int from transfers where from_user_id = ${userId}::uuid or to_user_id = ${userId}::uuid) as transfers,
    (select count(*)::int from referral_rewards where referrer_id = ${userId}::uuid or referee_id = ${userId}::uuid) as "referralRewards",
    (select count(*)::int from users where referred_by = ${userId}::uuid) as "inboundReferrals",
    (select count(*)::int from cards where user_id = ${userId}::uuid) as cards,
    (select count(*)::int from card_operations where user_id = ${userId}::uuid) as "cardOperations",
    (select count(*)::int from card_transactions where user_id = ${userId}::uuid) as "cardTransactions",
    (select count(*)::int from mock_upay_customers where external_ref = ${userId}) as "mockCustomers"`);
  const safeCounts: Counts = { users: 1, kycProfiles: profile ? 1 : 0, kycDocuments: documents.length, jobs: jobs.length,
    upaySubmissions: journal.length, upaySubmissionAliases: aliases.length, sponsorships: sponsors.length, ...counts };
  for (const name of ['nonzeroAccounts', 'ledgerEntries', 'depositAddresses', 'deposits', 'withdrawals', 'transfers', 'referralRewards', 'inboundReferrals', 'cards', 'cardOperations', 'cardTransactions', 'mockCustomers']) {
    if (safeCounts[name]) reasons.add(name);
  }
  return { result: { status: reasons.size ? 'blocked' : 'eligible', userId, submissionId: typeof profile?.submission_id === 'string' ? profile.submission_id : null,
    blockedReasons: [...reasons].sort(), counts: safeCounts, remoteCustomerRetained: customerNumbers.size > 0 },
    jobIds: jobs.map(job => String(job.id)), references: actualReferences, documentIds: docs, submissionIds: sids };
}

export async function inspectResetTestAccount(db: Db, telegramId: string): Promise<ResetTestAccountInspection> {
  authorize(telegramId);
  return db.transaction(async tx => (await inspectLocked(tx, telegramId)).result);
}

export async function resetTestAccount(db: Db, telegramId: string, expectedUserId: string, expectedSubmissionId: string | null) {
  authorize(telegramId);
  if (!uuid.test(expectedUserId) || (expectedSubmissionId !== null && !uuid.test(expectedSubmissionId))) throw new AppError('validation', 'Invalid reset snapshot');
  return db.transaction(async tx => {
    const scope = await inspectLocked(tx, telegramId);
    const snapshot = scope.result;
    if (snapshot.userId !== expectedUserId || snapshot.submissionId !== expectedSubmissionId) throw new AppError('validation', 'Account generation changed; inspect the reset again');
    if (snapshot.status !== 'eligible') throw new AppError('validation', `Test reset blocked: ${snapshot.blockedReasons.join(', ')}`);
    const userId = expectedUserId;
    await tx.execute(sql`delete from upay_submission_aliases where ${oneOf(sql`reference`, scope.references)}`);
    await tx.execute(sql`delete from upay_submissions where ${oneOf(sql`reference`, scope.references)}`);
    await tx.execute(sql`delete from jobs where ${oneOf(sql`id::text`, scope.jobIds)}`);
    await tx.execute(sql`delete from kyc_documents where user_id = ${userId}::uuid`);
    await tx.execute(sql`delete from kyc_profiles where user_id = ${userId}::uuid`);
    await tx.execute(sql`delete from biometric_tokens where user_id = ${userId}::uuid`);
    await tx.execute(sql`delete from admin_notifications where user_id = ${userId}::uuid`);
    await tx.execute(sql`delete from admin_audit_log where target_user_id = ${userId}::uuid`);
    await tx.execute(sql`update mail_senders set created_by = null where created_by = ${userId}::uuid`);
    await tx.execute(sql`delete from inbound_emails where user_id = ${userId}::uuid`);
    await tx.execute(sql`delete from mail_addresses where user_id = ${userId}::uuid`);
    await tx.execute(sql`delete from support_messages where user_id = ${userId}::uuid`);
    await tx.execute(sql`delete from support_threads where user_id = ${userId}::uuid`);
    await tx.execute(sql`delete from ledger_accounts where user_id = ${userId}::uuid and balance = 0`);
    await tx.execute(sql`delete from card_issue_sponsorships where telegram_id = ${telegramId}::bigint and operation_id is null and consumed_at is null`);
    await tx.execute(sql`delete from users where id = ${userId}::uuid and telegram_id = ${telegramId}::bigint`);
    const [remaining] = await rows<{ count: number }>(tx, sql`select (
      (select count(*) from users where id = ${userId}::uuid or telegram_id = ${telegramId}::bigint) +
      (select count(*) from biometric_tokens where user_id = ${userId}::uuid) +
      (select count(*) from kyc_profiles where user_id = ${userId}::uuid) +
      (select count(*) from kyc_documents where user_id = ${userId}::uuid) +
      (select count(*) from ledger_accounts where user_id = ${userId}::uuid) +
      (select count(*) from card_issue_sponsorships where telegram_id = ${telegramId}::bigint) +
      (select count(*) from jobs where payload->>'userId' = ${userId} or ${oneOf(sql`payload->>'submissionId'`, scope.submissionIds)} or ${oneOf(sql`id::text`, scope.jobIds)}) +
      (select count(*) from upay_submissions where ${oneOf(sql`reference`, scope.references)}) +
      (select count(*) from upay_submission_aliases where ${oneOf(sql`reference`, scope.references)})
    )::int as count`);
    if (remaining?.count !== 0) throw new AppError('validation', 'Scoped data changed during reset; no changes committed');
    return { ...snapshot, status: 'reset' as const, deleted: snapshot.counts, userAbsent: true, scopedRemaining: 0 };
  });
}
