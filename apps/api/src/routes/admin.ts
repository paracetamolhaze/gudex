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
    const { customerNo } = parse(z.object({ customerNo: providerId.optional() }).strict(), request.query);
    return services.manualAdmin.providerCards(request.userId, userId, customerNo);
  });
  app.post('/clients/:userId/kyc', async request => {
    const { userId } = parse(target, request.params);
    const input = parse(z.object({ submissionId: z.uuid(), customerId: providerId, customerNo: providerId, documentsMatch: z.literal(true) }).strict(), request.body);
    return services.manualAdmin.approveKyc(request.userId, userId, input);
  });
  app.post('/clients/:userId/reject', async request => {
    const { userId } = parse(target, request.params);
    const input = parse(z.object({ submissionId: z.uuid().optional(), reason: z.string().trim().min(1).max(500) }).strict(), request.body);
    return services.manualAdmin.rejectKyc(request.userId, userId, input);
  });
  app.get('/wallet-transfers', async () => services.feePayments.unmatched());
  app.post('/wallet-transfers/:id/assign', async request => {
    const { id } = parse(z.object({ id: z.uuid() }).strict(), request.params);
    const { query } = parse(z.object({ query: z.string().trim().min(1).max(64) }).strict(), request.body);
    const client = await services.manualAdmin.client(request.userId, query);
    return services.feePayments.assign(request.userId, id, client.userId);
  });
  app.post('/clients/:userId/requests/:operationId', async request => {
    const { userId, operationId } = parse(z.object({ userId: z.uuid(), operationId: z.uuid() }).strict(), request.params);
    const input = parse(z.union([z.object({ done: z.literal(true) }).strict(), z.object({ done: z.literal(false), reason: z.string().trim().min(1).max(300) }).strict()]), request.body);
    await services.cards.resolveManualRequest(request.userId, userId, operationId, input);
    return services.manualAdmin.client(request.userId, userId);
  });
  app.post('/clients/:userId/cards/:cardId/topup-addresses', async request => {
    const { userId, cardId } = parse(z.object({ userId: z.uuid(), cardId: z.uuid() }).strict(), request.params);
    const address = z.string().trim().max(64).optional();
    const input = parse(z.object({ USDT_TRC20: address, USDT_ERC20: address, USDT_BEP20: address, USDC_ERC20: address, USDC_BEP20: address }).strict(), request.body);
    return services.manualAdmin.setTopupAddresses(request.userId, userId, cardId, input);
  });
  app.post('/clients/:userId/card', async request => {
    const { userId } = parse(target, request.params);
    const input = parse(z.object({ operationId: z.uuid(), customerNo: providerId.optional(), cardNumber: z.string().trim().regex(/^[\d ]{13,23}$/),
      expiryMonth: z.number().int().min(1).max(12), expiryYear: z.number().int().min(0).max(2100), cvv: z.string().regex(/^\d{3,4}$/),
      email: z.string().trim().min(3).max(254) }).strict(), request.body);
    return services.manualAdmin.bindCard(request.userId, userId, input);
  });
  // Client mail on our domain: UPay sends codes there, the bot forwards them to the client's Telegram.
  app.post('/clients/:userId/mail', async request => {
    const { userId } = parse(target, request.params);
    const { address } = parse(z.object({ address: z.string().trim().min(3).max(254) }).strict(), request.body);
    await services.mail.setClientAddress(request.userId, userId, address);
    return services.manualAdmin.client(request.userId, userId);
  });
  app.get('/mail', async () => services.mail.overview());
  app.post('/mail/senders', async request => services.mail.addSender(request.userId, parse(z.object({
    pattern: z.string().trim().min(3).max(254), label: z.string().trim().min(1).max(40), codePattern: z.string().max(200).optional() }).strict(), request.body)));
  app.post('/mail/senders/remove', async request => services.mail.removeSender(request.userId,
    parse(z.object({ pattern: z.string().trim().min(3).max(254) }).strict(), request.body).pattern));
};
