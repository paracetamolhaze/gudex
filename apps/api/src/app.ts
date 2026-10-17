import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ASSET_DECIMALS, type AppConfigDto, DEPOSIT_NETWORKS, NETWORKS, type ServiceNoticeDto, WALLET_ASSETS } from '@gudex/shared';
import type { Config } from './config';
import type { Db } from './db/client';
import type { DepositProvider } from './deposits/provider';
import { AppError } from './lib/errors';
import { DbKycDocumentStore } from './kyc/document-store';
import type { MockUpayPartner } from './partner/mock';
import type { CardPartner } from './partner/types';
import type { UpayClient } from './partner/upay/client';
import type { JobHandler } from './queue/queue';
import { accountRoutes, profileRoutes } from './routes/account';
import { authRoutes, securityRoutes } from './routes/auth';
import { cardRoutes } from './routes/cards';
import { cardBillingRoutes } from './routes/card-billing';
import { devRoutes } from './routes/dev';
import { moneyRoutes } from './routes/money';
import { opsRoutes } from './routes/ops';
import { adminRoutes } from './routes/admin';
import { telegramRoutes } from './routes/telegram';
import { ActivityService } from './services/activity';
import { AuthService } from './services/auth';
import { CardService } from './services/cards';
import { CardBillingService } from './services/card-billing';
import { ExchangeService } from './services/exchange';
import { KycService } from './services/kyc';
import { NoticeService } from './services/notice';
import { NotificationService } from './services/notify';
import { AdminNotificationService } from './services/admin-notify';
import { ManualAdminService } from './services/manual-admin';
import { ReferralService } from './services/referrals';
import { TransferService } from './services/transfers';
import { WalletService } from './services/wallet';
import { DepositInvoiceService } from './services/deposit-invoices';
import { depositInvoiceRoutes } from './routes/deposit-invoices';
import type { NativeDepositInvoices } from './partner/upay/deposit-invoices';
import { WithdrawalService } from './services/withdrawals';
import type { BotApi } from './telegram/bot';
import { BotService } from './telegram/bot-service';
import type { WithdrawalProvider } from './withdrawals/provider';

export interface Deps {
  config: Config;
  db: Db;
  partner: CardPartner;
  depositProvider: DepositProvider;
  withdrawalProvider: WithdrawalProvider;
  bot: BotApi;
  // Есть только когда партнёр — заглушка: нужен dev-эндпоинту «симулировать покупку».
  mockPartner?: MockUpayPartner;
  upay?: UpayClient;
  cardBilling?: CardBillingService;
  depositInvoices?: NativeDepositInvoices;
}

export interface Services {
  auth: AuthService;
  kyc: KycService;
  wallet: WalletService;
  depositInvoices: DepositInvoiceService;
  withdrawals: WithdrawalService;
  transfers: TransferService;
  referrals: ReferralService;
  notices: NoticeService;
  exchange: ExchangeService;
  cards: CardService;
  cardBilling: CardBillingService;
  activity: ActivityService;
  notifications: NotificationService;
  adminNotifications: AdminNotificationService;
  manualAdmin: ManualAdminService;
  bot: BotService;
}

export function createServices(deps: Deps): Services {
  const { config, db, partner } = deps;
  const auth = new AuthService(db, config);
  const notices = new NoticeService(db);
  const wallet = new WalletService(db, deps.depositProvider, config.MIN_DEPOSIT);
  const cards = new CardService(db, config, partner);
  return {
    auth,
    kyc: new KycService(db, partner, config.KYC_POLL_SECONDS, new DbKycDocumentStore(db, config.appSecret, config.KYC_DOCUMENT_TTL_SECONDS), {
      live: config.CARD_PARTNER === 'upay', enabled: config.CARD_PARTNER !== 'upay' || config.UPAY_KYC_ENABLED,
      requireSelfie: config.UPAY_KYC_REQUIRE_SELFIE,
      manual: config.CARD_ISSUANCE_MODE === 'manual', adminTelegramIds: config.adminTelegramIds,
    }),
    wallet,
    depositInvoices: new DepositInvoiceService(db, config.appSecret, deps.depositInvoices,
      (tx, input) => wallet.creditInvoice(tx, input), { enabled: config.UPAY_INVOICE_DEPOSITS_ENABLED, live: config.CARD_PARTNER === 'upay' && !config.DEV_TOOLS }),
    withdrawals: new WithdrawalService(db, config, deps.withdrawalProvider),
    transfers: new TransferService(db),
    referrals: new ReferralService(db, config),
    notices,
    exchange: new ExchangeService(config, wallet),
    cards,
    cardBilling: deps.cardBilling ?? new CardBillingService(db, config, deps.upay),
    activity: new ActivityService(db),
    notifications: new NotificationService(db, deps.bot, config.publicUrl),
    adminNotifications: new AdminNotificationService(db, deps.bot, config),
    manualAdmin: new ManualAdminService(db, config, deps.upay, cards),
    bot: new BotService(deps.bot, config, auth, notices),
  };
}

export function jobHandlers(services: Services): Record<string, JobHandler> {
  return {
    ...services.kyc.handlers(),
    ...services.depositInvoices.handlers(),
    ...services.cards.handlers(),
    ...services.withdrawals.handlers(),
    ...services.notifications.handlers(),
    ...services.adminNotifications.handlers(),
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    unlocked: boolean;
  }
}

export interface BuildOptions {
  // Вызывается после каждого ответа. На Vercel так запускается обработка очереди (нет постоянного воркера).
  onResponse?: () => void;
  drainJobs?: () => Promise<number>;
}

export async function buildApp(deps: Deps, services: Services, options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
      // Токены и реквизиты карт не должны попадать в логи.
      redact: ['req.headers.authorization', 'req.headers["x-confirmation-token"]', 'res.body'],
    },
  });

  await app.register(cors, { origin: true });
  app.decorateRequest('userId', '');
  app.decorateRequest('unlocked', false);
  if (options.onResponse) app.addHook('onResponse', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    if (reply.statusCode >= 400) return;
    if (path === '/health' || path === '/v1/config' || path.startsWith('/v1/ops/') || path === '/v1/telegram/status') return;
    options.onResponse!();
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...err.details } });
    }
    // Ошибки разбора запроса от Fastify (неверный JSON, неподдерживаемый Content-Type) — это 4xx, а не сбой сервера.
    const { validation, statusCode } = err as { validation?: unknown; statusCode?: number };
    if (validation || (statusCode && statusCode >= 400 && statusCode < 500)) {
      return reply.status(statusCode ?? 400).send({ error: { code: 'validation', message: (err as Error).message } });
    }
    request.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal error' } });
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/v1/config', async (): Promise<AppConfigDto> => {
    const { config } = deps;
    return {
      assets: WALLET_ASSETS.map((asset) => ({
        asset,
        decimals: ASSET_DECIMALS[asset],
        networks: DEPOSIT_NETWORKS[asset].map((id) => ({
          id,
          name: NETWORKS[id].name,
          short: NETWORKS[id].short,
          withdrawFee: config.withdrawFees[id],
          minWithdraw: config.withdrawMin[id],
        })),
        minDeposit: config.MIN_DEPOSIT,
      })),
      card: {
        productName: config.CARD_PRODUCT_NAME,
        issueFeeUsd: config.CARD_ISSUE_FEE_USD,
        topupFeeBps: config.CARD_TOPUP_FEE_BPS,
        minTopupUsd: config.CARD_MIN_TOPUP_USD,
        maxCardsPerUser: config.MAX_CARDS_PER_USER,
        limits: {
          perTransactionUsd: config.CARD_LIMIT_TX_USD ?? null,
          dailyUsd: config.CARD_LIMIT_DAY_USD ?? null,
          monthlyUsd: config.CARD_LIMIT_MONTH_USD ?? null,
        },
      },
      referral: { shareBps: config.REFERRAL_SHARE_BPS },
      links: {
        site: config.SITE_URL,
        support: config.supportUsername,
        channel: config.channelUsername,
      },
      exchange: { provider: 'whitebird', ready: services.exchange.ready },
      devTools: config.DEV_TOOLS,
      integration: {
        cardPartner: config.CARD_PARTNER,
        issuanceMode: config.CARD_ISSUANCE_MODE,
        upayConfigured: Boolean(config.UPAY_LOGIN && config.UPAY_PASSWORD && config.UPAY_TOTP_SECRET),
        upayWritesEnabled: config.CARD_PARTNER === 'upay' && config.UPAY_WRITES_ENABLED,
        deposits: services.depositInvoices.ready ? 'live' : deps.depositProvider.mode,
        depositFlow: services.depositInvoices.ready ? 'checkout' : deps.depositProvider.mode === 'disabled' ? 'disabled' : 'address',
        depositInvoiceRead: services.depositInvoices.canReconcile,
        withdrawals: config.DEV_TOOLS ? 'demo' : 'disabled',
        capabilities: {
          kyc: config.CARD_ISSUANCE_MODE === 'manual' || config.CARD_PARTNER !== 'upay' || config.UPAY_KYC_ENABLED,
          issue: config.CARD_ISSUANCE_MODE === 'manual' || config.CARD_PARTNER !== 'upay' || config.UPAY_WRITES_ENABLED,
          topup: config.CARD_PARTNER !== 'upay' || config.UPAY_WRITES_ENABLED,
          freeze: config.CARD_PARTNER !== 'upay' || config.UPAY_WRITES_ENABLED,
        },
      },
    };
  });

  // Объявление о сбоях — без входа: плашку видно даже если вход не работает.
  app.get('/v1/notice', async (): Promise<ServiceNoticeDto> => services.notices.get());

  await app.register(authRoutes(services), { prefix: '/v1' });
  await app.register(securityRoutes(services), { prefix: '/v1' });
  await app.register(profileRoutes(deps, services), { prefix: '/v1' });
  await app.register(accountRoutes(services), { prefix: '/v1' });
  await app.register(depositInvoiceRoutes(services), { prefix: '/v1' });
  await app.register(cardRoutes(services), { prefix: '/v1' });
  await app.register(cardBillingRoutes(services), { prefix: '/v1' });
  await app.register(moneyRoutes(deps, services), { prefix: '/v1' });
  await app.register(telegramRoutes(deps, services.bot), { prefix: '/v1' });
  await app.register(opsRoutes(deps, services, options.drainJobs), { prefix: '/v1/ops' });
  await app.register(adminRoutes(services), { prefix: '/v1/admin' });
  if (deps.config.DEV_TOOLS) await app.register(devRoutes(deps, services), { prefix: '/v1/dev' });

  return app;
}
