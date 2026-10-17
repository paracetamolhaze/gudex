import { and, desc, eq } from 'drizzle-orm';
import {
  DEPOSIT_NETWORKS,
  fromMinor,
  isValidAddress,
  type Network,
  NETWORKS,
  toMinor,
  type WalletAsset,
  type WithdrawalDto,
} from '@gudex/shared';
import type { Config } from '../config';
import type { Db, Tx } from '../db/client';
import { kycProfiles, users, withdrawals } from '../db/schema';
import { accounts, move, post } from '../ledger/ledger';
import { AppError, isUniqueViolation } from '../lib/errors';
import { PartnerError } from '../partner/types';
import { enqueue, type JobContext, type JobHandler, PermanentJobError } from '../queue/queue';
import type { WithdrawalProvider } from '../withdrawals/provider';
import { notify } from './notify';

type WithdrawalRow = typeof withdrawals.$inferSelect;

const TERMINAL = ['succeeded', 'failed'];

function toDto(w: WithdrawalRow): WithdrawalDto {
  const asset = w.asset as WalletAsset;
  return {
    id: w.id,
    asset,
    network: w.network as Network,
    address: w.address,
    amount: fromMinor(w.amount, asset),
    fee: fromMinor(w.fee, asset),
    netAmount: fromMinor(w.amount - w.fee, asset),
    status: w.status,
    txHash: w.txHash,
    error: w.error,
    createdAt: w.createdAt.toISOString(),
  };
}

// Вывод USDT/USDC на внешний кошелёк. Схема как у операций с картой:
// резерв денег + задача в одной транзакции, отправка в блокчейн — в фоне.
export class WithdrawalService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly provider: WithdrawalProvider,
  ) {}

  private get providerId(): string { return this.provider.providerId ?? 'mock'; }

  async create(
    userId: string,
    input: { asset: WalletAsset; network: Network; address: string; amount: string; idempotencyKey: string },
  ): Promise<WithdrawalDto> {
    const existing = await this.findByKey(userId, input.idempotencyKey);
    if (existing) return toDto(existing);
    this.provider.assertAvailable?.();

    if (!DEPOSIT_NETWORKS[input.asset].includes(input.network)) {
      throw new AppError('validation', `${input.asset} is not supported on ${input.network}`);
    }
    const address = input.address.trim();
    if (!isValidAddress(input.network, address)) throw new AppError('invalid_address', 'Address does not match the network');

    const [kyc] = await this.db.select({ status: kycProfiles.status }).from(kycProfiles).where(eq(kycProfiles.userId, userId));
    if (kyc?.status !== 'approved') throw new AppError('kyc_required', 'Identity verification required');

    let amount: bigint;
    try {
      amount = toMinor(input.amount, input.asset);
    } catch {
      throw new AppError('validation', 'Invalid amount');
    }
    const fee = toMinor(this.config.withdrawFees[input.network], input.asset);
    const min = toMinor(this.config.withdrawMin[input.network], input.asset);
    if (amount < min || amount <= fee) {
      throw new AppError('amount_too_small', `Minimum withdrawal is ${this.config.withdrawMin[input.network]} ${input.asset}`);
    }

    try {
      return toDto(
        await this.db.transaction(async (tx) => {
          await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
          const [replay] = await tx.select().from(withdrawals).where(and(eq(withdrawals.userId, userId), eq(withdrawals.idempotencyKey, input.idempotencyKey)));
          if (replay) return replay;
          const [uncertain] = await tx.select({ id: withdrawals.id }).from(withdrawals).where(and(eq(withdrawals.userId, userId), eq(withdrawals.status, 'unknown'))).limit(1);
          if (uncertain) throw new AppError('provider_unavailable', 'An earlier withdrawal requires reconciliation before a new withdrawal');
          const [row] = await tx
            .insert(withdrawals)
            .values({ userId, asset: input.asset, network: input.network, address, amount, fee, idempotencyKey: input.idempotencyKey, providerId: this.providerId })
            .returning();
          await post(tx, {
            kind: 'withdrawal_hold',
            reference: `withdrawal_hold:${row!.id}`,
            postings: move(accounts.userWallet(userId, input.asset), accounts.clearing(input.asset), amount),
          });
          await enqueue(tx, 'withdrawal.send', { withdrawalId: row!.id });
          return row!;
        }),
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        const row = await this.findByKey(userId, input.idempotencyKey);
        if (row) return toDto(row);
      }
      throw err;
    }
  }

  async get(userId: string, id: string): Promise<WithdrawalDto> {
    const [row] = await this.db
      .select()
      .from(withdrawals)
      .where(and(eq(withdrawals.id, id), eq(withdrawals.userId, userId)));
    if (!row) throw new AppError('not_found', 'Withdrawal not found');
    return toDto(row);
  }

  private async findByKey(userId: string, idempotencyKey: string): Promise<WithdrawalRow | undefined> {
    const [row] = await this.db
      .select()
      .from(withdrawals)
      .where(and(eq(withdrawals.userId, userId), eq(withdrawals.idempotencyKey, idempotencyKey)));
    return row;
  }

  // ─── Воркер ────────────────────────────────────────────────────────────

  handlers(): Record<string, JobHandler> {
    type P = { withdrawalId: string };
    return {
      'withdrawal.send': {
        replaySafe: false,
        run: ({ withdrawalId }: P, context) => this.send(withdrawalId, context),
        onExhausted: ({ withdrawalId }: P) => this.markUnknown(withdrawalId),
      },
    };
  }

  private async send(withdrawalId: string, context?: JobContext): Promise<void> {
    const started = await this.db.transaction(async (tx) => {
      const [w] = await tx.select().from(withdrawals).where(eq(withdrawals.id, withdrawalId)).for('update');
      if (!w) throw new PermanentJobError(`Withdrawal ${withdrawalId} not found`);
      if (TERMINAL.includes(w.status)) return null;
      if (w.providerId !== this.providerId) {
        await tx.update(withdrawals).set({ status: 'unknown', error: 'Withdrawal provider differs from the active integration; manual reconciliation required', updatedAt: new Date() }).where(eq(withdrawals.id, w.id));
        return null;
      }
      const canSubmit = w.status === 'pending';
      if (canSubmit) await tx.update(withdrawals).set({ status: 'processing', attempts: w.attempts + 1, updatedAt: new Date() }).where(eq(withdrawals.id, w.id));
      return { w, canSubmit };
    });
    if (!started) return;
    const { w } = started;
    if (!started.canSubmit) {
      await this.markUnknown(w.id);
      await this.reconcileUnknown(w.id);
      return;
    }
    const asset = w.asset as WalletAsset;
    const network = w.network as Network;
    try {
      let result = await this.provider.findByReference?.(w.id);
      if (!result) {
        await context?.assertActive();
        result = await this.provider.send({ reference: w.id, asset, network, address: w.address, amount: w.amount - w.fee });
      }
      await this.completeSend(w.id, result.txHash);
    } catch (error) {
      if (error instanceof PartnerError && !error.retryable) {
        await this.failWithRefund(w.id, error.message);
      } else {
        await this.markUnknown(w.id);
        await this.reconcileUnknown(w.id);
      }
    }
  }

  private async completeSend(withdrawalId: string, txHash: string): Promise<void> {
    await this.finish(withdrawalId, async (tx, w) => {
      const asset = w.asset as WalletAsset;
      const network = w.network as Network;
      // Сумма за вычетом комиссии ушла в блокчейн, комиссия сети — доход GUDEX (из него оплачивается газ).
      await post(tx, {
        kind: 'withdrawal_settle',
        reference: `withdrawal_settle:${w.id}`,
        postings: [
          { account: accounts.clearing(asset), amount: -w.amount },
          { account: accounts.external(asset), amount: w.amount - w.fee },
          { account: accounts.fees(asset), amount: w.fee },
        ],
      });
      await tx.update(withdrawals).set({ status: 'succeeded', error: null, txHash, updatedAt: new Date() }).where(eq(withdrawals.id, w.id));
      await notify(tx, w.userId, {
        type: 'withdrawal_sent',
        amount: fromMinor(w.amount - w.fee, asset),
        asset,
        network: NETWORKS[network].name,
        address: w.address,
      });
    });
  }

  private async markUnknown(withdrawalId: string): Promise<void> {
    await this.finish(withdrawalId, async (tx, w) => {
      await tx.update(withdrawals).set({ status: 'unknown', error: 'Provider result is unconfirmed; funds remain reserved', updatedAt: new Date() }).where(eq(withdrawals.id, w.id));
    });
  }

  async listUnknown(limit = 50): Promise<WithdrawalDto[]> {
    const rows = await this.db.select().from(withdrawals).where(eq(withdrawals.status, 'unknown')).orderBy(desc(withdrawals.updatedAt)).limit(Math.max(1, Math.min(limit, 100)));
    return rows.map(toDto);
  }

  async reconcileUnknown(withdrawalId: string): Promise<WithdrawalDto> {
    const [w] = await this.db.select().from(withdrawals).where(eq(withdrawals.id, withdrawalId));
    if (!w) throw new AppError('not_found', 'Withdrawal not found');
    if (!TERMINAL.includes(w.status) && w.providerId !== this.providerId) {
      await this.markUnknown(w.id);
      return this.get(w.userId, w.id);
    }
    if (w.status === 'unknown' && this.provider.findByReference) {
      try {
        const result = await this.provider.findByReference(w.id);
        if (result) await this.completeSend(w.id, result.txHash);
      } catch {
        // Ошибка проверки не разрешает ни повторную отправку, ни возврат резерва.
      }
    }
    return this.get(w.userId, w.id);
  }

  // ВАЖНО для настоящего провайдера: сюда можно попасть, только если перевод точно не ушёл.
  private async failWithRefund(withdrawalId: string, reason: string): Promise<void> {
    await this.finish(withdrawalId, async (tx, w) => {
      const asset = w.asset as WalletAsset;
      await post(tx, {
        kind: 'withdrawal_refund',
        reference: `withdrawal_refund:${w.id}`,
        postings: move(accounts.clearing(asset), accounts.userWallet(w.userId, asset), w.amount),
      });
      await tx.update(withdrawals).set({ status: 'failed', error: reason, updatedAt: new Date() }).where(eq(withdrawals.id, w.id));
      await notify(tx, w.userId, { type: 'withdrawal_failed', amount: fromMinor(w.amount, asset), asset });
    });
  }

  private async finish(withdrawalId: string, apply: (tx: Tx, w: WithdrawalRow) => Promise<void>): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [w] = await tx.select().from(withdrawals).where(eq(withdrawals.id, withdrawalId)).for('update');
      if (!w || TERMINAL.includes(w.status)) return;
      await apply(tx, w);
    });
  }
}
