import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { WALLET_ASSETS } from '@gudex/shared';
import type { Services } from '../app';
import { parse } from '../lib/errors';
import { requireAuth } from './guard';

const idParams = z.object({ id: z.uuid() });
const idempotencyKey = z.string().min(8).max(100);
const asset = z.enum(WALLET_ASSETS);
const amount = z.string().regex(/^\d+([.,]\d+)?$/);

const issueBody = z.object({
  asset, idempotencyKey,
  expectedFundingSource: z.enum(['wallet', 'broker']).optional(),
  expectedCustomerCharge: amount.optional(),
});
const topupBody = z.object({ asset, amount, idempotencyKey, expectedFee: amount.optional(), expectedNetUsd: amount.optional() });
const quoteQuery = z.object({ asset, amount, cardId: z.uuid().optional() });
const statusBody = z.object({ idempotencyKey });
const additionalAttemptBody = z.object({ quoteToken: z.string().min(1).max(4096), idempotencyKey,
  acceptedRisk: z.literal(true), termsVersion: z.literal('additional-issue-v1') }).strict();

export const cardRoutes =
  (services: Services): FastifyPluginAsync =>
  async (app) => {
    requireAuth(app, services);

    app.get('/cards', async (request) => services.cards.list(request.userId));

    app.post('/cards', async (request, reply) => {
      const body = parse(issueBody, request.body);
      reply.status(202);
      return services.cards.issue(request.userId, body);
    });

    app.get('/cards/issue-quote', async (request, reply) => {
      const query = parse(z.object({ asset }), request.query);
      reply.header('Cache-Control', 'no-store');
      return services.cards.quoteIssue(request.userId, query.asset);
    });

    app.get('/cards/additional-attempt-quote', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return services.cards.quoteAdditionalAttempt(request.userId);
    });

    app.post('/cards/additional-attempt', async (request, reply) => {
      const body = parse(additionalAttemptBody, request.body);
      reply.header('Cache-Control', 'no-store').status(202);
      return services.cards.confirmAdditionalAttempt(request.userId, body);
    });

    app.get('/cards/topup-quote', async (request, reply) => {
      const query = parse(quoteQuery, request.query);
      reply.header('Cache-Control', 'no-store');
      return services.cards.quoteTopup(query.asset, query.amount, request.userId, query.cardId);
    });

    app.get('/cards/:id', async (request) => {
      const { id } = parse(idParams, request.params);
      return services.cards.get(request.userId, id);
    });

    // Реквизиты — только с подтверждением кодом/биометрией (POST /security/confirm).
    app.get('/cards/:id/sensitive', async (request, reply) => {
      const { id } = parse(idParams, request.params);
      const confirmation = request.headers['x-confirmation-token'];
      await services.auth.verifyConfirmation(typeof confirmation === 'string' ? confirmation : undefined, request.userId);
      reply.header('Cache-Control', 'no-store');
      return services.cards.getSensitive(request.userId, id);
    });

    app.post('/cards/:id/topup', async (request, reply) => {
      const { id } = parse(idParams, request.params);
      const body = parse(topupBody, request.body);
      reply.status(202);
      return services.cards.topup(request.userId, id, body);
    });

    app.post('/cards/:id/freeze', async (request, reply) => {
      const { id } = parse(idParams, request.params);
      const body = parse(statusBody, request.body);
      reply.status(202);
      return services.cards.setFrozen(request.userId, id, true, body.idempotencyKey);
    });

    app.post('/cards/:id/unfreeze', async (request, reply) => {
      const { id } = parse(idParams, request.params);
      const body = parse(statusBody, request.body);
      reply.status(202);
      return services.cards.setFrozen(request.userId, id, false, body.idempotencyKey);
    });

    app.get('/operations/:id', async (request) => {
      const { id } = parse(idParams, request.params);
      return services.cards.getOperation(request.userId, id);
    });
  };
