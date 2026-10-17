import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import type { Db } from '../../src/db/client';
import { UpayKycIntegration } from '../../src/partner/upay/kyc';
import { MemoryUpaySubmissionStore } from '../../src/partner/upay/submissions';
import type { UpayClient } from '../../src/partner/upay/client';
import { UpayError } from '../../src/partner/upay/transport';
import type { DbKycDocumentStore, KycStoredDocument } from '../../src/kyc/document-store';

const userId = '00000000-0000-4000-8000-000000000001';
const submissionId = '00000000-0000-4000-8000-000000000002';
const input = { externalRef: userId, firstName: 'TEST', lastName: 'USER', email: 'kyc@example.test', birthDate: '1990-01-01', citizenship: 'KZ',
  kyc: { submissionId, phone: '7771234567', globalCode: '+7', documentType: 'passport' as const, documentCountry: 'KZ', documentIds: { front: 'front', selfie: 'selfie' } } };
const markedCustomer = { customerId: 'CUSTOMER-ID-1', no: 'CUSTOMER-1', email: input.email,
  remark: `GUDEX-KYC:${submissionId}`, givenName: 'TEST', lastName: 'USER' };
const maskedCustomer = { ...markedCustomer, email: 'k***@example.test', givenName: 'T***', lastName: 'U***' };

function fixture(options: { loseSubmit?: boolean; remoteApproved?: boolean; wrongDocuments?: boolean; productLevel?: number;
  collectSelfie?: boolean; hideCreatedCustomer?: boolean; loseCustomerResponse?: boolean; customerError?: Error; uploadError?: Error; kycError?: Error;
  customerPage?: (pageNo: number) => { list: Record<string, unknown>[]; totalPages?: number };
  customerDetail?: Record<string, unknown> } = {}) {
  const config = loadConfig({ DATABASE_URL: 'unit-test-unused', JWT_SECRET: 'unit-test-key-with-16-characters', UPAY_KYC_ENABLED: 'true',
    UPAY_CUSTOMER_GROUP_ID: 'group-1', UPAY_LOGIN: 'bot@example.test', UPAY_PASSWORD: 'test', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ',
    UPAY_KYC_REQUIRE_SELFIE: options.collectSelfie ? 'true' : 'false' });
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const reads: { path: string; query?: Record<string, string | number> }[] = [];
  const files = new Map<string, KycStoredDocument>(['front', 'selfie'].map(kind => [kind, { id: kind, kind: kind as 'front' | 'selfie',
    mimeType: 'image/png', size: 4, bytes: Buffer.from('test'), expiresAt: new Date(Date.now() + 100000).toISOString() }]));
  const documents = { getOwned: async (_userId: string, id: string) => files.get(id)!,
    markUploaded: async (_userId: string, id: string, remoteUri: string) => { files.get(id)!.remoteUri = remoteUri; } } as unknown as DbKycDocumentStore;
  let uploaded = 0;
  let customerVisible = !options.hideCreatedCustomer;
  const client = { configured: true,
    readRequest: async (_method: string, path: string, request?: { query?: Record<string, string | number> }) => {
      reads.push({ path, query: request?.query });
      if (path === '/common/countryAndRegion') return [{ codeAlpha2: 'KZ', codeAlpha3: 'KAZ' }];
      if (path === '/card/getMayApplyCardDetail') return { kycLevel: options.productLevel ?? 2 };
      if (path === '/customer/group/all') return [{ id: 'group-1' }];
      if (path === '/customer/list') return options.customerPage?.(Number(request?.query?.pageNo)) ?? { list: customerVisible ? [{ no: 'CUSTOMER-1', email: input.email, remark: `GUDEX-KYC:${submissionId}`, givenName: 'TEST', lastName: 'USER' }] : [], totalPages: 1 };
      if (path === '/customer/get') return options.customerDetail ?? markedCustomer;
      if (path === '/card/get/kyc') return { documentType: [2], needKycLevel: options.productLevel ?? 2,
        passportFrontPath: options.wrongDocuments ? 'different-private-file' : 'private-file-1', facePath: 'private-file-2' };
      if (path === '/card/get/kycStatus') return { passport: options.remoteApproved ? 1 : 2, face: options.productLevel === 1 ? 0 : options.remoteApproved ? 1 : 2 };
      throw new Error('Unexpected read endpoint');
    },
    uploadRequest: async (_bytes: Uint8Array, _mime: string, _type: number, callbacks?: { beforeDispatch?: () => Promise<void> }) => {
      await callbacks?.beforeDispatch?.();
      uploaded++;
      if (options.uploadError) throw options.uploadError;
      return { uri: `private-file-${uploaded}` };
    },
    submitRequest: async (path: string, body: Record<string, unknown>, callbacks?: { beforeDispatch?: () => Promise<void> }) => {
      await callbacks?.beforeDispatch?.();
      writes.push({ path, body });
      if (path === '/customer/add' && options.customerError) throw options.customerError;
      if (path === '/card/submit/kyc' && options.kycError) throw options.kycError;
      if (path === '/customer/add' && options.loseCustomerResponse) throw new Error('lost customer response');
      if (path === '/card/submit/kyc' && options.loseSubmit) throw new Error('lost response');
      return {};
    } } as unknown as UpayClient;
  const profile = { userId, partnerProvider: 'upay', partnerCustomerId: 'CUSTOMER-1', documentType: 'passport', submissionId };
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [profile] }) }) }) } as unknown as Db;
  const journal = new MemoryUpaySubmissionStore();
  const helper = new UpayKycIntegration(config, client, journal, documents, db);
  return { helper, writes, reads, journal, files, uploaded: () => uploaded, showCustomer: () => { customerVisible = true; },
    recreate: () => new UpayKycIntegration(config, client, journal, documents, db) };
}

async function recoverFixture(options: Parameters<typeof fixture>[0]) {
  const context = fixture(options);
  await context.journal.begin({ reference: `customer:${submissionId}`, kind: 'customer', requestHash: 'original-request' });
  await context.journal.record(`customer:${submissionId}`, { state: 'unknown' });
  return context;
}

describe('UPay KYC protocol boundary', () => {
  it.each([
    { firstName: 'ANNE-MARIE' }, { lastName: "O'NEIL" }, { email: 'synthetic..name@example.test' },
    { kyc: { ...input.kyc, phone: '12345678901234' } }, { kyc: { ...input.kyc, globalCode: '+86', phone: '12345678901' } },
  ])('rejects a new customer that cannot pass native issuance or billing contact rules before any ADD or upload', async invalid => {
    const f = fixture();
    await expect(f.helper.createCustomer({ ...input, ...invalid })).rejects.toMatchObject({ retryable: false });
    expect(f.writes).toEqual([]);
    expect(f.uploaded()).toBe(0);
    expect(await f.journal.get(`customer:${submissionId}`)).toBeNull();
  });

  it.each([{ phone: '1234567890123', globalCode: '+7' }, { phone: '13800138000', globalCode: '+86' }])
    ('validates the national phone separately from its dial code without rewriting either', async contact => {
      const f = fixture();
      await f.helper.createCustomer({ ...input, kyc: { ...input.kyc, ...contact } });
      expect(f.writes[0]!.body).toMatchObject(contact);
    });

  it('does not reinterpret an older uncertain customer journal as a new native validation rejection', async () => {
    const f = await recoverFixture({ customerPage: () => ({ list: [], totalPages: 1 }) });
    const before = await f.journal.get(`customer:${submissionId}`);
    await expect(f.helper.createCustomer({ ...input, firstName: 'ANNE-MARIE' })).rejects.toMatchObject({ retryable: true });
    expect(f.writes).toEqual([]);
    expect(await f.journal.get(`customer:${submissionId}`)).toEqual(before);
  });

  it('creates a marked customer and sends mapped document URIs without treating submission as approval', async () => {
    const { helper, writes, journal } = fixture();
    expect(await helper.createCustomer(input)).toBe('CUSTOMER-1');
    expect(writes[0]).toMatchObject({ path: '/customer/add', body: { groupId: 'group-1', phone: '7771234567', globalCode: '+7', remark: `GUDEX-KYC:${submissionId}` } });
    expect(writes[1]).toEqual({ path: '/card/submit/kyc', body: { agentCardId: '2040769880440840193', customerNo: 'CUSTOMER-1', documentType: 2,
      countryCode: 'KAZ', documentFrontPath: 'private-file-1', documentBackPath: 'private-file-1', facePath: 'private-file-2' } });
    expect(await helper.getKycStatus('CUSTOMER-1')).toEqual({ status: 'pending' });
    expect(JSON.stringify(await journal.get(`kyc:${submissionId}`))).not.toContain('private-file');
  });

  it('does not resubmit after a lost KYC response, even when the helper is recreated', async () => {
    const { helper, writes, recreate } = fixture({ loseSubmit: true });
    await expect(helper.createCustomer(input)).rejects.toMatchObject({ customerNo: 'CUSTOMER-1' });
    await expect(recreate().createCustomer(input)).resolves.toBe('CUSTOMER-1');
    expect(writes.filter(write => write.path === '/card/submit/kyc')).toHaveLength(1);
  });

  it('requires both remote approval and the exact submitted photo references', async () => {
    const good = fixture({ remoteApproved: true });
    await good.helper.createCustomer(input);
    expect(await good.helper.getKycStatus('CUSTOMER-1')).toEqual({ status: 'approved' });
    const stale = fixture({ remoteApproved: true, wrongDocuments: true });
    await stale.helper.createCustomer(input);
    await expect(stale.helper.getKycStatus('CUSTOMER-1')).rejects.toThrow('document');
  });

  it('checks the worker lease before each outbound POST, including individual photo uploads', async () => {
    const { helper, writes, uploaded } = fixture();
    let checks = 0;
    await expect(helper.createCustomer({ ...input, beforeSubmit: async () => { if (++checks > 1) throw new Error('lease lost'); } }))
      .rejects.toMatchObject({ customerNo: 'CUSTOMER-1' });
    expect(writes.map(write => write.path)).toEqual(['/customer/add']);
    expect(uploaded()).toBe(0);
  });

  it('recovers a late customer receipt by reads and leaves KYC for an explicit new submission', async () => {
    const { helper, writes, showCustomer } = fixture({ hideCreatedCustomer: true, loseCustomerResponse: true });
    await expect(helper.createCustomer(input)).rejects.toThrow('matching receipt');
    showCustomer();
    expect(await helper.reconcileKycSubmission(input)).toEqual({ customerNo: 'CUSTOMER-1', submitted: false });
    expect(writes.map(write => write.path)).toEqual(['/customer/add']);
  });

  it('does not invent issuer face approval for a level-one product, even with local selfie collection enabled', async () => {
    const { helper } = fixture({ productLevel: 1, remoteApproved: true, collectSelfie: true });
    expect((await helper.getKycRequirements()).selfieRequired).toBe(true);
    await helper.createCustomer(input);
    expect(await helper.getKycStatus('CUSTOMER-1')).toEqual({ status: 'approved' });
  });

  it('recovers a masked list identity through exact-marker customer detail using reads only', async () => {
    const { helper, reads, writes, uploaded, journal } = await recoverFixture({ customerPage: () => ({ list: [maskedCustomer], totalPages: 1 }) });
    expect(await helper.reconcileKycSubmission(input)).toEqual({ customerNo: 'CUSTOMER-1', submitted: false });
    expect(reads).toEqual([
      { path: '/customer/list', query: { pageNo: 1, pageSize: 100 } },
      { path: '/customer/get', query: { customerId: 'CUSTOMER-ID-1' } },
    ]);
    expect(writes).toEqual([]);
    expect(uploaded()).toBe(0);
    expect(await journal.get(`customer:${submissionId}`)).toMatchObject({ state: 'confirmed', partnerReceiptId: 'CUSTOMER-1' });
    expect(await journal.get(`kyc:${submissionId}`)).toBeNull();
  });

  it('rejects duplicate exact markers even when only one list identity matches', async () => {
    const { helper, reads, journal } = await recoverFixture({ customerPage: () => ({ list: [markedCustomer,
      { ...maskedCustomer, customerId: 'CUSTOMER-ID-2', no: 'CUSTOMER-2', email: 'another@example.test' }], totalPages: 1 }) });
    await expect(helper.reconcileKycSubmission(input)).rejects.toThrow('not unique');
    expect(reads.some(read => read.path === '/customer/get')).toBe(false);
    expect(await journal.get(`customer:${submissionId}`)).toMatchObject({ state: 'unknown', partnerReceiptId: null });
  });

  it('does not confirm a candidate when the complete scan would exceed the page cap', async () => {
    const filler = Array.from({ length: 100 }, (_, index) => ({ no: `OTHER-${index}`, remark: 'unrelated' }));
    const { helper, reads, journal } = await recoverFixture({ customerPage: pageNo => ({
      list: pageNo === 1 ? [markedCustomer, ...filler.slice(1)] : filler, totalPages: 21,
    }) });
    await expect(helper.reconcileKycSubmission(input)).rejects.toThrow('incomplete');
    expect(reads.filter(read => read.path === '/customer/list')).toHaveLength(20);
    expect(await journal.get(`customer:${submissionId}`)).toMatchObject({ state: 'unknown', partnerReceiptId: null });
  });

  it('honors advertised remaining pages even when the current page is short', async () => {
    const { helper } = await recoverFixture({ customerPage: pageNo => ({ list: [pageNo === 1 ? markedCustomer
      : { ...maskedCustomer, customerId: 'CUSTOMER-ID-2', no: 'CUSTOMER-2' }], totalPages: 2 }) });
    await expect(helper.reconcileKycSubmission(input)).rejects.toThrow('not unique');
  });

  it('does not guess a customer detail identifier from an unsafe numeric value', async () => {
    const { helper, reads } = await recoverFixture({ customerPage: () => ({ list: [{ ...maskedCustomer, customerId: Number.MAX_SAFE_INTEGER + 1 }], totalPages: 1 }) });
    await expect(helper.reconcileKycSubmission(input)).rejects.toThrow('receipt');
    expect(reads.some(read => read.path === '/customer/get')).toBe(false);
  });

  it.each([
    ['marker', { remark: 'GUDEX-KYC:another-submission' }],
    ['email', { email: 'another@example.test' }],
    ['given name', { givenName: 'OTHER' }],
    ['last name', { lastName: 'OTHER' }],
    ['customer ID', { customerId: 'CUSTOMER-ID-2' }],
    ['customer number', { no: 'CUSTOMER-2' }],
    ['masked identity', { givenName: 'T***' }],
    ['missing identity', { lastName: undefined }],
  ])('rejects a detail with a mismatched %s', async (_field, change) => {
    const { helper, writes, uploaded, journal } = await recoverFixture({ customerPage: () => ({ list: [maskedCustomer], totalPages: 1 }),
      customerDetail: { ...markedCustomer, ...change } });
    await expect(helper.reconcileKycSubmission(input)).rejects.toThrow();
    expect(writes).toEqual([]);
    expect(uploaded()).toBe(0);
    expect(await journal.get(`customer:${submissionId}`)).toMatchObject({ state: 'unknown', partnerReceiptId: null });
  });

  it('never adopts matching identity without the exact marker', async () => {
    const { helper, reads } = await recoverFixture({ customerPage: () => ({ list: [{ ...markedCustomer, remark: 'other' }], totalPages: 1 }) });
    expect(await helper.reconcileKycSubmission(input)).toBeNull();
    expect(reads.some(read => read.path === '/customer/get')).toBe(false);
  });

  it('retains safe customer rejection diagnostics without adopting an older identity match or replaying the POST', async () => {
    const upstream = Object.assign(new UpayError('PRIVATE upstream identity, token and validation message', true, 987654), {
      metadata: { phase: 'post_dispatched', ack: 'rejected_envelope', httpStatus: 200 } as const,
    });
    const { helper, recreate, journal, writes, uploaded } = fixture({ customerError: upstream,
      customerPage: () => ({ list: [{ ...markedCustomer, remark: 'GUDEX-KYC:older-generation' }], totalPages: 1 }) });
    await expect(helper.createCustomer(input)).rejects.toThrow('matching receipt');
    expect(await journal.get(`customer:${submissionId}`)).toMatchObject({ state: 'unknown', partnerReceiptId: null, evidence: {
      step: 'customer_add', dispatchPhase: 'post_dispatched', responseAck: 'rejected_envelope', upstreamCode: 987654, httpStatus: 200,
    } });
    await expect(recreate().createCustomer(input)).rejects.toThrow('matching receipt');
    expect(await recreate().reconcileKycSubmission(input)).toBeNull();
    expect(writes.map(write => write.path)).toEqual(['/customer/add']);
    expect(uploaded()).toBe(0);
    expect(await journal.get(`kyc:${submissionId}`)).toBeNull();
    const stored = JSON.stringify(await journal.get(`customer:${submissionId}`));
    for (const privateValue of ['PRIVATE', 'identity', 'token', input.email, input.firstName, input.lastName, input.kyc.phone]) expect(stored).not.toContain(privateValue);
  });

  it('records an accepted customer envelope even while the exact marker receipt remains unavailable', async () => {
    const { helper, journal, writes } = fixture({ hideCreatedCustomer: true });
    await expect(helper.createCustomer(input)).rejects.toThrow('matching receipt');
    expect(await journal.get(`customer:${submissionId}`)).toMatchObject({ state: 'unknown', partnerReceiptId: null,
      evidence: { step: 'customer_add', dispatchPhase: 'post_dispatched', responseAck: 'accepted_envelope' } });
    expect(writes.map(write => write.path)).toEqual(['/customer/add']);
  });

  it.each(['file_upload', 'kyc_submit'] as const)('retains safe %s rejection diagnostics and never replays its POST after helper recreation', async step => {
    const error = Object.assign(new UpayError('PRIVATE photo URL, identity and response message', true, 987655), {
      metadata: { phase: 'post_dispatched', ack: 'rejected_envelope', httpStatus: 200 } as const,
    });
    const { helper, recreate, journal, writes, uploaded } = fixture(step === 'file_upload' ? { uploadError: error } : { kycError: error });
    const reference = step === 'file_upload' ? `upload:${submissionId}:front` : `kyc:${submissionId}`;
    await expect(helper.createCustomer(input)).rejects.toMatchObject({ customerNo: 'CUSTOMER-1' });
    expect(await journal.get(reference)).toMatchObject({ state: 'unknown', evidence: {
      step, dispatchPhase: 'post_dispatched', responseAck: 'rejected_envelope', upstreamCode: 987655, httpStatus: 200,
    } });
    const stored = JSON.stringify(await journal.get(reference));
    for (const privateValue of ['PRIVATE', 'private-file', input.email, input.firstName, input.lastName, input.kyc.phone]) expect(stored).not.toContain(privateValue);
    if (step === 'file_upload') await expect(recreate().createCustomer(input)).rejects.toThrow('upload receipt');
    else await expect(recreate().createCustomer(input)).resolves.toBe('CUSTOMER-1');
    expect(uploaded()).toBe(step === 'file_upload' ? 1 : 2);
    expect(writes.filter(write => write.path === '/customer/add')).toHaveLength(1);
    expect(writes.filter(write => write.path === '/card/submit/kyc')).toHaveLength(step === 'file_upload' ? 0 : 1);
  });
});
