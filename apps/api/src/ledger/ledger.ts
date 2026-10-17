import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { Asset } from '@gudex/shared';
import type { DbOrTx, Tx } from '../db/client';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../db/schema';
import { AppError } from '../lib/errors';

// ─── Коды счетов ─────────────────────────────────────────────────────────

export type AccountKind = 'user_wallet' | 'user_card' | 'system';

export interface AccountSpec {
  code: string;
  asset: Asset;
  kind: AccountKind;
  userId?: string;
  allowNegative?: boolean;
}

export const accounts = {
  userWallet: (userId: string, asset: Asset): AccountSpec => ({
    code: `user:${userId}:wallet:${asset}`,
    asset,
    kind: 'user_wallet',
    userId,
  }),
  // Зеркало баланса карты у партнёра. Источник истины — партнёр, поэтому
  // уход в минус не блокируется, а должен всплывать при сверке.
  card: (userId: string, cardId: string): AccountSpec => ({
    code: `card:${cardId}`,
    asset: 'USD',
    kind: 'user_card',
    userId,
    allowNegative: true,
  }),
  // Деньги, пришедшие извне (блокчейн). Уходит в минус на сумму всех депозитов.
  external: (asset: Asset): AccountSpec => ({ code: `system:external:${asset}`, asset, kind: 'system', allowNegative: true }),
  // Деньги, зарезервированные под операцию с картой, пока партнёр её не подтвердил.
  clearing: (asset: Asset): AccountSpec => ({ code: `system:clearing:${asset}`, asset, kind: 'system' }),
  // Доход GUDEX.
  fees: (asset: Asset): AccountSpec => ({ code: `system:fees:${asset}`, asset, kind: 'system' }),
  // Крипта, которая ушла партнёру на пополнение карт.
  partnerFunding: (asset: Asset): AccountSpec => ({ code: `system:partner_funding:${asset}`, asset, kind: 'system' }),
  // An explicitly authorized broker expense, never a user wallet credit.
  brokerIssueExpense: (): AccountSpec => ({ code: 'system:broker_issue_expense:USDT', asset: 'USDT', kind: 'system', allowNegative: true }),
  // Контрсчёт балансов карт: минус сумма всех карточных балансов у партнёра.
  cardIssuer: (): AccountSpec => ({ code: 'system:card_issuer:USD', asset: 'USD', kind: 'system', allowNegative: true }),
};

export async function ensureAccount(db: DbOrTx, spec: AccountSpec): Promise<string> {
  await db
    .insert(ledgerAccounts)
    .values({
      code: spec.code,
      asset: spec.asset,
      kind: spec.kind,
      userId: spec.userId,
      allowNegative: spec.allowNegative ?? false,
    })
    .onConflictDoNothing({ target: ledgerAccounts.code });
  const [row] = await db.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(eq(ledgerAccounts.code, spec.code));
  if (!row) throw new Error(`Ledger account ${spec.code} not found`);
  return row.id;
}

export async function getBalance(db: DbOrTx, code: string): Promise<bigint> {
  const [row] = await db.select({ balance: ledgerAccounts.balance }).from(ledgerAccounts).where(eq(ledgerAccounts.code, code));
  return row?.balance ?? 0n;
}

// ─── Проводки ────────────────────────────────────────────────────────────

export interface Posting {
  account: AccountSpec;
  amount: bigint; // +зачисление на счёт, −списание
}

export interface PostInput {
  kind: string;
  // Уникальная ссылка на бизнес-событие (например, `deposit:<id>`).
  reference: string;
  postings: Posting[];
  metadata?: Record<string, unknown>;
}

export interface PostResult {
  transactionId: string;
  duplicate: boolean;
}

/**
 * Записывает сбалансированную транзакцию. Должна вызываться внутри db.transaction.
 * - Сумма проводок по каждому активу обязана быть нулевой.
 * - Повтор с той же reference ничего не меняет и возвращает существующую транзакцию.
 * - Счета без allowNegative не могут уйти в минус (иначе insufficient_funds).
 */
export async function post(tx: Tx, input: PostInput): Promise<PostResult> {
  const postings = input.postings.filter((p) => p.amount !== 0n);
  if (postings.length === 0) throw new Error(`Empty ledger transaction ${input.reference}`);

  const sums = new Map<string, bigint>();
  for (const p of postings) sums.set(p.account.asset, (sums.get(p.account.asset) ?? 0n) + p.amount);
  for (const [asset, sum] of sums) {
    if (sum !== 0n) throw new Error(`Unbalanced ledger transaction ${input.reference}: ${asset} sum=${sum}`);
  }

  const [created] = await tx
    .insert(ledgerTransactions)
    .values({ kind: input.kind, reference: input.reference, metadata: input.metadata ?? null })
    .onConflictDoNothing({ target: ledgerTransactions.reference })
    .returning({ id: ledgerTransactions.id });

  if (!created) {
    const [existing] = await tx
      .select({ id: ledgerTransactions.id })
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.reference, input.reference));
    return { transactionId: existing!.id, duplicate: true };
  }

  const accountIds = new Map<string, string>();
  for (const p of postings) {
    if (!accountIds.has(p.account.code)) accountIds.set(p.account.code, await ensureAccount(tx, p.account));
  }

  // Блокируем счета в детерминированном порядке, чтобы параллельные транзакции не вставали в deadlock.
  const locked = await tx
    .select()
    .from(ledgerAccounts)
    .where(inArray(ledgerAccounts.id, [...accountIds.values()]))
    .orderBy(asc(ledgerAccounts.id))
    .for('update');
  const byId = new Map(locked.map((a) => [a.id, a]));

  const deltas = new Map<string, bigint>();
  for (const p of postings) {
    const id = accountIds.get(p.account.code)!;
    deltas.set(id, (deltas.get(id) ?? 0n) + p.amount);
  }

  for (const [id, delta] of deltas) {
    const account = byId.get(id)!;
    const next = account.balance + delta;
    if (next < 0n && !account.allowNegative) {
      throw new AppError('insufficient_funds', `Insufficient funds on ${account.code}`);
    }
    await tx
      .update(ledgerAccounts)
      .set({ balance: sql`${ledgerAccounts.balance} + ${delta}` })
      .where(eq(ledgerAccounts.id, id));
  }

  await tx.insert(ledgerEntries).values(
    postings.map((p) => ({
      transactionId: created.id,
      accountId: accountIds.get(p.account.code)!,
      asset: p.account.asset,
      amount: p.amount,
    })),
  );

  return { transactionId: created.id, duplicate: false };
}

// Перемещение одной суммы с одного счёта на другой — самый частый случай.
export function move(from: AccountSpec, to: AccountSpec, amount: bigint): Posting[] {
  return [
    { account: from, amount: -amount },
    { account: to, amount },
  ];
}
