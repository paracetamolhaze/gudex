import type { FastifyPluginAsync } from 'fastify';
import type { Services } from '../app';
import { parse } from '../lib/errors';
import { cardBillingInputSchema } from '../services/card-billing';
import { requireAuth } from './guard';

export const cardBillingRoutes = (services: Services): FastifyPluginAsync => async app => {
  requireAuth(app, services);
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
  app.get('/cards/billing-address', async request => services.cardBilling.get(request.userId));
  app.get('/cards/billing-countries', async request => services.cardBilling.countries(request.userId));
  app.put('/cards/billing-address', async request => services.cardBilling.save(request.userId, parse(cardBillingInputSchema, request.body)));
};
