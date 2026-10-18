import { eq } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db, DbOrTx } from '../db/client';
import { adminNotifications, users } from '../db/schema';
import { enqueue, PermanentJobError, type JobContext, type JobHandler } from '../queue/queue';
import type { BotApi } from '../telegram/bot';

type Stage = 'verification' | 'issuance' | 'card_request';
type AdminConfig = Pick<Config, 'adminTelegramIds' | 'publicUrl'>;

// The caller passes its business transaction, so a rolled-back application cannot notify an administrator.
export async function notifyAdmins(
  db: DbOrTx,
  config: Pick<Config, 'adminTelegramIds'>,
  input: { userId: string; eventKey: string; stage: Stage },
): Promise<void> {
  for (const recipient of new Set(config.adminTelegramIds)) {
    const [notification] = await db.insert(adminNotifications).values({
      ...input,
      recipientTelegramId: BigInt(recipient),
    }).onConflictDoNothing().returning({ id: adminNotifications.id });
    if (!notification) continue;
    await enqueue(db, 'admin.notify', { notificationId: notification.id }, {
      dedupeKey: `admin.notify:${notification.id}`,
      maxAttempts: 5,
    });
  }
}

const STAGES: Record<Stage, string> = { verification: 'Верификация', issuance: 'Выпуск карты', card_request: 'Пополнение или заморозка карты' };

export class AdminNotificationService {
  constructor(
    private readonly db: Db,
    private readonly bot: BotApi,
    private readonly config: AdminConfig,
  ) {}

  handlers(): Record<string, JobHandler> {
    return {
      'admin.notify': {
        run: (payload: { notificationId: string }, context?: JobContext) => this.send(payload.notificationId, context),
      },
    };
  }

  private async send(notificationId: string, context?: JobContext): Promise<void> {
    await this.db.transaction(async tx => {
      // Serializes duplicate jobs for this outbox row; successful notifications survive job re-enqueueing.
      const [notification] = await tx.select().from(adminNotifications)
        .where(eq(adminNotifications.id, notificationId)).for('update');
      if (!notification || notification.sentAt) return;
      if (!this.config.adminTelegramIds.includes(notification.recipientTelegramId.toString())) return;
      const stage = STAGES[notification.stage as Stage];
      if (!stage) throw new PermanentJobError('Unknown administrator notification stage');
      const [user] = await tx.select({ id: users.id, telegramId: users.telegramId }).from(users)
        .where(eq(users.id, notification.userId));
      if (!user) return;

      // No documents, names, contact details, card credentials or verification codes leave through Telegram.
      const text = `<b>Новая заявка</b>\nКлиент GUDEX: <code>${user.id}</code>\nTelegram ID: <code>${user.telegramId}</code>\nЭтап: ${stage}`;
      // No button: the administrator opens the admin screen from their own profile in the Mini App.
      await context?.assertActive();
      await this.bot.sendMessage(notification.recipientTelegramId, text);
      await tx.update(adminNotifications).set({ sentAt: new Date() }).where(eq(adminNotifications.id, notification.id));
    });
  }
}
