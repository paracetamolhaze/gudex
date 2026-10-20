import { and, eq, isNull } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import { cards, users } from '../db/schema';
import { enqueue, type JobHandler } from '../queue/queue';
import type { BotApi, WebAppButton } from '../telegram/bot';

// Уведомления в Telegram от имени бота. Ставятся в очередь в той же транзакции, что и событие,
// поэтому сообщение уйдёт, только если деньги действительно проведены.

export type NotifyEvent =
  | { type: 'deposit'; amount: string; asset: string; network: string }
  | { type: 'card_issued'; last4: string }
  | { type: 'card_failed'; amount: string; asset: string; sponsored?: boolean; additionalAttempt?: boolean }
  | { type: 'topup_succeeded'; last4: string; netUsd: string }
  | { type: 'topup_failed'; amount: string; asset: string }
  | { type: 'card_purchase'; last4: string; merchant: string; amountUsd: string; balanceUsd: string }
  | { type: 'card_refund'; last4: string; merchant: string; amountUsd: string; balanceUsd: string }
  | { type: 'withdrawal_sent'; amount: string; asset: string; network: string; address: string }
  | { type: 'withdrawal_failed'; amount: string; asset: string }
  | { type: 'transfer_received'; amount: string; asset: string; from: string }
  | { type: 'kyc_approved' }
  | { type: 'kyc_rejected' }
  | { type: 'application_received'; amount: string; asset: string; sponsored?: boolean }
  | { type: 'fee_paid'; amount: string; asset: string; missing?: string; minutesLeft?: number }
  | { type: 'application_paid'; amount: string; asset: string }
  | { type: 'application_rejected'; reason: string; amount?: string; asset?: string; sponsored?: boolean }
  | { type: 'support_reply' };

export async function notify(db: DbOrTx, userId: string, event: NotifyEvent): Promise<void> {
  await enqueue(db, 'notify', { userId, event }, { maxAttempts: 5 });
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const shortAddress = (a: string) => (a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

const MESSAGES: Record<'ru' | 'en', (e: NotifyEvent) => string> = {
  ru: (e) => {
    switch (e.type) {
      case 'deposit':
        return `✅ Зачислено <b>${e.amount} ${e.asset}</b> (${e.network})`;
      case 'card_issued':
        return `💳 Карта •• ${e.last4} выпущена и готова к использованию`;
      case 'card_failed':
        if (e.additionalAttempt) return 'Дополнительная попытка выпуска не завершилась. Средства с вашего баланса не списывались.';
        return e.sponsored
          ? 'Не удалось выпустить карту. Средства с вашего баланса не списывались; покрытие выпуска брокером снова доступно.'
          : `Не удалось выпустить карту. ${e.amount} ${e.asset} вернулись на баланс.`;
      case 'topup_succeeded':
        return `⬆️ Карта •• ${e.last4} пополнена на <b>$${e.netUsd}</b>`;
      case 'topup_failed':
        return `Пополнение карты не прошло. ${e.amount} ${e.asset} вернулись на баланс.`;
      case 'card_purchase':
        return `🛍 ${escape(e.merchant)}: <b>−$${e.amountUsd}</b>\nКарта •• ${e.last4}, баланс $${e.balanceUsd}`;
      case 'card_refund':
        return `↩️ Возврат от ${escape(e.merchant)}: <b>+$${e.amountUsd}</b>\nКарта •• ${e.last4}, баланс $${e.balanceUsd}`;
      case 'withdrawal_sent':
        return `↗️ Вывод <b>${e.amount} ${e.asset}</b> отправлен на ${shortAddress(e.address)} (${e.network})`;
      case 'withdrawal_failed':
        return `Вывод не выполнен. ${e.amount} ${e.asset} вернулись на баланс.`;
      case 'transfer_received':
        return `💸 Перевод от ${escape(e.from)}: <b>+${e.amount} ${e.asset}</b>`;
      case 'kyc_approved':
        return '✅ Верификация пройдена - можно выпускать карту.';
      case 'kyc_rejected':
        return 'Верификация не пройдена. Откройте приложение, чтобы попробовать снова.';
      case 'fee_paid':
        return e.missing ? `Получено <b>${e.amount} ${e.asset}</b>. Для выпуска не хватает ${e.missing} ${e.asset} - ${e.minutesLeft
          ? `отправьте их на тот же адрес в течение ${e.minutesLeft} мин.` : 'откройте приложение, чтобы доплатить.'}`
          : `✅ Получено <b>${e.amount} ${e.asset}</b> на оплату выпуска. Откройте приложение, чтобы продолжить.`;
      case 'application_paid':
        return `✅ <b>Оплата получена</b>: ${e.amount} ${e.asset}.
Ожидайте проверки данных. Мы напишем, когда карта будет готова.`;
      case 'application_received':
        return ['📝 <b>Данные отправлены на проверку</b>', 'Ожидайте проверки данных - мы напишем, когда карта будет готова.',
          ...(e.sponsored ? [] : [`За выпуск зарезервировано ${e.amount} ${e.asset}.`])].join('\n');
      case 'application_rejected':
        return [`Верификация не пройдена: ${escape(e.reason)}`,
          ...(e.amount && e.asset && !e.sponsored ? [`${e.amount} ${e.asset} вернулись на баланс.`] : []),
          'Откройте приложение, чтобы отправить данные заново.'].join('\n');
      case 'support_reply':
        return '💬 <b>Поддержка GUDEX ответила</b>\nОткройте приложение: «Профиль» › «Поддержка».';
    }
  },
  en: (e) => {
    switch (e.type) {
      case 'deposit':
        return `✅ <b>${e.amount} ${e.asset}</b> credited (${e.network})`;
      case 'card_issued':
        return `💳 Card •• ${e.last4} is issued and ready to use`;
      case 'card_failed':
        if (e.additionalAttempt) return 'The additional issuance attempt did not complete. Your balance was not charged.';
        return e.sponsored
          ? 'Card could not be issued. Your balance was not charged; broker coverage is available again.'
          : `Card could not be issued. ${e.amount} ${e.asset} returned to your balance.`;
      case 'topup_succeeded':
        return `⬆️ Card •• ${e.last4} topped up with <b>$${e.netUsd}</b>`;
      case 'topup_failed':
        return `Card top-up failed. ${e.amount} ${e.asset} returned to your balance.`;
      case 'card_purchase':
        return `🛍 ${escape(e.merchant)}: <b>−$${e.amountUsd}</b>\nCard •• ${e.last4}, balance $${e.balanceUsd}`;
      case 'card_refund':
        return `↩️ Refund from ${escape(e.merchant)}: <b>+$${e.amountUsd}</b>\nCard •• ${e.last4}, balance $${e.balanceUsd}`;
      case 'withdrawal_sent':
        return `↗️ Withdrawal of <b>${e.amount} ${e.asset}</b> sent to ${shortAddress(e.address)} (${e.network})`;
      case 'withdrawal_failed':
        return `Withdrawal failed. ${e.amount} ${e.asset} returned to your balance.`;
      case 'transfer_received':
        return `💸 Transfer from ${escape(e.from)}: <b>+${e.amount} ${e.asset}</b>`;
      case 'kyc_approved':
        return '✅ You are verified - you can now get a card.';
      case 'kyc_rejected':
        return 'Verification failed. Open the app to try again.';
      case 'fee_paid':
        return e.missing ? `Received <b>${e.amount} ${e.asset}</b>. ${e.missing} ${e.asset} is still missing for the card - ${e.minutesLeft
          ? `send it to the same address within ${e.minutesLeft} min.` : 'open the app to pay the rest.'}`
          : `✅ Received <b>${e.amount} ${e.asset}</b> for the card. Open the app to continue.`;
      case 'application_paid':
        return `✅ <b>Payment received</b>: ${e.amount} ${e.asset}.
Please wait while we check your details. We will message you when the card is ready.`;
      case 'application_received':
        return ['📝 <b>Details sent for review</b>', "Please wait while we check your details - we'll message you when the card is ready.",
          ...(e.sponsored ? [] : [`${e.amount} ${e.asset} is reserved for the issuance fee.`])].join('\n');
      case 'application_rejected':
        return [`Verification declined: ${escape(e.reason)}`,
          ...(e.amount && e.asset && !e.sponsored ? [`${e.amount} ${e.asset} returned to your balance.`] : []),
          'Open the app to submit your details again.'].join('\n');
      case 'support_reply':
        return '💬 <b>GUDEX support has replied</b>\nOpen the app: “Profile” › “Support”.';
    }
  },
};

// Одно напоминание новичку, который зарегистрировался, но карту так и не выпустил.
const CARD_REMINDER = {
  ru: [
    '💳 <b>Ваша карта GUDEX почти готова</b>',
    '',
    'Осталась пара шагов:',
    '1️⃣ Пройдите верификацию',
    '2️⃣ Оплатите выпуск в USDT или USDC',
    '3️⃣ Дождитесь проверки - мы напишем, когда карта будет готова',
    '',
    'Нажмите «Открыть GUDEX» 👇',
  ].join('\n'),
  en: [
    '💳 <b>Your GUDEX card is almost ready</b>',
    '',
    'Just a few steps left:',
    '1️⃣ Get verified',
    '2️⃣ Pay the issuance fee in USDT or USDC',
    '3️⃣ Wait for our review - we’ll message you when the card is ready',
    '',
    'Tap “Open GUDEX” 👇',
  ].join('\n'),
};

export class NotificationService {
  constructor(
    private readonly db: Db,
    private readonly bot: BotApi,
    private readonly publicUrl: string | null,
  ) {}

  handlers(): Record<string, JobHandler> {
    return {
      notify: { run: (p: { userId: string; event: NotifyEvent }) => this.send(p.userId, p.event) },
      'reminder.card': { run: (p: { userId: string }) => this.cardReminder(p.userId) },
    };
  }

  private button(locale: 'ru' | 'en'): WebAppButton | undefined {
    return this.publicUrl ? { text: locale === 'en' ? 'Open GUDEX' : 'Открыть GUDEX', url: this.publicUrl } : undefined;
  }

  private async cardReminder(userId: string): Promise<void> {
    const [card] = await this.db.select({ id: cards.id }).from(cards).where(eq(cards.userId, userId)).limit(1);
    if (card) return;
    // Отметка и отправка в одной транзакции: не дошло сообщение — отметка откатится и задача повторится.
    await this.db.transaction(async (tx) => {
      const [user] = await tx
        .update(users)
        .set({ cardReminderSentAt: new Date() })
        .where(and(eq(users.id, userId), isNull(users.cardReminderSentAt)))
        .returning({ telegramId: users.telegramId, locale: users.locale });
      if (!user) return;
      const locale = user.locale === 'en' ? 'en' : 'ru';
      const text = CARD_REMINDER[locale];
      if (this.publicUrl) await this.bot.sendPhoto(user.telegramId, `${this.publicUrl}/mascot/bot-reminder.jpg`, text, this.button(locale));
      else await this.bot.sendMessage(user.telegramId, text);
    });
  }

  private async send(userId: string, event: NotifyEvent): Promise<void> {
    const [user] = await this.db.select({ telegramId: users.telegramId, locale: users.locale }).from(users).where(eq(users.id, userId));
    if (!user) return;
    const locale = user.locale === 'en' ? 'en' : 'ru';
    await this.bot.sendMessage(user.telegramId, MESSAGES[locale](event), this.button(locale));
  }
}
