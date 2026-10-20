import { sql, type SQL } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { AppError } from '../lib/errors';

// Owner-requested reset of his own GUDEX account to zero, so the whole client path can be walked again:
// the user row and everything bound to it are deleted; the next Mini App launch creates a new empty account.
// It refuses when any money history exists; an unused broker grant goes too, so the fee is paid like any client.
// The customer in UPay is untouched (the bot never deletes there).
const OWNER_TELEGRAM_ID = '514468501';
export const ZERO_OWNER_CONFIRMATION = 'RESET_MY_ACCOUNT_TO_ZERO';
type Row = Record<string, unknown>;
const rows = async <T extends Row = Row>(tx: Tx, query: SQL) => (await tx.execute(query)).rows as T[];
const oneOf = (column: SQL, values: string[]) => values.length ? sql`${column} in (${sql.join(values.map(value => sql`${value}`), sql`, `)})` : sql`false`;

export interface ZeroAccountPlan {
  status: 'ready' | 'blocked' | 'not_found' | 'reset';
  userId: string | null;
  blockedReasons: string[];
  remove: Record<string, number>;
}

interface Scope { plan: ZeroAccountPlan; jobIds: string[]; references: string[] }

async function inspectLocked(tx: Tx): Promise<Scope> {
  await tx.execute(sql`set local lock_timeout = '3s'`);
  const [user] = await rows(tx, sql`select id::text from users where telegram_id = ${OWNER_TELEGRAM_ID}::bigint for update`);
  if (!user) return { plan: { status: 'not_found', userId: null, blockedReasons: [], remove: {} }, jobIds: [], references: [] };
  const userId = String(user.id);
  const [profile] = await rows(tx, sql`select submission_id::text from kyc_profiles where user_id = ${userId}::uuid for update`);
  const userJobs = await rows(tx, sql`select payload from jobs where payload->>'userId' = ${userId} for update`);
  const submissionIds = [...new Set([profile?.submission_id, ...userJobs.map(job => (job.payload as Row).submissionId)]
    .filter((value): value is string => typeof value === 'string'))];
  const jobs = await rows(tx, sql`select id::text, status from jobs where payload->>'userId' = ${userId}
    or ${oneOf(sql`payload->>'submissionId'`, submissionIds)} for update`);
  const grants = await rows(tx, sql`select id::text, operation_id, consumed_at from card_issue_sponsorships where telegram_id = ${OWNER_TELEGRAM_ID}::bigint for update`);
  const journal = await rows(tx, sql`select reference from upay_submissions where ${oneOf(sql`evidence->>'submissionId'`, submissionIds)}
    or ${oneOf(sql`reference`, submissionIds.flatMap(sid => [`customer:${sid}`, `kyc:${sid}`, ...['front', 'back', 'selfie'].map(role => `upload:${sid}:${role}`)]))} for update`);
  const references = journal.map(entry => String(entry.reference));
  const [money] = await rows<Record<string, number>>(tx, sql`select
    (select count(*)::int from ledger_entries e join ledger_accounts a on a.id = e.account_id where a.user_id = ${userId}::uuid) as "ledgerEntries",
    (select count(*)::int from ledger_accounts where user_id = ${userId}::uuid and balance <> 0) as "nonzeroAccounts",
    (select count(*)::int from deposits where user_id = ${userId}::uuid) as deposits,
    (select count(*)::int from withdrawals where user_id = ${userId}::uuid) as withdrawals,
    (select count(*)::int from transfers where from_user_id = ${userId}::uuid or to_user_id = ${userId}::uuid) as transfers,
    (select count(*)::int from referral_rewards where referrer_id = ${userId}::uuid or referee_id = ${userId}::uuid) as "referralRewards",
    (select count(*)::int from cards where user_id = ${userId}::uuid) as cards,
    (select count(*)::int from card_operations where user_id = ${userId}::uuid) as "cardOperations",
    (select count(*)::int from card_transactions where user_id = ${userId}::uuid) as "cardTransactions",
    (select count(*)::int from card_operation_request_aliases where user_id = ${userId}::uuid) as "cardRequestAliases",
    (select count(*)::int from card_issue_retry_consents where user_id = ${userId}::uuid) as "retryConsents",
    (select count(*)::int from wallet_transfers where user_id = ${userId}::uuid) as "walletTransfers",
    (select count(*)::int from fee_payments where user_id = ${userId}::uuid and received > 0) as "paidFeePayments",
    (select count(*)::int from deposit_invoices where user_id = ${userId}::uuid and (credited_amount is not null or state = 'credited')) as "creditedInvoices",
    (select count(*)::int from users where referred_by = ${userId}::uuid) as "inboundReferrals",
    (select count(*)::int from admin_audit_log where actor_user_id = ${userId}::uuid and target_user_id <> ${userId}::uuid) as "adminActionsOnOthers"`);
  const reasons = Object.entries(money ?? {}).filter(([, count]) => Number(count) > 0).map(([name]) => name);
  if (jobs.some(job => job.status === 'running')) reasons.push('runningJob');
  if (grants.some(grant => grant.operation_id !== null || grant.consumed_at !== null)) reasons.push('sponsorshipUsed');
  const [remove] = await rows<Record<string, number>>(tx, sql`select
    (select count(*)::int from kyc_profiles where user_id = ${userId}::uuid) as "kycProfiles",
    (select count(*)::int from kyc_documents where user_id = ${userId}::uuid) as "kycDocuments",
    (select count(*)::int from card_billing_addresses where user_id = ${userId}::uuid) as "billingAddresses",
    (select count(*)::int from biometric_tokens where user_id = ${userId}::uuid) as "biometricTokens",
    (select count(*)::int from deposit_addresses where user_id = ${userId}::uuid) as "depositAddresses",
    (select count(*)::int from deposit_invoices where user_id = ${userId}::uuid) as "depositInvoices",
    (select count(*)::int from fee_payments where user_id = ${userId}::uuid) as "feePayments",
    (select count(*)::int from ledger_accounts where user_id = ${userId}::uuid) as "ledgerAccounts",
    (select count(*)::int from admin_notifications where user_id = ${userId}::uuid) as "adminNotifications",
    (select count(*)::int from admin_audit_log where target_user_id = ${userId}::uuid) as "adminAuditLog",
    (select count(*)::int from mail_addresses where user_id = ${userId}::uuid) as "mailAddresses",
    (select count(*)::int from inbound_emails where user_id = ${userId}::uuid) as "inboundEmails",
    (select count(*)::int from support_messages where user_id = ${userId}::uuid) as "supportMessages"`);
  return { plan: { status: reasons.length ? 'blocked' : 'ready', userId, blockedReasons: reasons.sort(),
    remove: { users: 1, ...remove, jobs: jobs.length, upayJournal: references.length, unusedSponsorships: grants.length } },
    jobIds: jobs.map(job => String(job.id)), references };
}

export async function inspectZeroOwnerAccount(db: Db): Promise<ZeroAccountPlan> {
  return db.transaction(async tx => (await inspectLocked(tx)).plan);
}

export async function zeroOwnerAccount(db: Db, expectedUserId: string): Promise<ZeroAccountPlan> {
  return db.transaction(async tx => {
    const { plan, jobIds, references } = await inspectLocked(tx);
    if (plan.status !== 'ready' || plan.userId !== expectedUserId) {
      throw new AppError('validation', `The account changed or cannot be reset: ${plan.blockedReasons.join(', ') || plan.status}`);
    }
    const userId = plan.userId;
    await tx.execute(sql`delete from jobs where ${oneOf(sql`id::text`, jobIds)}`);
    await tx.execute(sql`delete from upay_submission_aliases where ${oneOf(sql`reference`, references)}`);
    await tx.execute(sql`delete from upay_submissions where ${oneOf(sql`reference`, references)}`);
    for (const statement of [
      sql`delete from admin_notifications where user_id = ${userId}::uuid`,
      sql`delete from admin_audit_log where target_user_id = ${userId}::uuid`,
      sql`delete from fee_payments where user_id = ${userId}::uuid`,
      sql`delete from deposit_invoices where user_id = ${userId}::uuid`,
      sql`delete from deposit_addresses where user_id = ${userId}::uuid`,
      sql`delete from card_billing_addresses where user_id = ${userId}::uuid`,
      sql`delete from kyc_documents where user_id = ${userId}::uuid`,
      sql`delete from kyc_profiles where user_id = ${userId}::uuid`,
      sql`delete from biometric_tokens where user_id = ${userId}::uuid`,
      sql`update mail_senders set created_by = null where created_by = ${userId}::uuid`,
      sql`delete from inbound_emails where user_id = ${userId}::uuid`,
      sql`delete from mail_addresses where user_id = ${userId}::uuid`,
      sql`delete from support_messages where user_id = ${userId}::uuid`,
      sql`delete from support_threads where user_id = ${userId}::uuid`,
      sql`delete from ledger_accounts where user_id = ${userId}::uuid`,
      sql`delete from card_issue_sponsorships where telegram_id = ${OWNER_TELEGRAM_ID}::bigint and operation_id is null and consumed_at is null`,
      sql`delete from users where id = ${userId}::uuid and telegram_id = ${OWNER_TELEGRAM_ID}::bigint`,
    ]) await tx.execute(statement);
    const [left] = await rows<{ count: number }>(tx, sql`select (
      (select count(*) from users where telegram_id = ${OWNER_TELEGRAM_ID}::bigint) +
      (select count(*) from kyc_profiles where user_id = ${userId}::uuid) +
      (select count(*) from card_billing_addresses where user_id = ${userId}::uuid) +
      (select count(*) from card_issue_sponsorships where telegram_id = ${OWNER_TELEGRAM_ID}::bigint) +
      (select count(*) from jobs where payload->>'userId' = ${userId})
    )::int as count`);
    if (left?.count !== 0) throw new AppError('validation', 'Account data changed during the reset; nothing was deleted');
    return { ...plan, status: 'reset' as const };
  });
}
