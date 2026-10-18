import { sql, type SQL } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { accounts, move, post } from '../ledger/ledger';
import { AppError } from '../lib/errors';

// Owner-requested removal of his own card application that an administrator has not handled yet, so he can
// submit a new one. The account and its PIN stay. The broker-paid reserve is closed and the one-time broker
// coverage becomes available again. Nothing was sent to UPay for this application, and nothing is sent now.
const OWNER_TELEGRAM_ID = '514468501';
export const REMOVE_OWNER_APPLICATION_CONFIRMATION = 'REMOVE_MY_APPLICATION';
const FEE = 10_000_000n;
type Row = Record<string, unknown>;
const rows = async <T extends Row = Row>(tx: Tx, query: SQL) => (await tx.execute(query)).rows as T[];

export interface OwnerApplicationPlan {
  status: 'ready' | 'blocked' | 'nothing_to_remove' | 'removed';
  userId: string | null;
  operationId: string | null;
  cardId: string | null;
  blockedReasons: string[];
  remove: Record<string, number>;
}

async function inspectLocked(tx: Tx): Promise<{ plan: OwnerApplicationPlan; sponsorshipId: string | null; submissionId: string | null }> {
  await tx.execute(sql`set local lock_timeout = '3s'`);
  const empty: OwnerApplicationPlan = { status: 'nothing_to_remove', userId: null, operationId: null, cardId: null, blockedReasons: [], remove: {} };
  const [user] = await rows(tx, sql`select id::text from users where telegram_id = ${OWNER_TELEGRAM_ID}::bigint for update`);
  if (!user) return { plan: empty, sponsorshipId: null, submissionId: null };
  const userId = String(user.id);
  const [profile] = await rows(tx, sql`select status, submission_id::text as submission_id from kyc_profiles where user_id = ${userId}::uuid for update`);
  const submissionId = typeof profile?.submission_id === 'string' ? profile.submission_id : null;
  const operations = await rows(tx, sql`select * from card_operations where user_id = ${userId}::uuid for update`);
  const reasons = new Set<string>();
  if (profile && profile.status === 'approved') reasons.add('application_already_approved');
  const [money] = await rows<Record<string, number>>(tx, sql`select
    (select count(*)::int from ledger_entries e join ledger_accounts a on a.id = e.account_id where a.user_id = ${userId}::uuid) as "clientLedgerEntries",
    (select count(*)::int from fee_payments where user_id = ${userId}::uuid and received > 0) as "paidFeePayments",
    (select count(*)::int from wallet_transfers where user_id = ${userId}::uuid) as "walletTransfers",
    (select count(*)::int from card_transactions where user_id = ${userId}::uuid) as "cardTransactions",
    (select count(*)::int from card_operation_request_aliases where user_id = ${userId}::uuid) as "requestAliases"`);
  for (const [name, count] of Object.entries(money ?? {})) if (Number(count) > 0) reasons.add(name);

  let operationId: string | null = null, cardId: string | null = null, sponsorshipId: string | null = null;
  if (operations.length > 1) reasons.add('more_than_one_card_operation');
  const op = operations[0];
  if (op) {
    operationId = String(op.id); cardId = String(op.card_id);
    if (op.type !== 'issue' || op.status !== 'pending' || op.fulfillment_mode !== 'manual' || Number(op.attempts) !== 0 || !op.sponsorship_id
      || op.asset !== 'USDT' || BigInt(String(op.amount)) !== FEE) reasons.add('not_a_waiting_broker_paid_application');
    sponsorshipId = op.sponsorship_id ? String(op.sponsorship_id) : null;
    const [card] = await rows(tx, sql`select * from cards where id = ${cardId}::uuid for update`);
    if (!card || card.user_id !== userId || card.status !== 'pending' || card.partner_card_id !== null) reasons.add('card_was_issued_or_changed');
    const grants = await rows(tx, sql`select * from card_issue_sponsorships where telegram_id = ${OWNER_TELEGRAM_ID}::bigint for update`);
    const grant = grants.find(row => row.id === op.sponsorship_id);
    if (!grant || grant.operation_id !== operationId || grant.consumed_at !== null || grant.retry_of_operation_id !== null) reasons.add('sponsorship_changed');
    const [sent] = await rows(tx, sql`select count(*)::int as count from upay_submissions where reference = ${operationId}`);
    if (Number(sent?.count) !== 0) reasons.add('sent_to_upay');
    const ledger = await rows(tx, sql`select reference from ledger_transactions where reference like ${`card_issue_%:${operationId}`}`);
    if (ledger.length !== 1 || ledger[0]!.reference !== `card_issue_hold:${operationId}`) reasons.add('unexpected_ledger_history');
  }
  const jobs = await rows(tx, sql`select status from jobs where payload->>'userId' = ${userId}
    or (${operationId}::text is not null and payload->>'operationId' = ${operationId}) for update`);
  if (jobs.some(job => job.status === 'running')) reasons.add('running_job');
  const [counts] = await rows<Record<string, number>>(tx, sql`select
    (select count(*)::int from kyc_profiles where user_id = ${userId}::uuid) as "kycProfiles",
    (select count(*)::int from kyc_documents where user_id = ${userId}::uuid) as "kycDocuments",
    (select count(*)::int from card_billing_addresses where user_id = ${userId}::uuid) as "billingAddresses",
    (select count(*)::int from fee_payments where user_id = ${userId}::uuid) as "feePayments",
    (select count(*)::int from admin_notifications where user_id = ${userId}::uuid) as "adminNotifications"`);
  const remove = { ...counts, cardOperations: op ? 1 : 0, cards: op ? 1 : 0, jobs: jobs.length };
  const nothing = !op && !profile;
  return { plan: { status: reasons.size ? 'blocked' : nothing ? 'nothing_to_remove' : 'ready', userId, operationId, cardId,
    blockedReasons: [...reasons].sort(), remove }, sponsorshipId, submissionId };
}

export async function inspectOwnerApplication(db: Db): Promise<OwnerApplicationPlan> {
  return db.transaction(async tx => (await inspectLocked(tx)).plan);
}

export async function removeOwnerApplication(db: Db, expected: { userId: string; operationId: string | null }): Promise<OwnerApplicationPlan> {
  return db.transaction(async tx => {
    const { plan, sponsorshipId } = await inspectLocked(tx);
    if (plan.status !== 'ready' || plan.userId !== expected.userId || plan.operationId !== expected.operationId) {
      throw new AppError('validation', `The account changed or the application cannot be removed: ${plan.blockedReasons.join(', ') || plan.status}`);
    }
    const userId = plan.userId;
    await tx.execute(sql`delete from jobs where payload->>'userId' = ${userId}
      or (${plan.operationId}::text is not null and payload->>'operationId' = ${plan.operationId})`);
    if (plan.operationId) {
      const operationId = plan.operationId;
      // Close the broker reserve through the guarded refund path, then drop the pair: they cancel out on system accounts.
      await tx.execute(sql`select set_config('gudex.sponsorship_v1', 'true', true), set_config('gudex.sponsorship_v2', 'true', true)`);
      await post(tx, { kind: 'card_issue_refund', reference: `card_issue_refund:${operationId}`,
        postings: move(accounts.clearing('USDT'), accounts.brokerIssueExpense(), FEE), metadata: { reason: 'owner removed his waiting application' } });
      // The one-time broker coverage is free again for the new application.
      await tx.execute(sql`update card_issue_sponsorships set operation_id = null, updated_at = now() where id = ${sponsorshipId}::uuid`);
      await tx.execute(sql`update card_operations set status = 'failed', error = 'Removed by the owner before review', updated_at = now() where id = ${operationId}::uuid`);
      await tx.execute(sql`delete from ledger_entries where transaction_id in (select id from ledger_transactions where reference in
        (${`card_issue_hold:${operationId}`}, ${`card_issue_refund:${operationId}`}))`);
      await tx.execute(sql`delete from ledger_transactions where reference in (${`card_issue_hold:${operationId}`}, ${`card_issue_refund:${operationId}`})`);
      await tx.execute(sql`delete from card_operations where id = ${operationId}::uuid`);
      await tx.execute(sql`delete from cards where id = ${plan.cardId}::uuid`);
    }
    const [profile] = await rows(tx, sql`select partner_provider from kyc_profiles where user_id = ${userId}::uuid`);
    for (const statement of [
      sql`delete from admin_notifications where user_id = ${userId}::uuid`,
      sql`delete from fee_payments where user_id = ${userId}::uuid and received = 0`,
      sql`delete from card_billing_addresses where user_id = ${userId}::uuid`,
      sql`delete from kyc_documents where user_id = ${userId}::uuid`,
      sql`delete from kyc_profiles where user_id = ${userId}::uuid`,
    ]) await tx.execute(statement);
    // A blank questionnaire, as a new client gets on registration.
    if (profile) await tx.execute(sql`insert into kyc_profiles (user_id, partner_provider) values (${userId}::uuid, ${String(profile.partner_provider)})`);
    return { ...plan, status: 'removed' as const };
  });
}
