import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { jobs, kycProfiles, upaySubmissions, users } from '../src/db/schema';
import { accounts, move, post } from '../src/ledger/ledger';
import { inspectKycSubjectAttestation, recordKycSubjectAttestation } from '../src/ops/kyc-subject-attestation';
import type { UpayClient } from '../src/partner/upay/client';
import { createTestContext, type TestContext } from './helpers';

const TARGET = '514468501', PRODUCT = 'PRODUCT-FIXTURE';
const CONFIRMATION = 'RECORD_MY_OBSERVED_PRIMARY_KYC_TRANSITION' as const;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown) => value as Record<string, unknown>;
let ctx: TestContext | undefined;
afterEach(async () => { await ctx?.close(); ctx = undefined; });

async function fixture(documentType: 'id_card' | 'passport' = 'id_card') {
  ctx = await createTestContext();
  const [user] = await ctx.db.insert(users).values({ telegramId: BigInt(TARGET), firstName: 'Synthetic' }).returning();
  const sid = randomUUID(), oldSid = randomUUID(), no = 'SYNTHETIC-NO', id = 'SYNTHETIC-ID';
  const beforeAt = Date.now() - 1200000, uploadedAt = beforeAt + 2000, submittedAt = beforeAt + 5000, reviewAt = beforeAt + 20000;
  await ctx.db.insert(kycProfiles).values({ userId: user!.id, partnerProvider: 'upay', status: 'unknown', submissionState: 'unknown',
    submissionId: sid, partnerCustomerId: no, firstName: 'TEST', lastName: 'USER', email: 'synthetic@example.test',
    phone: '7771234567', globalCode: '+7', documentType, documentCountry: 'KZ', birthDate: '1990-01-01', citizenship: 'KZ',
    documentIds: { front: randomUUID(), ...(documentType === 'id_card' ? { back: randomUUID() } : {}) },
    submittedAt: new Date(beforeAt - 600000), documentsSubmittedAt: new Date(submittedAt + 1000) });
  const snapshot = { userId: user!.id, submissionId: sid, requestHash: hash('current-accepted-primary-payload') };
  const bindingSnapshot = { userId: user!.id, submissionId: sid, customerId: id, customerNo: no, legacyMarker: `GUDEX-KYC:${oldSid}` };
  await ctx.db.insert(upaySubmissions).values([
    { reference: `customer:${sid}`, kind: 'customer', state: 'unknown', requestHash: hash('original-create'), evidence: { submissionId: sid } },
    { reference: `customer-binding:${sid}`, kind: 'customer_binding', state: 'confirmed', requestHash: hash(JSON.stringify(bindingSnapshot)),
      evidence: { submissionId: sid, customerNo: no, operatorBound: true } },
    { reference: `kyc:${sid}`, kind: 'kyc', state: 'acknowledged', requestHash: snapshot.requestHash,
      createdAt: new Date(submittedAt), updatedAt: new Date(reviewAt), evidence: {
        customerNo: no, submissionId: sid, documentType: documentType === 'id_card' ? 1 : 2, kycProtocol: 'customer_primary',
        nationalityCodeHash: hash(JSON.stringify(398)), documentFrontHash: hash('front-uri'), documentBackHash: hash(documentType === 'id_card' ? 'back-uri' : '*'),
        step: 'kyc_submit', dispatchPhase: 'post_dispatched', responseAck: 'accepted_envelope', status: 'pending',
      } },
    ...(documentType === 'id_card' ? ['front', 'back'] : ['front']).map(role => ({ reference: `upload:${sid}:${role}`, kind: 'upload',
      state: 'confirmed', requestHash: hash(role), createdAt: new Date(uploadedAt), evidence: { customerNo: no, submissionId: sid, documentRole: role } })),
  ]);
  await ctx.db.insert(jobs).values({ queue: 'kyc.submit', payload: { userId: user!.id, submissionId: sid }, status: 'done' });
  const candidate = { customerId: id, no, remark: bindingSnapshot.legacyMarker };
  const remote = {
    filtered: [candidate], global: [candidate], totalPages: 1, cards: [] as Record<string, unknown>[],
    detail: { ...candidate, email: 'synthetic@example.test', givenName: 'TEST', lastName: 'USER', phone: '7771234567', globalCode: '+7' } as Record<string, unknown>,
    info: { authResult: 1, primaryApprovedNum: 1, items: [{ documentType: documentType === 'id_card' ? 1 : 2, level: 1, status: 1,
      nationalityCode: null, frontPhoto: null, backPhoto: null }] } as Record<string, unknown>,
    product: { kycLevel: 1 }, mirror: { customerNo: no, certifiedDocumentType: [documentType === 'id_card' ? 1 : 2] },
    onMirror: undefined as (() => Promise<void>) | undefined,
  };
  const reads: { method: string; path: string; query?: Record<string, unknown> }[] = [];
  const client = { readRequest: async (method: string, path: string, options?: { query?: Record<string, unknown> }) => {
    reads.push({ method, path, query: options?.query });
    if (method !== 'GET') throw new Error('Attestation must not perform a remote mutation');
    if (path === '/customer/list') return { list: options?.query?.email ? remote.filtered : remote.global, totalPages: options?.query?.email ? 1 : remote.totalPages };
    if (path === '/customer/get') return remote.detail;
    if (path === '/card/list') return { list: remote.cards, totalPages: 1 };
    if (path === '/kyc/info') return remote.info;
    if (path === '/card/getMayApplyCardDetail') return remote.product;
    if (path === '/card/get/kyc') { await remote.onMirror?.(); return remote.mirror; }
    throw new Error('Unexpected attestation endpoint');
  } } as unknown as Pick<UpayClient, 'readRequest'>;
  const input = { expected: snapshot, observedBeforeAt: new Date(beforeAt).toISOString(), observedReviewAt: new Date(reviewAt).toISOString(), confirmation: CONFIRMATION };
  return { userId: user!.id, sid, oldSid, no, snapshot, input, remote, reads, client, beforeAt, uploadedAt, submittedAt, reviewAt };
}

async function state() {
  return { users: await ctx!.db.select().from(users), profiles: await ctx!.db.select().from(kycProfiles),
    journals: await ctx!.db.select().from(upaySubmissions).orderBy(upaySubmissions.reference), jobs: await ctx!.db.select().from(jobs) };
}
async function changeKyc(sid: string, patch: Record<string, unknown>) {
  const [current] = await ctx!.db.select().from(upaySubmissions).where(eq(upaySubmissions.reference, `kyc:${sid}`));
  await ctx!.db.update(upaySubmissions).set({ evidence: { ...object(current!.evidence), ...patch } }).where(eq(upaySubmissions.reference, `kyc:${sid}`));
}

describe('operator-observed primary subject transition attestation', () => {
  it.each(['id_card', 'passport'] as const)('records only provenance for an accepted %s generation, preserving all receipts and unknown profile', async type => {
    const f = await fixture(type), before = await state();
    const inspected = await inspectKycSubjectAttestation(ctx!.db, f.client, TARGET, PRODUCT);
    expect(inspected).toMatchObject({ eligible: true, snapshot: f.snapshot, remoteMutationsPerformed: false });
    expect(JSON.stringify(inspected)).not.toContain('synthetic@example.test');
    expect(await state()).toEqual(before);
    const now = Date.now();
    expect(await recordKycSubjectAttestation(ctx!.db, f.client, TARGET, PRODUCT, f.input)).toEqual({ recorded: true, status: 'unknown', remoteMutationsPerformed: false });
    const after = await state();
    expect(after.profiles).toEqual(before.profiles);
    expect(after.jobs).toEqual(before.jobs);
    expect(after.users).toEqual(before.users);
    const journal = after.journals.find(row => row.reference === `kyc:${f.sid}`)!;
    const original = before.journals.find(row => row.reference === `kyc:${f.sid}`)!;
    expect(journal).toMatchObject({ ...original, updatedAt: expect.any(Date), evidence: { ...object(original.evidence),
      primaryInitialStatus: 4, primaryReviewObserved: true, primaryObservationSource: 'operator_observed_transition',
      primaryInitialObservedAt: f.beforeAt, primaryReviewObservedAt: f.reviewAt, primaryAttestedAt: expect.any(Number) } });
    expect(Number(object(journal.evidence).primaryAttestedAt)).toBeGreaterThanOrEqual(now);
    expect(object(journal.evidence).approvalBasis).toBeUndefined();
    expect(object(journal.evidence).photoReceiptMatched).toBeUndefined();
    expect(after.journals.filter(row => row.reference !== journal.reference)).toEqual(before.journals.filter(row => row.reference !== journal.reference));
    expect(f.reads.every(read => read.method === 'GET')).toBe(true);
    const afterRecord = await state(), count = f.reads.length;
    await expect(recordKycSubjectAttestation(ctx!.db, f.client, TARGET, PRODUCT, f.input)).rejects.toMatchObject({ code: 'validation' });
    expect(await state()).toEqual(afterRecord);
    expect(f.reads).toHaveLength(count);
  });

  it('serializes simultaneous confirmations and cannot overwrite the original observation', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([recordKycSubjectAttestation(ctx!.db, f.client, TARGET, PRODUCT, f.input),
      recordKycSubjectAttestation(ctx!.db, f.client, TARGET, PRODUCT, f.input)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await state()).profiles[0]).toMatchObject({ status: 'unknown', submissionState: 'unknown' });
  });

  it.each(['unknown POST', 'unconfirmed envelope', 'wrong protocol', 'missing hash', 'existing baseline', 'wrong customer', 'wrong document type'] as const)
    ('blocks %s without changing any local row or making a remote call', async scenario => {
      const f = await fixture();
      if (scenario === 'unknown POST') await ctx!.db.update(upaySubmissions).set({ state: 'unknown' }).where(eq(upaySubmissions.reference, `kyc:${f.sid}`));
      else await changeKyc(f.sid, scenario === 'unconfirmed envelope' ? { responseAck: 'unconfirmed' } : scenario === 'wrong protocol' ? { kycProtocol: 'card' }
        : scenario === 'missing hash' ? { nationalityCodeHash: null } : scenario === 'existing baseline' ? { primaryInitialStatus: 4 }
        : scenario === 'wrong customer' ? { customerNo: 'OTHER-NO' } : { documentType: 2 });
      const before = await state();
      await expect(recordKycSubjectAttestation(ctx!.db, f.client, TARGET, PRODUCT, f.input)).rejects.toMatchObject({ code: 'validation' });
      expect(await state()).toEqual(before);
      expect(f.reads).toHaveLength(0);
    });

  it.each(['foreign country', 'foreign front', 'missing back', 'pending item', 'wrong auth', 'duplicate item', 'higher product', 'foreign mirror', 'wrong certified type', 'identity mismatch', 'duplicate marker', 'remote card', 'binding hash'] as const)
    ('refuses issuer subject recovery with %s', async scenario => {
      const f = await fixture(), item = (f.remote.info.items as Record<string, unknown>[])[0]!;
      if (scenario === 'foreign country') item.nationalityCode = 398;
      if (scenario === 'foreign front') item.frontPhoto = 'other-document-uri';
      if (scenario === 'missing back') delete item.backPhoto;
      if (scenario === 'pending item') item.status = 3;
      if (scenario === 'wrong auth') f.remote.info.authResult = 2;
      if (scenario === 'duplicate item') (f.remote.info.items as unknown[]).push({ ...item });
      if (scenario === 'higher product') f.remote.product.kycLevel = 2;
      if (scenario === 'foreign mirror') f.remote.mirror.customerNo = 'OTHER-NO';
      if (scenario === 'wrong certified type') f.remote.mirror.certifiedDocumentType = [2];
      if (scenario === 'identity mismatch') f.remote.detail.phone = 'other-phone';
      if (scenario === 'duplicate marker') f.remote.global.push({ ...f.remote.global[0]!, customerId: 'OTHER-ID', no: 'OTHER-NO' });
      if (scenario === 'remote card') f.remote.cards.push({ customerNo: f.no });
      if (scenario === 'binding hash') await ctx!.db.update(upaySubmissions).set({ requestHash: '0'.repeat(64) }).where(eq(upaySubmissions.reference, `customer-binding:${f.sid}`));
      const before = await state();
      await expect(recordKycSubjectAttestation(ctx!.db, f.client, TARGET, PRODUCT, f.input)).rejects.toMatchObject({ code: 'validation' });
      expect(await state()).toEqual(before);
      expect(f.reads.every(read => read.method === 'GET')).toBe(true);
    });

  it.each(['after upload', 'review before submit', 'future review', 'older than an hour', 'malformed date', 'reversed', 'missing confirmation'] as const)
    ('rejects an untrustworthy observation window: %s', async scenario => {
      const f = await fixture();
      if (scenario === 'after upload') f.input.observedBeforeAt = new Date(f.uploadedAt + 1).toISOString();
      if (scenario === 'review before submit') f.input.observedReviewAt = new Date(f.submittedAt - 1).toISOString();
      if (scenario === 'future review') f.input.observedReviewAt = new Date(Date.now() + 60000).toISOString();
      if (scenario === 'older than an hour') f.input.observedBeforeAt = new Date(Date.now() - 3600001).toISOString();
      if (scenario === 'malformed date') f.input.observedBeforeAt = 'not-a-date';
      if (scenario === 'reversed') f.input.observedReviewAt = new Date(f.beforeAt - 1).toISOString();
      if (scenario === 'missing confirmation') (f.input as unknown as Record<string, unknown>).confirmation = '';
      const before = await state();
      await expect(recordKycSubjectAttestation(ctx!.db, f.client, TARGET, PRODUCT, f.input)).rejects.toMatchObject({ code: 'validation' });
      expect(await state()).toEqual(before);
      expect(f.reads).toHaveLength(0);
    });

  it.each(['running job', 'queued poll', 'missing upload', 'other journal', 'financial history', 'different account', 'expected generation'] as const)
    ('blocks unsafe local state: %s', async scenario => {
      const f = await fixture();
      if (scenario === 'running job') await ctx!.db.update(jobs).set({ status: 'running', lockedUntil: new Date(Date.now() - 86400000) });
      if (scenario === 'queued poll') await ctx!.db.insert(jobs).values({ queue: 'kyc.poll', payload: { userId: f.userId, submissionId: f.sid }, status: 'queued' });
      if (scenario === 'missing upload') await ctx!.db.delete(upaySubmissions).where(eq(upaySubmissions.reference, `upload:${f.sid}:back`));
      if (scenario === 'other journal') await ctx!.db.insert(upaySubmissions).values({ reference: 'foreign-generation', kind: 'kyc', state: 'unknown', requestHash: hash('foreign'), evidence: { customerNo: f.no, submissionId: randomUUID() } });
      if (scenario === 'financial history') await ctx!.db.transaction(async tx => {
        await post(tx, { kind: 'fixture', reference: 'fixture:funded-wallet', postings: move(accounts.external('USDT'), accounts.userWallet(f.userId, 'USDT'), 1n) });
      });
      if (scenario === 'expected generation') f.input.expected = { ...f.snapshot, submissionId: randomUUID() };
      const before = await state();
      await expect(recordKycSubjectAttestation(ctx!.db, f.client, scenario === 'different account' ? '1' : TARGET, PRODUCT, f.input)).rejects.toMatchObject({ code: 'validation' });
      expect(await state()).toEqual(before);
      expect(f.reads).toHaveLength(0);
    });

  it('revalidates the full generation after remote proof and leaves a concurrent poll update intact', async () => {
    const f = await fixture();
    f.remote.onMirror = async () => { await changeKyc(f.sid, { status: 'pending', diagnosticRace: true }); };
    await expect(recordKycSubjectAttestation(ctx!.db, f.client, TARGET, PRODUCT, f.input)).rejects.toMatchObject({ code: 'validation' });
    const after = await state();
    expect(after.profiles[0]).toMatchObject({ status: 'unknown' });
    const evidence = object(after.journals.find(row => row.reference === `kyc:${f.sid}`)!.evidence);
    expect(evidence.diagnosticRace).toBe(true);
    expect(evidence.primaryInitialStatus).toBeUndefined();
  });

  it.each(['email', 'givenName', 'lastName', 'phone', 'globalCode'] as const)('requires the fresh exact identity field %s', async field => {
    const f = await fixture();
    f.remote.detail[field] = 'unrelated-fixture';
    const before = await state();
    await expect(recordKycSubjectAttestation(ctx!.db, f.client, TARGET, PRODUCT, f.input)).rejects.toMatchObject({ code: 'validation' });
    expect(await state()).toEqual(before);
  });

  it('rechecks legacy marker ownership under the final lock after the remote reads', async () => {
    const f = await fixture();
    f.remote.onMirror = async () => {
      const [other] = await ctx!.db.insert(users).values({ telegramId: 123456789n }).returning();
      await ctx!.db.insert(kycProfiles).values({ userId: other!.id, submissionId: f.oldSid, partnerCustomerId: 'OTHER-NO' });
    };
    await expect(recordKycSubjectAttestation(ctx!.db, f.client, TARGET, PRODUCT, f.input)).rejects.toMatchObject({ code: 'validation' });
    const after = await state();
    expect(after.profiles.find(row => row.userId === f.userId)).toMatchObject({ status: 'unknown', submissionState: 'unknown' });
    expect(object(after.journals.find(row => row.reference === `kyc:${f.sid}`)!.evidence).primaryInitialStatus).toBeUndefined();
  });

  it('blocks prior financial activity even when the user wallet balance is back to zero', async () => {
    const f = await fixture();
    await ctx!.db.transaction(async tx => {
      await post(tx, { kind: 'fixture', reference: 'fixture-in', postings: move(accounts.external('USDT'), accounts.userWallet(f.userId, 'USDT'), 10n) });
      await post(tx, { kind: 'fixture', reference: 'fixture-out', postings: move(accounts.userWallet(f.userId, 'USDT'), accounts.external('USDT'), 10n) });
    });
    const before = await state();
    await expect(recordKycSubjectAttestation(ctx!.db, f.client, TARGET, PRODUCT, f.input)).rejects.toMatchObject({ code: 'validation' });
    expect(await state()).toEqual(before);
    expect(f.reads).toHaveLength(0);
  });
});
