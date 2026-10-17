import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { NETWORK_IDS, WALLET_ASSETS } from '@gudex/shared';
import type { Services } from '../app';
import { parse } from '../lib/errors';
import { requireAuth } from './guard';

const createBody = z.object({ asset: z.enum(WALLET_ASSETS), network: z.enum(NETWORK_IDS),
  amount: z.string().regex(/^\d+(?:[.,]\d{1,6})?$/).max(40), idempotencyKey: z.string().min(8).max(100) }).strict();
export const depositInvoiceRoutes = (services: Services): FastifyPluginAsync => async app => {
  requireAuth(app, services);
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
  app.get('/deposit-invoices/options', async () => services.depositInvoices.options());
  app.get('/deposit-invoices/active', async request => services.depositInvoices.active(request.userId));
  app.post('/deposit-invoices', async (request, reply) => {
    const input = parse(createBody, request.body);
    reply.status(202);
    return services.depositInvoices.create(request.userId, input);
  });
  app.post('/deposit-invoices/:id/retry', async (request, reply) => {
    const { id } = parse(z.object({ id: z.uuid() }), request.params);
    parse(z.object({}).strict(), request.body);
    reply.status(202);
    return services.depositInvoices.retry(request.userId, id);
  });
  app.get('/deposit-invoices/:id', async request => {
    const { id } = parse(z.object({ id: z.uuid() }), request.params);
    return services.depositInvoices.get(request.userId, id);
  });
};
