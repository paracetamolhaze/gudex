import type { Config } from '../config';
import { AppError } from '../lib/errors';
import { type AuthService, deriveSecret } from '../services/auth';
import type { NoticeService } from '../services/notice';
import type { BotApi } from './bot';
import type { TelegramUser } from './init-data';

interface Update {
  message?: {
    chat: { id: number };
    from?: TelegramUser;
    text?: string;
  };
}

const RU = ['ru', 'uk', 'be', 'kk', 'ky', 'uz', 'tg', 'az', 'hy'];

// Лимиты Telegram на длину описаний.
const DESCRIPTION_MAX = 512;
const SHORT_MAX = 120;

type Line = string | null;
const lines = (items: Line[]) => items.filter((line): line is string => line !== null);

// Короткое описание (профиль бота, превью ссылки) — убираем необязательные строки, пока не влезет в лимит.
function fit(required: string, optional: Line[]): string {
  const rest = lines(optional);
  while (rest.length > 0 && [required, ...rest].join('\n').length > SHORT_MAX) rest.pop();
  return [required, ...rest].join('\n');
}

// Полное описание: первый вариант, который влезает в лимит (длинные @ники могут не поместиться).
function firstFitting(variants: Line[][]): string {
  const texts = variants.map((variant) => lines(variant).join('\n'));
  return texts.find((text) => text.length <= DESCRIPTION_MAX) ?? texts[texts.length - 1]!;
}

interface DescriptionTexts {
  intro: string[];
  site: string;
  channel: string | null;
  support: string | null;
  supportWarning: string;
  cta: string;
}

function description(t: DescriptionTexts): string {
  const variant = (warning: boolean, channel: boolean): Line[] => [
    ...t.intro,
    '',
    t.site,
    channel ? t.channel : null,
    t.support && (warning ? `${t.support} ${t.supportWarning}` : t.support),
    '',
    t.cta,
  ];
  return firstFitting([variant(true, true), variant(false, true), variant(false, false)]);
}

export function botDescriptions(config: Config): Record<string, { description: string; short: string }> {
  const site = config.SITE_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const channel = config.channelUsername ? `@${config.channelUsername}` : null;
  const support = config.supportUsername ? `@${config.supportUsername}` : null;

  const ru = {
    description: description({
      intro: [
        'GUDEX - криптокарта Visa для покупок по всему миру.',
        '',
        'С GUDEX вы можете:',
        '✔️ Пополнять карту в USDT и USDC',
        '✔️ Выпустить виртуальную карту Visa прямо в Telegram',
        '✔️ Добавить карту в Apple Pay и Google Pay',
        '✔️ Оплачивать покупки и подписки онлайн и офлайн по всему миру',
      ],
      site: `🔗 Сайт: ${site}`,
      channel: channel && `📢 Канал: ${channel}`,
      support: support && `🆘 Поддержка: ${support}`,
      supportWarning: '- она никогда не пишет первой',
      cta: 'Нажмите «Открыть GUDEX» внизу 👇',
    }),
    short: fit('GUDEX - криптокарта Visa для покупок по всему миру', [
      support && `🆘 Помощь: ${support}`,
      `🔗 Сайт: ${site}`,
      channel && `📢 Канал: ${channel}`,
    ]),
  };
  const en = {
    description: description({
      intro: [
        'GUDEX is a crypto Visa card for spending anywhere in the world.',
        '',
        'With GUDEX you can:',
        '✔️ Top up the card with USDT and USDC',
        '✔️ Get a virtual Visa card right in Telegram',
        '✔️ Add the card to Apple Pay and Google Pay',
        '✔️ Pay for purchases and subscriptions online and in stores worldwide',
      ],
      site: `🔗 Website: ${site}`,
      channel: channel && `📢 Channel: ${channel}`,
      support: support && `🆘 Support: ${support}`,
      supportWarning: '- it never messages first',
      cta: 'Tap “Открыть GUDEX” below 👇',
    }),
    short: fit('GUDEX - crypto Visa card for spending worldwide', [
      support && `🆘 Support: ${support}`,
      `🔗 Website: ${site}`,
      channel && `📢 Channel: ${channel}`,
    ]),
  };
  // Только языки, на которые официально переведён Telegram, — остальным покажется английское.
  return { default: en, ...Object.fromEntries(['ru', 'uk', 'be', 'kk', 'uz'].map((code) => [code, ru])) };
}

// Приветствие после «Старт»: картинка с маскотом, коротко о возможностях и кнопка открытия приложения.
function welcome(ru: boolean, support: string | null): string {
  const lines = ru
    ? [
        '👋 <b>Добро пожаловать в GUDEX!</b>',
        '',
        'Криптокарта Visa прямо в Telegram:',
        '💳 Виртуальная карта Visa',
        '💸 Пополнение в USDT и USDC',
        '📱 Apple Pay и Google Pay',
        '🌍 Покупки и подписки по всему миру',
        '',
        'Нажмите «Открыть GUDEX», чтобы начать 👇',
      ]
    : [
        '👋 <b>Welcome to GUDEX!</b>',
        '',
        'A crypto Visa card right in Telegram:',
        '💳 Virtual Visa card',
        '💸 Top up with USDT and USDC',
        '📱 Apple Pay and Google Pay',
        '🌍 Purchases and subscriptions worldwide',
        '',
        'Tap “Open GUDEX” to get started 👇',
      ];
  if (support) lines.push('', ru ? `🆘 Поддержка: @${support}` : `🆘 Support: @${support}`);
  return lines.join('\n');
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Бот: приглашения через /start, служебные команды и одноразовая настройка вебхука, меню и описания.
export class BotService {
  readonly webhookSecret: string;

  constructor(
    private readonly bot: BotApi,
    private readonly config: Config,
    private readonly auth: AuthService,
    private readonly notices: NoticeService,
  ) {
    this.webhookSecret = deriveSecret(config.appSecret, 'gudex:webhook').toString('hex').slice(0, 48);
  }

  async handleUpdate(update: Update): Promise<void> {
    const message = update.message;
    const from = message?.from;
    if (!message || !from) return;
    const text = message.text?.trim() ?? '';
    const ru = RU.includes(from.language_code ?? 'ru');
    const [command = '', ...args] = text.split(/\s+/);

    // /start: регистрируем (с пригласившим, если пришли по ссылке /start ref_код) и приветствуем.
    if (command === '/start') {
      await this.auth.registerFromBot(from, args[0]);
      const text = welcome(ru, this.config.supportUsername);
      const url = this.config.publicUrl;
      if (url) await this.bot.sendPhoto(message.chat.id, `${url}/mascot/bot-welcome.jpg`, text, { text: ru ? 'Открыть GUDEX' : 'Open GUDEX', url });
      else await this.bot.sendMessage(message.chat.id, text);
      return;
    }

    // Узнать свой Telegram ID — нужен, чтобы выдать права администратора (ADMIN_TELEGRAM_IDS).
    if (command === '/id') {
      await this.bot.sendMessage(message.chat.id, `${ru ? 'Ваш Telegram ID' : 'Your Telegram ID'}: <code>${from.id}</code>`);
      return;
    }

    if (command === '/notice' && this.config.adminTelegramIds.includes(String(from.id))) {
      await this.bot.sendMessage(message.chat.id, await this.noticeCommand(text.slice('/notice'.length).trim()));
      return;
    }

    if (!this.config.publicUrl) return;
    await this.bot.sendMessage(message.chat.id, ru ? 'Всё управление картой - в приложении GUDEX. Вопрос? Напишите в «Профиль» › «Поддержка» 👇' : 'Everything is managed in the GUDEX app. Questions? Message us in “Profile” › “Support” 👇', {
      text: ru ? 'Открыть GUDEX' : 'Open GUDEX',
      url: this.config.publicUrl,
    });
  }

  // /notice — показать текущее объявление, /notice текст — включить, /notice off — убрать.
  private async noticeCommand(argument: string): Promise<string> {
    if (!argument) {
      const { message } = await this.notices.get();
      return message
        ? `Сейчас в приложении показано:\n\n${escape(message)}\n\nУбрать: <code>/notice off</code>`
        : 'Объявления нет.\n\nПоказать: <code>/notice Текст объявления</code>';
    }
    if (['off', 'выкл', '-'].includes(argument.toLowerCase())) {
      await this.notices.set(null);
      return '✅ Объявление убрано из приложения.';
    }
    await this.notices.set(argument);
    return `✅ Объявление показано в приложении:\n\n${escape(argument)}\n\nУбрать: <code>/notice off</code>`;
  }

  // Состояние вебхука у Telegram: сколько апдейтов ждут доставки и последняя ошибка.
  async status(): Promise<unknown> {
    const info = (await this.bot.call('getWebhookInfo', {})) as Record<string, unknown> | null;
    const me = (await this.bot.call('getMe', {})) as { username?: string } | null;
    return {
      bot: me?.username ?? null,
      url: info?.url ?? null,
      pendingUpdates: info?.pending_update_count ?? null,
      lastError: info?.last_error_message ?? null,
      lastErrorAt: typeof info?.last_error_date === 'number' ? new Date(info.last_error_date * 1000).toISOString() : null,
    };
  }

  // Направляет вебхук бота на этот сервер и ставит кнопку меню «GUDEX», открывающую Mini App.
  async setup() {
    const url = this.config.publicUrl;
    if (!url || !this.config.TELEGRAM_BOT_TOKEN) throw new AppError('validation', 'PUBLIC_URL and TELEGRAM_BOT_TOKEN are required');
    const webhook = `${url}/v1/telegram/webhook`;
    await this.bot.call('setWebhook', { url: webhook, secret_token: this.webhookSecret, allowed_updates: ['message'] });

    // Остальное — оформление: ошибка в одном шаге не должна мешать другим, поэтому собираем результаты.
    const steps: { step: string; error?: string }[] = [];
    const run = async (step: string, method: string, payload: object) => {
      try {
        await this.bot.call(method, payload);
        steps.push({ step });
      } catch (err) {
        steps.push({ step, error: (err as Error).message });
      }
    };
    await run('menu', 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть GUDEX', web_app: { url } } });
    // Описание видно в пустом чате до нажатия «Старт» («Что умеет этот бот?»), короткое — в профиле бота.
    for (const [language, texts] of Object.entries(botDescriptions(this.config))) {
      const lang = language === 'default' ? {} : { language_code: language };
      if (texts.description.length > DESCRIPTION_MAX) steps.push({ step: `description:${language}`, error: 'too long' });
      else await run(`description:${language}`, 'setMyDescription', { description: texts.description, ...lang });
      await run(`short:${language}`, 'setMyShortDescription', { short_description: texts.short, ...lang });
    }
    await run('commands:ru', 'setMyCommands', { commands: [{ command: 'start', description: 'Открыть GUDEX' }], language_code: 'ru' });
    await run('commands', 'setMyCommands', { commands: [{ command: 'start', description: 'Open GUDEX' }] });
    return { webhook, app: url, steps };
  }
}
