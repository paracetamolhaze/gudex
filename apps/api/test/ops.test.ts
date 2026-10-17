import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { DisabledDepositProvider } from '../src/deposits/provider';
import { DbUpaySessionStore } from '../src/partner/upay/session-store';
import { UpayFinancialPartner } from '../src/partner/upay/financial-partner';
import type { UpayClient } from '../src/partner/upay/client';
import { MockUpayPartner } from '../src/partner/mock';
import type { CardPartner } from '../src/partner/types';
import { appSettings, cardOperations, cards, deposits, jobs, kycProfiles, ledgerAccounts, ledgerTransactions, upaySubmissions, withdrawals } from '../src/db/schema';
import { buildApp, createServices } from '../src/app';
import { createRuntimeDeps } from '../src/runtime';
import { api, createTestContext, registerUser, verifiedUserWithFunds, type TestContext } from './helpers';

const opsToken = 'test-operator-token-with-at-least-32-characters';
let ctx: TestContext;
afterEach(async () => { if (ctx) await ctx.close(); });

describe('operator API', () => {
  it('restricts subject attestation to OPS, the exact owner and a strict observed-transition snapshot without dispatching work', async () => {
    let wakeups = 0;
    ctx = await createTestContext(undefined, { env: { OPS_API_TOKEN: opsToken }, onResponse: () => { wakeups++; } });
    const { token } = await registerUser(ctx);
    const url = '/v1/ops/kyc/514468501/subject-attestation';
    const headers = { authorization: `Bearer ${opsToken}` };
    const valid = { expected: { userId: randomUUID(), submissionId: randomUUID(), requestHash: 'a'.repeat(64) },
      observedBeforeAt: '2026-10-16T10:00:00.000Z', observedReviewAt: '2026-10-16T10:01:00.000Z',
      confirmation: 'RECORD_MY_OBSERVED_PRIMARY_KYC_TRANSITION' };
    const beforeProfiles = await ctx.db.select().from(kycProfiles);
    const beforeJobs = await ctx.db.select().from(jobs);
    const beforeJournal = await ctx.db.select().from(upaySubmissions);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Attestation route guards must not use external HTTP'));
    wakeups = 0;
    try {
      for (const method of ['GET', 'POST'] as const) {
        for (const authHeaders of [{}, { authorization: `Bearer ${token}` }]) {
          const response = await ctx.app.inject({ method, url, headers: authHeaders, ...(method === 'POST' ? { payload: valid } : {}) });
          expect(response.statusCode).toBe(401);
          expect(response.headers['cache-control']).toBe('no-store');
        }
        const wrongOwner = await ctx.app.inject({ method, url: '/v1/ops/kyc/999/subject-attestation', headers,
          ...(method === 'POST' ? { payload: valid } : {}) });
        expect(wrongOwner.statusCode).toBe(400);
        expect(wrongOwner.headers['cache-control']).toBe('no-store');
        const disabled = await ctx.app.inject({ method, url, headers, ...(method === 'POST' ? { payload: valid } : {}) });
        expect(disabled.statusCode).toBe(503);
        expect(disabled.headers['cache-control']).toBe('no-store');
      }
      const invalidBodies = [{}, { ...valid, confirmation: 'anything' }, { ...valid, bypass: true },
        { ...valid, expected: { ...valid.expected, bypass: true } },
        { ...valid, expected: { ...valid.expected, userId: 'PRIVATE_USER_ID' } },
        { ...valid, expected: { ...valid.expected, submissionId: 'PRIVATE_SUBMISSION_ID' } },
        { ...valid, expected: { userId: valid.expected.userId, submissionId: valid.expected.submissionId } },
        { ...valid, expected: { ...valid.expected, requestHash: 'PRIVATE_REQUEST_HASH' } },
        { ...valid, observedBeforeAt: 'PRIVATE_TIMESTAMP' }, { ...valid, observedReviewAt: 123 },
      ];
      for (const payload of invalidBodies) {
        const response = await ctx.app.inject({ method: 'POST', url, headers, payload });
        expect(response.statusCode).toBe(400);
        expect(response.headers['cache-control']).toBe('no-store');
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(wakeups).toBe(0);
      expect(await ctx.db.select().from(kycProfiles)).toEqual(beforeProfiles);
      expect(await ctx.db.select().from(jobs)).toEqual(beforeJobs);
      expect(await ctx.db.select().from(upaySubmissions)).toEqual(beforeJournal);
      expect(await ctx.db.select().from(cardOperations)).toEqual([]);
    } finally { fetch.mockRestore(); }
  });
  it('requires OPS and the exact personal authorization for an existing-customer KYC continuation', async () => {
    let wakeups = 0;
    ctx = await createTestContext(undefined, { env: { OPS_API_TOKEN: opsToken }, onResponse: () => { wakeups++; } });
    const { token } = await registerUser(ctx);
    const url = '/v1/ops/kyc/514468501/existing-customer';
    const headers = { authorization: `Bearer ${opsToken}` };
    wakeups = 0;
    for (const method of ['GET', 'POST'] as const) {
      expect((await ctx.app.inject({ method, url })).statusCode).toBe(401);
      expect((await ctx.app.inject({ method, url, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
      expect((await ctx.app.inject({ method, url: '/v1/ops/kyc/999/existing-customer', headers })).statusCode).toBe(400);
    }
    for (const payload of [{}, { expected: {}, confirmation: 'anything' }, {
      expected: { userId: randomUUID(), submissionId: randomUUID(), customerId: 'fixture', customerNo: 'fixture', legacyMarker: `GUDEX-KYC:${randomUUID()}` },
      confirmation: 'USE_MY_PREVIOUS_UPAY_CUSTOMER_AND_SUBMIT_CURRENT_KYC', bypass: true,
    }]) {
      expect((await ctx.app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(400);
    }
    expect(wakeups).toBe(0);
  });
  it('restricts the personal test reset to OPS, the exact authorized ID and a reviewed account generation', async () => {
    let wakeups = 0;
    ctx = await createTestContext(undefined, { env: { OPS_API_TOKEN: opsToken }, onResponse: () => { wakeups++; } });
    const { token } = await registerUser(ctx);
    const headers = { authorization: `Bearer ${opsToken}` };
    const url = '/v1/ops/test-account/514468501/reset';
    wakeups = 0;
    for (const method of ['GET', 'POST'] as const) {
      expect((await ctx.app.inject({ method, url })).statusCode).toBe(401);
      expect((await ctx.app.inject({ method, url, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
      expect((await ctx.app.inject({ method, url: '/v1/ops/test-account/999/reset', headers })).statusCode).toBe(400);
    }
    const inspected = await ctx.app.inject({ method: 'GET', url, headers });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json().status).toBe('not_found');
    expect(inspected.headers['cache-control']).toBe('no-store');
    for (const payload of [{}, { expectedUserId: randomUUID(), expectedSubmissionId: null },
      { expectedUserId: randomUUID(), expectedSubmissionId: null, confirmation: 'anything' },
      { expectedUserId: randomUUID(), expectedSubmissionId: null,
        confirmation: 'DELETE_ONLY_MY_UNFUNDED_GUDEX_TEST_ACCOUNT', bypass: true }]) {
      expect((await ctx.app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(400);
    }
    expect(wakeups).toBe(0);
  });
  it.each([['customer', 'customer_add'], ['upload', 'file_upload'], ['kyc', 'kyc_submit']] as const)(
    'observes %s verification progress without exposing identity data or waking submission jobs', async (kind, step) => {
    let wakeups = 0;
    ctx = await createTestContext(undefined, { env: { OPS_API_TOKEN: opsToken }, onResponse: () => { wakeups++; } });
    const { token, telegramId } = await registerUser(ctx);
    const { userId } = await ctx.services.auth.verifySession(token);
    const submissionId = randomUUID();
    await ctx.db.update(kycProfiles).set({ status: 'pending', submissionState: 'queued', submissionId,
      firstName: 'PRIVATE_NAME', email: 'private@example.test', phone: '12345678901' }).where(eq(kycProfiles.userId, userId));
    const reference = kind === 'upload' ? `upload:${submissionId}:front` : `${kind}:${submissionId}`;
    await ctx.db.insert(upaySubmissions).values({ reference, kind,
      state: 'unknown', requestHash: 'private-hash', evidence: { photo: 'private-image-uri', token: 'private-token',
        step, dispatchPhase: 'post_dispatched', responseAck: 'rejected_envelope', upstreamCode: 10003, httpStatus: 200,
        approvalBasis: 'issuer_subject_status', photoReceiptMatched: false, primaryInitialStatus: 4, primaryReviewObserved: true,
        primaryObservationSource: 'PRIVATE_OBSERVATION_SOURCE', primaryInitialObservedAt: 1711111111111,
        primaryReviewObservedAt: 1722222222222, primaryAttestedAt: 1733333333333 } });
    await ctx.db.insert(jobs).values({ queue: 'kyc.submit', payload: { userId, submissionId }, lastError: 'private-error' });
    const url = `/v1/ops/kyc/${telegramId}`;
    wakeups = 0;
    expect((await ctx.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await api(ctx, token).get(url)).status).toBe(401);
    const response = await ctx.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${opsToken}` } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ remoteMutationsPerformed: false, status: 'pending', submissionState: 'queued',
      customerLinked: false, submissionRecorded: true, journal: [{ kind, state: 'unknown', hasReceipt: false }],
      jobs: [{ queue: 'kyc.submit', status: 'queued', count: 1, error_present: true }] });
    expect(response.json().journal[0].diagnostic).toEqual({ step, dispatchPhase: 'post_dispatched',
      responseAck: 'rejected_envelope', upstreamCode: 10003, httpStatus: 200,
      ...(kind === 'kyc' ? { approvalBasis: 'issuer_subject_status', photoReceiptMatched: false } : {}) });
    expect(response.json().journal[0]).not.toHaveProperty('evidence');
    for (const value of ['PRIVATE_NAME', 'private@example.test', '12345678901', 'private-image-uri', 'private-token', 'private-error', submissionId, userId,
      'PRIVATE_OBSERVATION_SOURCE', '1711111111111', '1722222222222', '1733333333333',
      'primaryInitialStatus', 'primaryReviewObserved', 'primaryObservationSource', 'primaryInitialObservedAt', 'primaryReviewObservedAt', 'primaryAttestedAt']) {
      expect(response.body).not.toContain(value);
    }
    expect((await ctx.app.inject({ method: 'POST', url: `${url}/recheck` })).statusCode).toBe(401);
    expect((await api(ctx, token).post(`${url}/recheck`)).status).toBe(401);
    const rechecked = await ctx.app.inject({ method: 'POST', url: `${url}/recheck`, headers: { authorization: `Bearer ${opsToken}` } });
    expect(rechecked.statusCode).toBe(200);
    expect(rechecked.body).not.toContain('PRIVATE_NAME');
    expect(rechecked.json()).toMatchObject({ status: 'pending', customerLinked: false });
    expect(wakeups).toBe(0);
    expect((await ctx.db.select().from(jobs).where(eq(jobs.queue, 'kyc.submit')))[0]!.status).toBe('queued');
  });
  it('discards invalid diagnostic envelopes and strips unsafe or nonnumeric diagnostic fields', async () => {
    let wakeups = 0;
    ctx = await createTestContext(undefined, { env: { OPS_API_TOKEN: opsToken }, onResponse: () => { wakeups++; } });
    const { token, telegramId } = await registerUser(ctx);
    const { userId } = await ctx.services.auth.verifySession(token);
    const submissionId = randomUUID();
    const reference = `kyc:${submissionId}`;
    const diagnostic = { step: 'kyc_submit', dispatchPhase: 'pre_dispatch', responseAck: 'unconfirmed' };
    await ctx.db.update(kycProfiles).set({ status: 'pending', submissionState: 'unknown', submissionId })
      .where(eq(kycProfiles.userId, userId));
    await ctx.db.insert(upaySubmissions).values({ reference, kind: 'kyc', state: 'unknown', requestHash: 'private-hash' });
    wakeups = 0;
    for (const evidence of [
      'private-evidence-string',
      { ...diagnostic, step: 'private-invalid-step' },
      { ...diagnostic, dispatchPhase: 'private-invalid-phase' },
      { ...diagnostic, responseAck: 'private-invalid-ack' },
    ]) {
      await ctx.db.update(upaySubmissions).set({ evidence }).where(eq(upaySubmissions.reference, reference));
      const response = await ctx.app.inject({ method: 'GET', url: `/v1/ops/kyc/${telegramId}`,
        headers: { authorization: `Bearer ${opsToken}` } });
      expect(response.statusCode).toBe(200);
      expect(response.json().journal[0]).not.toHaveProperty('diagnostic');
      expect(response.json().journal[0]).not.toHaveProperty('evidence');
      expect(response.body).not.toContain('private-');
    }
    for (const proof of [
      { approvalBasis: 'document_hashes', photoReceiptMatched: true, expected: { approvalBasis: 'document_hashes', photoReceiptMatched: true } },
      { approvalBasis: 'issuer_subject_status', photoReceiptMatched: false, expected: { approvalBasis: 'issuer_subject_status', photoReceiptMatched: false } },
      { approvalBasis: 'private-invalid-basis', photoReceiptMatched: true, expected: {} },
      { approvalBasis: ['issuer_subject_status'], photoReceiptMatched: true, expected: {} },
      { approvalBasis: 'issuer_subject_status', photoReceiptMatched: 'private-invalid-boolean', expected: { approvalBasis: 'issuer_subject_status' } },
    ]) {
      await ctx.db.update(upaySubmissions).set({ evidence: { ...diagnostic,
        approvalBasis: proof.approvalBasis, photoReceiptMatched: proof.photoReceiptMatched,
        primaryObservationSource: 'private-observation-source', primaryAttestedAt: 1711111111111,
        photo: 'private-image-uri', token: 'private-token' } }).where(eq(upaySubmissions.reference, reference));
      const response = await ctx.app.inject({ method: 'GET', url: `/v1/ops/kyc/${telegramId}`,
        headers: { authorization: `Bearer ${opsToken}` } });
      expect(response.statusCode).toBe(200);
      expect(response.json().journal[0].diagnostic).toEqual({ ...diagnostic, ...proof.expected });
      expect(response.json().journal[0]).not.toHaveProperty('evidence');
      expect(response.body).not.toContain('private-');
      expect(response.body).not.toContain('1711111111111');
    }
    for (const invalidNumbers of [
      { upstreamCode: 'private-code-string', httpStatus: 'private-status-string' },
      { upstreamCode: Number.MAX_SAFE_INTEGER + 1, httpStatus: 600 },
      { upstreamCode: 10003.5, httpStatus: 200.5 },
      { upstreamCode: Number.MIN_SAFE_INTEGER - 1, httpStatus: 99 },
    ]) {
      await ctx.db.update(upaySubmissions).set({ evidence: { ...diagnostic, ...invalidNumbers,
        photo: 'private-image-uri', token: 'private-token', extra: 'private-extra-field' } })
        .where(eq(upaySubmissions.reference, reference));
      const response = await ctx.app.inject({ method: 'GET', url: `/v1/ops/kyc/${telegramId}`,
        headers: { authorization: `Bearer ${opsToken}` } });
      expect(response.statusCode).toBe(200);
      expect(response.json().journal[0].diagnostic).toEqual(diagnostic);
      expect(response.json().journal[0]).not.toHaveProperty('evidence');
      expect(response.body).not.toContain('private-');
    }
    expect(wakeups).toBe(0);
    expect((await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId)))[0]!.partnerCustomerId).toBeNull();
  });
  it('does not wake financial jobs from health, configuration or operator diagnostics', async () => {
    let wakeups = 0;
    ctx = await createTestContext(undefined, { env: { OPS_API_TOKEN: opsToken }, onResponse: () => { wakeups++; } });
    const { token } = await registerUser(ctx);
    wakeups = 0;
    for (const url of ['/health', '/v1/config', '/v1/ops/status', '/v1/ops/database/status']) {
      expect((await ctx.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${opsToken}` } })).statusCode).toBe(200);
    }
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/ops/upay/payment-password/check', headers: { authorization: `Bearer ${opsToken}` } })).statusCode).toBe(503);
    expect(wakeups).toBe(0);
    expect((await api(ctx, token).get('/v1/me')).status).toBe(200);
    expect(wakeups).toBe(1);
  });
  it('observes a single legacy customer with matching identity without leaking or binding it', async () => {
    let wakeups = 0;
    ctx = await createTestContext(undefined, { env: { OPS_API_TOKEN: opsToken }, onResponse: () => { wakeups++; } });
    const { token, telegramId } = await registerUser(ctx);
    const { userId } = await ctx.services.auth.verifySession(token);
    const submissionId = randomUUID();
    const legacySubmissionId = randomUUID();
    const legacyMarker = `GUDEX-KYC:${legacySubmissionId}`;
    const customerId = 'legacy-private-customer-id';
    const customerNumber = 'legacy-private-customer-number';
    const identity = { firstName: 'PRIVATE_FIRST_NAME', lastName: 'PRIVATE_LAST_NAME', email: 'private-legacy@example.test',
      phone: '7012345678', globalCode: '+7' };
    await ctx.db.update(kycProfiles).set({ ...identity, status: 'pending', submissionState: 'queued', submissionId,
      partnerProvider: 'upay', partnerCustomerId: null }).where(eq(kycProfiles.userId, userId));
    await ctx.db.insert(jobs).values({ queue: 'kyc.submit', payload: { userId, submissionId } });
    const beforeProfile = await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    const beforeJobs = await ctx.db.select().from(jobs);
    const readRequest = vi.fn(async (method: string, endpoint: string, options?: { query?: Record<string, string | number> }) => {
      if (method !== 'GET') throw new Error('This diagnostic must only read customer data');
      if (endpoint === '/customer/list') {
        expect(options?.query).toEqual({ pageNo: 1, pageSize: 100, email: identity.email });
        return { totalPages: 1, totalSize: 1, list: [{ customerId, no: customerNumber, remark: legacyMarker,
          email: 'p***@example.test', givenName: 'P***', lastName: 'P***' }] };
      }
      if (endpoint === '/customer/get') {
        expect(options?.query).toEqual({ customerId });
        return { customerId, no: customerNumber, remark: legacyMarker, email: identity.email.toUpperCase(),
          givenName: identity.firstName.toLowerCase(), lastName: identity.lastName.toLowerCase(),
          phone: identity.phone, globalCode: identity.globalCode };
      }
      throw new Error('Unexpected customer diagnostic endpoint');
    });
    const submitRequest = vi.fn(async () => { throw new Error('Customer diagnostics must not submit'); });
    const uploadRequest = vi.fn(async () => { throw new Error('Customer diagnostics must not upload'); });
    const upay = { readRequest, submitRequest, uploadRequest } as unknown as UpayClient;
    const config = loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'isolated-ops-test-secret', OPS_API_TOKEN: opsToken });
    await ctx.app.close();
    ctx.app = await buildApp({ config, db: ctx.db, partner: new MockUpayPartner(ctx.db),
      depositProvider: new DisabledDepositProvider(), withdrawalProvider: { providerId: 'disabled',
        send: async () => { throw new Error('Customer diagnostics must not withdraw'); } }, bot: ctx.bot, upay,
    }, ctx.services, { onResponse: () => { wakeups++; } });
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External HTTP must not be used by this fixture'));
    wakeups = 0;
    try {
      const response = await ctx.app.inject({ method: 'GET', url: `/v1/ops/kyc/${telegramId}?customerBinding=1`,
        headers: { authorization: `Bearer ${opsToken}` } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({ remoteMutationsPerformed: false, customerLinked: false,
        customerBinding: { ok: true, sampledRows: 1, exactMarkerMatches: 0, matches: [], existingCustomer: {
          searchComplete: true, emailExact: true, givenNameExact: true, lastNameExact: true, phoneExact: true,
          globalCodeExact: true, legacyGudexMarker: true, currentMarker: false, customerIdMatches: true,
          customerNumberMatches: true,
        } },
      });
      for (const value of [...Object.values(identity), identity.email.toUpperCase(), identity.firstName.toLowerCase(),
        identity.lastName.toLowerCase(), 'p***@example.test', 'P***', customerId, customerNumber, userId,
        submissionId, legacySubmissionId, legacyMarker, `GUDEX-KYC:${submissionId}`]) {
        expect(response.body).not.toContain(value);
      }
      expect(readRequest.mock.calls.map(([method, endpoint]) => [method, endpoint])).toEqual([
        ['GET', '/customer/list'], ['GET', '/customer/get'],
      ]);
      expect(submitRequest).not.toHaveBeenCalled();
      expect(uploadRequest).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(wakeups).toBe(0);
      expect(await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId))).toEqual(beforeProfile);
      expect(beforeProfile[0]!.partnerCustomerId).toBeNull();
      expect(await ctx.db.select().from(jobs)).toEqual(beforeJobs);
      expect(await ctx.db.select().from(upaySubmissions)).toEqual([]);
    } finally { fetch.mockRestore(); }
  });
  it('keeps one-time database setup unavailable unless explicitly enabled', async () => {
    ctx = await createTestContext(undefined, { env: { OPS_API_TOKEN: opsToken } });
    const response = await ctx.app.inject({ method: 'POST', url: '/v1/ops/database/prepare-live', headers: { authorization: `Bearer ${opsToken}` }, payload: { rolePassword: 'a'.repeat(64) } });
    expect(response.statusCode).toBe(404);
  });
  it('reports only safe linked-customer KYC receipts and issuance readiness without dispatching work', async () => {
    let wakeups = 0;
    ctx = await createTestContext(undefined, { env: { OPS_API_TOKEN: opsToken }, onResponse: () => { wakeups++; } });
    const { token, telegramId } = await registerUser(ctx);
    const { userId } = await ctx.services.auth.verifySession(token);
    const submissionId = randomUUID();
    const legacyMarker = `GUDEX-KYC:${randomUUID()}`;
    const customerId = 'private-product-customer-id';
    const customerNumber = 'private-product-customer-number';
    const productId = 'private-agent-card-id';
    const identity = { firstName: 'PRIVATE PRODUCT FIRST', lastName: 'PRIVATE PRODUCT LAST',
      email: 'private-product@example.test', phone: '7019876543', globalCode: '+7' };
    const secrets = { photoUri: 'https://private.example.test/photo-secret', fullName: 'PRIVATE_FULL_NAME',
      documentNumber: 'PRIVATE_DOCUMENT_NUMBER', reason: 'PRIVATE_REJECTION_REASON', token: 'PRIVATE_RESPONSE_TOKEN' };
    const nationalityCode = 'PRIVATE_COUNTRY_CODE';
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const receiptEvidence = { kycProtocol: 'customer_primary', customerNo: customerNumber, documentType: 2,
      nationalityCodeHash: hash(JSON.stringify(nationalityCode)), documentFrontHash: hash(secrets.photoUri),
      documentBackHash: hash('*'), photo: secrets.photoUri, token: secrets.token };
    const validDetail = { openFee: '10.00', defaultOpenAmount: '0.00', cardCurrency: 'USD',
      rechargeCurrency: 'USDT', openFeeCurrency: 'USDT', accountCoinSymbol: 'USDT', accountCoinBalance: '987654.123456',
      kycLevel: 2, productId, ...secrets };
    const validForm = { customerNo: customerNumber, givenName: identity.firstName, lastName: identity.lastName,
      defaultType: null, needParams: ['givenName', 'lastName', 'documentType'],
      holdPassportPath: secrets.photoUri, pinCode: secrets.token, ...secrets };
    let productDetail: unknown = validDetail;
    let feeForm: unknown = validForm;
    let feeReadFails = false;
    let remoteFront: unknown = { data: { uri: secrets.photoUri }, fullUrl: secrets.photoUri,
      PRIVATE_PHOTO_FIELD: secrets.token };
    let mirrorCustomerNo = customerNumber;
    let mirrorFront: unknown = JSON.stringify({ uri: secrets.photoUri, fullUrl: secrets.photoUri, PRIVATE_PHOTO_FIELD: secrets.token });
    let mirrorCountry: unknown = nationalityCode;
    const country = { code: nationalityCode, codeAlpha2: 'KZ', codeAlpha3: 'KAZ', name: 'PRIVATE_COUNTRY_NAME', id: 'PRIVATE_COUNTRY_ID' };
    let countryList: unknown = [country];
    let countryReadFails = false;
    await ctx.db.update(kycProfiles).set({ ...identity, documentType: 'passport', documentCountry: 'KZ', status: 'unknown',
      submissionState: 'unknown', submissionId, partnerProvider: 'upay', partnerCustomerId: customerNumber })
      .where(eq(kycProfiles.userId, userId));
    await ctx.db.insert(jobs).values({ queue: 'kyc.submit', payload: { userId, submissionId } });
    await ctx.db.insert(upaySubmissions).values([
      { reference: `kyc:${randomUUID()}`, kind: 'kyc', state: 'acknowledged', requestHash: 'private-old-request-hash',
        evidence: { kycProtocol: 'card', documentType: 1 } },
      { reference: `kyc:${submissionId}`, kind: 'kyc', state: 'acknowledged', requestHash: 'private-current-request-hash', evidence: receiptEvidence },
    ]);
    const beforeProfile = await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    const beforeJobs = await ctx.db.select().from(jobs);
    const beforeJournal = await ctx.db.select().from(upaySubmissions);
    const readRequest = vi.fn(async (method: string, endpoint: string, options?: { query?: Record<string, string | number> }) => {
      if (method !== 'GET') throw new Error('Product diagnostics must only read');
      if (endpoint === '/customer/list') {
        expect(options?.query).toEqual({ pageNo: 1, pageSize: 100, email: identity.email });
        return { totalPages: 1, totalSize: 1, list: [{ customerId, no: customerNumber, remark: legacyMarker,
          email: 'p***@example.test', givenName: 'P***', lastName: 'P***' }] };
      }
      if (endpoint === '/customer/get') {
        expect(options?.query).toEqual({ customerId });
        return { customerId, no: customerNumber, remark: legacyMarker, email: identity.email,
          givenName: identity.firstName, lastName: identity.lastName, phone: identity.phone, globalCode: identity.globalCode };
      }
      if (endpoint === '/card/get/kyc') {
        expect(options?.query).toEqual({ customerNo: customerNumber, agentCardId: productId });
        return { documentType: [1, '2', 'PRIVATE_DOCUMENT_TYPE_TEXT', '123', 1.5, Number.MAX_SAFE_INTEGER + 1],
          needKycLevel: 2, ...secrets, customerNo: mirrorCustomerNo, certifiedDocumentType: [2],
          passportCountryCode: mirrorCountry, passportFrontPath: mirrorFront };
      }
      if (endpoint === '/card/getMayApplyCardDetail') {
        expect(options?.query).toEqual({ agentCardId: productId });
        return productDetail;
      }
      if (endpoint === '/card/getCardFee') {
        expect(options?.query).toEqual({ agentCardId: productId, customerNo: customerNumber });
        if (feeReadFails) throw new Error(secrets.token);
        return feeForm;
      }
      if (endpoint === '/common/countryAndRegion') {
        expect(options?.query).toEqual({ level: 2 });
        if (countryReadFails) throw new Error(secrets.token);
        return countryList;
      }
      if (endpoint === '/kyc/info') {
        expect(options?.query).toEqual({ customerNo: customerNumber });
        return { customerNo: customerNumber, ...secrets, authResult: 1, primaryApprovedNum: 1, items: [
          { documentType: 2, status: 1, state: 3, level: 1, ...secrets, nationalityCode, frontPhoto: remoteFront, backPhoto: '*' },
          { documentType: '2', status: 'PRIVATE_STATUS_TEXT', state: Number.MAX_SAFE_INTEGER + 1, level: 'PRIVATE_LEVEL_TEXT', ...secrets },
          null, 'PRIVATE_RAW_ITEM',
        ] };
      }
      throw new Error('Unexpected product diagnostic endpoint');
    });
    const submitRequest = vi.fn(async () => { throw new Error('Product diagnostics must not submit'); });
    const uploadRequest = vi.fn(async () => { throw new Error('Product diagnostics must not upload'); });
    const upay = { readRequest, submitRequest, uploadRequest } as unknown as UpayClient;
    const config = loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'isolated-ops-product-secret',
      OPS_API_TOKEN: opsToken, UPAY_PRODUCT_ID: productId });
    await ctx.app.close();
    ctx.app = await buildApp({ config, db: ctx.db, partner: new MockUpayPartner(ctx.db),
      depositProvider: new DisabledDepositProvider(), withdrawalProvider: { providerId: 'disabled',
        send: async () => { throw new Error('Product diagnostics must not withdraw'); } }, bot: ctx.bot, upay,
    }, ctx.services, { onResponse: () => { wakeups++; } });
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External HTTP must not be used by this fixture'));
    wakeups = 0;
    try {
      const response = await ctx.app.inject({ method: 'GET', url: `/v1/ops/kyc/${telegramId}?customerBinding=1`,
        headers: { authorization: `Bearer ${opsToken}` } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({ remoteMutationsPerformed: false, customerLinked: true,
        customerBinding: { ok: true, existingCustomer: { legacyGudexMarker: true, currentMarker: false } } });
      expect(response.json().customerBinding.productRequirements).toEqual({
        fields: ['documentType', 'needKycLevel', 'photoUri', 'fullName', 'documentNumber', 'reason', 'token', 'customerNo', 'certifiedDocumentType', 'passportCountryCode', 'passportFrontPath'],
        requestedDocumentType: 'passport', documentTypeShape: 'array', documentTypes: [1, '2'],
        needKycLevel: 2, productKycLevel: 2,
        customerKycFields: ['customerNo', 'photoUri', 'fullName', 'documentNumber', 'reason', 'token', 'authResult', 'primaryApprovedNum', 'items'],
        customerAuthResult: 1, customerPrimaryApproved: 1,
        customerKycItems: [
          { fields: ['documentType', 'status', 'state', 'level', 'photoUri', 'fullName', 'documentNumber', 'reason', 'token', 'nationalityCode', 'frontPhoto', 'backPhoto'], documentType: 2, status: 1, state: 3, level: 1 },
          { fields: ['documentType', 'status', 'state', 'level', 'photoUri', 'fullName', 'documentNumber', 'reason', 'token'], documentType: null, status: null, state: null, level: null },
        ],
      });
      const ready = { feeReadOk: true, issuanceFormReady: true, needParams: ['givenName', 'lastName', 'documentType'],
        openFeeUsdt: '10.00', defaultOpenUsdt: '0.00', cardCurrency: 'USD', rechargeCurrency: 'USDT',
        openFeeCurrency: 'USDT', accountCoinBalanceSufficient: true };
      expect(response.json().customerBinding.issuanceReadiness).toEqual(ready);
      expect(response.json().customerBinding.primaryReceipt).toEqual({ protocolMatches: true, documentTypeMatches: true,
        countryHashMatches: true, frontHashMatches: true, backHashMatches: true, itemUnique: true,
        itemLevelMatches: true, itemStatusSupported: true, countryType: 'string',
        frontPhoto: { shape: 'object', knownKeys: ['data', 'fullUrl', 'uri'] }, backPhoto: { shape: 'rawstring', knownKeys: [] } });
      const noRawHttpPath = { empty: false, placeholder: false, absoluteHttpUrl: false,
        nullLiteral: false, undefinedLiteral: false, maskedStars: false, maskedX: false, looksBase64Envelope: false,
        pathnameHashMatches: false, pathnameWithoutLeadingSlashHashMatches: false,
        decodedPathnameHashMatches: false, decodedPathnameWithoutLeadingSlashHashMatches: false };
      expect(response.json().customerBinding.primaryCardMirror).toEqual({ protocolMatches: true, documentTypeMatches: true,
        customerMatches: true, certifiedDocumentTypeMatches: true, certifiedDocumentTypeShape: 'array',
        countryType: 'string', countryHashMatches: true, frontHashMatches: true, backHashMatches: true,
        backPlaceholder: true, frontPhoto: { shape: 'json', knownKeys: ['fullUrl', 'uri'] },
        backPhoto: { shape: 'null', knownKeys: [] }, countryEmpty: false, countryPlaceholder: false,
        countryNullLiteral: false, countryUndefinedLiteral: false, countryMaskedStars: false,
        frontPhotoPath: noRawHttpPath, backPhotoPath: noRawHttpPath });
      const rawCountryMatch = { countryRowUnique: true, submittedRawCodeMatches: true, mirrorCountryMatchesRawCode: true,
        mirrorCountryMatchesAlpha2: false, mirrorCountryMatchesAlpha3: false, mirrorCountryEmpty: false, mirrorCountryPlaceholder: false };
      expect(response.json().customerBinding.primaryCardCountry).toEqual(rawCountryMatch);
      for (const value of [...Object.values(identity), ...Object.values(secrets), customerId, customerNumber,
        productId, legacyMarker, submissionId, userId, 'p***@example.test', 'P***',
        nationalityCode, 'KZ', 'KAZ', country.name, country.id, '987654.123456', ...Object.values(receiptEvidence).filter(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)),
        'PRIVATE_PHOTO_FIELD', 'private-old-request-hash', 'private-current-request-hash',
        'PRIVATE_DOCUMENT_TYPE_TEXT', 'PRIVATE_STATUS_TEXT', 'PRIVATE_LEVEL_TEXT', 'PRIVATE_RAW_ITEM']) {
        expect(response.body).not.toContain(value);
      }
      expect(readRequest.mock.calls.map(([method, endpoint]) => [method, endpoint])).toEqual([
        ['GET', '/customer/list'], ['GET', '/customer/get'], ['GET', '/card/get/kyc'],
        ['GET', '/card/getMayApplyCardDetail'], ['GET', '/kyc/info'], ['GET', '/common/countryAndRegion'], ['GET', '/card/getCardFee'],
      ]);
      // These are observations of the exact returned form, never fallback guesses or writes.
      const cases = [
        { label: 'exact fee boundary', detail: { ...validDetail, accountCoinBalance: '10.000000' }, form: validForm, expected: { ...ready } },
        { label: 'fraction below fee', detail: { ...validDetail, accountCoinBalance: '9.999999' }, form: validForm, expected: { ...ready, accountCoinBalanceSufficient: false } },
        { label: 'invalid balance', detail: { ...validDetail, accountCoinBalance: 'PRIVATE_BALANCE' }, form: validForm, expected: { ...ready, accountCoinBalanceSufficient: null } },
        { label: 'wrong balance currency', detail: { ...validDetail, accountCoinSymbol: 'USD' }, form: validForm, expected: { ...ready, accountCoinBalanceSufficient: null } },
        { label: 'form balance ignored', detail: { ...validDetail, accountCoinBalance: undefined }, form: { ...validForm, accountCoinBalance: '100000' }, expected: { ...ready, accountCoinBalanceSufficient: null } },
        { label: 'different customer', form: { ...validForm, customerNo: customerId }, expected: { ...ready, issuanceFormReady: false } },
        { label: 'missing requirements', form: { ...validForm, needParams: undefined }, expected: { ...ready, issuanceFormReady: false, needParams: null } },
        { label: 'private requirement name', form: { ...validForm, needParams: [...validForm.needParams, secrets.token], [secrets.token]: 'present' }, expected: { ...ready } },
        { label: 'over budget', detail: { ...validDetail, openFee: '10.01' }, form: validForm, expected: { ...ready, issuanceFormReady: false, openFeeUsdt: '10.01' } },
        { label: 'initial funding unsupported', detail: { ...validDetail, defaultOpenAmount: '1.00' }, form: validForm, expected: { ...ready, issuanceFormReady: false, defaultOpenUsdt: '1.00' } },
        { label: 'invalid fee precision', detail: { ...validDetail, openFee: '10.001' }, form: validForm, expected: { ...ready, issuanceFormReady: false, openFeeUsdt: null, defaultOpenUsdt: null, accountCoinBalanceSufficient: null } },
        { label: 'missing fee shape', detail: { kycLevel: 2 }, form: validForm, expected: { ...ready, issuanceFormReady: false, openFeeUsdt: null, defaultOpenUsdt: null, cardCurrency: null, rechargeCurrency: null, openFeeCurrency: null, accountCoinBalanceSufficient: null } },
        { label: 'unverified currencies', detail: { ...validDetail, cardCurrency: 'PRIVATE_CURRENCY', rechargeCurrency: 'PRIVATE_CURRENCY', openFeeCurrency: 'PRIVATE_CURRENCY' }, form: validForm, expected: { ...ready, issuanceFormReady: false, openFeeUsdt: null, defaultOpenUsdt: null, cardCurrency: null, rechargeCurrency: null, openFeeCurrency: null, accountCoinBalanceSufficient: null } },
        ...[null, [], 'PRIVATE_RAW_FORM'].map(form => ({ label: 'unsupported form', form, expected: { ...ready, feeReadOk: false, issuanceFormReady: false, needParams: null, openFeeUsdt: null, defaultOpenUsdt: null, accountCoinBalanceSufficient: null } })),
        { label: 'fee read unavailable', form: validForm, readFails: true, expected: { ...ready, feeReadOk: false, issuanceFormReady: false, needParams: null, openFeeUsdt: null, defaultOpenUsdt: null, accountCoinBalanceSufficient: null } },
      ];
      for (const item of cases) {
        productDetail = 'detail' in item ? item.detail : validDetail;
        feeForm = item.form;
        feeReadFails = 'readFails' in item && item.readFails === true;
        const observation = await ctx.app.inject({ method: 'GET', url: `/v1/ops/kyc/${telegramId}?customerBinding=1`,
          headers: { authorization: `Bearer ${opsToken}` } });
        expect(observation.statusCode, item.label).toBe(200);
        expect(observation.json().customerBinding.ok, item.label).toBe(true);
        expect(observation.json().customerBinding.issuanceReadiness, item.label).toEqual(item.expected);
        for (const value of [...Object.values(secrets), customerId, customerNumber, 'PRIVATE_BALANCE', 'PRIVATE_CURRENCY', 'PRIVATE_RAW_FORM']) {
          expect(observation.body, item.label).not.toContain(value);
        }
      }
      productDetail = validDetail;
      feeForm = validForm;
      feeReadFails = false;
      const unconfirmedCountry = { ...rawCountryMatch, countryRowUnique: false, submittedRawCodeMatches: false, mirrorCountryMatchesRawCode: false };
      const countryCases = [
        { label: 'alpha2 alias', mirror: 'kz', expected: { ...rawCountryMatch, mirrorCountryMatchesRawCode: false, mirrorCountryMatchesAlpha2: true } },
        { label: 'alpha3 alias', mirror: 'kaz', expected: { ...rawCountryMatch, mirrorCountryMatchesRawCode: false, mirrorCountryMatchesAlpha3: true } },
        { label: 'alpha2 alternate field', mirror: 'KZ', countries: { list: [{ code: nationalityCode, alpha2: 'kz', alpha3: 'KAZ' }] }, expected: { ...rawCountryMatch, mirrorCountryMatchesRawCode: false, mirrorCountryMatchesAlpha2: true } },
        { label: 'creator raw code fallback', mirror: 'KZ', countries: [{ code: 'KZ', codeAlpha3: 'KAZ' }], expected: { ...rawCountryMatch, submittedRawCodeMatches: false } },
        { label: 'raw code type mismatch', mirror: '398', countries: [{ ...country, code: 398 }], expected: { ...rawCountryMatch, submittedRawCodeMatches: false, mirrorCountryMatchesRawCode: false } },
        { label: 'duplicate country rows', mirror: nationalityCode, countries: [country, { ...country }], expected: unconfirmedCountry },
        { label: 'country absent', mirror: nationalityCode, countries: [{ ...country, codeAlpha2: 'YY' }], expected: unconfirmedCountry },
        { label: 'unsupported country shape', mirror: nationalityCode, countries: { data: [country] }, expected: unconfirmedCountry },
        { label: 'invalid raw code', mirror: nationalityCode, countries: [{ ...country, code: { private: secrets.token } }], expected: { ...rawCountryMatch, submittedRawCodeMatches: false, mirrorCountryMatchesRawCode: false } },
        { label: 'empty mirror country', mirror: '', expected: { ...rawCountryMatch, mirrorCountryMatchesRawCode: false, mirrorCountryEmpty: true } },
        { label: 'placeholder mirror country', mirror: '*', expected: { ...rawCountryMatch, mirrorCountryMatchesRawCode: false, mirrorCountryPlaceholder: true } },
        { label: 'country read unavailable', mirror: nationalityCode, readFails: true, expected: unconfirmedCountry },
      ];
      for (const item of countryCases) {
        mirrorCountry = item.mirror;
        countryList = 'countries' in item ? item.countries : [country];
        countryReadFails = 'readFails' in item && item.readFails === true;
        const observation = await ctx.app.inject({ method: 'GET', url: `/v1/ops/kyc/${telegramId}?customerBinding=1`,
          headers: { authorization: `Bearer ${opsToken}` } });
        expect(observation.statusCode, item.label).toBe(200);
        expect(observation.json().customerBinding.ok, item.label).toBe(true);
        expect(observation.json().customerBinding.primaryCardCountry, item.label).toEqual(item.expected);
        expect(observation.json().customerBinding.issuanceReadiness, item.label).toEqual(ready);
        for (const value of [...Object.values(secrets), nationalityCode, 'KZ', 'KAZ', country.name, country.id,
          receiptEvidence.nationalityCodeHash, customerNumber, customerId]) {
          expect(observation.body, item.label).not.toContain(value);
        }
      }
      mirrorCountry = nationalityCode;
      countryList = [country];
      countryReadFails = false;
      remoteFront = { fullUrl: secrets.photoUri, PRIVATE_PHOTO_FIELD: secrets.token };
      mirrorCustomerNo = customerId;
      mirrorFront = { fullUrl: secrets.photoUri, PRIVATE_PHOTO_FIELD: secrets.token };
      const unconfirmedReceipt = await ctx.app.inject({ method: 'GET', url: `/v1/ops/kyc/${telegramId}?customerBinding=1`,
        headers: { authorization: `Bearer ${opsToken}` } });
      expect(unconfirmedReceipt.json().customerBinding.primaryReceipt).toMatchObject({ frontHashMatches: false,
        countryHashMatches: true, frontPhoto: { shape: 'object', knownKeys: ['fullUrl'] } });
      expect(unconfirmedReceipt.json().customerBinding.primaryCardMirror).toMatchObject({ customerMatches: false,
        countryHashMatches: true, frontHashMatches: false, backHashMatches: true,
        frontPhoto: { shape: 'object', knownKeys: ['fullUrl'] } });
      expect(unconfirmedReceipt.body).not.toContain(secrets.photoUri);
      expect(unconfirmedReceipt.body).not.toContain(secrets.token);
      expect(submitRequest).not.toHaveBeenCalled();
      expect(uploadRequest).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(wakeups).toBe(0);
      expect(await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId))).toEqual(beforeProfile);
      expect(await ctx.db.select().from(jobs)).toEqual(beforeJobs);
      expect(await ctx.db.select().from(upaySubmissions)).toEqual(beforeJournal);
    } finally { fetch.mockRestore(); }
  });
  it('protects issuance sponsorship with the operator secret and a strict fixed-budget request', async () => {
    ctx = await createTestContext(undefined, { env: { OPS_API_TOKEN: opsToken } });
    const { token } = await registerUser(ctx);
    const grant = vi.spyOn(ctx.services.cards, 'grantIssueSponsorship');
    const url = '/v1/ops/card-issue-sponsorships';
    const valid = { telegramId: '514468501', reason: 'Owner approved a personal launch test' };
    try {
      for (const headers of [{}, { authorization: `Bearer ${token}` }]) {
        expect((await ctx.app.inject({ method: 'POST', url, headers, payload: valid })).statusCode).toBe(401);
      }
      for (const payload of [
        { ...valid, telegramId: '0' }, { ...valid, telegramId: '-1' },
        { ...valid, telegramId: 'not-a-telegram-id' }, { ...valid, telegramId: '1'.repeat(17) },
        { ...valid, reason: '  short  ' }, { ...valid, reason: 'x'.repeat(301) },
        { ...valid, budgetUsd: '1000000' }, { ...valid, partnerProvider: 'mock' },
      ]) {
        expect((await ctx.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${opsToken}` }, payload })).statusCode).toBe(400);
      }
      expect(grant).not.toHaveBeenCalled();
      expect(await ctx.db.select().from(cardOperations)).toEqual([]);
    } finally { grant.mockRestore(); }
  });
  it('grants a fixed broker sponsorship before registration without minting funds or dispatching work', async () => {
    let partnerCalls = 0, wakeups = 0;
    const partner = new Proxy({} as CardPartner, { get: () => () => { partnerCalls++; throw new Error('A sponsorship grant must not call the card partner'); } });
    ctx = await createTestContext(() => partner, { env: { OPS_API_TOKEN: opsToken,
      CARD_PARTNER: 'upay', DEV_TOOLS: 'false', UPAY_WRITES_ENABLED: 'false', UPAY_KYC_ENABLED: 'false',
      UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ',
    }, onResponse: () => { wakeups++; } });
    const payload = { telegramId: '514468501', reason: '  Owner approved a personal launch test  ' };
    for (let i = 0; i < 2; i++) {
      const response = await ctx.app.inject({ method: 'POST', url: '/v1/ops/card-issue-sponsorships',
        headers: { authorization: `Bearer ${opsToken}` }, payload });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ telegramId: payload.telegramId, budgetUsd: '10', fundingSource: 'broker', status: 'available' });
    }
    expect(partnerCalls).toBe(0); expect(wakeups).toBe(0);
    expect(await ctx.db.select().from(cardOperations)).toEqual([]);
    expect(await ctx.db.select().from(cards)).toEqual([]);
    expect(await ctx.db.select().from(deposits)).toEqual([]);
    expect(await ctx.db.select().from(jobs)).toEqual([]);
    expect(await ctx.db.select().from(ledgerTransactions)).toEqual([]);
    expect(await ctx.db.select().from(ledgerAccounts)).toEqual([]);
  });
  it('requires a separate operator secret for diagnostics, bot setup and queue wakeups', async () => {
    ctx = await createTestContext(undefined, { env: { OPS_API_TOKEN: opsToken } });
    const { token } = await registerUser(ctx);
    for (const [method, url] of [['GET', '/v1/ops/status'], ['POST', '/v1/ops/queue/drain'],
      ['POST', '/v1/telegram/setup'], ['GET', '/v1/cron']] as const) {
      expect((await ctx.app.inject({ method, url })).statusCode).toBe(401);
      expect((await ctx.app.inject({ method, url, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    }
    const status = await ctx.app.inject({ method: 'GET', url: '/v1/ops/status', headers: { authorization: `Bearer ${opsToken}` } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ cardPartner: 'mock', upayConfigured: false, upayWritesEnabled: false });
    const drained = await ctx.app.inject({ method: 'POST', url: '/v1/ops/queue/drain', headers: { authorization: `Bearer ${opsToken}` } });
    expect(drained.statusCode).toBe(200);
    expect(drained.json().processed).toBeTypeOf('number');
  });
  it('does not expose operator routes when the operator secret is unset', async () => {
    ctx = await createTestContext();
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/ops/status' })).statusCode).toBe(404);
  });
});

describe('UPay session storage', () => {
  it('encrypts session values, shares sessions between instances and rejects a changed encryption key', async () => {
    ctx = await createTestContext();
    const first = new DbUpaySessionStore(ctx.db, 'test-app-secret');
    const session = { token: 'private-upay-session-token', expiresAt: Date.now() + 10000, fingerprint: 'configuration-fingerprint' };
    await first.withLock(async access => { await access.set(session); });
    const [row] = await ctx.db.select().from(appSettings).where(eq(appSettings.key, 'upay:session:v1'));
    expect(JSON.stringify(row!.value)).not.toContain(session.token);
    expect(JSON.stringify(row!.value)).not.toContain('configuration-fingerprint');
    const second = new DbUpaySessionStore(ctx.db, 'test-app-secret');
    expect(await second.withLock(access => access.get())).toEqual(session);
    expect(await new DbUpaySessionStore(ctx.db, 'rotated-app-secret').withLock(access => access.get())).toBeNull();
    await second.withLock(access => access.set(null));
    expect(await first.withLock(access => access.get())).toBeNull();
  });
});

describe('provider boundaries', () => {
  it('returns non-transferable demo identifiers and keeps WhiteBird disabled with demo custody', async () => {
    ctx = await createTestContext(undefined, { env: { WHITEBIRD_MERCHANT_ID: 'test-merchant' } });
    const { token } = await registerUser(ctx);
    const client = api(ctx, token);
    expect((await client.get('/v1/deposits/address?asset=USDC&network=ERC20')).body).toMatchObject({ demo: true });
    expect((await client.get('/v1/deposits/address?asset=USDC&network=ERC20')).body.address).toMatch(/^GUDEX-DEMO:/);
    expect(ctx.services.exchange.ready).toBe(false);
  });
  it('does not return old demo addresses when custody is disabled', async () => {
    ctx = await createTestContext(undefined, { depositProvider: new DisabledDepositProvider() });
    const { token } = await registerUser(ctx);
    const response = await api(ctx, token).get('/v1/deposits/address?asset=USDT&network=TON');
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('provider_unavailable');
  });
  it('blocks unverified UPay mutations before creating an operation or reserving money', async () => {
    ctx = await createTestContext();
    const { token } = await verifiedUserWithFunds(ctx, '100');
    const { userId } = await ctx.services.auth.verifySession(token);
    const config = loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'local-test-secret-16', CARD_PARTNER: 'upay',
      UPAY_LOGIN: 'automation@example.test', UPAY_PASSWORD: 'test', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ' });
    const deps = createRuntimeDeps(config, ctx.db);
    expect(deps.partner).toBeInstanceOf(UpayFinancialPartner);
    const liveServices = createServices(deps);
    await expect(liveServices.cards.issue(userId, { asset: 'USDT', idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(liveServices.withdrawals.create(userId, { asset: 'USDT', network: 'TON', address: 'unused', amount: '20', idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(await ctx.db.select().from(cardOperations)).toEqual([]);
    expect(await ctx.db.select().from(withdrawals)).toEqual([]);
    expect((await ctx.services.wallet.getWallet(userId)).balances[0]!.amount).toBe('100');
  });
});
