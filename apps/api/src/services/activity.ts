import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { type ActivityItemDto, type ActivityStatus, fromMinor, type Network, type WalletAsset } from '@gudex/shared';
import type { Db } from '../db/client';
import { cardOperations, cards, cardTransactions, deposits, referralRewards, transfers, users, withdrawals } from '../db/schema';
import { EXPLORERS, type WatchNetwork } from '../payments/chain-watch';

const sender = alias(users, 'sender');
const receiver = alias(users, 'receiver');
const handle = (u: { username: string | null; firstName: string | null } | null) => (u?.username ? `@${u.username}` : (u?.firstName ?? null));

const opStatus = (status: string): ActivityStatus =>
  status === 'succeeded' ? 'succeeded' : status === 'failed' ? 'failed' : status === 'unknown' ? 'unknown' : 'pending';

// A payment to an app-wallet address keeps its chain transaction in the deposit id: app-wallet:<network>:<hash>:<log index>.
const depositHash = (providerId: string, externalId: string): string | null => {
  const parts = externalId.split(':');
  return providerId === 'app-wallet' && parts.length === 4 && parts[2] ? parts[2] : null;
};
const explorerUrl = (network: string, txHash: string | null): string | null =>
  txHash && network in EXPLORERS ? `${EXPLORERS[network as WatchNetwork]}${txHash}` : null;
const noChain = { txHash: null, explorerUrl: null };

// Лента операций пользователя: депозиты, выводы, переводы, бонусы, операции с картой и покупки — вперемешку по времени.
export class ActivityService {
  constructor(private readonly db: Db) {}

  async list(userId: string, limit = 50): Promise<ActivityItemDto[]> {
    const [depositRows, opRows, txRows, withdrawalRows, transferRows, rewardRows] = await Promise.all([
      this.db
        .select()
        .from(deposits)
        .where(and(eq(deposits.userId, userId), eq(deposits.status, 'credited')))
        .orderBy(desc(deposits.createdAt))
        .limit(limit),
      this.db
        .select({ op: cardOperations, last4: cards.last4 })
        .from(cardOperations)
        .innerJoin(cards, eq(cards.id, cardOperations.cardId))
        .where(and(eq(cardOperations.userId, userId), inArray(cardOperations.type, ['issue', 'topup'])))
        .orderBy(desc(cardOperations.createdAt))
        .limit(limit),
      this.db
        .select({ tx: cardTransactions, last4: cards.last4 })
        .from(cardTransactions)
        .innerJoin(cards, eq(cards.id, cardTransactions.cardId))
        .where(eq(cardTransactions.userId, userId))
        .orderBy(desc(cardTransactions.occurredAt))
        .limit(limit),
      this.db.select().from(withdrawals).where(eq(withdrawals.userId, userId)).orderBy(desc(withdrawals.createdAt)).limit(limit),
      this.db
        .select({ transfer: transfers, sender, receiver })
        .from(transfers)
        .innerJoin(sender, eq(sender.id, transfers.fromUserId))
        .innerJoin(receiver, eq(receiver.id, transfers.toUserId))
        .where(or(eq(transfers.fromUserId, userId), eq(transfers.toUserId, userId)))
        .orderBy(desc(transfers.createdAt))
        .limit(limit),
      this.db
        .select()
        .from(referralRewards)
        .where(eq(referralRewards.referrerId, userId))
        .orderBy(desc(referralRewards.createdAt))
        .limit(limit),
    ]);

    const items: ActivityItemDto[] = [
      ...depositRows.map((d) => {
        const txHash = depositHash(d.providerId, d.externalId);
        return {
          id: `deposit:${d.id}`,
          kind: 'deposit' as const,
          status: 'succeeded' as const,
          asset: d.asset as WalletAsset,
          amount: `+${fromMinor(d.amount, d.asset as WalletAsset)}`,
          fee: null,
          merchant: null,
          counterparty: null,
          cardLast4: null,
          cardId: null,
          network: d.network as Network,
          txHash,
          explorerUrl: explorerUrl(d.network, txHash),
          createdAt: d.createdAt.toISOString(),
        };
      }),
      ...withdrawalRows.map((w) => {
        const asset = w.asset as WalletAsset;
        return {
          id: `withdrawal:${w.id}`,
          kind: 'withdrawal' as const,
          status: opStatus(w.status),
          asset,
          amount: `-${fromMinor(w.amount, asset)}`,
          fee: fromMinor(w.fee, asset),
          merchant: null,
          counterparty: w.address,
          cardLast4: null,
          cardId: null,
          network: w.network as Network,
          txHash: w.txHash,
          explorerUrl: explorerUrl(w.network, w.txHash),
          createdAt: w.createdAt.toISOString(),
        };
      }),
      ...transferRows.map(({ transfer, sender, receiver }) => {
        const asset = transfer.asset as WalletAsset;
        const incoming = transfer.toUserId === userId;
        return {
          id: `transfer:${transfer.id}`,
          kind: incoming ? ('transfer_in' as const) : ('transfer_out' as const),
          status: 'succeeded' as const,
          asset,
          amount: `${incoming ? '+' : '-'}${fromMinor(transfer.amount, asset)}`,
          fee: null,
          merchant: null,
          counterparty: handle(incoming ? sender : receiver),
          cardLast4: null,
          cardId: null,
          network: null,
          ...noChain,
          createdAt: transfer.createdAt.toISOString(),
        };
      }),
      ...rewardRows.map((r) => {
        const asset = r.asset as WalletAsset;
        return {
          id: `referral:${r.id}`,
          kind: 'referral_reward' as const,
          status: 'succeeded' as const,
          asset,
          amount: `+${fromMinor(r.amount, asset)}`,
          fee: null,
          merchant: null,
          counterparty: null,
          cardLast4: null,
          cardId: null,
          network: null,
          ...noChain,
          createdAt: r.createdAt.toISOString(),
        };
      }),
      ...opRows.map(({ op, last4 }) => {
        const asset = op.asset as WalletAsset;
        return {
          id: `operation:${op.id}`,
          kind: op.type === 'issue' ? ('card_issue' as const) : ('card_topup' as const),
          status: opStatus(op.status),
          asset,
          amount: op.sponsorshipId ? '0' : `-${fromMinor(op.amount ?? 0n, asset)}`,
          fee: op.sponsorshipId ? '0' : op.fee !== null ? fromMinor(op.fee, asset) : null,
          fundingSource: op.sponsorshipId ? 'broker' as const : 'wallet' as const,
          merchant: null,
          counterparty: null,
          cardLast4: last4,
          cardId: op.cardId,
          network: null,
          ...noChain,
          createdAt: op.createdAt.toISOString(),
        };
      }),
      ...txRows.map(({ tx, last4 }) => ({
        id: `card_tx:${tx.id}`,
        kind: tx.kind === 'refund' ? ('card_refund' as const) : ('card_purchase' as const),
        status: 'succeeded' as const,
        asset: 'USD' as const,
        amount: `${tx.kind === 'refund' ? '+' : '-'}${fromMinor(tx.amountUsd, 'USD')}`,
        fee: null,
        merchant: tx.merchant,
        counterparty: null,
        cardLast4: last4,
        cardId: tx.cardId,
        network: null,
        ...noChain,
        createdAt: tx.occurredAt.toISOString(),
      })),
    ];

    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
}
