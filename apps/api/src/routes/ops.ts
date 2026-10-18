import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Deps, Services } from '../app';
import { AppError, parse } from '../lib/errors';
import { UpayError } from '../partner/upay/transport';
import { inspectUpayContracts } from '../partner/upay/contracts';
import { inspectUpayWalletReadiness } from '../partner/upay/wallet-readiness';
import { inspectUpayAccess } from '../partner/upay/access-readiness';
import { inspectDatabase, prepareLiveDatabase } from '../ops/live-database';
import { inspectKycStatus } from '../ops/kyc-status';
import { inspectResetTestAccount, resetTestAccount } from '../ops/reset-test-account';
import { inspectUnfinishedCard, removeUnfinishedCard, REMOVE_UNFINISHED_CARD_CONFIRMATION } from '../ops/remove-unfinished-card';
import { inspectZeroOwnerAccount, zeroOwnerAccount, ZERO_OWNER_CONFIRMATION } from '../ops/zero-owner-account';
import { inspectOwnerApplication, removeOwnerApplication, REMOVE_OWNER_APPLICATION_CONFIRMATION } from '../ops/remove-owner-application';
import { inspectExistingKycCustomer, resumeExistingKycCustomer } from '../ops/kyc-existing-customer';
import { inspectKycSubjectAttestation, recordKycSubjectAttestation } from '../ops/kyc-subject-attestation';
import { inspectCardOperationStatus } from '../ops/card-operation-status';
import { inspectCardOperationProviderStatus } from '../ops/card-operation-provider-status';
import { inspectUpayAuthStatus } from '../ops/upay-auth-status';
import { appSettings, cardOperations, users } from '../db/schema';
import { CRON_HEARTBEAT_KEY, cronReadiness } from './telegram';
import { requireOps } from './ops-auth';

export const opsRoutes = (deps: Deps, services: Services, drainJobs?: () => Promise<number>): FastifyPluginAsync => async app => {
  app.addHook('preHandler', async request => requireOps(request, deps.config));
  app.get('/status', async () => {
    const [jobs, [heartbeat], unknownCards, unknownWithdrawals, upayAuth] = await Promise.all([
      deps.db.execute(sql`select queue, status, count(*)::int as count from jobs group by queue, status order by queue, status`),
      deps.db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, CRON_HEARTBEAT_KEY)),
      services.cards.listUnknown(), services.withdrawals.listUnknown(),
      inspectUpayAuthStatus(deps.db, deps.config),
    ]);
    return { cardPartner: deps.config.CARD_PARTNER, upayConfigured: Boolean(deps.upay?.configured),
      upayWritesEnabled: deps.config.CARD_PARTNER === 'upay' && deps.config.UPAY_WRITES_ENABLED,
      upayKycEnabled: deps.config.CARD_PARTNER === 'upay' && deps.config.UPAY_KYC_ENABLED,
      paymentPasswordConfigured: Boolean(deps.config.UPAY_PAYMENT_PASSWORD),
      upayAuth, cron: cronReadiness(heartbeat?.value), jobs: jobs.rows, unknownCards, unknownWithdrawals };
  });
  app.post('/upay/check', async () => {
    if (!deps.upay) throw new AppError('provider_unavailable', 'UPay is not configured');
    try { return await deps.upay.check(); }
    catch (err) {
      if (err instanceof UpayError) throw new AppError('provider_unavailable', err.message);
      throw err;
    }
  });
  app.post('/upay/payment-password/check', async () => {
    if (!deps.upay) throw new AppError('provider_unavailable', 'UPay is not configured');
    try { return await deps.upay.validatePaymentPassword(); }
    catch (err) {
      if (err instanceof UpayError) throw new AppError('provider_unavailable', err.message);
      throw err;
    }
  });
  app.get('/upay/contracts', async () => {
    if (!deps.upay) throw new AppError('provider_unavailable', 'UPay is not configured');
    return inspectUpayContracts(deps.upay, deps.config);
  });
  app.get('/upay/wallet/check', async () => {
    if (!deps.upay) throw new AppError('provider_unavailable', 'UPay is not configured');
    return inspectUpayWalletReadiness(deps.upay);
  });
  app.get('/upay/deposits/check', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (deps.depositInvoices?.inspectInvoiceReadiness) {
      const inspection = await deps.depositInvoices.inspectInvoiceReadiness();
      return { serviceReady: services.depositInvoices.ready, flow: 'checkout', ...inspection,
        ...(inspection.ready && services.depositInvoices.ready ? { options: await services.depositInvoices.options() } : {}) };
    }
    return { ready: services.depositInvoices.ready, flow: 'checkout', options: await services.depositInvoices.options() };
  });
  app.get('/test-account/514468501/additional-attempt', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const [owner] = await deps.db.select({ id: users.id }).from(users).where(eq(users.telegramId, 514468501n));
    if (!owner) throw new AppError('not_found', 'Test account not found');
    const quote = await services.cards.quoteAdditionalAttempt(owner.id);
    return quote.eligible ? { eligible: true, termsVersion: quote.termsVersion, customerCharge: quote.customerCharge,
      additionalBrokerCostUsd: quote.additionalBrokerCostUsd, maximumCumulativeCostUsd: quote.maximumCumulativeCostUsd,
      expiresAt: quote.expiresAt, financialSubmissionSent: false } : { eligible: false, reason: quote.reason, financialSubmissionSent: false };
  });
  app.get('/upay/access/check', async () => {
    if (!deps.upay) throw new AppError('provider_unavailable', 'UPay is not configured');
    return inspectUpayAccess(deps.upay, deps.config);
  });
  app.get('/database/status', async () => inspectDatabase(deps.db));
  // This maintenance action is restricted inside the service to the owner's explicitly authorized test ID.
  app.get('/test-account/:telegramId/reset', async (request, reply) => {
    const { telegramId } = parse(z.object({ telegramId: z.literal('514468501') }), request.params);
    reply.header('Cache-Control', 'no-store');
    return inspectResetTestAccount(deps.db, telegramId);
  });
  app.post('/test-account/:telegramId/reset', async (request, reply) => {
    const { telegramId } = parse(z.object({ telegramId: z.literal('514468501') }), request.params);
    const body = parse(z.object({ expectedUserId: z.uuid(), expectedSubmissionId: z.uuid().nullable(),
      confirmation: z.literal('DELETE_ONLY_MY_UNFUNDED_GUDEX_TEST_ACCOUNT'),
    }).strict(), request.body);
    const result = await resetTestAccount(deps.db, telegramId, body.expectedUserId, body.expectedSubmissionId);
    reply.header('Cache-Control', 'no-store');
    return result;
  });
  // Owner-authorized removal of the unfinished test issuance; the GET only shows what would be removed.
  app.get('/test-account/:telegramId/unfinished-card', async (request, reply) => {
    parse(z.object({ telegramId: z.literal('514468501') }), request.params);
    reply.header('Cache-Control', 'no-store');
    return inspectUnfinishedCard(deps.db, deps.upay);
  });
  app.post('/test-account/:telegramId/unfinished-card', async (request, reply) => {
    parse(z.object({ telegramId: z.literal('514468501') }), request.params);
    const body = parse(z.object({ expectedUserId: z.uuid(), expectedOperationId: z.uuid().nullable(), expectedCardId: z.uuid().nullable(),
      confirmation: z.literal(REMOVE_UNFINISHED_CARD_CONFIRMATION) }).strict(), request.body);
    reply.header('Cache-Control', 'no-store');
    return removeUnfinishedCard(deps.db, deps.upay, { userId: body.expectedUserId, operationId: body.expectedOperationId, cardId: body.expectedCardId });
  });
  // Owner-requested reset of his account to zero; the GET only shows what would be deleted.
  app.get('/test-account/:telegramId/zero', async (request, reply) => {
    parse(z.object({ telegramId: z.literal('514468501') }), request.params);
    reply.header('Cache-Control', 'no-store');
    return inspectZeroOwnerAccount(deps.db);
  });
  app.post('/test-account/:telegramId/zero', async (request, reply) => {
    parse(z.object({ telegramId: z.literal('514468501') }), request.params);
    const body = parse(z.object({ expectedUserId: z.uuid(), confirmation: z.literal(ZERO_OWNER_CONFIRMATION) }).strict(), request.body);
    reply.header('Cache-Control', 'no-store');
    return zeroOwnerAccount(deps.db, body.expectedUserId);
  });
  // Owner-requested removal of his waiting card application; the GET only shows what would be removed.
  app.get('/test-account/:telegramId/application', async (request, reply) => {
    parse(z.object({ telegramId: z.literal('514468501') }), request.params);
    reply.header('Cache-Control', 'no-store');
    return inspectOwnerApplication(deps.db);
  });
  app.post('/test-account/:telegramId/application', async (request, reply) => {
    parse(z.object({ telegramId: z.literal('514468501') }), request.params);
    const body = parse(z.object({ expectedUserId: z.uuid(), expectedOperationId: z.uuid().nullable(),
      confirmation: z.literal(REMOVE_OWNER_APPLICATION_CONFIRMATION) }).strict(), request.body);
    reply.header('Cache-Control', 'no-store');
    return removeOwnerApplication(deps.db, { userId: body.expectedUserId, operationId: body.expectedOperationId });
  });
  app.get('/kyc/:telegramId', async (request, reply) => {
    const { telegramId } = parse(z.object({ telegramId: z.string().regex(/^[1-9]\d{0,15}$/) }), request.params);
    const query = parse(z.object({ customerBinding: z.literal('1').optional() }), request.query);
    reply.header('Cache-Control', 'no-store');
    return inspectKycStatus(deps.db, telegramId, query.customerBinding ? deps.upay : undefined, deps.config.UPAY_PRODUCT_ID);
  });
  app.post('/kyc/:telegramId/recheck', async (request, reply) => {
    const { telegramId } = parse(z.object({ telegramId: z.string().regex(/^[1-9]\d{0,15}$/) }), request.params);
    const [user] = await deps.db.select({ id: users.id }).from(users).where(eq(users.telegramId, BigInt(telegramId)));
    if (!user) throw new AppError('not_found', 'User not found');
    // Recheck reads existing UPay receipts; it cannot create a customer or send documents.
    await services.kyc.recheck(user.id);
    reply.header('Cache-Control', 'no-store');
    return inspectKycStatus(deps.db, telegramId);
  });
  app.get('/kyc/:telegramId/existing-customer', async (request, reply) => {
    const { telegramId } = parse(z.object({ telegramId: z.literal('514468501') }), request.params);
    if (!deps.upay || deps.config.CARD_PARTNER !== 'upay' || !deps.config.UPAY_KYC_ENABLED) {
      throw new AppError('provider_unavailable', 'Live UPay verification is unavailable');
    }
    reply.header('Cache-Control', 'no-store');
    return inspectExistingKycCustomer(deps.db, deps.upay, telegramId);
  });
  app.post('/kyc/:telegramId/existing-customer', async (request, reply) => {
    const { telegramId } = parse(z.object({ telegramId: z.literal('514468501') }), request.params);
    const body = parse(z.object({ expected: z.object({ userId: z.uuid(), submissionId: z.uuid(),
      customerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), customerNo: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      legacyMarker: z.string().regex(/^GUDEX-KYC:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
    }).strict(), confirmation: z.literal('USE_MY_PREVIOUS_UPAY_CUSTOMER_AND_SUBMIT_CURRENT_KYC') }).strict(), request.body);
    if (!deps.upay || deps.config.CARD_PARTNER !== 'upay' || !deps.config.UPAY_KYC_ENABLED) {
      throw new AppError('provider_unavailable', 'Live UPay verification is unavailable');
    }
    reply.header('Cache-Control', 'no-store');
    return resumeExistingKycCustomer(deps.db, deps.upay, telegramId, body.expected);
  });
  const subjectAttestationOptions = { onRequest: async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
  } };
  app.get('/kyc/:telegramId/subject-attestation', subjectAttestationOptions, async request => {
    const { telegramId } = parse(z.object({ telegramId: z.literal('514468501') }), request.params);
    if (!deps.upay || deps.config.CARD_PARTNER !== 'upay' || !deps.config.UPAY_KYC_ENABLED) {
      throw new AppError('provider_unavailable', 'Live UPay verification is unavailable');
    }
    return inspectKycSubjectAttestation(deps.db, deps.upay, telegramId, deps.config.UPAY_PRODUCT_ID);
  });
  app.post('/kyc/:telegramId/subject-attestation', subjectAttestationOptions, async request => {
    const { telegramId } = parse(z.object({ telegramId: z.literal('514468501') }), request.params);
    const body = parse(z.object({ expected: z.object({ userId: z.uuid(), submissionId: z.uuid(),
      requestHash: z.string().regex(/^[a-f0-9]{64}$/i),
    }).strict(), observedBeforeAt: z.iso.datetime({ offset: true }), observedReviewAt: z.iso.datetime({ offset: true }),
    confirmation: z.literal('RECORD_MY_OBSERVED_PRIMARY_KYC_TRANSITION'),
    }).strict(), request.body);
    if (!deps.upay || deps.config.CARD_PARTNER !== 'upay' || !deps.config.UPAY_KYC_ENABLED) {
      throw new AppError('provider_unavailable', 'Live UPay verification is unavailable');
    }
    return recordKycSubjectAttestation(deps.db, deps.upay, telegramId, deps.config.UPAY_PRODUCT_ID, body);
  });
  app.post('/card-issue-sponsorships', async request => {
    const body = parse(z.object({
      telegramId: z.string().regex(/^[1-9]\d{0,15}$/),
      reason: z.string().trim().min(10).max(300),
    }).strict(), request.body);
    return services.cards.grantIssueSponsorship(body);
  });
  app.post('/database/prepare-live', async request => {
    if (!deps.config.LIVE_DATABASE_SETUP_ENABLED) throw new AppError('not_found', 'Not found');
    const { rolePassword } = parse(z.object({ rolePassword: z.string().regex(/^[a-f0-9]{64}$/) }), request.body);
    return prepareLiveDatabase(deps.config, rolePassword);
  });
  app.post('/queue/drain', async () => {
    if (!drainJobs) throw new AppError('provider_unavailable', 'Queue drain is provided by the runtime');
    return { processed: await drainJobs() };
  });
  app.get('/cards/:id/status', { onRequest: async (_request, reply) => { reply.header('Cache-Control', 'no-store'); } }, async request => {
    const { id } = parse(z.object({ id: z.uuid() }).strict(), request.params);
    parse(z.object({}).strict(), request.query);
    return inspectCardOperationStatus(deps.db, id);
  });
  app.get('/cards/:id/provider-status', { onRequest: async (_request, reply) => { reply.header('Cache-Control', 'no-store'); } }, async request => {
    const { id } = parse(z.object({ id: z.uuid() }).strict(), request.params);
    parse(z.object({}).strict(), request.query);
    if (!deps.upay) throw new AppError('provider_unavailable', 'UPay is not configured');
    return inspectCardOperationProviderStatus(deps.db, deps.upay, id, deps.config.UPAY_PRODUCT_ID, deps.config.UPAY_CUSTOMER_GROUP_ID);
  });
  app.post('/cards/:id/reconcile', async request => {
    const { id } = parse(z.object({ id: z.uuid() }), request.params);
    request.log.info({ event: 'ops.card_reconcile', operationId: id }, 'Operator requested lookup-only reconciliation');
    return services.cards.reconcileUnknown(id);
  });
  app.post('/cards/:id/receipt', async request => {
    const { id } = parse(z.object({ id: z.uuid() }), request.params);
    const body = parse(z.object({ orderNo: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      partnerCardId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional() }), request.body);
    const [op] = await deps.db.select().from(cardOperations).where(eq(cardOperations.id, id));
    if (!op) throw new AppError('not_found', 'Card operation not found');
    if (!['issue', 'topup'].includes(op.type) || !['unknown', 'processing'].includes(op.status)) {
      throw new AppError('validation', 'Receipt binding requires an unresolved issuance or top-up');
    }
    if (!deps.partner.bindReceipt) throw new AppError('provider_unavailable', 'Receipt reconciliation is unavailable for this provider');
    await deps.partner.bindReceipt(id, body.orderNo, body.partnerCardId);
    request.log.info({ event: 'ops.card_receipt_bound', operationId: id }, 'Operator verified an exact partner receipt');
    return services.cards.reconcileUnknown(id);
  });
  app.post('/withdrawals/:id/reconcile', async request => {
    const { id } = parse(z.object({ id: z.uuid() }), request.params);
    request.log.info({ event: 'ops.withdrawal_reconcile', withdrawalId: id }, 'Operator requested lookup-only reconciliation');
    return services.withdrawals.reconcileUnknown(id);
  });
};
