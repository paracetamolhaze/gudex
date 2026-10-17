import { randomBytes } from 'node:crypto';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { fromMinor, type ReferralDto, WALLET_ASSETS, type WalletAsset } from '@gudex/shared';
import type { Config } from '../config';
import type { Db, Tx } from '../db/client';
import { referralRewards, users } from '../db/schema';
import { accounts, move, post } from '../ledger/ledger';
import { AppError, isUniqueViolation } from '../lib/errors';

// Без похожих символов (0/o, 1/l/i), чтобы код можно было продиктовать.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function newCode(): string {
  return [...randomBytes(8)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

// Доля пригласившего от комиссии GUDEX. Вызывается в той же транзакции, где комиссия зачислена на счёт доходов.
export async function rewardReferrer(
  tx: Tx,
  shareBps: number,
  input: { userId: string; asset: WalletAsset; fee: bigint; source: string },
): Promise<void> {
  if (shareBps <= 0 || input.fee <= 0n) return;
  const [user] = await tx.select({ referredBy: users.referredBy }).from(users).where(eq(users.id, input.userId));
  if (!user?.referredBy) return;
  // Округление вниз: никогда не отдаём больше, чем заработали.
  const reward = (input.fee * BigInt(shareBps)) / 10000n;
  if (reward <= 0n) return;
  const [created] = await tx
    .insert(referralRewards)
    .values({ referrerId: user.referredBy, refereeId: input.userId, asset: input.asset, amount: reward, source: input.source })
    .onConflictDoNothing({ target: referralRewards.source })
    .returning({ id: referralRewards.id });
  if (!created) return;
  const { transactionId } = await post(tx, {
    kind: 'referral_reward',
    reference: `referral_reward:${input.source}`,
    postings: move(accounts.fees(input.asset), accounts.userWallet(user.referredBy, input.asset), reward),
  });
  await tx.update(referralRewards).set({ ledgerTransactionId: transactionId }).where(eq(referralRewards.id, created.id));
}

export class ReferralService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  async get(userId: string): Promise<ReferralDto> {
    const code = await this.ensureCode(userId);
    const [invited] = await this.db.select({ n: count() }).from(users).where(eq(users.referredBy, userId));
    const earned = await this.db
      .select({ asset: referralRewards.asset, total: sql<string>`sum(${referralRewards.amount})` })
      .from(referralRewards)
      .where(eq(referralRewards.referrerId, userId))
      .groupBy(referralRewards.asset);
    return {
      // Через «Старт» в боте: работает без настройки главного Mini App в BotFather.
      link: `https://t.me/${this.config.BOT_USERNAME}?start=ref_${code}`,
      invited: invited?.n ?? 0,
      earned: WALLET_ASSETS.map((asset) => {
        const row = earned.find((e) => e.asset === asset);
        return { asset, amount: fromMinor(BigInt(row?.total ?? 0), asset) };
      }),
      shareBps: this.config.REFERRAL_SHARE_BPS,
    };
  }

  // Код создаётся при первом заходе в раздел «Пригласить друзей».
  private async ensureCode(userId: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const [user] = await this.db.select({ code: users.referralCode }).from(users).where(eq(users.id, userId));
      if (!user) throw new AppError('unauthorized', 'User not found');
      if (user.code) return user.code;
      try {
        await this.db
          .update(users)
          .set({ referralCode: newCode() })
          .where(and(eq(users.id, userId), isNull(users.referralCode)));
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    throw new Error('Could not allocate a referral code');
  }
}
