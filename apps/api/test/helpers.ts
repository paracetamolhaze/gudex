import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp, createServices, type Deps, jobHandlers, type Services } from '../src/app';
import { loadConfig } from '../src/config';
import { createDb, type Db } from '../src/db/client';
import { MockDepositProvider } from '../src/deposits/provider';
import type { DepositProvider } from '../src/deposits/provider';
import { MockUpayPartner } from '../src/partner/mock';
import type { CardPartner } from '../src/partner/types';
import { JobRunner } from '../src/queue/queue';
import { LogBotApi } from '../src/telegram/bot';
import { signInitData } from '../src/telegram/init-data';
import { MockWithdrawalProvider, type WithdrawalProvider } from '../src/withdrawals/provider';

export const TEST_BOT_TOKEN = '123456:TEST-bot-token-for-gudex';
export const TEST_PIN = '1234';

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  bot: LogBotApi;
  services: Services;
  runner: JobRunner;
  settle: () => Promise<void>;
  close: () => Promise<void>;
}

export async function createTestContext(
  makePartner?: (db: Db) => CardPartner,
  options: { withdrawalProvider?: WithdrawalProvider; depositProvider?: DepositProvider; env?: Record<string, string>; onResponse?: () => void } = {},
): Promise<TestContext> {
  const config = loadConfig({
    ...process.env,
    ADMIN_TELEGRAM_IDS: '999',
    REFERRAL_SHARE_BPS: '2000',
    PUBLIC_URL: 'https://gudex.test',
    DEV_TOOLS: 'true',
    CARD_ISSUE_FEE_USD: '10',
    CARD_TOPUP_FEE_BPS: '150',
    CARD_MIN_TOPUP_USD: '10',
    MAX_CARDS_PER_USER: '3',
    MOCK_PARTNER_DELAY_MS: '0',
    KYC_MOCK_DELAY_MS: '0',
    KYC_POLL_SECONDS: '1',
    ...options.env,
    TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN,
  });
  const { db, pool } = createDb(config.DATABASE_URL);
  await db.execute(sql`
    truncate users, biometric_tokens, kyc_profiles, ledger_accounts, ledger_transactions, ledger_entries,
      deposit_addresses, deposits, cards, card_operations, card_issue_sponsorships, card_transactions, jobs,
      withdrawals, transfers, referral_rewards, app_settings, kyc_documents, upay_submissions,
      mock_upay_customers, mock_upay_cards, mock_upay_recharges, mock_upay_transactions cascade
  `);
  const partner = makePartner ? makePartner(db) : new MockUpayPartner(db);
  const bot = new LogBotApi();
  const deps: Deps = { config, db, partner, mockPartner: partner instanceof MockUpayPartner ? partner : undefined, depositProvider: options.depositProvider ?? new MockDepositProvider(), withdrawalProvider: options.withdrawalProvider ?? new MockWithdrawalProvider(), bot };
  const services = createServices(deps);
  const runner = new JobRunner(db, jobHandlers(services));
  const app = await buildApp(deps, services, { onResponse: options.onResponse, drainJobs: () => runner.drain({ maxJobs: 50, maxDurationMs: 5000 }) });

  // Выполняет очередь до конца, «перематывая время» для отложенных задач и повторов.
  const settle = async () => {
    for (let i = 0; i < 50; i++) {
      await db.execute(sql`update jobs set run_at = now() where status = 'queued'`);
      const processed = await runner.drain();
      if (processed === 0) return;
    }
    throw new Error('Queue did not settle');
  };

  return {
    app,
    db,
    bot,
    services,
    runner,
    settle,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

// initData так, как её подписал бы Telegram.
export function makeInitData(telegramId: number, options: { botToken?: string; authDate?: number; startParam?: string } = {}): string {
  const params = new URLSearchParams({
    query_id: 'AAH-test',
    user: JSON.stringify({ id: telegramId, first_name: 'Ivan', username: `user${telegramId}`, language_code: 'ru' }),
    auth_date: String(options.authDate ?? Math.floor(Date.now() / 1000)),
  });
  if (options.startParam) params.set('start_param', options.startParam);
  params.set('hash', signInitData(params, options.botToken ?? TEST_BOT_TOKEN));
  return params.toString();
}

let nextTelegramId = 1000;

export async function telegramLogin(ctx: TestContext, telegramId: number, startParam?: string) {
  const res = await ctx.app.inject({ method: 'POST', url: '/v1/auth/telegram', payload: { initData: makeInitData(telegramId, { startParam }) } });
  if (res.statusCode !== 200) throw new Error(`telegram login failed: ${res.body}`);
  return res.json() as { accessToken: string; unlocked: boolean; hasPin: boolean };
}

// Новый пользователь: вход через Telegram + создание кода-пароля → разблокированная сессия.
export async function registerUser(ctx: TestContext, startParam?: string): Promise<{ token: string; telegramId: number }> {
  const telegramId = nextTelegramId++;
  const locked = await telegramLogin(ctx, telegramId, startParam);
  const res = await api(ctx, locked.accessToken).post('/v1/security/pin', { pin: TEST_PIN });
  if (res.status !== 200) throw new Error(`set pin failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.accessToken, telegramId };
}

export function api(ctx: TestContext, token: string) {
  const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, headers: Record<string, string> = {}) => {
    const res = await ctx.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}`, ...headers } });
    return { status: res.statusCode, body: res.json() };
  };
  return {
    get: (url: string, headers?: Record<string, string>) => call('GET', url, undefined, headers),
    post: (url: string, payload?: object, headers?: Record<string, string>) => call('POST', url, payload ?? {}, headers),
    patch: (url: string, payload: object) => call('PATCH', url, payload),
  };
}

export async function verifiedUserWithFunds(ctx: TestContext, usdt = '100', startParam?: string) {
  const user = await registerUser(ctx, startParam);
  const client = api(ctx, user.token);
  await client.post('/v1/kyc', { firstName: 'Ivan', lastName: 'Petrov', email: 'ivan@test.dev', birthDate: '1990-05-01', citizenship: 'KZ' });
  await ctx.settle();
  if (usdt !== '0') await client.post('/v1/dev/deposit', { asset: 'USDT', network: 'TON', amount: usdt });
  return { ...user, client };
}

// Инварианты двойной записи: каждая транзакция сбалансирована, кэш балансов совпадает с проводками.
export async function assertLedgerConsistent(db: Db): Promise<void> {
  const unbalanced = await db.execute(sql`
    select transaction_id, asset, sum(amount) as total from ledger_entries
    group by transaction_id, asset having sum(amount) <> 0
  `);
  if (unbalanced.rows.length > 0) throw new Error(`Unbalanced transactions: ${JSON.stringify(unbalanced.rows)}`);
  const drift = await db.execute(sql`
    select a.code, a.balance, coalesce(sum(e.amount), 0) as entries
    from ledger_accounts a left join ledger_entries e on e.account_id = a.id
    group by a.id having a.balance <> coalesce(sum(e.amount), 0)
  `);
  if (drift.rows.length > 0) throw new Error(`Balance cache drift: ${JSON.stringify(drift.rows)}`);
}
