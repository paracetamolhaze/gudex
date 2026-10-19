import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { type MeDto, NETWORK_IDS, WALLET_ASSETS } from '@gudex/shared';
import type { Deps, Services } from '../app';
import { users } from '../db/schema';
import { AppError, parse } from '../lib/errors';
import { MAX_KYC_UPLOAD_BYTES } from '../kyc/document-store';
import { cardBillingInputSchema } from '../services/card-billing';
import { requireAuth } from './guard';

// Имя — латиницей, как в загранпаспорте: оно печатается на карте.
const latinName = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z '-]{0,48}$/, 'Latin letters only');

const kycBody = z.object({
  firstName: latinName,
  lastName: latinName,
  // Older Mini App builds still send the email the client typed; manual issuance ignores it.
  email: z.email().max(254).optional(),
  birthDate: z.iso.date(),
  citizenship: z.string().regex(/^[A-Za-z]{2}$/),
  phone: z.string().regex(/^\d{7,15}$/).optional(),
  globalCode: z.string().regex(/^\+[1-9]\d{0,3}$/).optional(),
  documentType: z.enum(['id_card', 'passport', 'driving_license']).optional(),
  documentCountry: z.string().regex(/^[A-Za-z]{2}$/).optional(),
  documentIds: z.object({ front: z.uuid(), back: z.uuid().optional(), selfie: z.uuid().optional() }).optional(),
});

// Manual issuance: the same questionnaire, but contacts and photos are mandatory, plus billing and payment.
const applicationBody = z.object({
  kyc: kycBody.extend({
    phone: z.string().regex(/^\d{7,15}$/),
    globalCode: z.string().regex(/^\+[1-9]\d{0,3}$/),
    documentType: z.enum(['id_card', 'passport', 'driving_license']),
    documentCountry: z.string().regex(/^[A-Za-z]{2}$/),
    documentIds: z.object({ front: z.uuid(), back: z.uuid().optional(), selfie: z.uuid().optional() }),
  }).strict(),
  billing: cardBillingInputSchema,
  asset: z.enum(WALLET_ASSETS),
  idempotencyKey: z.string().min(8).max(100),
  expectedFundingSource: z.enum(['wallet', 'broker']).optional(),
  expectedCustomerCharge: z.string().regex(/^\d+([.,]\d+)?$/).optional(),
}).strict();

function assertAdult(birthDate: string): void {
  const birth = new Date(`${birthDate}T00:00:00Z`), now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  if (now.getUTCMonth() < birth.getUTCMonth() || now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() < birth.getUTCDate()) age--;
  if (!(age >= 18 && age < 120)) throw new AppError('validation', 'birthDate: must be 18+');
}

const documentUpload = z.object({
  kind: z.enum(['front', 'back', 'selfie']),
  mimeType: z.enum(['image/jpeg', 'image/png']),
  base64: z.string().min(1).max(Math.ceil(MAX_KYC_UPLOAD_BYTES / 3) * 4),
  clientDocumentId: z.uuid().optional(),
});

const meBody = z.object({ locale: z.enum(['ru', 'en']) });

const addressQuery = z.object({
  asset: z.enum(WALLET_ASSETS),
  network: z.enum(NETWORK_IDS),
});

const activityQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

// Профиль — доступен и до ввода кода-пароля: по нему приложение решает, что показать.
export const profileRoutes =
  (deps: Deps, services: Services): FastifyPluginAsync =>
  async (app) => {
    requireAuth(app, services, { allowLocked: true });

    const me = async (userId: string): Promise<MeDto> => {
      const [user] = await deps.db.select().from(users).where(eq(users.id, userId));
      if (!user) throw new AppError('unauthorized', 'User not found');
      return {
        id: user.id,
        telegram: {
          id: user.telegramId.toString(),
          username: user.username,
          firstName: user.firstName,
          lastName: user.lastName,
          photoUrl: user.photoUrl,
        },
        locale: user.locale as MeDto['locale'],
        hasPin: user.pinHash !== null,
        kyc: await services.kyc.get(userId),
      };
    };

    app.get('/me', async (request) => me(request.userId));

    app.patch('/me', async (request) => {
      const body = parse(meBody, request.body);
      await deps.db.update(users).set({ locale: body.locale }).where(eq(users.id, request.userId));
      return me(request.userId);
    });
  };

export const accountRoutes =
  (services: Services): FastifyPluginAsync =>
  async (app) => {
    requireAuth(app, services);

    app.get('/kyc/requirements', async () => services.kyc.requirements());

    app.post('/kyc/documents', { bodyLimit: 3 * 1024 * 1024 }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.status(201);
      return services.kyc.uploadDocument(request.userId, parse(documentUpload, request.body));
    });

    app.delete('/kyc/documents/:id', async request => {
      const { id } = parse(z.object({ id: z.uuid() }), request.params);
      await services.kyc.removeDocument(request.userId, id);
      return { ok: true };
    });

    app.post('/kyc/recheck', async request => services.kyc.recheck(request.userId));

    app.post('/kyc', async (request) => {
      const body = parse(kycBody, request.body);
      assertAdult(body.birthDate);
      return services.kyc.submit(request.userId, body);
    });

    app.get('/fee-payments/current', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return services.feePayments.current(request.userId);
    });

    app.post('/fee-payments', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const body = parse(z.object({ asset: z.enum(WALLET_ASSETS), network: z.enum(['TRC20', 'BEP20', 'ERC20', 'POLYGON']) }).strict(), request.body);
      return services.feePayments.create(request.userId, body);
    });

    app.post('/card-application', async (request, reply) => {
      const body = parse(applicationBody, request.body);
      assertAdult(body.kyc.birthDate);
      reply.header('Cache-Control', 'no-store');
      reply.status(202);
      return services.cardApplications.submit(request.userId, body);
    });

    app.post('/card-application/pay', async (request, reply) => {
      const body = parse(z.object({ asset: z.enum(WALLET_ASSETS) }).strict(), request.body);
      reply.header('Cache-Control', 'no-store');
      return services.cardApplications.payFromBalance(request.userId, body.asset);
    });

    app.get('/wallet', async (request) => services.wallet.getWallet(request.userId));

    app.get('/deposits/address', async (request) => {
      const query = parse(addressQuery, request.query);
      return services.wallet.getDepositAddress(request.userId, query.asset, query.network);
    });

    app.get('/activity', async (request) => {
      const query = parse(activityQuery, request.query);
      return services.activity.list(request.userId, query.limit);
    });
  };
