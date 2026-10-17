import { z } from 'zod';
import { type Network, NETWORK_IDS, toMinor } from '@gudex/shared';

// Пустая строка в .env (TELEGRAM_BOT_TOKEN=) считается «не задано».
const optional = () =>
  z
    .string()
    .optional()
    .transform((v) => v || undefined);

const flag = (fallback: 'true' | 'false') =>
  z
    .string()
    .default(fallback)
    .transform((v) => v === 'true');

const schema = z
  .object({
    PORT: z.coerce.number().default(4100),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_URL: z.string().min(1),
    DATABASE_URL_UNPOOLED: optional(),
    POSTGRES_URL_NON_POOLING: optional(),
    LIVE_DATABASE_SETUP_ENABLED: flag('false'),
    // Токен бота из @BotFather. Из него же выводятся ключи подписи сессий и секрет вебхука.
    TELEGRAM_BOT_TOKEN: optional(),
    // Запасной секрет для локальной разработки без бота.
    JWT_SECRET: optional(),
    // Публичный адрес Mini App (https://...). На Vercel берётся из VERCEL_PROJECT_PRODUCTION_URL.
    PUBLIC_URL: optional(),
    VERCEL_PROJECT_PRODUCTION_URL: optional(),
    VERCEL: optional(),
    // Тестовый режим: кнопки «симулировать пополнение/покупку».
    DEV_TOOLS: flag('false'),
    // Вход без Telegram (POST /v1/auth/dev) — только для локальной разработки, на Vercel запрещён.
    DEV_LOGIN: flag('false'),
    CARD_PARTNER: z.enum(['mock', 'upay']).default('mock'),
    UPAY_BASE_URL: z.literal('https://broker-admin.upay.plus/api/v1').default('https://broker-admin.upay.plus/api/v1'),
    UPAY_LOGIN: optional(),
    UPAY_PASSWORD: optional(),
    UPAY_TOTP_SECRET: optional(),
    UPAY_PAYMENT_PASSWORD: optional(),
    UPAY_PRODUCT_ID: z.string().min(1).default('2040769880440840193'),
    UPAY_CUSTOMER_GROUP_ID: optional(),
    UPAY_WRITES_ENABLED: flag('false'),
    UPAY_KYC_ENABLED: flag('false'),
    UPAY_INVOICE_DEPOSITS_ENABLED: flag('false'),
    UPAY_KYC_REQUIRE_SELFIE: flag('false'),
    KYC_DOCUMENT_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(86400),
    UPAY_DEVICE_ID: z.string().min(8).max(200).default('WEB-GUDEX-Automation/1'),
    UPAY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(25000).default(8000),
    UPAY_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
    // Server-to-server access for diagnostics and queue wakeups. Never sent to the Mini App.
    OPS_API_TOKEN: optional(),
    CRON_SECRET: optional(),
    JOB_DRAIN_MS: z.coerce.number().int().min(1000).max(45000).default(20000),
    JOB_POLL_MS: z.coerce.number().int().min(100).max(60000).default(1000),
    CARD_PRODUCT_NAME: z.string().default('GUDEX Visa'),
    CARD_ISSUE_FEE_USD: z.string().default('10'),
    CARD_TOPUP_FEE_BPS: z.coerce.number().int().min(0).max(10000).default(150),
    CARD_MIN_TOPUP_USD: z.string().default('10'),
    MAX_CARDS_PER_USER: z.coerce.number().int().min(1).default(3),
    MIN_DEPOSIT: z.string().default('1'),
    // Лимиты карты у эмитента — только для показа в тарифах. Пусто — строка не показывается.
    CARD_LIMIT_TX_USD: optional(),
    CARD_LIMIT_DAY_USD: optional(),
    CARD_LIMIT_MONTH_USD: optional(),
    // Вывод на внешний кошелёк: комиссия сети и минимальная сумма, по сетям («СЕТЬ:сумма» через запятую).
    WITHDRAW_FEES: z.string().default('TON:0.3,TRC20:2,BEP20:0.5,POLYGON:0.5,ERC20:5'),
    WITHDRAW_MIN: z.string().default('TON:5,TRC20:10,BEP20:5,POLYGON:5,ERC20:20'),
    // Доля пригласившего от комиссий GUDEX с операций приглашённого, в базисных пунктах (2000 = 20%).
    REFERRAL_SHARE_BPS: z.coerce.number().int().min(0).max(10000).default(2000),
    // @ник бота без @: из него строится ссылка-приглашение.
    BOT_USERNAME: z.string().default('gudex_card_bot'),
    SITE_URL: z.string().default('https://gudexchange.com'),
    // Обменник WhiteBird внутри приложения (покупка крипты). Включается, когда задан WHITEBIRD_MERCHANT_ID.
    WHITEBIRD_SDK_URL: z.string().default('https://sdk.whitebird.io/v2.0/integration/wbExchangeSdk-v001.js'),
    WHITEBIRD_MERCHANT_ID: optional(),
    // Не секрет: basic-токен для AuthMode, виден клиенту. Для TokensMode/session нужен серверный x-api-key (позже).
    WHITEBIRD_MERCHANT_PASS: optional(),
    WHITEBIRD_MODE: z.enum(['AuthMode', 'LoginMode', 'TokensMode']).default('AuthMode'),
    WHITEBIRD_COLOR: optional(),
    // @ник поддержки и канала (без @). Пусто — кнопки и ссылки не показываются.
    SUPPORT_USERNAME: optional(),
    CHANNEL_USERNAME: optional(),
    // Напоминание новичку, который так и не выпустил карту: через сколько минут после регистрации. 0 — выключено.
    CARD_REMINDER_MINUTES: z.coerce.number().int().min(0).default(45),
    // Telegram ID через запятую: им доступны команды бота /notice (объявление о сбоях).
    ADMIN_TELEGRAM_IDS: optional(),
    MOCK_PARTNER_DELAY_MS: z.coerce.number().int().min(0).default(1500),
    KYC_MOCK_DELAY_MS: z.coerce.number().int().min(0).default(3000),
    KYC_POLL_SECONDS: z.coerce.number().min(0.5).default(2),
  })
  .refine((c) => c.TELEGRAM_BOT_TOKEN || (c.JWT_SECRET && c.JWT_SECRET.length >= 16), {
    message: 'Set TELEGRAM_BOT_TOKEN (or JWT_SECRET for local development)',
  });

export type Config = z.infer<typeof schema> & {
  appSecret: string;
  publicUrl: string | null;
  devLogin: boolean;
  withdrawFees: Record<Network, string>;
  withdrawMin: Record<Network, string>;
  adminTelegramIds: string[];
  supportUsername: string | null;
  channelUsername: string | null;
};

// "TON:0.3,TRC20:2" → { TON: '0.3', TRC20: '2', ... }. Каждая сеть обязана быть указана.
function perNetwork(name: string, value: string): Record<Network, string> {
  const map = Object.fromEntries(
    value.split(',').map((pair) => {
      const [network, amount] = pair.split(':').map((part) => part.trim());
      return [network, amount];
    }),
  );
  for (const network of NETWORK_IDS) {
    const amount = map[network];
    if (!amount) throw new Error(`${name}: no value for ${network}`);
    toMinor(amount, 'USDT');
  }
  return map as Record<Network, string>;
}

const username = (value: string | undefined) => value?.replace(/^@/, '').trim() || null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  if (parsed.OPS_API_TOKEN && parsed.OPS_API_TOKEN.length < 32) throw new Error('OPS_API_TOKEN must contain at least 32 characters');
  if (parsed.CARD_PARTNER === 'upay' && parsed.DEV_TOOLS) throw new Error('Disable DEV_TOOLS before selecting the live UPay partner');
  if (parsed.CARD_PARTNER === 'upay' && !(parsed.UPAY_LOGIN && parsed.UPAY_PASSWORD && parsed.UPAY_TOTP_SECRET)) {
    throw new Error('UPay requires UPAY_LOGIN, UPAY_PASSWORD and UPAY_TOTP_SECRET');
  }
  if (parsed.UPAY_WRITES_ENABLED && !/^\d{6}$/.test(parsed.UPAY_PAYMENT_PASSWORD ?? '')) throw new Error('UPAY_WRITES_ENABLED requires a six digit UPAY_PAYMENT_PASSWORD');
  const publicUrl =
    parsed.PUBLIC_URL ?? (parsed.VERCEL_PROJECT_PRODUCTION_URL ? `https://${parsed.VERCEL_PROJECT_PRODUCTION_URL}` : null);
  return {
    ...parsed,
    appSecret: parsed.TELEGRAM_BOT_TOKEN ?? parsed.JWT_SECRET!,
    publicUrl,
    devLogin: parsed.DEV_LOGIN && !parsed.VERCEL,
    withdrawFees: perNetwork('WITHDRAW_FEES', parsed.WITHDRAW_FEES),
    withdrawMin: perNetwork('WITHDRAW_MIN', parsed.WITHDRAW_MIN),
    adminTelegramIds: (parsed.ADMIN_TELEGRAM_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean),
    supportUsername: username(parsed.SUPPORT_USERNAME),
    channelUsername: username(parsed.CHANNEL_USERNAME),
  };
}
