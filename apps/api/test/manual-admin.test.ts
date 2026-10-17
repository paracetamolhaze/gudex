import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { adminAuditLog, cardOperations, cards, jobs, kycDocuments, kycProfiles, ledgerEntries, users } from '../src/db/schema';
import { DbKycDocumentStore } from '../src/kyc/document-store';
import type { UpayClient } from '../src/partner/upay/client';
import type { CardService } from '../src/services/cards';
import { ManualAdminService } from '../src/services/manual-admin';
import { api, createTestContext, registerUser, telegramLogin, TEST_BOT_TOKEN, TEST_PIN, type TestContext } from './helpers';

let ctx: TestContext;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
const productId = '2040769880440840193';
const env = { CARD_ISSUANCE_MODE: 'manual', ADMIN_TELEGRAM_IDS: '999', CARD_REMINDER_MINUTES: '0' };
const config = () => loadConfig({ ...process.env, ...env, TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN, CARD_PARTNER: 'upay',
  UPAY_LOGIN: 'synthetic-login', UPAY_PASSWORD: 'synthetic-password', UPAY_TOTP_SECRET: 'JBSWY3DPEHPK3PXP', DEV_TOOLS: 'false' });

beforeEach(async () => { ctx = await createTestContext(undefined, { env }); });
afterEach(async () => { await ctx.close(); vi.restoreAllMocks(); });

async function fixture() {
  const [admin] = await ctx.db.insert(users).values({ telegramId: 999n }).returning();
  const [user] = await ctx.db.insert(users).values({ telegramId: 1001n }).returning();
  const [foreign] = await ctx.db.insert(users).values({ telegramId: 1002n }).returning();
  const store = new DbKycDocumentStore(ctx.db, config().appSecret);
  const front = await store.put(user!.id, { kind: 'front', mimeType: 'image/png', base64: png });
  const submissionId = randomUUID();
  await ctx.db.insert(kycProfiles).values({ userId: user!.id, partnerProvider: 'upay', status: 'pending', submissionState: 'manual_review',
    submissionId, firstName: 'Ivan', lastName: 'Petrov', email: 'ivan@example.test', phone: '2025550100', globalCode: '+1',
    documentType: 'passport', citizenship: 'KZ', documentCountry: 'KZ', birthDate: '1990-05-01', documentIds: { front: front.id }, submittedAt: new Date() });
  const customer: Record<string, unknown> = { customerId: 'customer_id', no: 'customer_no', givenName: 'Ivan', lastName: 'Petrov',
    email: 'ivan@example.test', phone: '2025550100', globalCode: '+1' };
  const info: Record<string, unknown> = { authResult: 1, primaryApprovedNum: 1, items: [{ documentType: 2, level: 1, status: 1 }] };
  const detail: Record<string, unknown> = { agentCustomerCardId: 'native_card', accountCardId: 'account_card', brokerCardId: 'broker_card',
    customerNo: 'customer_no', cardStatus: 1, agentCardId: productId, cardSignatureName: 'Ivan Petrov', cardNumber: '****4242', expirationTime: '12/30' };
  const receipt: Record<string, unknown> = { orderNo: 'native_order', cardId: 'broker_card', customerNo: 'customer_no', status: 1,
    currency: 'USDT', paymentAmount: '10.00', openCardAmount: '10.00', rechargeAmount: '0.00' };
  const readRequest = vi.fn(async (method: string, path: string) => {
    if (method === 'GET' && path === '/customer/get') return customer;
    if (method === 'GET' && path === '/kyc/info') return info;
    if (method === 'GET' && path === '/card/getAgentCustomerCardDetail') return detail;
    if (method === 'GET' && path === '/card/list') return { pageNo: 1, totalPages: 1, list: [detail] };
    if (method === 'POST' && path === '/card/getPageToCardOperateRecord') return { pageNo: 1, totalPages: 1, list: [receipt] };
    throw new Error('Unexpected provider endpoint');
  });
  const loginInfo = vi.fn(async () => ({ id: 'synthetic_member', iv: 'synthetic_iv_1234' }));
  const complete = vi.fn(async () => {});
  const service = new ManualAdminService(ctx.db, config(), { readRequest, loginInfo } as unknown as Pick<UpayClient, 'readRequest' | 'loginInfo'>,
    { completeManualIssue: complete } as unknown as CardService);
  const approve = () => service.approveKyc(admin!.id, user!.id, { submissionId, customerId: 'customer_id', customerNo: 'customer_no', documentsMatch: true });
  const operation = async (mode: 'manual' | 'automatic' = 'manual', status: 'pending' | 'unknown' = 'pending') => {
    await ctx.db.update(kycProfiles).set({ status: 'approved', submissionState: 'manual_verified', partnerCustomerId: 'customer_no' }).where(eq(kycProfiles.userId, user!.id));
    const [card] = await ctx.db.insert(cards).values({ userId: user!.id, status: 'pending', productName: 'Synthetic Premier' }).returning();
    const [op] = await ctx.db.insert(cardOperations).values({ userId: user!.id, cardId: card!.id, type: 'issue', status,
      asset: 'USDT', amount: 0n, fee: 10_000000n, partnerProvider: 'upay', fulfillmentMode: mode, idempotencyKey: randomUUID() }).returning();
    return op!;
  };
  return { admin: admin!, user: user!, foreign: foreign!, front, store, submissionId, customer, info, detail, receipt,
    readRequest, loginInfo, complete, service, approve, operation };
}

describe('manual administrator boundary', () => {
  it('requires an unlocked allowlisted Telegram session, hides data from OPS/user tokens, and never caches errors', async () => {
    const outsider = await registerUser(ctx);
    const locked = await telegramLogin(ctx, 999);
    for (const token of [undefined, 'synthetic-ops-token', outsider.token, locked.accessToken]) {
      const response = await ctx.app.inject({ method: 'GET', url: '/v1/admin/applications', headers: token ? { authorization: `Bearer ${token}` } : {} });
      expect([401, 403]).toContain(response.statusCode);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain('items');
    }
    const unlocked = await api(ctx, locked.accessToken).post('/v1/security/pin', { pin: TEST_PIN });
    const token = unlocked.body.accessToken;
    expect((await api(ctx, token).get('/v1/admin/me')).body).toEqual({ isAdmin: true });
    const response = await ctx.app.inject({ method: 'POST', url: `/v1/admin/clients/${randomUUID()}/reject`,
      headers: { authorization: `Bearer ${token}` }, payload: { submissionId: randomUUID(), reason: 'Needs correction' } });
    expect(response.statusCode).toBe(403);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rejects unexpected identity/financial fields even with an admin confirmation', async () => {
    const locked = await telegramLogin(ctx, 999);
    const { body: unlocked } = await api(ctx, locked.accessToken).post('/v1/security/pin', { pin: TEST_PIN });
    const { body: confirmation } = await api(ctx, unlocked.accessToken).post('/v1/security/confirm', { pin: TEST_PIN });
    for (const [path, payload] of [
      ['kyc', { submissionId: randomUUID(), customerId: 'exact', customerNo: 'exact', documentsMatch: true, approved: true }],
      ['card', { operationId: randomUUID(), partnerCardId: 'exact', orderNo: 'exact', pan: 'DO_NOT_ACCEPT' }],
    ] as const) {
      const response = await api(ctx, unlocked.accessToken).post(`/v1/admin/clients/${randomUUID()}/${path}`, payload,
        { 'x-confirmation-token': confirmation.confirmationToken });
      expect(response.status).toBe(400);
    }
  });

  it('shows unresolved automatic work without making it eligible for manual binding', async () => {
    const f = await fixture();
    const op = await f.operation('automatic', 'unknown');
    const list = await f.service.applications(f.admin.id, { page: 1, limit: 20 });
    expect(list.items).toMatchObject([{ userId: f.user.id, hasPendingCard: true }]);
    await expect(f.service.bindCard(f.admin.id, f.user.id, { operationId: op.id, partnerCardId: 'native_card', orderNo: 'native_order' })).rejects.toMatchObject({ code: 'validation' });
    expect(f.readRequest).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
  });

  it('only reveals active current-owned document bytes to admins, records access and never exposes ciphertext', async () => {
    const f = await fixture();
    const foreignDoc = await f.store.put(f.foreign.id, { kind: 'front', mimeType: 'image/png', base64: png });
    await expect(f.service.document(f.user.id, f.user.id, f.front.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(f.service.document(f.admin.id, f.user.id, foreignDoc.id)).rejects.toMatchObject({ code: 'not_found' });
    const result = await f.service.document(f.admin.id, f.user.id, f.front.id);
    expect(result).toEqual({ id: f.front.id, kind: 'front', mimeType: 'image/png', base64: png });
    expect(await ctx.db.select().from(adminAuditLog)).toHaveLength(1);
    await ctx.db.update(kycDocuments).set({ expiresAt: new Date(0) }).where(eq(kycDocuments.id, f.front.id));
    await expect(f.service.document(f.admin.id, f.user.id, f.front.id)).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('manual identity approval', () => {
  it('requires real provider identity+approval, commits approval/audit/notification and deletes only own submitted photos', async () => {
    const f = await fixture();
    const foreignDoc = await f.store.put(f.foreign.id, { kind: 'front', mimeType: 'image/png', base64: png });
    const result = await f.approve();
    expect(result.kyc).toMatchObject({ status: 'approved', submissionState: 'manual_verified', partnerCustomerId: 'customer_no', documents: [] });
    expect(f.readRequest.mock.calls.map(call => call.slice(0, 2))).toEqual([['GET', '/customer/get'], ['GET', '/kyc/info']]);
    expect((await ctx.db.select().from(kycDocuments)).map(row => row.id)).toEqual([foreignDoc.id]);
    expect(await ctx.db.select().from(adminAuditLog)).toHaveLength(1);
    expect((await ctx.db.select().from(jobs)).filter(row => row.queue === 'notify')).toHaveLength(1);
    expect(await ctx.db.select().from(ledgerEntries)).toEqual([]);
    await expect(f.approve()).rejects.toMatchObject({ code: 'validation' });
    expect(await ctx.db.select().from(adminAuditLog)).toHaveLength(1);
  });

  it.each(['givenName', 'lastName', 'email', 'phone', 'globalCode', 'customerId', 'no'])('rejects a mismatching provider %s without approving or deleting photos', async key => {
    const f = await fixture();
    f.customer[key] = 'foreign_value';
    await expect(f.approve()).rejects.toMatchObject({ code: 'validation' });
    expect((await ctx.db.select().from(kycProfiles))[0]!.status).toBe('pending');
    expect(await ctx.db.select().from(kycDocuments)).toHaveLength(1);
    expect(await ctx.db.select().from(adminAuditLog)).toEqual([]);
  });

  it.each([2, 3, 4, '1'])('does not mistake provider document status %s for approval', async status => {
    const f = await fixture();
    f.info.items = [{ documentType: 2, level: 1, status }];
    await expect(f.approve()).rejects.toMatchObject({ code: 'validation' });
    expect(await ctx.db.select().from(adminAuditLog)).toEqual([]);
  });

  it('rechecks generation after provider reads and does not overwrite a new submission', async () => {
    const f = await fixture();
    const next = randomUUID();
    f.readRequest.mockImplementationOnce(async () => {
      await ctx.db.update(kycProfiles).set({ submissionId: next, updatedAt: new Date() }).where(eq(kycProfiles.userId, f.user.id));
      return f.customer;
    });
    await expect(f.approve()).rejects.toMatchObject({ code: 'validation' });
    expect((await ctx.db.select().from(kycProfiles))[0]).toMatchObject({ submissionId: next, status: 'pending' });
    expect(await ctx.db.select().from(adminAuditLog)).toEqual([]);
  });

  it('rejects a customer already assigned locally and cannot approve while an automatic job is active', async () => {
    const f = await fixture();
    await ctx.db.insert(kycProfiles).values({ userId: f.foreign.id, partnerProvider: 'upay', partnerCustomerId: 'customer_no' });
    await expect(f.approve()).rejects.toMatchObject({ code: 'validation' });
    await ctx.db.delete(kycProfiles).where(eq(kycProfiles.userId, f.foreign.id));
    await ctx.db.insert(jobs).values({ queue: 'kyc.submit', payload: { userId: f.user.id, submissionId: f.submissionId } });
    f.readRequest.mockClear();
    await expect(f.approve()).rejects.toMatchObject({ code: 'validation' });
    expect(f.readRequest).not.toHaveBeenCalled();
    expect(await ctx.db.select().from(adminAuditLog)).toEqual([]);
  });

  it('rejects only the current manual verification without touching money or provider', async () => {
    const f = await fixture();
    await expect(f.service.rejectKyc(f.admin.id, f.user.id, { submissionId: randomUUID(), reason: 'Photo not clear' })).rejects.toMatchObject({ code: 'validation' });
    const result = await f.service.rejectKyc(f.admin.id, f.user.id, { submissionId: f.submissionId, reason: 'Photo not clear' });
    expect(result.kyc).toMatchObject({ status: 'rejected', submissionState: 'none' });
    expect(f.readRequest).not.toHaveBeenCalled();
    expect(await ctx.db.select().from(ledgerEntries)).toEqual([]);
    expect(await ctx.db.select().from(kycDocuments)).toEqual([]);
  });
});

describe('manual card proof', () => {
  it('returns only exact-customer card choices and never returns clear PAN/CVV or foreign records', async () => {
    const f = await fixture();
    await f.operation();
    f.readRequest.mockImplementationOnce(async () => ({ pageNo: 1, totalPages: 1, list: [
      { ...f.detail, cvv: 'SENSITIVE_SECRET' },
      { ...f.detail, agentCustomerCardId: 'other_own_card', cardNumber: 'SENSITIVE_CLEAR_PAN' },
      { ...f.detail, customerNo: 'foreign_customer', agentCustomerCardId: 'foreign_card', cardSignatureName: 'PRIVATE_FOREIGN_NAME' },
    ] }));
    const result = await f.service.providerCards(f.admin.id, f.user.id);
    expect(result).toEqual([
      { id: 'native_card', brokerCardId: 'broker_card', last4: '4242', state: 1, holderName: 'Ivan Petrov' },
      { id: 'other_own_card', brokerCardId: 'broker_card', last4: null, state: 1, holderName: 'Ivan Petrov' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SENSITIVE|PRIVATE_FOREIGN|foreign_card/);
  });

  it.each(['agentCustomerCardId', 'cardId'])('rejects contradictory receipt identifiers even when the other %s alias matches', async key => {
    const f = await fixture();
    const op = await f.operation();
    f.receipt.agentCustomerCardId = 'native_card';
    f.receipt[key] = 'foreign_card';
    await expect(f.service.bindCard(f.admin.id, f.user.id, { operationId: op.id, partnerCardId: 'native_card', orderNo: 'native_order' })).rejects.toMatchObject({ code: 'validation' });
    expect(f.complete).not.toHaveBeenCalled();
  });

  it('passes only the exact successful receipt and verified card display with a fresh local binding fence', async () => {
    const f = await fixture();
    const op = await f.operation();
    await f.service.bindCard(f.admin.id, f.user.id, { operationId: op.id, partnerCardId: 'native_card', orderNo: 'native_order' });
    expect(f.complete).toHaveBeenCalledExactlyOnceWith(f.admin.id, f.user.id, op.id,
      { partnerCardId: 'native_card', last4: '4242', expiryMonth: 12, expiryYear: 2030 },
      { grossUsd: 1000n, orderNo: 'native_order', partnerCustomerId: 'customer_no', submissionId: f.submissionId,
        productId, operationUpdatedAt: op.updatedAt.toISOString() });
    expect(f.readRequest.mock.calls.every(([method, path]) => method === 'GET' || path === '/card/getPageToCardOperateRecord')).toBe(true);
  });

  it.each(['customerNo', 'agentCustomerCardId', 'agentCardId', 'cardSignatureName', 'cardStatus'])('blocks a foreign/ineligible card %s before settlement', async key => {
    const f = await fixture();
    const op = await f.operation();
    f.detail[key] = key === 'cardStatus' ? 2 : 'foreign';
    await expect(f.service.bindCard(f.admin.id, f.user.id, { operationId: op.id, partnerCardId: 'native_card', orderNo: 'native_order' })).rejects.toMatchObject({ code: 'validation' });
    expect(f.complete).not.toHaveBeenCalled();
  });

  it.each(['orderNo', 'cardId', 'customerNo', 'currency', 'status', 'paymentAmount', 'rechargeAmount'])('blocks an unproven issuance receipt %s without settlement', async key => {
    const f = await fixture();
    const op = await f.operation();
    f.receipt[key] = key === 'status' ? 2 : key === 'paymentAmount' ? '10.01' : key === 'rechargeAmount' ? '1.00' : 'foreign';
    await expect(f.service.bindCard(f.admin.id, f.user.id, { operationId: op.id, partnerCardId: 'native_card', orderNo: 'native_order' })).rejects.toMatchObject({ code: 'validation' });
    expect(f.complete).not.toHaveBeenCalled();
    expect((await ctx.db.select().from(cardOperations))[0]!.status).toBe('pending');
  });
});
