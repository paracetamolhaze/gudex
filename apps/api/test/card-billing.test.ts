import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { cardBillingAddresses, kycProfiles, users } from '../src/db/schema';
import { CardBillingService } from '../src/services/card-billing';
import type { UpayClient } from '../src/partner/upay/client';
import { UpayError } from '../src/partner/upay/transport';
import { PartnerCardRegionRestrictedError } from '../src/partner/types';
import { createTestContext, registerUser, telegramLogin, type TestContext } from './helpers';

let ctx: TestContext | undefined;
afterEach(async () => { await ctx?.close(); ctx = undefined; });
const input = { countryId: 'COUNTRY-KZ', postalCode: '050000', address: 'Example Street 10, Almaty' };
const config = () => loadConfig({ ...process.env, JWT_SECRET: 'test-only-billing-secret-at-least-32', CARD_PARTNER: 'upay', DEV_TOOLS: 'false', UPAY_KYC_ENABLED: 'true',
  UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ' });

async function fixture() {
  ctx = await createTestContext();
  const userId = randomUUID();
  await ctx.db.insert(users).values({ id: userId, telegramId: 817421n });
  await ctx.db.insert(kycProfiles).values({ userId, status: 'approved', partnerProvider: 'upay', partnerCustomerId: 'OWN-CUSTOMER',
    firstName: 'TEST', lastName: 'USER', email: 'synthetic@example.test', phone: '7771234567', globalCode: '+7', submissionId: randomUUID() });
  const remote = { rows: [] as Record<string, unknown>[], details: new Map<string, Record<string, unknown>>(),
    failAfterCreate: false, publish: true, mismatch: false, reject: false, failInfo: false, beforeSubmit: undefined as (() => Promise<void>) | undefined };
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const client = {
    configured: true,
    readRequest: async (method: string, path: string, options?: { query?: Record<string, unknown> }) => {
      calls.push({ method, path });
      if (method !== 'GET') throw new Error('Unexpected non-GET read');
      if (path === '/common/countryAndRegion') return [{ id: input.countryId, name_en: 'Kazakhstan', code: 'KZ' }];
      if (path === '/card/getCardFee') return { customerNo: 'OWN-CUSTOMER', requiredInfo: true, addressType: '3', needParams: ['givenName', 'lastName', 'documentType'] };
      if (path === '/address/getSelectList') {
        expect(options?.query?.customerNo).toBe('OWN-CUSTOMER');
        return remote.rows;
      }
      if (path === '/address/info') {
        if (remote.failInfo) throw new Error('Synthetic upstream read unavailable');
        return remote.details.get(String(options?.query?.id));
      }
      throw new Error('Unexpected read endpoint');
    },
    submitRequest: async (path: string, body: Record<string, unknown>, options?: { beforeDispatch?: () => Promise<void> }) => {
      await remote.beforeSubmit?.();
      await options?.beforeDispatch?.();
      calls.push({ method: 'POST', path, body });
      expect(path).toBe('/address/edit');
      expect(body).toMatchObject({ type: 'ADD', id: '', isDefault: false });
      if (remote.reject) throw new UpayError('Synthetic business rejection', true, 9999, { phase: 'post_dispatched', ack: 'rejected_envelope', httpStatus: 200 });
      if (remote.publish) {
        const id = remote.rows.length ? `OWN-ADDRESS-${remote.rows.length + 1}` : 'OWN-ADDRESS';
        remote.rows.push({ id, tag: body.tag, name: body.name, address: body.address, isDefault: false });
        remote.details.set(id, { ...body, id, ...(remote.mismatch ? { email: 'foreign@example.test' } : {}) });
      }
      if (remote.failAfterCreate) throw new Error('Accepted by upstream but response lost');
      return null;
    },
  } as unknown as Pick<UpayClient, 'configured' | 'readRequest' | 'submitRequest'>;
  const service = new CardBillingService(ctx.db, config(), client);
  return { userId, remote, calls, client, service };
}

describe('owned billing address creation and verified readback', () => {
  it('checks the product restriction against the verified own billing code without changing the address or submitting anything', async () => {
    const f = await fixture();
    await f.service.save(f.userId, input);
    const before = await ctx!.db.select().from(cardBillingAddresses);
    f.calls.length = 0;

    await expect(f.service.getVerifiedAddressId('OWN-CUSTOMER', '+1-869,+7')).rejects.toBeInstanceOf(PartnerCardRegionRestrictedError);

    expect(await ctx!.db.select().from(cardBillingAddresses)).toEqual(before);
    expect(f.calls.map(call => call.path)).toEqual(['/address/getSelectList', '/address/info']);
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
    expect(await f.service.getVerifiedAddressId('FOREIGN-CUSTOMER', '+7')).toBeNull();
    expect(await f.service.getVerifiedAddressId('OWN-CUSTOMER', '+33')).toBe('OWN-ADDRESS');
  });

  it('never exposes or adopts a global address book entry, even one with matching contacts', async () => {
    const f = await fixture();
    f.remote.rows.push({ id: 'GLOBAL', tag: 'some-other-tag', address: 'Other customer private address', name: 'PRIVATE NAME' });
    expect(await f.service.get(f.userId)).toEqual({ required: true, status: 'missing', address: null });
    expect(await f.service.getVerifiedAddressId('OWN-CUSTOMER')).toBeNull();
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('creates only the explicit own address with KYC contacts, encrypts it and verifies marker plus detail', async () => {
    const f = await fixture();
    expect(await f.service.save(f.userId, input)).toEqual({ required: true, status: 'ready', address: input });
    expect(await f.service.getVerifiedAddressId('OWN-CUSTOMER')).toBe('OWN-ADDRESS');
    const writes = f.calls.filter(call => call.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toMatchObject({ name: 'TEST USER', phone: '7771234567', intlDialCode: '+7', email: 'synthetic@example.test', ...input });
    expect(writes[0]!.body!.tag).toMatch(/^GDXB[a-f0-9]{16}$/);
    const row = (await ctx!.db.select().from(cardBillingAddresses))[0]!;
    expect(JSON.stringify(row)).not.toContain(input.address);
    expect(JSON.stringify(row)).not.toContain('synthetic@example.test');
    expect(row).toMatchObject({ userId: f.userId, status: 'ready', partnerAddressId: 'OWN-ADDRESS' });
  });

  it('recovers an accepted creation with lost response without a second POST, including a new service instance', async () => {
    const f = await fixture();
    f.remote.failAfterCreate = true;
    expect(await f.service.save(f.userId, input)).toMatchObject({ status: 'ready' });
    const restarted = new CardBillingService(ctx!.db, config(), f.client);
    expect(await restarted.save(f.userId, input)).toMatchObject({ status: 'ready' });
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });

  it('retains an unresolved send and permits only marker lookup on retries or changed input', async () => {
    const f = await fixture();
    f.remote.failAfterCreate = true; f.remote.publish = false;
    expect(await f.service.save(f.userId, input)).toMatchObject({ status: 'pending' });
    expect(await f.service.save(f.userId, input)).toMatchObject({ status: 'pending' });
    await expect(f.service.save(f.userId, { ...input, address: 'Different Street 20' })).rejects.toMatchObject({ code: 'validation' });
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(await f.service.getVerifiedAddressId('OWN-CUSTOMER')).toBeNull();
  });

  it('reports a transient read failure as provider unavailable instead of asking for a new address', async () => {
    const f = await fixture();
    await f.service.save(f.userId, input);
    f.remote.failInfo = true;
    await expect(f.service.getVerifiedAddressId('OWN-CUSTOMER')).rejects.toMatchObject({ code: 'provider_unavailable', status: 503 });
    expect(await f.service.get(f.userId)).toMatchObject({ status: 'pending', address: input });
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    f.remote.failInfo = false;
    expect(await f.service.getVerifiedAddressId('OWN-CUSTOMER')).toBe('OWN-ADDRESS');
  });

  it('serializes concurrent explicit submissions and creates one address', async () => {
    const f = await fixture();
    await Promise.all([f.service.save(f.userId, input), f.service.save(f.userId, input)]);
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(await f.service.getVerifiedAddressId('OWN-CUSTOMER')).toBe('OWN-ADDRESS');
  });

  it('allows an explicit ready-address edit with a new private marker and leaves the old upstream entry intact', async () => {
    const f = await fixture();
    await f.service.save(f.userId, input);
    const original = (await ctx!.db.select().from(cardBillingAddresses))[0]!;
    const corrected = { ...input, address: 'Updated Street 30, Almaty' };
    expect(await f.service.save(f.userId, corrected)).toMatchObject({ status: 'ready', address: corrected });
    const updated = (await ctx!.db.select().from(cardBillingAddresses))[0]!;
    expect(updated.marker).not.toBe(original.marker);
    expect(await f.service.getVerifiedAddressId('OWN-CUSTOMER')).toBe('OWN-ADDRESS-2');
    expect(f.remote.details.get('OWN-ADDRESS')!.address).toBe(input.address);
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(2);
    expect(f.calls.filter(call => call.method === 'POST').every(call => call.path === '/address/edit' && call.body?.type === 'ADD' && call.body.id === '')).toBe(true);
    expect(await f.service.save(f.userId, corrected)).toMatchObject({ status: 'ready' });
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(2);
  });

  it('allows correcting a proven business-rejected metadata request while unknown submissions remain protected', async () => {
    const f = await fixture();
    f.remote.reject = true;
    expect(await f.service.save(f.userId, input)).toMatchObject({ status: 'missing', address: input });
    expect(await f.service.get(f.userId)).toMatchObject({ status: 'missing' });
    const rejected = (await ctx!.db.select().from(cardBillingAddresses))[0]!;
    f.remote.reject = false;
    const corrected = { ...input, address: 'Corrected Street 20, Almaty' };
    expect(await f.service.save(f.userId, corrected)).toMatchObject({ status: 'ready', address: corrected });
    const ready = (await ctx!.db.select().from(cardBillingAddresses))[0]!;
    expect(ready.marker).not.toBe(rejected.marker);
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(2);
  });

  it.each(['duplicate marker', 'wrong detail', 'foreign customer', 'changed generation'] as const)('rejects unsafe verified binding: %s', async scenario => {
    const f = await fixture();
    f.remote.mismatch = scenario === 'wrong detail';
    await f.service.save(f.userId, input);
    if (scenario === 'duplicate marker') f.remote.rows.push({ ...f.remote.rows[0], id: 'DUPLICATE' });
    if (scenario === 'foreign customer') await ctx!.db.update(kycProfiles).set({ partnerCustomerId: 'CHANGED' }).where(eq(kycProfiles.userId, f.userId));
    if (scenario === 'changed generation') await ctx!.db.update(kycProfiles).set({ submissionId: randomUUID() }).where(eq(kycProfiles.userId, f.userId));
    expect(await f.service.getVerifiedAddressId('OWN-CUSTOMER')).toBeNull();
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });

  it('rechecks the approved owner after authentication immediately before dispatch', async () => {
    const f = await fixture();
    f.remote.beforeSubmit = async () => { await ctx!.db.update(kycProfiles).set({ status: 'unknown' }).where(eq(kycProfiles.userId, f.userId)); };
    await f.service.save(f.userId, input);
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(0);
  });

  it.each([{ ...input, countryId: 'NOT-ALLOWED' }, { ...input, postalCode: '123' }, { ...input, address: 'Невалидно' }])
    ('validates native fields and actual country catalogue before any external write', async invalid => {
      const f = await fixture();
      await expect(f.service.save(f.userId, invalid)).rejects.toMatchObject({ code: 'validation' });
      expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(0);
      expect(await ctx!.db.select().from(cardBillingAddresses)).toHaveLength(0);
    });

  it('requires an unlocked session and accepts only address fields at the API boundary', async () => {
    ctx = await createTestContext();
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/cards/billing-address' })).statusCode).toBe(401);
    const user = await registerUser(ctx);
    const locked = await telegramLogin(ctx, user.telegramId);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/cards/billing-address', headers: { authorization: `Bearer ${locked.accessToken}` } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'PUT', url: '/v1/cards/billing-address', headers: { authorization: `Bearer ${user.token}` }, payload: { ...input, customerNo: 'FOREIGN' } })).statusCode).toBe(400);
  });
});
