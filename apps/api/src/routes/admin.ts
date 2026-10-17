import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app';
import { parse } from '../lib/errors';
import { requireAuth } from './guard';

const target = z.object({ userId: z.uuid() }).strict();
const providerId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

/** Telegram administrator sessions only. No OPS secret is exposed to Mini App. */
export const adminRoutes = (services: Services): FastifyPluginAsync => async app => {
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
  requireAuth(app, services);
  app.addHook('preHandler', async request => {
    await services.manualAdmin.assertAdmin(request.userId);
    if (request.method !== 'GET') {
      const token = request.headers['x-confirmation-token'];
      await services.auth.verifyConfirmation(typeof token === 'string' ? token : undefined, request.userId);
    }
  });
  app.get('/me', async request => services.manualAdmin.me(request.userId));
  app.get('/applications', async request => services.manualAdmin.applications(request.userId, parse(z.object({
    page: z.coerce.number().int().min(1).max(100_000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20),
  }).strict(), request.query)));
  app.get('/clients/:query', async request => {
    const { query } = parse(z.object({ query: z.string().min(1).max(64) }).strict(), request.params);
    return services.manualAdmin.client(request.userId, query);
  });
  app.get('/clients/:userId/documents/:documentId', async request => {
    const { userId, documentId } = parse(z.object({ userId: z.uuid(), documentId: z.uuid() }).strict(), request.params);
    return services.manualAdmin.document(request.userId, userId, documentId);
  });
  app.get('/clients/:userId/provider-cards', async request => {
    const { userId } = parse(target, request.params);
    return services.manualAdmin.providerCards(request.userId, userId);
  });
  app.post('/clients/:userId/kyc', async request => {
    const { userId } = parse(target, request.params);
    const input = parse(z.object({ submissionId: z.uuid(), customerId: providerId, customerNo: providerId, documentsMatch: z.literal(true) }).strict(), request.body);
    return services.manualAdmin.approveKyc(request.userId, userId, input);
  });
  app.post('/clients/:userId/reject', async request => {
    const { userId } = parse(target, request.params);
    const input = parse(z.object({ submissionId: z.uuid(), reason: z.string().trim().min(1).max(500) }).strict(), request.body);
    return services.manualAdmin.rejectKyc(request.userId, userId, input);
  });
  app.post('/clients/:userId/card', async request => {
    const { userId } = parse(target, request.params);
    const input = parse(z.object({ operationId: z.uuid(), partnerCardId: providerId, orderNo: providerId }).strict(), request.body);
    return services.manualAdmin.bindCard(request.userId, userId, input);
  });
};
