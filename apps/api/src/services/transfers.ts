import { and, eq, sql } from 'drizzle-orm';
import { fromMinor, type RecipientDto, toMinor, type TransferDto, type WalletAsset } from '@gudex/shared';
import type { Db } from '../db/client';
import { kycProfiles, transfers, users } from '../db/schema';
import { accounts, move, post } from '../ledger/ledger';
import { AppError, isUniqueViolation } from '../lib/errors';
import { notify } from './notify';

type UserRow = typeof users.$inferSelect;

// Ник Telegram: 4–32 символа, латиница, цифры и подчёркивание.
const USERNAME_RE = /^[A-Za-z0-9_]{4,32}$/;

const normalize = (username: string) => username.trim().replace(/^@/, '');

// Имя получателя — только имя и первая буква фамилии: достаточно, чтобы убедиться, что адресат верный.
function recipientDto(user: UserRow): RecipientDto {
  const name = [user.firstName, user.lastName ? `${user.lastName[0]}.` : null].filter(Boolean).join(' ');
  return { username: user.username ?? '', name: name || null };
}

// Переводы между пользователями GUDEX по @нику: мгновенно и без комиссии, деньги не покидают леджер.
export class TransferService {
  constructor(private readonly db: Db) {}

  async findRecipient(userId: string, username: string): Promise<RecipientDto> {
    return recipientDto(await this.recipient(userId, username));
  }

  private async recipient(userId: string, username: string): Promise<UserRow> {
    const name = normalize(username);
    if (!USERNAME_RE.test(name)) throw new AppError('recipient_not_found', 'Recipient not found');
    const [user] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = ${name.toLowerCase()}`);
    if (!user) throw new AppError('recipient_not_found', 'Recipient not found');
    if (user.id === userId) throw new AppError('self_transfer', 'Cannot transfer to yourself');
    return user;
  }

  async create(
    userId: string,
    input: { username: string; asset: WalletAsset; amount: string; idempotencyKey: string },
  ): Promise<TransferDto> {
    const existing = await this.findByKey(userId, input.idempotencyKey);
    if (existing) return existing;

    const [kyc] = await this.db.select({ status: kycProfiles.status }).from(kycProfiles).where(eq(kycProfiles.userId, userId));
    if (kyc?.status !== 'approved') throw new AppError('kyc_required', 'Identity verification required');

    const recipient = await this.recipient(userId, input.username);
    let amount: bigint;
    try {
      amount = toMinor(input.amount, input.asset);
    } catch {
      throw new AppError('validation', 'Invalid amount');
    }
    if (amount <= 0n) throw new AppError('amount_too_small', 'Amount must be positive');
    const [sender] = await this.db.select().from(users).where(eq(users.id, userId));

    try {
      const row = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(transfers)
          .values({ fromUserId: userId, toUserId: recipient.id, asset: input.asset, amount, idempotencyKey: input.idempotencyKey })
          .returning();
        const { transactionId } = await post(tx, {
          kind: 'transfer',
          reference: `transfer:${row!.id}`,
          postings: move(accounts.userWallet(userId, input.asset), accounts.userWallet(recipient.id, input.asset), amount),
        });
        await tx.update(transfers).set({ ledgerTransactionId: transactionId }).where(eq(transfers.id, row!.id));
        await notify(tx, recipient.id, {
          type: 'transfer_received',
          amount: fromMinor(amount, input.asset),
          asset: input.asset,
          from: sender?.username ? `@${sender.username}` : (sender?.firstName ?? 'GUDEX'),
        });
        return row!;
      });
      return { id: row.id, asset: input.asset, amount: fromMinor(amount, input.asset), recipient: recipientDto(recipient), createdAt: row.createdAt.toISOString() };
    } catch (err) {
      if (isUniqueViolation(err)) {
        const again = await this.findByKey(userId, input.idempotencyKey);
        if (again) return again;
      }
      throw err;
    }
  }

  private async findByKey(userId: string, idempotencyKey: string): Promise<TransferDto | null> {
    const [row] = await this.db
      .select({ transfer: transfers, recipient: users })
      .from(transfers)
      .innerJoin(users, eq(users.id, transfers.toUserId))
      .where(and(eq(transfers.fromUserId, userId), eq(transfers.idempotencyKey, idempotencyKey)));
    if (!row) return null;
    const asset = row.transfer.asset as WalletAsset;
    return {
      id: row.transfer.id,
      asset,
      amount: fromMinor(row.transfer.amount, asset),
      recipient: recipientDto(row.recipient),
      createdAt: row.transfer.createdAt.toISOString(),
    };
  }
}
