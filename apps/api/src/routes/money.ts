import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type Locale, NETWORK_IDS, WALLET_ASSETS } from '@gudex/shared';
import type { Deps, Services } from '../app';
import { users } from '../db/schema';
import { parse } from '../lib/errors';
import { requireAuth } from './guard';

const idempotencyKey = z.string().min(8).max(100);
const asset = z.enum(WALLET_ASSETS);
const amount = z.string().regex(/^\d+([.,]\d+)?$/);

const withdrawalBody = z.object({
  asset,
  network: z.enum(NETWORK_IDS),
  address: z.string().trim().min(1).max(128),
  amount,
  idempotencyKey,
});
const transferBody = z.object({ username: z.string().min(1).max(40), asset, amount, idempotencyKey });
const recipientQuery = z.object({ username: z.string().min(1).max(40) });
const idParams = z.object({ id: z.uuid() });

// Вывод, переводы, приглашения и обменник. Деньги уходят с баланса только с подтверждением кодом или биометрией.
export const moneyRoutes =
  (deps: Deps, services: Services): FastifyPluginAsync =>
  async (app) => {
    requireAuth(app, services);

    const confirmed = async (request: FastifyRequest) => {
      const token = request.headers['x-confirmation-token'];
      await services.auth.verifyConfirmation(typeof token === 'string' ? token : undefined, request.userId);
    };

    app.post('/withdrawals', async (request, reply) => {
      const body = parse(withdrawalBody, request.body);
      await confirmed(request);
      reply.status(202);
      return services.withdrawals.create(request.userId, { ...body, amount: body.amount.replace(',', '.') });
    });

    app.get('/withdrawals/:id', async (request) => {
      const { id } = parse(idParams, request.params);
      return services.withdrawals.get(request.userId, id);
    });

    app.get('/transfers/recipient', async (request) => {
      const { username } = parse(recipientQuery, request.query);
      return services.transfers.findRecipient(request.userId, username);
    });

    app.post('/transfers', async (request) => {
      const body = parse(transferBody, request.body);
      await confirmed(request);
      return services.transfers.create(request.userId, { ...body, amount: body.amount.replace(',', '.') });
    });

    app.get('/referral', async (request) => services.referrals.get(request.userId));

    // Обменник WhiteBird: ключи партнёра и адреса пополнения клиента для виджета.
    app.get('/exchange/session', async (request, reply) => {
      const [user] = await deps.db.select({ locale: users.locale }).from(users).where(eq(users.id, request.userId));
      reply.header('Cache-Control', 'no-store');
      return services.exchange.session(request.userId, (user?.locale ?? 'ru') as Locale);
    });
  };
