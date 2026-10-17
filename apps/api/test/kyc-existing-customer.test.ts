import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { jobs, kycDocuments, kycProfiles, upaySubmissions, users } from '../src/db/schema';
import { accounts, move, post } from '../src/ledger/ledger';
import { inspectExistingKycCustomer, resumeExistingKycCustomer } from '../src/ops/kyc-existing-customer';
import type { UpayClient } from '../src/partner/upay/client';
import { createTestContext, type TestContext } from './helpers';

const target = '514468501';
let ctx: TestContext | undefined;
afterEach(async () => { await ctx?.close(); ctx = undefined; });

async function fixture() {
  ctx = await createTestContext(undefined, { env: { CARD_PARTNER: 'upay', DEV_TOOLS: 'false', UPAY_KYC_ENABLED: 'true',
    UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ' } });
  const [user] = await ctx.db.insert(users).values({ telegramId: BigInt(target), firstName: 'Synthetic fixture' }).returning();
  const submissionId = randomUUID(), oldSubmissionId = randomUUID(), front = randomUUID(), selfie = randomUUID();
  await ctx.db.insert(kycProfiles).values({ userId: user!.id, partnerProvider: 'upay', status: 'unknown', submissionState: 'unknown',
    submissionId, firstName: 'TEST', lastName: 'USER', email: 'owner@example.test', birthDate: '1990-01-01', citizenship: 'KZ',
    phone: '7771234567', globalCode: '+7', documentType: 'passport', documentCountry: 'KZ', documentIds: { front, selfie } });
  await ctx.db.insert(kycDocuments).values(['front', 'selfie'].map((kind, index) => ({ id: index ? selfie : front, userId: user!.id,
    kind, mimeType: 'image/png', size: 8, ciphertext: 'encrypted-fixture', iv: 'fixture', tag: 'fixture', expiresAt: new Date(Date.now() + 86400000) })));
  await ctx.db.insert(upaySubmissions).values({ reference: `customer:${submissionId}`, kind: 'customer', state: 'unknown', requestHash: 'original-user-request', evidence: { submissionId } });
  await ctx.db.insert(jobs).values({ queue: 'kyc.submit', payload: { userId: user!.id, submissionId }, status: 'done' });
  const masked = { customerId: 'EXISTING-ID', no: 'EXISTING-NO', accountId: 'EXISTING-ACCOUNT', remark: `GUDEX-KYC:${oldSubmissionId}`,
    email: 'o***@example.test', givenName: 'T***', lastName: 'U***' };
  const detail = { ...masked, email: 'owner@example.test', givenName: 'TEST', lastName: 'USER', phone: '7771234567', globalCode: '+7' };
  const reads: { method: string; path: string; query?: Record<string, unknown> }[] = [];
  const remote = { filtered: [masked], global: [masked], detail, cards: [] as Record<string, unknown>[],
    totalPages: 1, beforeCardRead: undefined as (() => Promise<void>) | undefined };
  const client = { readRequest: async (method: string, path: string, options?: { query?: Record<string, unknown> }) => {
    reads.push({ method, path, query: options?.query });
    if (method !== 'GET') throw new Error('A customer recovery must never send a remote mutation');
    if (path === '/customer/list') return { list: options?.query?.email ? remote.filtered : remote.global,
      totalPages: options?.query?.email ? 1 : remote.totalPages };
    if (path === '/customer/get') return remote.detail;
    if (path === '/card/list') { await remote.beforeCardRead?.(); return { list: remote.cards, totalPages: 1 }; }
    throw new Error('Unexpected recovery endpoint');
  } } as unknown as Pick<UpayClient, 'readRequest'>;
  const expected = { userId: user!.id, submissionId, customerId: masked.customerId, customerNo: masked.no, legacyMarker: masked.remark };
  return { userId: user!.id, submissionId, oldSubmissionId, front, selfie, client, remote, reads, expected };
}

async function localRows() {
  return { users: await ctx!.db.select().from(users), profiles: await ctx!.db.select().from(kycProfiles),
    journals: await ctx!.db.select().from(upaySubmissions), jobs: await ctx!.db.select().from(jobs), documents: await ctx!.db.select().from(kycDocuments) };
}

async function previouslyBound(status: 'unknown' | 'rejected' = 'rejected') {
  const f = await fixture();
  await resumeExistingKycCustomer(ctx!.db, f.client, target, f.expected);
  await ctx!.db.update(jobs).set({ status: 'done' });
  await ctx!.db.update(kycProfiles).set({ status, submissionState: status === 'unknown' ? 'unknown' : 'none', rejectionReason: 'Fixture preflight failure' })
    .where(eq(kycProfiles.userId, f.userId));
  return f;
}

describe('explicit recovery using the same owner’s existing UPay customer', () => {
  it('binds the verified older customer and queues the existing user submission without any remote POST', async () => {
    const f = await fixture();
    const inspection = await inspectExistingKycCustomer(ctx!.db, f.client, target);
    expect(inspection).toMatchObject({ status: 'eligible', eligible: true, remoteMutationsPerformed: false });
    expect(JSON.stringify(inspection)).not.toContain('owner@example.test');
    expect(await resumeExistingKycCustomer(ctx!.db, f.client, target, inspection.snapshot)).toEqual({
      status: 'pending', submissionState: 'queued', queued: true, remoteMutationsPerformed: false,
    });
    expect(await ctx!.services.kyc.get(f.userId)).toMatchObject({ status: 'pending', submissionState: 'queued' });
    expect((await ctx!.db.select().from(kycProfiles))[0]).toMatchObject({ partnerCustomerId: 'EXISTING-NO', submissionId: f.submissionId });
    expect((await ctx!.db.select().from(upaySubmissions).where(eq(upaySubmissions.reference, `customer:${f.submissionId}`)))[0])
      .toMatchObject({ state: 'unknown', partnerReceiptId: null, requestHash: 'original-user-request' });
    expect((await ctx!.db.select().from(upaySubmissions).where(eq(upaySubmissions.reference, `customer-binding:${f.submissionId}`)))[0])
      .toMatchObject({ kind: 'customer_binding', state: 'confirmed', partnerReceiptId: null,
        evidence: { submissionId: f.submissionId, customerNo: 'EXISTING-NO', operatorBound: true } });
    expect((await ctx!.db.select().from(jobs)).filter(job => job.status === 'queued' && job.queue === 'kyc.submit')).toHaveLength(1);
    expect(f.reads.every(read => read.method === 'GET')).toBe(true);
    const before = await localRows();
    const readCount = f.reads.length;
    await expect(resumeExistingKycCustomer(ctx!.db, f.client, target, inspection.snapshot)).rejects.toMatchObject({ code: 'validation' });
    expect(await localRows()).toEqual(before);
    expect(f.reads).toHaveLength(readCount);
  });

  it('serializes concurrent operator confirmations and queues one continuation of the same generation', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([resumeExistingKycCustomer(ctx!.db, f.client, target, f.expected),
      resumeExistingKycCustomer(ctx!.db, f.client, target, f.expected)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const state = await localRows();
    expect(state.jobs.filter(job => job.status === 'queued' && job.queue === 'kyc.submit')).toHaveLength(1);
    expect(state.journals.filter(journal => journal.kind === 'customer_binding')).toHaveLength(1);
    expect(state.profiles[0]).toMatchObject({ status: 'pending', partnerCustomerId: 'EXISTING-NO', submissionId: f.submissionId });
  });

  it('continues an already operator-bound submission rejected before any upload and preserves both journals', async () => {
    const f = await fixture();
    await resumeExistingKycCustomer(ctx!.db, f.client, target, f.expected);
    // Model the worker's local preflight rejection: nothing was uploaded or submitted.
    await ctx!.db.update(jobs).set({ status: 'done' });
    await ctx!.db.update(kycProfiles).set({ status: 'rejected', submissionState: 'none', rejectionReason: 'Fixture preflight failure' })
      .where(eq(kycProfiles.userId, f.userId));
    const journals = await ctx!.db.select().from(upaySubmissions);
    const inspection = await inspectExistingKycCustomer(ctx!.db, f.client, target);
    expect(inspection).toMatchObject({ status: 'eligible', snapshot: f.expected });
    expect(await resumeExistingKycCustomer(ctx!.db, f.client, target, inspection.snapshot)).toMatchObject({ status: 'pending', queued: true, remoteMutationsPerformed: false });
    expect(await ctx!.db.select().from(upaySubmissions)).toEqual(journals);
    expect((await ctx!.db.select().from(jobs)).filter(job => job.queue === 'kyc.submit' && job.status === 'queued')).toHaveLength(1);
    expect((await ctx!.db.select().from(kycProfiles))[0]).toMatchObject({ partnerCustomerId: 'EXISTING-NO', submissionId: f.submissionId,
      status: 'pending', submissionState: 'queued', rejectionReason: null, documentsSubmittedAt: null, reviewedAt: null });
    expect(f.reads.every(read => read.method === 'GET')).toBe(true);
  });

  it('also resumes an unknown operator-bound preflight once under concurrent confirmations', async () => {
    const f = await previouslyBound('unknown');
    const journals = await ctx!.db.select().from(upaySubmissions);
    const results = await Promise.allSettled([resumeExistingKycCustomer(ctx!.db, f.client, target, f.expected),
      resumeExistingKycCustomer(ctx!.db, f.client, target, f.expected)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await ctx!.db.select().from(jobs)).filter(job => job.queue === 'kyc.submit' && job.status === 'queued')).toHaveLength(1);
    expect(await ctx!.db.select().from(upaySubmissions)).toEqual(journals);
    const before = await localRows();
    await expect(resumeExistingKycCustomer(ctx!.db, f.client, target, f.expected)).rejects.toMatchObject({ code: 'validation' });
    expect(await localRows()).toEqual(before);
  });

  it.each(['customer number', 'operator flag', 'submission ID', 'request hash', 'receipt', 'state', 'missing binding'] as const)
    ('never trusts an existing operator binding with a conflicting %s', async scenario => {
      const f = await previouslyBound();
      const reference = `customer-binding:${f.submissionId}`;
      if (scenario === 'missing binding') await ctx!.db.delete(upaySubmissions).where(eq(upaySubmissions.reference, reference));
      else {
        const evidence = { submissionId: scenario === 'submission ID' ? randomUUID() : f.submissionId,
          customerNo: scenario === 'customer number' ? 'ANOTHER-CUSTOMER' : 'EXISTING-NO', operatorBound: scenario !== 'operator flag' };
        await ctx!.db.update(upaySubmissions).set({ evidence,
          ...(scenario === 'request hash' ? { requestHash: '0'.repeat(64) } : {}),
          ...(scenario === 'receipt' ? { partnerReceiptId: 'EXISTING-NO' } : {}),
          ...(scenario === 'state' ? { state: 'unknown' } : {}),
        }).where(eq(upaySubmissions.reference, reference));
      }
      const before = await localRows();
      await expect(inspectExistingKycCustomer(ctx!.db, f.client, target)).rejects.toMatchObject({ code: 'validation' });
      await expect(resumeExistingKycCustomer(ctx!.db, f.client, target, f.expected)).rejects.toMatchObject({ code: 'validation' });
      expect(await localRows()).toEqual(before);
    });

  it.each(['upload', 'kyc', 'primary document'] as const)('refuses to resume an already-bound customer after any %s dispatch', async kind => {
    const f = await previouslyBound();
    const reference = kind === 'upload' ? `upload:${f.submissionId}:front` : kind === 'kyc' ? `kyc:${f.submissionId}` : `primary:${f.submissionId}:1`;
    await ctx!.db.insert(upaySubmissions).values({ reference, kind, requestHash: 'fixture-dispatched', state: 'unknown',
      evidence: { submissionId: f.submissionId, customerNo: 'EXISTING-NO' } });
    const before = await localRows();
    await expect(resumeExistingKycCustomer(ctx!.db, f.client, target, f.expected)).rejects.toMatchObject({ code: 'validation' });
    expect(await localRows()).toEqual(before);
  });

  it.each(['documents submitted', 'already reviewed', 'foreign journal'] as const)('keeps bound-customer recovery limited to untouched preflight: %s', async scenario => {
    const f = await previouslyBound();
    if (scenario === 'foreign journal') await ctx!.db.insert(upaySubmissions).values({ reference: 'foreign-fixture', kind: 'customer',
      state: 'unknown', requestHash: 'foreign-fixture', evidence: { customerNo: 'EXISTING-NO' } });
    else await ctx!.db.update(kycProfiles).set(scenario === 'documents submitted' ? { documentsSubmittedAt: new Date() } : { reviewedAt: new Date() })
      .where(eq(kycProfiles.userId, f.userId));
    const before = await localRows();
    await expect(resumeExistingKycCustomer(ctx!.db, f.client, target, f.expected)).rejects.toMatchObject({ code: 'validation' });
    expect(await localRows()).toEqual(before);
  });

  it('rechecks the durable binding after remote proof and never overwrites a changed binding', async () => {
    const f = await previouslyBound();
    f.remote.beforeCardRead = async () => { await ctx!.db.update(upaySubmissions).set({ requestHash: '0'.repeat(64) })
      .where(eq(upaySubmissions.reference, `customer-binding:${f.submissionId}`)); };
    await expect(resumeExistingKycCustomer(ctx!.db, f.client, target, f.expected)).rejects.toMatchObject({ code: 'validation' });
    expect((await ctx!.db.select().from(upaySubmissions)).find(journal => journal.kind === 'customer_binding')?.requestHash).toBe('0'.repeat(64));
    expect((await ctx!.db.select().from(kycProfiles))[0]).toMatchObject({ status: 'rejected', submissionState: 'none' });
    expect((await ctx!.db.select().from(jobs)).filter(job => job.status === 'queued')).toEqual([]);
  });

  it.each(['email', 'givenName', 'lastName', 'phone', 'globalCode', 'customerId', 'no', 'remark'] as const)
    ('rejects a customer detail with mismatched %s without changing any local data', async field => {
      const f = await fixture();
      f.remote.detail[field] = 'different-fixture-value';
      const before = await localRows();
      await expect(resumeExistingKycCustomer(ctx!.db, f.client, target, f.expected)).rejects.toMatchObject({ code: 'validation' });
      expect(await localRows()).toEqual(before);
      expect(f.reads.every(read => read.method === 'GET')).toBe(true);
    });

  it.each(['unmarked', 'current marker', 'duplicate marker', 'incomplete scan', 'unsafe identifier', 'remote card', 'unidentified card'] as const)
    ('does not adopt an existing customer with %s', async scenario => {
      const f = await fixture();
      if (scenario === 'unmarked') f.remote.filtered = [{ ...f.remote.filtered[0]!, remark: 'unrelated' }];
      if (scenario === 'current marker') f.remote.filtered = [{ ...f.remote.filtered[0]!, remark: `GUDEX-KYC:${f.submissionId}` }];
      if (scenario === 'duplicate marker') f.remote.global.push({ ...f.remote.global[0]!, customerId: 'OTHER-ID', no: 'OTHER-NO' });
      if (scenario === 'incomplete scan') f.remote.totalPages = 21;
      if (scenario === 'unsafe identifier') Object.assign(f.remote.filtered[0]!, { customerId: Number.MAX_SAFE_INTEGER + 1 });
      if (scenario === 'remote card') f.remote.cards.push({ customerNo: 'EXISTING-NO', agentCustomerCardId: 'EXISTING-CARD' });
      if (scenario === 'unidentified card') f.remote.cards.push({ agentCustomerCardId: 'UNBOUND-CARD' });
      const before = await localRows();
      await expect(resumeExistingKycCustomer(ctx!.db, f.client, target, f.expected)).rejects.toMatchObject({ code: 'validation' });
      expect(await localRows()).toEqual(before);
    });

  it.each(['profile number', 'profile old submission', 'journal receipt', 'journal number', 'journal old submission', 'foreign current document'] as const)
    ('preserves other users and refuses a shared %s binding', async scenario => {
      const f = await fixture();
      const [other] = await ctx!.db.insert(users).values({ telegramId: BigInt(target) + 1n }).returning();
      await ctx!.db.insert(kycProfiles).values({ userId: other!.id, partnerProvider: 'upay',
        partnerCustomerId: scenario === 'profile number' ? 'EXISTING-NO' : null,
        submissionId: scenario === 'profile old submission' ? f.oldSubmissionId : null,
        documentIds: scenario === 'foreign current document' ? { front: f.front } : null });
      if (scenario.startsWith('journal')) await ctx!.db.insert(upaySubmissions).values({ reference: `customer:${randomUUID()}`, kind: 'customer',
        requestHash: 'foreign-fixture', state: 'unknown', partnerReceiptId: scenario === 'journal receipt' ? 'EXISTING-NO' : null,
        evidence: scenario === 'journal number' ? { customerNo: 'EXISTING-NO' } : scenario === 'journal old submission' ? { submissionId: f.oldSubmissionId } : {} });
      const before = await localRows();
      await expect(resumeExistingKycCustomer(ctx!.db, f.client, target, f.expected)).rejects.toMatchObject({ code: 'validation' });
      expect(await localRows()).toEqual(before);
    });

  it('allows unrelated local customers, remote cards and background jobs without changing them', async () => {
    const f = await fixture();
    const [other] = await ctx!.db.insert(users).values({ telegramId: BigInt(target) + 1n }).returning();
    await ctx!.db.insert(kycProfiles).values({ userId: other!.id, partnerProvider: 'upay', partnerCustomerId: 'FOREIGN-CUSTOMER', submissionId: randomUUID() });
    await ctx!.db.insert(jobs).values({ queue: 'kyc.submit', payload: { userId: other!.id, submissionId: randomUUID() }, status: 'running' });
    f.remote.cards.push({ customerNo: 'FOREIGN-CUSTOMER', agentCustomerCardId: 'FOREIGN-CARD' });
    const foreignBefore = (await localRows()).profiles.find(profile => profile.userId === other!.id);
    await resumeExistingKycCustomer(ctx!.db, f.client, target, f.expected);
    expect((await localRows()).profiles.find(profile => profile.userId === other!.id)).toEqual(foreignBefore);
  });

  it.each(['queued', 'running', 'expired running'] as const)('never queues alongside an existing %s KYC job', async status => {
    const f = await fixture();
    await ctx!.db.insert(jobs).values({ queue: 'kyc.submit', payload: { userId: f.userId, submissionId: f.submissionId },
      status: status === 'queued' ? 'queued' : 'running', lockedUntil: status === 'expired running' ? new Date(0) : null });
    const before = await localRows();
    await expect(resumeExistingKycCustomer(ctx!.db, f.client, target, f.expected)).rejects.toMatchObject({ code: 'validation' });
    expect(await localRows()).toEqual(before);
    expect(f.reads).toEqual([]);
  });

  it.each(['upload', 'kyc'] as const)('keeps an uncertain existing %s journal and never replays it', async kind => {
    const f = await fixture();
    await ctx!.db.insert(upaySubmissions).values({ reference: kind === 'kyc' ? `kyc:${f.submissionId}` : `upload:${f.submissionId}:front`,
      kind, requestHash: 'original-fixture', state: 'unknown', evidence: { submissionId: f.submissionId } });
    const before = await localRows();
    await expect(resumeExistingKycCustomer(ctx!.db, f.client, target, f.expected)).rejects.toMatchObject({ code: 'validation' });
    expect(await localRows()).toEqual(before);
    expect(f.reads).toEqual([]);
  });

  it('blocks financial history even if the wallet has returned to zero', async () => {
    const f = await fixture();
    await ctx!.db.transaction(async tx => {
      await post(tx, { kind: 'fixture', reference: 'fixture-in', postings: move(accounts.external('USDT'), accounts.userWallet(f.userId, 'USDT'), 10n) });
      await post(tx, { kind: 'fixture', reference: 'fixture-out', postings: move(accounts.userWallet(f.userId, 'USDT'), accounts.external('USDT'), 10n) });
    });
    const before = await localRows();
    await expect(resumeExistingKycCustomer(ctx!.db, f.client, target, f.expected)).rejects.toMatchObject({ code: 'validation' });
    expect(await localRows()).toEqual(before);
  });

  it.each(['foreign owner', 'wrong kind', 'expired'] as const)('requires every current document to be valid: %s', async failure => {
    const f = await fixture();
    if (failure === 'foreign owner') {
      const [other] = await ctx!.db.insert(users).values({ telegramId: BigInt(target) + 1n }).returning();
      await ctx!.db.update(kycDocuments).set({ userId: other!.id }).where(eq(kycDocuments.id, f.front));
    } else await ctx!.db.update(kycDocuments).set(failure === 'wrong kind' ? { kind: 'back' } : { expiresAt: new Date(0) }).where(eq(kycDocuments.id, f.front));
    const before = await localRows();
    await expect(resumeExistingKycCustomer(ctx!.db, f.client, target, f.expected)).rejects.toMatchObject({ code: 'validation' });
    expect(await localRows()).toEqual(before);
  });

  it.each(['generation', 'document expiry'] as const)('checks %s again after remote lookups and before enqueuing', async change => {
    const f = await fixture();
    f.remote.beforeCardRead = async () => {
      if (change === 'generation') await ctx!.db.update(kycProfiles).set({ submissionId: randomUUID() }).where(eq(kycProfiles.userId, f.userId));
      else await ctx!.db.update(kycDocuments).set({ expiresAt: new Date(0) }).where(eq(kycDocuments.id, f.front));
    };
    await expect(resumeExistingKycCustomer(ctx!.db, f.client, target, f.expected)).rejects.toMatchObject({ code: 'validation' });
    const after = await localRows();
    expect(after.profiles[0]).toMatchObject({ status: 'unknown', partnerCustomerId: null });
    expect(after.journals).toHaveLength(1);
    expect(after.jobs.filter(job => job.status === 'queued')).toEqual([]);
  });

  it('refuses any account or opaque snapshot outside the explicit authorization', async () => {
    const f = await fixture();
    const before = await localRows();
    await expect(inspectExistingKycCustomer(ctx!.db, f.client, '514468502')).rejects.toMatchObject({ code: 'validation' });
    await expect(resumeExistingKycCustomer(ctx!.db, f.client, target, { ...f.expected, userId: randomUUID() })).rejects.toMatchObject({ code: 'validation' });
    await expect(resumeExistingKycCustomer(ctx!.db, f.client, target, { ...f.expected, customerId: 'ANOTHER-CUSTOMER' })).rejects.toMatchObject({ code: 'validation' });
    expect(await localRows()).toEqual(before);
  });
});
