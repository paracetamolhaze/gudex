import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client';
import { jobs, kycDocuments, kycProfiles, upaySubmissions } from '../src/db/schema';
import { DbKycDocumentStore } from '../src/kyc/document-store';
import { MockUpayPartner } from '../src/partner/mock';
import { PartnerError, type PartnerCustomerInput, type PartnerKycStatus } from '../src/partner/types';
import { UpayKycUnknownError } from '../src/partner/upay/kyc';
import { JobLeaseLostError, type JobContext } from '../src/queue/queue';
import { api, createTestContext, registerUser, type TestContext } from './helpers';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1kAAAAASUVORK5CYII=';
const env = { CARD_PARTNER: 'upay', DEV_TOOLS: 'false', UPAY_KYC_ENABLED: 'true', UPAY_KYC_REQUIRE_SELFIE: 'true',
  UPAY_LOGIN: 'kyc-fixture@example.test', UPAY_PASSWORD: 'test-password', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ', UPAY_CUSTOMER_GROUP_ID: 'test-group' };
const identity = { firstName: 'Test', lastName: 'User', email: 'kyc@example.test', birthDate: '1990-01-01', citizenship: 'KZ',
  phone: '7771234567', globalCode: '+7', documentType: 'passport', documentCountry: 'KZ' };
class FixtureLivePartner extends MockUpayPartner {
  submissions = 0;
  unknown = false;
  unknownCustomerKnown = true;
  recovery: { customerNo?: string; submitted: boolean } | null = null;
  review: PartnerKycStatus = { status: 'approved' };
  constructor(db: Db) { super(db); }
  assertKycReady(): void {}
  async createCustomer(_input: PartnerCustomerInput): Promise<string> {
    this.submissions++;
    if (this.unknown) throw new UpayKycUnknownError(undefined, this.unknownCustomerKnown ? 'LIVE-CUSTOMER-1' : undefined);
    return 'LIVE-CUSTOMER-1';
  }
  async getKycStatus(): Promise<PartnerKycStatus> { return this.review; }
  async reconcileKycSubmission() { return this.recovery; }
}
let ctx: TestContext;
let partner: FixtureLivePartner;
afterEach(async () => { if (ctx) await ctx.close(); });
async function setup() {
  ctx = await createTestContext(db => { partner = new FixtureLivePartner(db); return partner; }, { env });
  const user = await registerUser(ctx);
  const client = api(ctx, user.token);
  const upload = async (kind: string) => {
    const result = await client.post('/v1/kyc/documents', { kind, mimeType: 'image/png', base64: png });
    expect(result.status).toBe(201);
    return result.body.id as string;
  };
  return { ...user, client, upload };
}

describe('secure KYC document lifecycle', () => {
  it('reuses a staged upload receipt after a lost response and never overwrites a conflicting photo', async () => {
    const { client } = await setup();
    const clientDocumentId = randomUUID();
    const body = { clientDocumentId, kind: 'front', mimeType: 'image/png', base64: png };
    const first = await client.post('/v1/kyc/documents', body);
    const second = await client.post('/v1/kyc/documents', body);
    expect(first.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(first.body.id).toBe(clientDocumentId);
    const changed = Buffer.from(png, 'base64');
    changed[changed.length - 1] ^= 1;
    expect((await client.post('/v1/kyc/documents', { ...body, base64: changed.toString('base64') })).status).toBe(400);
    expect((await client.post('/v1/kyc/documents', { ...body, kind: 'selfie' })).status).toBe(400);
    expect(await ctx.db.select().from(kycDocuments)).toHaveLength(1);
  });
  it('requires authentication and valid image contents, and encrypts staged photos and provider references', async () => {
    const { client, upload, token } = await setup();
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/kyc/documents', payload: { kind: 'front', mimeType: 'image/png', base64: png } })).statusCode).toBe(401);
    expect((await client.post('/v1/kyc/documents', { kind: 'front', mimeType: 'image/png', base64: Buffer.from('not-an-image').toString('base64') })).status).toBe(400);
    const documentId = await upload('front');
    const { userId } = await ctx.services.auth.verifySession(token);
    const store = new DbKycDocumentStore(ctx.db, 'document-test-key');
    // A different application key cannot decrypt the staged image.
    await expect(store.getOwned(userId, documentId)).rejects.toMatchObject({ code: 'validation' });
    const [raw] = await ctx.db.select().from(kycDocuments).where(eq(kycDocuments.id, documentId));
    expect(JSON.stringify(raw)).not.toContain(png);
    expect((await client.get('/v1/kyc/requirements')).body).toMatchObject({ live: true, documentsRequired: true, selfieRequired: true, maxUploadBytes: 2097152 });
  });

  it('rejects another user photos and missing ID card back before calling the partner', async () => {
    const { client, upload } = await setup();
    const front = await upload('front'), selfie = await upload('selfie');
    const other = api(ctx, (await registerUser(ctx)).token);
    expect((await other.post('/v1/kyc', { ...identity, documentIds: { front, selfie } })).status).toBe(400);
    expect((await client.post('/v1/kyc', { ...identity, documentType: 'id_card', documentIds: { front, selfie } })).status).toBe(400);
    expect(partner.submissions).toBe(0);
  });

  it('accepts one concurrent submission and deletes photos only after acknowledged partner submission', async () => {
    const { client, upload } = await setup();
    const front = await upload('front'), selfie = await upload('selfie');
    const attempts = await Promise.all([1, 2].map(() => client.post('/v1/kyc', { ...identity, documentIds: { front, selfie } })));
    expect(attempts.map(attempt => attempt.status).sort()).toEqual([200, 409]);
    expect(await ctx.db.select().from(kycDocuments)).toHaveLength(2);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/v1/kyc/documents/${front}`, headers: { authorization: `Bearer ${(await registerUser(ctx)).token}` } })).statusCode).toBe(200);
    expect(await ctx.db.select().from(kycDocuments)).toHaveLength(2);
    await ctx.settle();
    expect(partner.submissions).toBe(1);
    expect((await client.get('/v1/me')).body.kyc).toMatchObject({ status: 'approved', submissionState: 'submitted' });
    expect(await ctx.db.select().from(kycDocuments)).toEqual([]);
  });

  it('keeps uncertain submissions unknown without approval or redispatch and erases expired staged photos', async () => {
    const { client, upload } = await setup();
    partner.unknown = true;
    const front = await upload('front'), selfie = await upload('selfie');
    await client.post('/v1/kyc', { ...identity, documentIds: { front, selfie } });
    await ctx.settle();
    expect((await client.get('/v1/me')).body.kyc).toMatchObject({ status: 'unknown', submissionState: 'unknown' });
    expect((await client.post('/v1/kyc', { ...identity, documentIds: { front, selfie } })).status).toBe(409);
    expect(partner.submissions).toBe(1);
    expect(await ctx.db.select().from(kycDocuments)).toHaveLength(2);
    await ctx.db.update(kycDocuments).set({ expiresAt: new Date(Date.now() - 1000) });
    await ctx.services.kyc.handlers()['kyc.cleanup']!.run({});
    expect(await ctx.db.select().from(kycDocuments)).toEqual([]);
    expect((await client.get('/v1/me')).body.kyc.status).toBe('unknown');
  });

  it('keeps an undispatched preflight failure unknown with staged photos instead of reporting issuer rejection', async () => {
    const { client, upload, token } = await setup();
    const front = await upload('front'), selfie = await upload('selfie');
    const { userId } = await ctx.services.auth.verifySession(token);
    partner.createCustomer = async () => {
      partner.submissions++;
      throw new PartnerError('Product/document preflight unavailable', false);
    };
    expect((await client.post('/v1/kyc', { ...identity, documentIds: { front, selfie } })).status).toBe(200);

    await ctx.settle();

    const [profile] = await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    expect(profile).toMatchObject({ status: 'unknown', submissionState: 'unknown', rejectionReason: null,
      reviewedAt: null, documentsSubmittedAt: null, partnerCustomerId: null });
    expect((await client.get('/v1/me')).body.kyc).toMatchObject({ status: 'unknown', submissionState: 'unknown' });
    expect((await ctx.db.select().from(kycDocuments)).map(document => document.id).sort()).toEqual([front, selfie].sort());
    expect(partner.submissions).toBe(1);
  });

  it('reports issuer rejection only after the submitted verification returns a rejected status', async () => {
    const { client, upload, token } = await setup();
    const front = await upload('front'), selfie = await upload('selfie');
    const { userId } = await ctx.services.auth.verifySession(token);
    partner.review = { status: 'rejected', reason: 'The issuer rejected the submitted verification' };
    expect((await client.post('/v1/kyc', { ...identity, documentIds: { front, selfie } })).status).toBe(200);

    await ctx.settle();

    const [profile] = await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    expect(profile).toMatchObject({ status: 'rejected', submissionState: 'submitted',
      rejectionReason: partner.review.reason, partnerCustomerId: 'LIVE-CUSTOMER-1' });
    expect(profile!.reviewedAt).toBeInstanceOf(Date);
    expect(profile!.documentsSubmittedAt).toBeInstanceOf(Date);
    expect((await client.get('/v1/me')).body.kyc).toMatchObject({ status: 'rejected', rejectionReason: partner.review.reason });
    expect(await ctx.db.select().from(kycDocuments)).toEqual([]);
    expect(partner.submissions).toBe(1);
  });

  it('can reconcile an uncertain submission by reading the known customer without another submission', async () => {
    const { client, upload } = await setup();
    partner.unknown = true;
    const front = await upload('front'), selfie = await upload('selfie');
    await client.post('/v1/kyc', { ...identity, documentIds: { front, selfie } });
    await ctx.settle();
    const result = await client.post('/v1/kyc/recheck');
    expect(result.body.status).toBe('approved');
    expect(partner.submissions).toBe(1);
    expect(await ctx.db.select().from(kycDocuments)).toEqual([]);
  });

  it('recovers a customer-only receipt without submitting documents until the user explicitly retries', async () => {
    const { client, upload } = await setup();
    partner.unknown = true;
    partner.unknownCustomerKnown = false;
    const front = await upload('front'), selfie = await upload('selfie');
    await client.post('/v1/kyc', { ...identity, documentIds: { front, selfie } });
    await ctx.settle();
    partner.recovery = { customerNo: 'LIVE-CUSTOMER-1', submitted: false };
    expect((await client.post('/v1/kyc/recheck')).body).toMatchObject({ status: 'none', submissionState: 'none', rejectionReason: null });
    expect(partner.submissions).toBe(1);
    partner.unknown = false;
    expect((await client.post('/v1/kyc', { ...identity, documentIds: { front, selfie } })).status).toBe(200);
    await ctx.settle();
    expect(partner.submissions).toBe(2);
    expect((await client.get('/v1/me')).body.kyc.status).toBe('approved');
  });

  it('does not import approval or a customer identifier from the mock partner into live verification', async () => {
    const { client, upload, token } = await setup();
    const { userId } = await ctx.services.auth.verifySession(token);
    await ctx.db.update(kycProfiles).set({ status: 'approved', partnerProvider: 'mock', partnerCustomerId: 'MOCK-CUSTOMER' }).where(eq(kycProfiles.userId, userId));
    expect((await client.get('/v1/me')).body.kyc.status).toBe('none');
    const front = await upload('front'), selfie = await upload('selfie');
    expect((await client.post('/v1/kyc', { ...identity, documentIds: { front, selfie } })).body.status).toBe('pending');
    await ctx.settle();
    const [profile] = await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    expect(profile).toMatchObject({ partnerProvider: 'upay', partnerCustomerId: 'LIVE-CUSTOMER-1', status: 'approved' });
  });

  it('does not let a delayed old poll delete reused photos or mark a new queued submission as submitted', async () => {
    const { client, upload } = await setup();
    partner.unknown = true;
    const front = await upload('front'), selfie = await upload('selfie');
    await client.post('/v1/kyc', { ...identity, documentIds: { front, selfie } });
    await ctx.settle();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const delayed = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    partner.getKycStatus = async () => {
      if (++reads === 1) { entered(); await delayed; return { status: 'pending' }; }
      return { status: 'rejected', reason: 'Test issuer rejection' };
    };
    const oldPoll = client.post('/v1/kyc/recheck');
    await started;
    try {
      expect((await client.post('/v1/kyc/recheck')).body.status).toBe('rejected');
      // A fresh upload can reuse its client UUID after the old acknowledged generation was erased.
      for (const [kind, clientDocumentId] of [['front', front], ['selfie', selfie]]) {
        expect((await client.post('/v1/kyc/documents', { kind, clientDocumentId, mimeType: 'image/png', base64: png })).status).toBe(201);
      }
      expect((await client.post('/v1/kyc', { ...identity, documentIds: { front, selfie } })).body).toMatchObject({ status: 'pending', submissionState: 'queued' });
    } finally {
      release();
      await oldPoll;
    }
    expect((await client.get('/v1/me')).body.kyc).toMatchObject({ status: 'pending', submissionState: 'queued' });
    expect((await ctx.db.select().from(kycDocuments)).map(document => document.id).sort()).toEqual([front, selfie].sort());
  });

  it('does not poll or mark unknown a queued submission already bound to a customer before KYC dispatch', async () => {
    const { client, upload, token } = await setup();
    const front = await upload('front'), selfie = await upload('selfie');
    expect((await client.post('/v1/kyc', { ...identity, documentIds: { front, selfie } })).status).toBe(200);
    const { userId } = await ctx.services.auth.verifySession(token);
    await ctx.db.update(kycProfiles).set({ partnerCustomerId: 'LIVE-CUSTOMER-1', updatedAt: new Date() })
      .where(eq(kycProfiles.userId, userId));
    const beforeProfile = await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    const beforeJobs = await ctx.db.select().from(jobs);
    expect(await ctx.db.select().from(upaySubmissions)).toEqual([]);
    let reads = 0;
    partner.getKycStatus = async () => { reads++; throw new Error('No KYC request was dispatched for this customer'); };

    const result = await client.post('/v1/kyc/recheck');

    expect.soft(reads).toBe(0);
    expect(result.body).toMatchObject({ status: 'pending', submissionState: 'queued' });
    expect(await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId))).toEqual(beforeProfile);
    expect(await ctx.db.select().from(jobs)).toEqual(beforeJobs);
    expect((await ctx.db.select().from(kycDocuments)).map(document => document.id).sort()).toEqual([front, selfie].sort());
    expect(partner.submissions).toBe(0);
  });

  it.each(['new submission', 'same submission revision'] as const)('does not mark a newer queued %s unknown after an old status read fails', async generation => {
    const { client, upload, token } = await setup();
    const front = await upload('front'), selfie = await upload('selfie');
    const { userId } = await ctx.services.auth.verifySession(token);
    const oldSubmissionId = randomUUID();
    const oldRevision = new Date('2026-10-16T10:00:00.000Z');
    await ctx.db.update(kycProfiles).set({ ...identity, documentType: 'passport', documentIds: { front, selfie },
      status: 'pending', submissionState: 'submitted', partnerProvider: 'upay', partnerCustomerId: 'LIVE-CUSTOMER-1',
      submissionId: oldSubmissionId, documentsSubmittedAt: oldRevision, updatedAt: oldRevision })
      .where(eq(kycProfiles.userId, userId));
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    partner.getKycStatus = async () => {
      reads++;
      await delayed;
      throw new Error('The old remote status response was lost');
    };
    const oldRecheck = client.post('/v1/kyc/recheck');
    let expectedProfile: typeof kycProfiles.$inferSelect[] = [];
    let expectedJobs: typeof jobs.$inferSelect[] = [];
    try {
      await vi.waitFor(() => expect(reads).toBe(1), { timeout: 2000, interval: 10 });
      const submissionId = generation === 'new submission' ? randomUUID() : oldSubmissionId;
      await ctx.db.update(kycProfiles).set({ status: 'pending', submissionState: 'queued', submissionId,
        documentsSubmittedAt: null, updatedAt: new Date(oldRevision.getTime() + 1000) })
        .where(eq(kycProfiles.userId, userId));
      expectedProfile = await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
      expectedJobs = await ctx.db.select().from(jobs);
    } finally {
      release();
      await oldRecheck;
    }

    expect(await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId))).toEqual(expectedProfile);
    expect(await ctx.db.select().from(jobs)).toEqual(expectedJobs);
    expect((await ctx.db.select().from(kycDocuments)).map(document => document.id).sort()).toEqual([front, selfie].sort());
    expect(partner.submissions).toBe(0);
    expect(reads).toBe(1);
  });

  it.each(['success', 'failure'] as const)('ignores a late %s from an expired submission handler after the same submission is resumed', async outcome => {
    const { client, upload, token } = await setup();
    const front = await upload('front'), selfie = await upload('selfie');
    expect((await client.post('/v1/kyc', { ...identity, documentIds: { front, selfie } })).status).toBe(200);
    const { userId } = await ctx.services.auth.verifySession(token);
    const [initial] = await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    const submissionId = initial!.submissionId!;
    const controller = new AbortController();
    const context: JobContext = { signal: controller.signal, assertActive: async () => {
      if (controller.signal.aborted) throw new JobLeaseLostError('The original submission lease expired');
    } };
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    partner.createCustomer = async input => {
      await input.beforeSubmit?.();
      calls++;
      await delayed;
      if (outcome === 'failure') throw new UpayKycUnknownError(undefined, 'LIVE-LATE-CUSTOMER');
      return 'LIVE-LATE-CUSTOMER';
    };
    const handler = ctx.services.kyc.handlers()['kyc.submit']!;
    const payload = { userId, submissionId };
    const lateSend = handler.run(payload, context).catch(error => {
      if (!(error instanceof JobLeaseLostError)) throw error;
    });
    let expectedProfile: typeof kycProfiles.$inferSelect[] = [];
    let expectedJobs: typeof jobs.$inferSelect[] = [];
    let expectedDocuments: typeof kycDocuments.$inferSelect[] = [];
    try {
      await vi.waitFor(() => expect(calls).toBe(1), { timeout: 2000, interval: 10 });
      controller.abort();
      await handler.onExhausted!(payload, new JobLeaseLostError('The queue exhausted the original lease'));
      await ctx.db.update(kycProfiles).set({ status: 'pending', submissionState: 'queued',
        partnerCustomerId: 'LIVE-RECOVERED-CUSTOMER', documentsSubmittedAt: null,
        updatedAt: new Date(initial!.updatedAt.getTime() + 1000) })
        .where(eq(kycProfiles.userId, userId));
      expectedProfile = await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
      expectedJobs = await ctx.db.select().from(jobs);
      expectedDocuments = await ctx.db.select().from(kycDocuments);
    } finally {
      release();
      await lateSend;
    }

    expect(await ctx.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId))).toEqual(expectedProfile);
    expect(await ctx.db.select().from(jobs)).toEqual(expectedJobs);
    expect(await ctx.db.select().from(kycDocuments)).toEqual(expectedDocuments);
    expect(calls).toBe(1);
  });
});
