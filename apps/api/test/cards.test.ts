import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import { AppError } from '../src/lib/errors';
import { MockUpayPartner } from '../src/partner/mock';
import { PartnerError, type PartnerCard } from '../src/partner/types';
import { api, assertLedgerConsistent, createTestContext, registerUser, TEST_PIN, type TestContext, verifiedUserWithFunds } from './helpers';

let ctx: TestContext;
afterEach(async () => {
  await assertLedgerConsistent(ctx.db);
  await ctx.close();
});

const key = () => randomUUID();

describe('onboarding', () => {
  it('requires KYC before issuing a card and approves it through the partner', async () => {
    ctx = await createTestContext();
    const { token } = await registerUser(ctx);
    const client = api(ctx, token);

    expect((await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: key() })).body.error.code).toBe('kyc_required');

    const submitted = await client.post('/v1/kyc', { firstName: 'Ivan', lastName: 'Petrov', email: 'ivan@test.dev', birthDate: '1990-05-01', citizenship: 'kz' });
    expect(submitted.body.status).toBe('pending');
    await ctx.settle();
    const me = await client.get('/v1/me');
    expect(me.body.kyc).toMatchObject({ status: 'approved', firstName: 'IVAN', lastName: 'PETROV' });
  });

  it('lets a rejected user resubmit KYC', async () => {
    ctx = await createTestContext();
    const { token } = await registerUser(ctx);
    const client = api(ctx, token);
    await client.post('/v1/kyc', { firstName: 'Ivan', lastName: 'Reject', email: 'ivan@test.dev', birthDate: '1990-05-01', citizenship: 'KZ' });
    await ctx.settle();
    expect((await client.get('/v1/me')).body.kyc.status).toBe('rejected');

    await client.post('/v1/kyc', { firstName: 'Ivan', lastName: 'Petrov', email: 'ivan@test.dev', birthDate: '1990-05-01', citizenship: 'KZ' });
    await ctx.settle();
    expect((await client.get('/v1/me')).body.kyc.status).toBe('approved');
  });

  it('rejects non-latin names and minors', async () => {
    ctx = await createTestContext();
    const { token } = await registerUser(ctx);
    const client = api(ctx, token);
    expect((await client.post('/v1/kyc', { firstName: 'Иван', lastName: 'Petrov', email: 'ivan@test.dev', birthDate: '1990-05-01', citizenship: 'KZ' })).status).toBe(400);
    expect((await client.post('/v1/kyc', { firstName: 'Ivan', lastName: 'Petrov', email: 'ivan@test.dev', birthDate: '2015-05-01', citizenship: 'KZ' })).status).toBe(400);
  });
});

describe('card lifecycle', () => {
  it('issues, tops up, spends and freezes a card with correct balances', async () => {
    ctx = await createTestContext();
    const { client } = await verifiedUserWithFunds(ctx, '100');

    // Выпуск: комиссия 10 USD списывается сразу, повтор с тем же ключом — та же операция.
    const issueKey = key();
    const issued = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: issueKey });
    expect(issued.status).toBe(202);
    expect(issued.body.card.status).toBe('pending');
    const again = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: issueKey });
    expect(again.body.operation.id).toBe(issued.body.operation.id);
    expect((await client.get('/v1/wallet')).body.balances[0]).toEqual({ asset: 'USDT', amount: '90' });

    await ctx.settle();
    const cardId = issued.body.card.id;
    const card = (await client.get(`/v1/cards/${cardId}`)).body;
    expect(card.status).toBe('active');
    expect(card.last4).toMatch(/^\d{4}$/);

    // Пополнение: 50 USDT − 1.5% = 49.25 USD на карту.
    const quote = await client.get('/v1/cards/topup-quote?asset=USDT&amount=50');
    expect(quote.body).toMatchObject({ fee: '0.75', netUsd: '49.25' });
    const topup = await client.post(`/v1/cards/${cardId}/topup`, { asset: 'USDT', amount: '50', idempotencyKey: key() });
    expect(topup.body.status).toBe('pending');
    await ctx.settle();
    expect((await client.get(`/v1/operations/${topup.body.id}`)).body.status).toBe('succeeded');
    expect((await client.get(`/v1/cards/${cardId}`)).body.balance).toBe('49.25');

    // Денег не хватает — ничего не резервируется.
    const tooMuch = await client.post(`/v1/cards/${cardId}/topup`, { asset: 'USDT', amount: '100', idempotencyKey: key() });
    expect(tooMuch.body.error.code).toBe('insufficient_funds');
    const tooSmall = await client.post(`/v1/cards/${cardId}/topup`, { asset: 'USDT', amount: '5', idempotencyKey: key() });
    expect(tooSmall.body.error.code).toBe('amount_too_small');

    // Покупка приходит от партнёра через синхронизацию.
    expect((await client.post(`/v1/dev/cards/${cardId}/purchase`, { amount: '20', merchant: 'Netflix' })).status).toBe(200);
    await ctx.settle();
    expect((await client.get(`/v1/cards/${cardId}`)).body.balance).toBe('29.25');

    const wallet = (await client.get('/v1/wallet')).body;
    expect(wallet).toMatchObject({ cardsTotalUsd: '29.25', totalUsd: '69.25' });

    // Заморозка: покупки отклоняются.
    await client.post(`/v1/cards/${cardId}/freeze`, { idempotencyKey: key() });
    await ctx.settle();
    expect((await client.get(`/v1/cards/${cardId}`)).body.status).toBe('frozen');
    expect((await client.post(`/v1/dev/cards/${cardId}/purchase`, { amount: '1' })).status).toBe(400);

    const activity = (await client.get('/v1/activity')).body;
    expect(activity.map((a: { kind: string }) => a.kind)).toEqual(['card_purchase', 'card_topup', 'card_issue', 'deposit']);
    expect(activity[0]).toMatchObject({ amount: '-20', merchant: 'Netflix', asset: 'USD' });

    // Платёжные реквизиты: только владельцу и только с подтверждением кодом-паролем.
    expect((await client.get(`/v1/cards/${cardId}/sensitive`)).body.error.code).toBe('unlock_required');
    const { confirmationToken } = (await client.post('/v1/security/confirm', { pin: TEST_PIN })).body;
    const sensitive = await client.get(`/v1/cards/${cardId}/sensitive`, { 'x-confirmation-token': confirmationToken });
    expect(sensitive.body.pan).toMatch(/^400000\d{10}$/);
    const stranger = api(ctx, (await registerUser(ctx)).token);
    const strangerConfirm = (await stranger.post('/v1/security/confirm', { pin: TEST_PIN })).body.confirmationToken;
    expect((await stranger.get(`/v1/cards/${cardId}/sensitive`, { 'x-confirmation-token': strangerConfirm })).status).toBe(404);
    expect((await stranger.get(`/v1/cards/${cardId}/sensitive`, { 'x-confirmation-token': confirmationToken })).body.error.code).toBe(
      'unlock_required',
    );

    // Бот сообщил о каждом событии: депозит, выпуск, пополнение, покупка.
    const texts = ctx.bot.sent.map((m) => m.text).join(' | ');
    expect(texts).toContain('Зачислено <b>100 USDT</b> (TON)');
    expect(texts).toMatch(/Карта •• \d{4} выпущена/);
    expect(texts).toContain('пополнена на <b>$49.25</b>');
    expect(texts).toContain('Netflix: <b>−$20</b>');
  });

  it('refunds the issue fee when the partner rejects the card', async () => {
    class RejectingPartner extends MockUpayPartner {
      override async issueCard(): Promise<PartnerCard> {
        throw new PartnerError('Application rejected', false);
      }
    }
    ctx = await createTestContext((db) => new RejectingPartner(db));
    const { client } = await verifiedUserWithFunds(ctx, '100');

    const issued = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: key() });
    expect((await client.get('/v1/wallet')).body.balances[0].amount).toBe('90');
    await ctx.settle();

    expect((await client.get(`/v1/cards/${issued.body.card.id}`)).body).toMatchObject({ status: 'failed', failureReason: 'Application rejected' });
    expect((await client.get('/v1/wallet')).body.balances[0].amount).toBe('100');
    expect((await client.get('/v1/cards')).body).toEqual([]);
  });

  it('does not issue a second card when the partner response is lost', async () => {
    let calls = 0;
    class FlakyPartner extends MockUpayPartner {
      override async issueCard(input: { externalRef: string; partnerCustomerId: string }): Promise<PartnerCard> {
        calls++;
        await super.issueCard(input);
        if (calls === 1) throw new Error('timeout'); // карта создана, но ответ не дошёл
        return super.issueCard(input);
      }
    }
    ctx = await createTestContext((db: Db) => new FlakyPartner(db));
    const { client } = await verifiedUserWithFunds(ctx, '100');

    const issued = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: key() });
    await ctx.settle();

    expect(calls).toBe(1);
    expect((await client.get(`/v1/cards/${issued.body.card.id}`)).body.status).toBe('active');
    const partnerCards = await ctx.db.execute(sql`select count(*)::int as n from mock_upay_cards`);
    expect(partnerCards.rows[0]).toEqual({ n: 1 });
  });

  it('retains the issue hold during an ambiguous result and reconciles without submitting again', async () => {
    let calls = 0;
    let lookupUnavailable = false;
    class AmbiguousPartner extends MockUpayPartner {
      override async findCardByExternalRef(externalRef: string): Promise<PartnerCard | null> {
        if (lookupUnavailable) throw new Error('lookup unavailable');
        return super.findCardByExternalRef(externalRef);
      }
      override async issueCard(input: { externalRef: string; partnerCustomerId: string }): Promise<PartnerCard> {
        calls++;
        await super.issueCard(input);
        lookupUnavailable = true;
        throw new Error('response lost');
      }
    }
    ctx = await createTestContext((db) => new AmbiguousPartner(db));
    const { client } = await verifiedUserWithFunds(ctx, '100');
    const issued = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: key() });
    await ctx.settle();
    expect((await client.get(`/v1/operations/${issued.body.operation.id}`)).body.status).toBe('unknown');
    expect((await client.get(`/v1/cards/${issued.body.card.id}`)).body).toMatchObject({ status: 'pending', pendingOperationStatus: 'unknown' });
    expect((await client.get('/v1/wallet')).body.balances[0].amount).toBe('90');
    expect(await ctx.services.cards.listUnknown()).toHaveLength(1);
    expect((await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: key() })).status).toBe(503);
    expect((await ctx.services.cards.reconcileUnknown(issued.body.operation.id)).status).toBe('unknown');
    expect(calls).toBe(1);

    lookupUnavailable = false;
    expect((await ctx.services.cards.reconcileUnknown(issued.body.operation.id)).status).toBe('succeeded');
    expect((await client.get(`/v1/cards/${issued.body.card.id}`)).body).toMatchObject({ status: 'active', pendingOperationStatus: null });
    expect((await client.get('/v1/wallet')).body.balances[0].amount).toBe('90');
    expect(calls).toBe(1);
    expect(await ctx.services.cards.listUnknown()).toEqual([]);
  });

  it('does not treat an empty lookup as permission to replay an ambiguous issuance', async () => {
    let calls = 0;
    class UnconfirmedPartner extends MockUpayPartner {
      override async issueCard(): Promise<PartnerCard> {
        calls++;
        throw new Error('unknown submission result');
      }
    }
    ctx = await createTestContext((db) => new UnconfirmedPartner(db));
    const { client } = await verifiedUserWithFunds(ctx, '100');
    const issued = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: key() });
    await ctx.settle();
    expect((await ctx.services.cards.reconcileUnknown(issued.body.operation.id)).status).toBe('unknown');
    await ctx.settle();
    expect(calls).toBe(1);
    expect((await client.get('/v1/wallet')).body.balances[0].amount).toBe('90');
  });

  it('retains a top-up hold after remote success until its reference can be confirmed', async () => {
    let calls = 0;
    let lookupUnavailable = false;
    class AmbiguousRechargePartner extends MockUpayPartner {
      override async isRechargeDone(externalRef: string): Promise<boolean> {
        if (lookupUnavailable) throw new Error('lookup unavailable');
        return super.isRechargeDone(externalRef);
      }
      override async rechargeCard(input: { partnerCardId: string; amountUsd: bigint; externalRef: string }): Promise<void> {
        calls++;
        await super.rechargeCard(input);
        lookupUnavailable = true;
        throw new Error('response lost');
      }
    }
    ctx = await createTestContext((db) => new AmbiguousRechargePartner(db));
    const { client } = await verifiedUserWithFunds(ctx, '100');
    const issued = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: key() });
    await ctx.settle();
    const cardId = issued.body.card.id;
    const topup = await client.post(`/v1/cards/${cardId}/topup`, { asset: 'USDT', amount: '50', idempotencyKey: key() });
    await ctx.settle();
    expect((await client.get(`/v1/operations/${topup.body.id}`)).body.status).toBe('unknown');
    expect((await client.get('/v1/wallet')).body.balances[0].amount).toBe('40');
    expect((await client.get(`/v1/cards/${cardId}`)).body.balance).toBe('0');
    expect((await client.post(`/v1/cards/${cardId}/topup`, { asset: 'USDT', amount: '20', idempotencyKey: key() })).status).toBe(503);
    expect((await client.post(`/v1/cards/${cardId}/freeze`, { idempotencyKey: key() })).status).toBe(503);
    expect((await ctx.db.execute(sql`select balance::text as cents from mock_upay_cards`)).rows[0]).toEqual({ cents: '4925' });
    lookupUnavailable = false;
    expect((await ctx.services.cards.reconcileUnknown(topup.body.id)).status).toBe('succeeded');
    expect((await client.get(`/v1/cards/${cardId}`)).body.balance).toBe('49.25');
    expect((await client.get('/v1/wallet')).body.balances[0].amount).toBe('40');
    expect(calls).toBe(1);
  });

  it('reconciles a lost freeze response from card state without repeating the mutation', async () => {
    let calls = 0;
    let lookupUnavailable = true;
    let staleState = false;
    class AmbiguousFreezePartner extends MockUpayPartner {
      override async freezeCard(partnerCardId: string): Promise<void> {
        calls++;
        await super.freezeCard(partnerCardId);
        throw new Error('freeze response lost');
      }
      async getCardState(partnerCardId: string): Promise<'active' | 'frozen' | null> {
        if (lookupUnavailable) throw new Error('state lookup unavailable');
        if (staleState) return 'active';
        return super.getCardState(partnerCardId);
      }
    }
    ctx = await createTestContext((db) => new AmbiguousFreezePartner(db));
    const { client } = await verifiedUserWithFunds(ctx, '100');
    const issued = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: key() });
    await ctx.settle();
    const cardId = issued.body.card.id;
    const frozen = await client.post(`/v1/cards/${cardId}/freeze`, { idempotencyKey: key() });
    await ctx.settle();
    expect((await client.get(`/v1/operations/${frozen.body.id}`)).body.status).toBe('unknown');
    expect((await client.get(`/v1/cards/${cardId}`)).body.status).toBe('active');
    expect((await ctx.db.execute(sql`select status from mock_upay_cards`)).rows[0]).toEqual({ status: 'frozen' });
    lookupUnavailable = false;
    staleState = true;
    expect((await ctx.services.cards.reconcileUnknown(frozen.body.id)).status).toBe('unknown');
    staleState = false;
    expect((await ctx.services.cards.reconcileUnknown(frozen.body.id)).status).toBe('succeeded');
    expect((await client.get(`/v1/cards/${cardId}`)).body.status).toBe('frozen');
    expect(calls).toBe(1);
  });

  it('resumes one pending issuance for competing keys at the last card slot', async () => {
    ctx = await createTestContext();
    const { client } = await verifiedUserWithFunds(ctx, '100');
    for (let i = 0; i < 2; i++) { await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: key() }); await ctx.settle(); }
    const results = await Promise.all([
      client.post('/v1/cards', { asset: 'USDT', idempotencyKey: key() }),
      client.post('/v1/cards', { asset: 'USDT', idempotencyKey: key() }),
    ]);
    expect(results.map((r) => r.status)).toEqual([202, 202]);
    expect(results[0]!.body.operation.id).toBe(results[1]!.body.operation.id);
    expect((await client.get('/v1/cards')).body).toHaveLength(3);
    expect((await client.get('/v1/wallet')).body.balances[0].amount).toBe('70');
  });

  it('replays a parallel identical issuance key when the first request fills the last card slot', async () => {
    ctx = await createTestContext();
    const { client } = await verifiedUserWithFunds(ctx, '100');
    for (let i = 0; i < 2; i++) { await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: key() }); await ctx.settle(); }
    const idempotencyKey = key();
    const results = await Promise.all([
      client.post('/v1/cards', { asset: 'USDT', idempotencyKey }),
      client.post('/v1/cards', { asset: 'USDT', idempotencyKey }),
    ]);
    expect(results.map((r) => r.status)).toEqual([202, 202]);
    expect(results[0]!.body.operation.id).toBe(results[1]!.body.operation.id);
    expect(results[0]!.body.card.id).toBe(results[1]!.body.card.id);
    expect((await client.get('/v1/wallet')).body.balances[0].amount).toBe('70');
    expect((await client.get('/v1/cards')).body).toHaveLength(3);
  });

  it('checks partner write readiness before creating an operation or reserving funds', async () => {
    let unavailable = false;
    class GatedPartner extends MockUpayPartner {
      assertWriteReady(): void {
        if (unavailable) throw new AppError('provider_unavailable', 'writes disabled');
      }
    }
    ctx = await createTestContext((db) => new GatedPartner(db));
    const { client } = await verifiedUserWithFunds(ctx, '100');
    unavailable = true;
    expect((await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: key() })).status).toBe(503);
    expect((await client.get('/v1/wallet')).body.balances[0].amount).toBe('100');
    expect((await ctx.db.execute(sql`select count(*)::int as count from card_operations`)).rows[0]).toEqual({ count: 0 });
  });

  it('validates the live recharge tariff before reserving money', async () => {
    class MinimumPartner extends MockUpayPartner {
      async validateRecharge(): Promise<void> { throw new PartnerError('Minimum UPay gross recharge is 20 USDT', false); }
    }
    ctx = await createTestContext((db) => new MinimumPartner(db));
    const { client } = await verifiedUserWithFunds(ctx, '100');
    const issued = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: key() });
    await ctx.settle();
    const response = await client.post(`/v1/cards/${issued.body.card.id}/topup`, { asset: 'USDT', amount: '10', idempotencyKey: key() });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('20 USDT');
    expect((await client.get('/v1/wallet')).body.balances[0].amount).toBe('90');
    expect((await ctx.db.execute(sql`select count(*)::int as count from card_operations where type = 'topup'`)).rows[0]).toEqual({ count: 0 });
  });

  it('quotes the effective wallet minimum from the owned card tariff before holding money', async () => {
    class LiveMinimumPartner extends MockUpayPartner {
      async getRechargeMinimum(): Promise<bigint> { return 1986n; }
    }
    ctx = await createTestContext((db) => new LiveMinimumPartner(db));
    const { client } = await verifiedUserWithFunds(ctx, '100');
    const issued = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: key() });
    await ctx.settle();
    const cardId = issued.body.card.id;
    const low = await client.get(`/v1/cards/topup-quote?asset=USDT&amount=20&cardId=${cardId}`);
    expect(low.status).toBe(422);
    expect(low.body.error).toMatchObject({ code: 'amount_too_small', minAmount: '20.17', asset: 'USDT' });
    const quote = await client.get(`/v1/cards/topup-quote?asset=USDT&amount=20.17&cardId=${cardId}`);
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({ minAmount: '20.17', netUsd: '19.86' });
    const rejected = await client.post(`/v1/cards/${cardId}/topup`, { asset: 'USDT', amount: '20', idempotencyKey: key() });
    expect(rejected.status).toBe(422);
    expect((await client.get('/v1/wallet')).body.balances[0].amount).toBe('90');
    expect((await ctx.db.execute(sql`select count(*)::int as count from card_operations where type = 'topup'`)).rows[0]).toEqual({ count: 0 });
    const stranger = api(ctx, (await registerUser(ctx)).token);
    expect((await stranger.get(`/v1/cards/topup-quote?asset=USDT&amount=20.17&cardId=${cardId}`)).status).toBe(404);
    const accepted = await client.post(`/v1/cards/${cardId}/topup`, { asset: 'USDT', amount: '20.17', idempotencyKey: key() });
    expect(accepted.status).toBe(202);
    await ctx.settle();
    expect((await client.get(`/v1/cards/${cardId}`)).body.balance).toBe('19.86');
  });

  it('books verified partner costs separately and rewards only the remaining margin', async () => {
    class CostedPartner extends MockUpayPartner {
      async getIssueSettlement(): Promise<{ grossUsd: bigint }> { return { grossUsd: 1000n }; }
      async getRechargeSettlement(): Promise<{ grossUsd: bigint }> { return { grossUsd: 4960n }; }
    }
    ctx = await createTestContext((db) => new CostedPartner(db));
    const inviter = await verifiedUserWithFunds(ctx, '0');
    const referral = (await inviter.client.get('/v1/referral')).body;
    const code = /start=ref_([a-z0-9]+)$/.exec(referral.link)![1]!;
    const { client } = await verifiedUserWithFunds(ctx, '100', `ref_${code}`);
    const issued = await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: key() });
    await ctx.settle();
    const topup = await client.post(`/v1/cards/${issued.body.card.id}/topup`, { asset: 'USDT', amount: '50', idempotencyKey: key() });
    await ctx.settle();
    expect((await client.get(`/v1/operations/${topup.body.id}`)).body.status).toBe('succeeded');
    expect((await client.get('/v1/wallet')).body.balances[0].amount).toBe('40');
    expect((await client.get(`/v1/cards/${issued.body.card.id}`)).body.balance).toBe('49.25');
    const costs = await ctx.db.execute(sql`select code, balance::text as balance from ledger_accounts where code in ('system:fees:USDT', 'system:partner_funding:USDT') order by code`);
    expect(costs.rows).toEqual([{ code: 'system:fees:USDT', balance: '320000' }, { code: 'system:partner_funding:USDT', balance: '59600000' }]);
    expect((await inviter.client.get('/v1/wallet')).body.balances[0].amount).toBe('0.08');
  });

  it('enforces the card limit', async () => {
    ctx = await createTestContext();
    const { client } = await verifiedUserWithFunds(ctx, '100');
    for (let i = 0; i < 3; i++) { expect((await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: key() })).status).toBe(202); await ctx.settle(); }
    expect((await client.post('/v1/cards', { asset: 'USDT', idempotencyKey: key() })).body.error.code).toBe('card_limit');
  });

  it('credits each deposit exactly once', async () => {
    ctx = await createTestContext();
    const { client } = await verifiedUserWithFunds(ctx, '0');
    await client.post('/v1/dev/deposit', { asset: 'USDC', network: 'ERC20', amount: '25.5' });
    const address = (await client.get('/v1/deposits/address?asset=USDC&network=ERC20')).body;
    expect(address.demo).toBe(true);
    expect(address.address).toMatch(/^GUDEX-DEMO:ERC20:[0-9a-f]{20}$/);
    const ton = (await client.get('/v1/deposits/address?asset=USDT&network=TON')).body;
    expect(ton.demo).toBe(true);
    expect(ton.address).toMatch(/^GUDEX-DEMO:TON:[0-9a-f]{20}$/);
    expect((await client.get('/v1/deposits/address?asset=USDC&network=TRC20')).status).toBe(400);
    expect((await client.get('/v1/wallet')).body.balances).toEqual([
      { asset: 'USDT', amount: '0' },
      { asset: 'USDC', amount: '25.5' },
    ]);
  });
});

