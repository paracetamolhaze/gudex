import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PartnerError } from '../src/partner/types';
import { AppError } from '../src/lib/errors';
import { api, assertLedgerConsistent, createTestContext, makeInitData, registerUser, TEST_PIN, type TestContext, verifiedUserWithFunds } from './helpers';

let ctx: TestContext;
afterEach(async () => {
  await assertLedgerConsistent(ctx.db);
  await ctx.close();
});

const key = () => randomUUID();
const TRON_ADDRESS = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
const EVM_ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';

type Client = ReturnType<typeof api>;

async function confirmation(client: Client): Promise<Record<string, string>> {
  const res = await client.post('/v1/security/confirm', { pin: TEST_PIN });
  return { 'x-confirmation-token': res.body.confirmationToken };
}

const usdt = async (client: Client) => (await client.get('/v1/wallet')).body.balances.find((b: { asset: string }) => b.asset === 'USDT').amount;

describe('networks', () => {
  it('offers BEP20 and Polygon for deposits and rejects unsupported pairs', async () => {
    ctx = await createTestContext();
    const { token } = await registerUser(ctx);
    const client = api(ctx, token);

    const config = await client.get('/v1/config');
    const usdc = config.body.assets.find((a: { asset: string }) => a.asset === 'USDC');
    expect(usdc.networks.map((n: { id: string }) => n.id)).toEqual(['BEP20', 'POLYGON', 'ERC20']);
    expect(usdc.networks[0]).toMatchObject({ short: 'BEP20', withdrawFee: '0.5', minWithdraw: '5' });

    const bep20 = await client.get('/v1/deposits/address?asset=USDC&network=BEP20');
    expect(bep20.body.demo).toBe(true);
    expect(bep20.body.address).toMatch(/^GUDEX-DEMO:BEP20:[0-9a-f]{20}$/);
    expect((await client.get('/v1/deposits/address?asset=USDC&network=TON')).status).toBe(400);
  });
});

describe('withdrawals', () => {
  it('reserves funds, sends in the background and shows up in history', async () => {
    ctx = await createTestContext();
    const { client } = await verifiedUserWithFunds(ctx, '100');
    const body = { asset: 'USDT', network: 'TRC20', address: TRON_ADDRESS, amount: '50', idempotencyKey: key() };

    // Без подтверждения кодом деньги не уходят.
    expect((await client.post('/v1/withdrawals', body)).body.error.code).toBe('unlock_required');

    const headers = await confirmation(client);
    expect((await client.post('/v1/withdrawals', { ...body, address: EVM_ADDRESS }, headers)).body.error.code).toBe('invalid_address');
    expect((await client.post('/v1/withdrawals', { ...body, amount: '5' }, headers)).body.error.code).toBe('amount_too_small');

    const created = await client.post('/v1/withdrawals', body, headers);
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({ status: 'pending', amount: '50', fee: '2', netAmount: '48' });
    expect(await usdt(client)).toBe('50');

    // Повтор с тем же ключом — тот же вывод, второй раз не списывается.
    const again = await client.post('/v1/withdrawals', body, headers);
    expect(again.body.id).toBe(created.body.id);
    expect(await usdt(client)).toBe('50');

    await ctx.settle();
    const done = await client.get(`/v1/withdrawals/${created.body.id}`);
    expect(done.body.status).toBe('succeeded');
    expect(done.body.txHash).toBeTruthy();

    const activity = await client.get('/v1/activity');
    expect(activity.body[0]).toMatchObject({ kind: 'withdrawal', amount: '-50', fee: '2', counterparty: TRON_ADDRESS, network: 'TRC20' });
    expect(ctx.bot.sent.some((m) => m.text.includes('Вывод <b>48 USDT</b>'))).toBe(true);
  });

  it('returns the money when the provider rejects the transfer', async () => {
    ctx = await createTestContext(undefined, {
      withdrawalProvider: {
        send: async () => {
          throw new PartnerError('rejected by provider', false);
        },
      },
    });
    const { client } = await verifiedUserWithFunds(ctx, '100');
    const created = await client.post(
      '/v1/withdrawals',
      { asset: 'USDT', network: 'BEP20', address: EVM_ADDRESS, amount: '20', idempotencyKey: key() },
      await confirmation(client),
    );
    expect(await usdt(client)).toBe('80');
    await ctx.settle();
    expect((await client.get(`/v1/withdrawals/${created.body.id}`)).body).toMatchObject({ status: 'failed', error: 'rejected by provider' });
    expect(await usdt(client)).toBe('100');
  });

  it('keeps an uncertain withdrawal reserved and only reconciles by reference', async () => {
    let submissions = 0;
    let sent = false;
    let lookupUnavailable = true;
    const txHash = `0x${'a'.repeat(64)}`;
    ctx = await createTestContext(undefined, {
      withdrawalProvider: {
        send: async () => {
          submissions++;
          sent = true;
          throw new Error('response lost after broadcast');
        },
        findByReference: async () => {
          if (!sent) return null;
          if (lookupUnavailable) throw new Error('lookup unavailable');
          return { txHash };
        },
      },
    });
    const { client } = await verifiedUserWithFunds(ctx, '100');
    const created = await client.post('/v1/withdrawals', { asset: 'USDT', network: 'BEP20', address: EVM_ADDRESS, amount: '20', idempotencyKey: key() }, await confirmation(client));
    await ctx.settle();
    expect((await client.get(`/v1/withdrawals/${created.body.id}`)).body.status).toBe('unknown');
    expect(await usdt(client)).toBe('80');
    expect(await ctx.services.withdrawals.listUnknown()).toHaveLength(1);
    expect((await client.post('/v1/withdrawals', { asset: 'USDT', network: 'BEP20', address: EVM_ADDRESS, amount: '20', idempotencyKey: key() }, await confirmation(client))).status).toBe(503);
    expect((await ctx.services.withdrawals.reconcileUnknown(created.body.id)).status).toBe('unknown');
    expect(submissions).toBe(1);
    lookupUnavailable = false;
    expect((await ctx.services.withdrawals.reconcileUnknown(created.body.id))).toMatchObject({ status: 'succeeded', txHash });
    expect(await usdt(client)).toBe('80');
    expect(submissions).toBe(1);
  });

  it('never replays an uncertain withdrawal when the provider has no lookup method', async () => {
    let submissions = 0;
    ctx = await createTestContext(undefined, { withdrawalProvider: { send: async () => { submissions++; throw new Error('unconfirmed broadcast'); } } });
    const { client } = await verifiedUserWithFunds(ctx, '100');
    const created = await client.post('/v1/withdrawals', { asset: 'USDT', network: 'BEP20', address: EVM_ADDRESS, amount: '20', idempotencyKey: key() }, await confirmation(client));
    await ctx.settle();
    expect((await ctx.services.withdrawals.reconcileUnknown(created.body.id)).status).toBe('unknown');
    expect(await usdt(client)).toBe('80');
    expect(submissions).toBe(1);
  });

  it('checks withdrawal availability before reserving funds', async () => {
    let sends = 0;
    ctx = await createTestContext(undefined, { withdrawalProvider: {
      assertAvailable: () => { throw new AppError('provider_unavailable', 'withdrawals disabled'); },
      send: async () => { sends++; return { txHash: 'unused' }; },
    } });
    const { client } = await verifiedUserWithFunds(ctx, '100');
    const response = await client.post('/v1/withdrawals', { asset: 'USDT', network: 'BEP20', address: EVM_ADDRESS, amount: '20', idempotencyKey: key() }, await confirmation(client));
    expect(response.status).toBe(503);
    expect(await usdt(client)).toBe('100');
    expect(sends).toBe(0);
  });
});

describe('transfers', () => {
  it('sends money to another GUDEX user by @username', async () => {
    ctx = await createTestContext();
    const sender = await verifiedUserWithFunds(ctx, '100');
    const recipient = await registerUser(ctx);
    const recipientClient = api(ctx, recipient.token);
    const username = `user${recipient.telegramId}`;

    // Регистр и @ не важны, как в Telegram.
    const found = await sender.client.get(`/v1/transfers/recipient?username=@${username.toUpperCase()}`);
    expect(found.body).toEqual({ username, name: 'Ivan' });
    expect((await sender.client.get('/v1/transfers/recipient?username=nobody_here')).body.error.code).toBe('recipient_not_found');
    expect((await sender.client.get(`/v1/transfers/recipient?username=user${sender.telegramId}`)).body.error.code).toBe('self_transfer');

    const body = { username, asset: 'USDT', amount: '25', idempotencyKey: key() };
    expect((await sender.client.post('/v1/transfers', body)).body.error.code).toBe('unlock_required');
    const headers = await confirmation(sender.client);
    const sent = await sender.client.post('/v1/transfers', body, headers);
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ amount: '25', recipient: { username } });
    expect((await sender.client.post('/v1/transfers', body, headers)).body.id).toBe(sent.body.id);

    expect(await usdt(sender.client)).toBe('75');
    expect(await usdt(recipientClient)).toBe('25');
    expect((await recipientClient.get('/v1/activity')).body[0]).toMatchObject({
      kind: 'transfer_in',
      amount: '+25',
      counterparty: `@user${sender.telegramId}`,
    });
    expect((await sender.client.get('/v1/activity')).body[0]).toMatchObject({ kind: 'transfer_out', amount: '-25', counterparty: `@${username}` });

    await ctx.settle();
    expect(ctx.bot.sent.some((m) => m.text.includes(`Перевод от @user${sender.telegramId}`))).toBe(true);

    const tooMuch = await sender.client.post('/v1/transfers', { ...body, amount: '1000', idempotencyKey: key() }, headers);
    expect(tooMuch.body.error.code).toBe('insufficient_funds');

    // Без верификации переводить нельзя (получать — можно).
    const back = await recipientClient.post(
      '/v1/transfers',
      { username: `user${sender.telegramId}`, asset: 'USDT', amount: '5', idempotencyKey: key() },
      await confirmation(recipientClient),
    );
    expect(back.body.error.code).toBe('kyc_required');
  });
});

describe('referrals', () => {
  it('pays the inviter a share of card fees, whichever way the friend arrived', async () => {
    ctx = await createTestContext();
    const inviter = await verifiedUserWithFunds(ctx, '100');
    const referral = await inviter.client.get('/v1/referral');
    expect(referral.body).toMatchObject({ invited: 0, shareBps: 2000 });
    const code = /start=ref_([a-z0-9]+)$/.exec(referral.body.link)![1]!;
    expect((await inviter.client.get('/v1/referral')).body.link).toBe(referral.body.link);

    // Друг открыл Mini App по ссылке и выпустил карту: 20% от $10 — пригласившему.
    const friend = await verifiedUserWithFunds(ctx, '100', `ref_${code}`);
    await friend.client.post('/v1/cards', { asset: 'USDT', idempotencyKey: key() });
    await ctx.settle();
    const card = (await friend.client.get('/v1/cards')).body[0];
    await friend.client.post(`/v1/cards/${card.id}/topup`, { asset: 'USDT', amount: '50', idempotencyKey: key() });
    await ctx.settle();

    expect(await usdt(inviter.client)).toBe('102.15');
    const after = await inviter.client.get('/v1/referral');
    expect(after.body.invited).toBe(1);
    expect(after.body.earned.find((e: { asset: string }) => e.asset === 'USDT').amount).toBe('2.15');
    expect((await inviter.client.get('/v1/activity')).body.filter((a: { kind: string }) => a.kind === 'referral_reward')).toHaveLength(2);

    // Уже зарегистрированного пользователя ссылка не «переманивает».
    const existing = await registerUser(ctx);
    const relogin = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/telegram',
      payload: { initData: makeInitData(existing.telegramId, { startParam: `ref_${code}` }) },
    });
    expect(relogin.statusCode).toBe(200);
    expect((await inviter.client.get('/v1/referral')).body.invited).toBe(1);

    // Друг нажал «Старт» в боте по ссылке-приглашению — запомнили сразу, до открытия приложения.
    await ctx.services.bot.handleUpdate({
      message: { chat: { id: 5000 }, from: { id: 5000, first_name: 'Bot', username: 'from_bot' }, text: `/start ref_${code}` },
    });
    expect((await inviter.client.get('/v1/referral')).body.invited).toBe(2);
    await assertLedgerConsistent(ctx.db);
  });
});

describe('service notice', () => {
  it('is switched on and off by an admin through the bot', async () => {
    ctx = await createTestContext();
    const read = async () => (await ctx.app.inject({ method: 'GET', url: '/v1/notice' })).json();
    expect(await read()).toEqual({ message: null, updatedAt: null });

    const say = (fromId: number, text: string) =>
      ctx.services.bot.handleUpdate({ message: { chat: { id: fromId }, from: { id: fromId, first_name: 'X' }, text } });

    await say(12345, '/notice Взлом!');
    expect((await read()).message).toBeNull();

    await say(999, '/notice Задержка зачислений в сети TRC20');
    expect((await read()).message).toBe('Задержка зачислений в сети TRC20');
    await say(999, '/notice off');
    expect((await read()).message).toBeNull();

    await say(12345, '/id');
    expect(ctx.bot.sent.at(-1)?.text).toContain('<code>12345</code>');
  });
});

describe('exchange (WhiteBird)', () => {
  it('keeps WhiteBird disabled for demo deposits even when merchant credentials are configured', async () => {
    ctx = await createTestContext();
    const { token } = await registerUser(ctx);
    const client = api(ctx, token);
    expect((await client.get('/v1/config')).body.exchange).toEqual({ provider: 'whitebird', ready: false });
    const soon = (await client.get('/v1/exchange/session')).body;
    expect(soon).toMatchObject({ ready: false, merchantId: null, options: [], mode: 'AuthMode' });
    // Скрипт SDK отдаётся всегда (дефолтный CDN), ключей — нет.
    expect(soon.sdkUrl).toContain('sdk.whitebird.io');
    await ctx.close();

    ctx = await createTestContext(undefined, {
      env: { WHITEBIRD_MERCHANT_ID: 'm-1', WHITEBIRD_MERCHANT_PASS: 'basic', WHITEBIRD_COLOR: '#2E66E9' },
    });
    const user = await registerUser(ctx);
    const configured = api(ctx, user.token);
    expect((await configured.get('/v1/config')).body.exchange.ready).toBe(false);
    const session = await configured.get('/v1/exchange/session');
    expect(session.body).toMatchObject({ ready: false, merchantId: null, merchantPass: null, options: [], mode: 'AuthMode', themeMode: 'dark', color: '#2E66E9', locale: 'ru' });

    // Без входа ключи не выдаются.
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/exchange/session' })).statusCode).toBe(401);
  });
});
