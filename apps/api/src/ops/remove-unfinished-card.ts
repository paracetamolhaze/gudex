import { sql, type SQL } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { accounts, move, post } from '../ledger/ledger';
import { AppError } from '../lib/errors';
import type { UpayClient } from '../partner/upay/client';

// One owner-authorized cleanup: the unfinished broker-paid test issuance of 16 October is removed,
// so the owner's GUDEX account keeps only the questionnaire and the UPay customer link. Nothing is
// sent to UPay; the bot only reads the customer's card list to prove that no card exists there.
const OWNER_TELEGRAM_ID = '514468501';
export const REMOVE_UNFINISHED_CARD_CONFIRMATION = 'REMOVE_MY_UNFINISHED_CARD';
const FEE = 10_000_000n;
type Row = Record<string, unknown>;
const rows = async <T extends Row = Row>(tx: Tx, query: SQL) => (await tx.execute(query)).rows as T[];
const oneOf = (column: SQL, values: string[]) => values.length ? sql`${column} in (${sql.join(values.map(value => sql`${value}`), sql`, `)})` : sql`false`;

export interface UnfinishedCardPlan {
  status: 'ready' | 'blocked' | 'nothing_to_remove' | 'removed';
  userId: string | null;
  operationId: string | null;
  cardId: string | null;
  sponsorshipId: string | null;
  upayCustomerCards: number | null;
  invoices: number;
  jobs: number;
  blockedReasons: string[];
  kept: { kycStatus: string | null; customerLinked: boolean; billingAddress: boolean };
}

interface Scope { plan: UnfinishedCardPlan; invoiceIds: string[]; jobIds: string[] }
type CardListReader = Pick<UpayClient, 'readRequest'>;

/** Cards of this Customer ID in UPay, through the only read the bot is allowed (GET /card/list). */
async function upayCards(upay: CardListReader | undefined, customerNo: string | null): Promise<number | null> {
  if (!upay || !customerNo) return null;
  try {
    const page = await upay.readRequest<{ list?: unknown[]; totalPages?: unknown }>('GET', '/card/list', { query: { customerNo, pageNo: 1, pageSize: 100 } });
    if (!Array.isArray(page?.list) || Number(page.totalPages) > 1) return null;
    return page.list.filter(row => row && typeof row === 'object' && String((row as Row).customerNo) === customerNo).length;
  } catch { return null; }
}

async function inspectLocked(tx: Tx, cardsInUpay: number | null): Promise<Scope> {
  await tx.execute(sql`set local lock_timeout = '3s'`);
  const empty: UnfinishedCardPlan = { status: 'nothing_to_remove', userId: null, operationId: null, cardId: null, sponsorshipId: null,
    upayCustomerCards: cardsInUpay, invoices: 0, jobs: 0, blockedReasons: [], kept: { kycStatus: null, customerLinked: false, billingAddress: false } };
  const [user] = await rows(tx, sql`select id::text from users where telegram_id = ${OWNER_TELEGRAM_ID}::bigint for update`);
  if (!user) return { plan: empty, invoiceIds: [], jobIds: [] };
  const userId = String(user.id);
  const [profile] = await rows(tx, sql`select status, partner_customer_id from kyc_profiles where user_id = ${userId}::uuid for update`);
  const [billing] = await rows(tx, sql`select 1 as present from card_billing_addresses where user_id = ${userId}::uuid`);
  const kept = { kycStatus: profile ? String(profile.status) : null, customerLinked: Boolean(profile?.partner_customer_id), billingAddress: Boolean(billing) };
  const operations = await rows(tx, sql`select * from card_operations where user_id = ${userId}::uuid for update`);
  const invoices = await rows(tx, sql`select id::text, state, credited_amount from deposit_invoices where user_id = ${userId}::uuid for update`);
  const reasons = new Set<string>();
  if (invoices.some(invoice => invoice.credited_amount !== null || invoice.state === 'credited')) reasons.add('credited_deposit_invoice');
  const invoiceIds = invoices.map(invoice => String(invoice.id));
  if (!operations.length) {
    return { plan: { ...empty, userId, kept, invoices: invoiceIds.length, status: invoiceIds.length ? 'ready' : 'nothing_to_remove' }, invoiceIds, jobIds: [] };
  }
  if (operations.length !== 1) reasons.add('more_than_one_card_operation');
  const op = operations[0]!;
  const operationId = String(op.id), cardId = String(op.card_id);
  if (op.type !== 'issue' || op.status !== 'unknown' || op.partner_provider !== 'upay' || !op.sponsorship_id || op.asset !== 'USDT'
    || BigInt(String(op.amount)) !== FEE) reasons.add('not_the_unfinished_broker_paid_issue');
  const [card] = await rows(tx, sql`select * from cards where id = ${cardId}::uuid for update`);
  if (!card || card.user_id !== userId || card.status !== 'pending' || card.partner_card_id !== null) reasons.add('card_was_issued_or_changed');
  const grants = await rows(tx, sql`select * from card_issue_sponsorships where telegram_id = ${OWNER_TELEGRAM_ID}::bigint for update`);
  const grant = grants.find(row => row.id === op.sponsorship_id);
  if (grants.length !== 1 || !grant || grant.operation_id !== operationId || grant.consumed_at !== null || grant.retry_of_operation_id !== null) reasons.add('sponsorship_changed');
  const [consents] = await rows(tx, sql`select count(*)::int as count from card_issue_retry_consents where original_operation_id = ${operationId}::uuid or new_operation_id = ${operationId}::uuid`);
  if (Number(consents?.count) !== 0) reasons.add('additional_attempt_exists');
  const journal = await rows(tx, sql`select * from upay_submissions where reference = ${operationId} for update`);
  if (journal.some(entry => entry.partner_receipt_id !== null || entry.partner_card_id !== null)) reasons.add('issuance_receipt_recorded');
  const [aliases] = await rows(tx, sql`select (select count(*)::int from upay_submission_aliases where reference = ${operationId})
    + (select count(*)::int from card_operation_request_aliases where operation_id = ${operationId}::uuid)
    + (select count(*)::int from card_transactions where card_id = ${cardId}::uuid) as count`);
  if (Number(aliases?.count) !== 0) reasons.add('receipt_alias_or_card_transactions');
  const ledger = await rows(tx, sql`select reference from ledger_transactions where reference in
    (${`card_issue_hold:${operationId}`}, ${`card_issue_refund:${operationId}`}, ${`card_issue_settle:${operationId}`})`);
  if (ledger.length !== 1 || ledger[0]!.reference !== `card_issue_hold:${operationId}`) reasons.add('unexpected_ledger_history');
  if (cardsInUpay === null) reasons.add('upay_card_list_unavailable');
  else if (cardsInUpay > 0) reasons.add('upay_customer_has_cards');
  const jobs = await rows(tx, sql`select id::text, status from jobs where payload->>'operationId' = ${operationId} or payload->>'cardId' = ${cardId}
    or ${oneOf(sql`payload->>'invoiceId'`, invoiceIds)} for update`);
  if (jobs.some(job => job.status === 'running')) reasons.add('running_job');
  return { plan: { status: reasons.size ? 'blocked' : 'ready', userId, operationId, cardId, sponsorshipId: String(op.sponsorship_id),
    upayCustomerCards: cardsInUpay, invoices: invoiceIds.length, jobs: jobs.length, blockedReasons: [...reasons].sort(), kept }, invoiceIds, jobIds: jobs.map(job => String(job.id)) };
}

async function customerNo(db: Db): Promise<string | null> {
  const [row] = (await db.execute(sql`select p.partner_customer_id from kyc_profiles p join users u on u.id = p.user_id
    where u.telegram_id = ${OWNER_TELEGRAM_ID}::bigint`)).rows as Row[];
  return typeof row?.partner_customer_id === 'string' ? row.partner_customer_id : null;
}

export async function inspectUnfinishedCard(db: Db, upay: CardListReader | undefined): Promise<UnfinishedCardPlan> {
  const cardsInUpay = await upayCards(upay, await customerNo(db));
  return db.transaction(async tx => (await inspectLocked(tx, cardsInUpay)).plan);
}

export async function removeUnfinishedCard(db: Db, upay: CardListReader | undefined,
  expected: { userId: string; operationId: string | null; cardId: string | null }): Promise<UnfinishedCardPlan> {
  const cardsInUpay = await upayCards(upay, await customerNo(db));
  return db.transaction(async tx => {
    const { plan, invoiceIds, jobIds } = await inspectLocked(tx, cardsInUpay);
    if (plan.status !== 'ready' || plan.userId !== expected.userId || plan.operationId !== expected.operationId || plan.cardId !== expected.cardId) {
      throw new AppError('validation', `The account changed or cannot be cleaned: ${plan.blockedReasons.join(', ') || plan.status}`);
    }
    if (jobIds.length) await tx.execute(sql`delete from jobs where ${oneOf(sql`id::text`, jobIds)}`);
    if (invoiceIds.length) await tx.execute(sql`delete from deposit_invoices where ${oneOf(sql`id::text`, invoiceIds)}`);
    if (plan.operationId) {
      const operationId = plan.operationId;
      // Close the reserve through the guarded refund path first, so every database rule still holds.
      await tx.execute(sql`select set_config('gudex.sponsorship_v1', 'true', true), set_config('gudex.sponsorship_v2', 'true', true)`);
      await post(tx, { kind: 'card_issue_refund', reference: `card_issue_refund:${operationId}`,
        postings: move(accounts.clearing('USDT'), accounts.brokerIssueExpense(), FEE), metadata: { reason: 'owner removed the unfinished test issuance' } });
      await tx.execute(sql`update card_issue_sponsorships set operation_id = null, updated_at = now() where id = ${plan.sponsorshipId}::uuid`);
      await tx.execute(sql`update card_operations set status = 'failed', error = 'Removed by the owner: no card was issued', updated_at = now() where id = ${operationId}::uuid`);
      // Hold and refund cancel out on the system accounts, so removing both keeps every cached balance true.
      await tx.execute(sql`delete from ledger_entries where transaction_id in (select id from ledger_transactions where reference in
        (${`card_issue_hold:${operationId}`}, ${`card_issue_refund:${operationId}`}))`);
      await tx.execute(sql`delete from ledger_transactions where reference in (${`card_issue_hold:${operationId}`}, ${`card_issue_refund:${operationId}`})`);
      await tx.execute(sql`delete from upay_submissions where reference = ${operationId}`);
      await tx.execute(sql`delete from card_operations where id = ${operationId}::uuid`);
      await tx.execute(sql`delete from cards where id = ${plan.cardId}::uuid`);
      await tx.execute(sql`delete from card_issue_sponsorships where id = ${plan.sponsorshipId}::uuid`);
    }
    return { ...plan, status: 'removed' as const };
  });
}
