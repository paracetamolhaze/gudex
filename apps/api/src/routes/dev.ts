import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { NETWORK_IDS, toMinor, WALLET_ASSETS } from '@gudex/shared';
import type { Deps, Services } from '../app';
import { cards } from '../db/schema';
import { AppError, parse } from '../lib/errors';
import { PartnerError } from '../partner/types';
import { enqueue } from '../queue/queue';
import { requireAuth } from './guard';

// Эндпоинты только для разработки (DEV_TOOLS=true): имитируют внешний мир без блокчейна и без UPay.

const depositBody = z.object({
  asset: z.enum(WALLET_ASSETS),
  network: z.enum(NETWORK_IDS),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
});

const purchaseBody = z.object({
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  merchant: z.string().min(1).max(60).default('Test merchant'),
});

export const devRoutes =
  (deps: Deps, services: Services): FastifyPluginAsync =>
  async (app) => {
    requireAuth(app, services);

    app.post('/deposit', async (request) => {
      const body = parse(depositBody, request.body);
      await services.wallet.simulateDeposit(request.userId, body.asset, body.network, body.amount);
      return services.wallet.getWallet(request.userId);
    });

    app.post('/cards/:id/purchase', async (request) => {
      const { id } = parse(z.object({ id: z.uuid() }), request.params);
      const body = parse(purchaseBody, request.body);
      if (!deps.mockPartner) throw new AppError('validation', 'Purchase simulation needs the mock partner');
      const card = await services.cards.get(request.userId, id);
      const [row] = await deps.db.select({ partnerCardId: cards.partnerCardId }).from(cards).where(eq(cards.id, card.id));
      if (!row?.partnerCardId) throw new AppError('card_not_active', 'Card is not issued yet');
      try {
        await deps.mockPartner.simulatePurchase(row.partnerCardId, toMinor(body.amount, 'USD'), body.merchant);
      } catch (err) {
        if (err instanceof PartnerError) throw new AppError('validation', err.message);
        throw err;
      }
      await enqueue(deps.db, 'card.sync', { cardId: card.id }, { dedupeKey: `card.sync:${card.id}` });
      return { ok: true };
    });
  };
