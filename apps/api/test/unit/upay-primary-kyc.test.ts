import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config';
import type { Db } from '../../src/db/client';
import type { DbKycDocumentStore, KycStoredDocument } from '../../src/kyc/document-store';
import type { UpayClient } from '../../src/partner/upay/client';
import { UpayKycIntegration } from '../../src/partner/upay/kyc';
import { MemoryUpaySubmissionStore } from '../../src/partner/upay/submissions';
import { UpayError } from '../../src/partner/upay/transport';

const userId = '00000000-0000-4000-8000-000000000101';
const submissionId = '00000000-0000-4000-8000-000000000102';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture(options: { passport?: boolean; productLevel?: number; beforeStatus?: number; afterStatus?: number;
  loseSubmit?: boolean; mismatch?: boolean; noRemotePhotos?: boolean; duplicate?: boolean; unbound?: boolean; topApproved?: boolean;
  photoShape?: 'json' | 'nested' | 'display_only'; foreignPassportBack?: boolean; nationality?: string | null; countryCode?: string | number;
  nativeHidden?: boolean; failObservation?: boolean } = {}) {
  const config = loadConfig({ DATABASE_URL: 'unit-unused', JWT_SECRET: 'primary-unit-secret-32', UPAY_KYC_ENABLED: 'true',
    UPAY_CUSTOMER_GROUP_ID: 'group-1', UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ' });
  const input = { externalRef: userId, email: 'primary@example.test', firstName: 'TEST', lastName: 'USER', birthDate: '1990-01-01', citizenship: 'KZ',
    kyc: { submissionId, ...(options.unbound ? {} : { customerNo: 'CUSTOMER-1' }), phone: '7771234567', globalCode: '+7',
      documentType: options.passport ? 'passport' as const : 'id_card' as const, documentCountry: 'KZ',
      documentIds: options.passport ? { front: 'front' } : { front: 'front', back: 'back' } } };
  const selectedType = options.passport ? 2 : 1;
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const reads: string[] = [], uploads: number[] = [];
  const files = new Map<string, KycStoredDocument>(['front', 'back'].map(kind => [kind, { id: kind, kind: kind as 'front' | 'back',
    mimeType: 'image/png', size: 8, bytes: Buffer.from('fixture'), expiresAt: new Date(Date.now() + 86400000).toISOString() }]));
  let submitted = false;
  let productLevel = options.productLevel ?? 1;
  let nativeHidden = options.nativeHidden ?? false;
  let remoteStatus = options.afterStatus ?? 3;
  let observationFailed = false;
  const countryCode = options.countryCode ?? 'KZ';
  const photo = (uri: string) => options.photoShape === 'json' ? JSON.stringify({ uri, fullUrl: 'PRIVATE-preview-url' })
    : options.photoShape === 'nested' ? { data: { fileUri: uri }, fullUrl: 'PRIVATE-preview-url' }
      : options.photoShape === 'display_only' ? { fullUrl: uri } : uri;
  const client = { configured: true,
    readRequest: async (_method: string, path: string) => {
      reads.push(path);
      if (path === '/card/getMayApplyCardDetail') return { kycLevel: productLevel };
      if (path === '/common/countryAndRegion') return [{ code: countryCode, codeAlpha2: 'KZ', codeAlpha3: 'KAZ' }];
      if (path === '/customer/group/all') return [{ id: 'group-1' }];
      if (path === '/customer/list') return { list: [{ customerId: 'ID-1', no: 'CUSTOMER-1', email: input.email, givenName: input.firstName,
        lastName: input.lastName, remark: `GUDEX-KYC:${submissionId}` }], totalPages: 1 };
      if (path === '/card/get/kyc') return { customerNo: 'CUSTOMER-1', certifiedDocumentType: [selectedType], needKycLevel: 2,
        documentType: [2, 1, 4, 3], idCardFrontPath: 'photo-1', idCardBackPath: 'photo-2' };
      if (path === '/card/get/kycStatus') return { idCard: options.afterStatus ?? 1, passport: options.afterStatus ?? 1, face: 4 };
      if (path === '/kyc/info') {
        if (submitted && options.failObservation && !observationFailed) { observationFailed = true; throw new Error('PRIVATE observation failure'); }
        const selected = { documentType: selectedType, level: 1, status: submitted ? remoteStatus : options.beforeStatus ?? 4,
          nationalityCode: submitted && nativeHidden ? null : options.nationality === undefined ? countryCode : options.nationality,
          frontPhoto: submitted && !options.noRemotePhotos && !nativeHidden ? photo(options.mismatch ? 'FOREIGN-private-photo' : 'photo-1') : null,
          backPhoto: options.foreignPassportBack ? 'FOREIGN-back-photo' : selectedType === 1 && submitted && !options.noRemotePhotos && !nativeHidden ? photo('photo-2') : null };
        return { authResult: options.topApproved ? 1 : 4, primaryApprovedNum: options.topApproved ? 1 : 0,
          items: [selected, ...(options.duplicate ? [{ ...selected }] : []), { documentType: selectedType === 1 ? 2 : 1, level: 1, status: 4 },
            { documentType: 3, level: 2, status: 4 }] };
      }
      throw new Error('Unexpected primary read');
    },
    uploadRequest: async (_bytes: Uint8Array, _mime: string, fileType: number, callbacks?: { beforeDispatch?: () => Promise<void> }) => {
      await callbacks?.beforeDispatch?.();
      uploads.push(fileType);
      return { uri: `photo-${uploads.length}` };
    },
    submitRequest: async (path: string, body: Record<string, unknown>, callbacks?: { beforeDispatch?: () => Promise<void> }) => {
      await callbacks?.beforeDispatch?.();
      writes.push({ path, body });
      if (path === '/kyc/submit') {
        submitted = true;
        if (options.loseSubmit) throw new UpayError('PRIVATE upstream response', true, 987654,
          { phase: 'post_dispatched', ack: 'rejected_envelope', httpStatus: 200 });
      }
      return {};
    } } as unknown as UpayClient;
  const profile = { userId, partnerProvider: 'upay', partnerCustomerId: 'CUSTOMER-1', documentType: input.kyc.documentType, submissionId };
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [structuredClone(profile)] }) }) }) } as unknown as Db;
  const documents = { getOwned: async (_userId: string, id: string) => files.get(id)!,
    markUploaded: async (_userId: string, id: string, remoteUri: string) => { files.get(id)!.remoteUri = remoteUri; } } as unknown as DbKycDocumentStore;
  const journal = new MemoryUpaySubmissionStore();
  const createHelper = () => new UpayKycIntegration(config, client, journal, documents, db, 'customer');
  return { helper: createHelper(), recreate: createHelper, client, input, writes, reads, uploads, journal, profile,
    setProductLevel: (value: number) => { productLevel = value; }, setRemoteStatus: (value: number) => { remoteStatus = value; },
    setNativeHidden: (value: boolean) => { nativeHidden = value; } };
}

describe('UPay customer primary verification protocol', () => {
  it('persists the preflight and observed review, then records issuer subject approval without claiming photo receipt', async () => {
    const { helper, recreate, input, journal, writes, setRemoteStatus } = fixture({ nativeHidden: true, topApproved: true });
    await helper.createCustomer(input);
    expect(await journal.get(`kyc:${submissionId}`)).toMatchObject({ state: 'acknowledged', evidence: { primaryInitialStatus: 4,
      primaryInitialObservedAt: expect.any(Number), primaryReviewObserved: true, primaryReviewObservedAt: expect.any(Number), primaryObservationSource: 'live_response' } });
    expect(await helper.getKycStatus('CUSTOMER-1')).toEqual({ status: 'pending' });
    setRemoteStatus(1);
    expect(await recreate().getKycStatus('CUSTOMER-1')).toEqual({ status: 'approved' });
    const proof = await journal.get(`kyc:${submissionId}`);
    expect(proof).toMatchObject({ state: 'confirmed', evidence: { approvalBasis: 'issuer_subject_status', photoReceiptMatched: false,
      documentFrontHash: hash('photo-1'), documentBackHash: hash('photo-2') } });
    expect(await recreate().getKycStatus('CUSTOMER-1')).toEqual({ status: 'approved' });
    expect(writes.map(write => write.path)).toEqual(['/kyc/submit']);
  });

  it('keeps an accepted POST acknowledged when its observation GET fails and never repeats it', async () => {
    const { helper, recreate, input, journal, writes, setRemoteStatus } = fixture({ nativeHidden: true, topApproved: true, failObservation: true });
    expect(await helper.createCustomer(input)).toBe('CUSTOMER-1');
    expect(await journal.get(`kyc:${submissionId}`)).toMatchObject({ state: 'acknowledged', evidence: { responseAck: 'accepted_envelope' } });
    expect((await journal.get(`kyc:${submissionId}`))!.evidence.primaryReviewObserved).toBeUndefined();
    await recreate().createCustomer(input);
    expect(await recreate().getKycStatus('CUSTOMER-1')).toEqual({ status: 'pending' });
    setRemoteStatus(1);
    expect(await recreate().getKycStatus('CUSTOMER-1')).toEqual({ status: 'approved' });
    expect(writes).toHaveLength(1);
  });

  it('does not invent an intervening review when the first post-submit read already reports hidden approval', async () => {
    const { helper, input, writes, journal } = fixture({ nativeHidden: true, topApproved: true, afterStatus: 1 });
    await helper.createCustomer(input);
    await expect(helper.getKycStatus('CUSTOMER-1')).rejects.toThrow();
    expect((await journal.get(`kyc:${submissionId}`))!.evidence.primaryReviewObserved).toBeUndefined();
    expect(writes).toHaveLength(1);
  });

  it('retains confirmed exact-document provenance when subsequent issuer reads hide the same subject fields', async () => {
    const { helper, recreate, input, journal, setNativeHidden } = fixture({ afterStatus: 1, topApproved: true });
    await helper.createCustomer(input);
    expect(await helper.getKycStatus('CUSTOMER-1')).toEqual({ status: 'approved' });
    const before = await journal.get(`kyc:${submissionId}`);
    expect(before).toMatchObject({ state: 'confirmed', evidence: { approvalBasis: 'document_hashes', photoReceiptMatched: true } });
    expect(before!.evidence.primaryReviewObserved).toBeUndefined();
    setNativeHidden(true);
    expect(await recreate().getKycStatus('CUSTOMER-1')).toEqual({ status: 'approved' });
    expect(await journal.get(`kyc:${submissionId}`)).toEqual(before);
  });

  it('keeps the first immutable review observation when two read-only polls observe it concurrently', async () => {
    const { helper, recreate, input, journal } = fixture({ nativeHidden: true, failObservation: true });
    await helper.createCustomer(input);
    let clock = Date.now() + 10000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
    try {
      expect(await Promise.all([helper.getKycStatus('CUSTOMER-1'), recreate().getKycStatus('CUSTOMER-1')])).toEqual([{ status: 'pending' }, { status: 'pending' }]);
      const before = await journal.get(`kyc:${submissionId}`);
      expect(before).toMatchObject({ state: 'acknowledged', evidence: { primaryReviewObserved: true, primaryObservationSource: 'live_response' } });
      await helper.getKycStatus('CUSTOMER-1');
      expect(await journal.get(`kyc:${submissionId}`)).toEqual(before);
    } finally { spy.mockRestore(); }
  });

  it('does not confirm an older generation after the current profile changes during its issuer lookup', async () => {
    const { helper, input, journal, client, profile, setRemoteStatus } = fixture({ nativeHidden: true, topApproved: true });
    await helper.createCustomer(input);
    setRemoteStatus(1);
    const read = client.readRequest.bind(client);
    client.readRequest = async <T>(...args: Parameters<UpayClient['readRequest']>) => {
      const [method, path, options] = args;
      const value = await read<T>(method, path, options);
      if (path === '/card/get/kyc') profile.submissionId = '00000000-0000-4000-8000-000000000999';
      return value;
    };
    await expect(helper.getKycStatus('CUSTOMER-1')).rejects.toThrow('binding changed');
    expect(await journal.get(`kyc:${submissionId}`)).toMatchObject({ state: 'acknowledged' });
    expect((await journal.get(`kyc:${submissionId}`))!.evidence.approvalBasis).toBeUndefined();
  });

  it('uses the native primary ID contract for product level one without the unrelated card-level selfie gate', async () => {
    const { helper, input, writes, reads, uploads, journal } = fixture();
    expect(await helper.getKycRequirements()).toEqual({ selfieRequired: false, documentTypes: ['id_card', 'passport'] });
    expect(await helper.createCustomer(input)).toBe('CUSTOMER-1');
    expect(uploads).toEqual([1, 2]);
    expect(writes).toEqual([{ path: '/kyc/submit', body: { customerNo: 'CUSTOMER-1', nationalityCode: 'KZ', documentType: 1,
      frontPhoto: 'photo-1', backPhoto: 'photo-2', holdFrontPhoto: '*', holdBackPhoto: '*' } }]);
    expect(reads).not.toContain('/card/get/kyc');
    expect(await journal.get(`kyc:${submissionId}`)).toMatchObject({ state: 'acknowledged', evidence: {
      kycProtocol: 'customer_primary', documentType: 1, documentFrontHash: hash('photo-1'), documentBackHash: hash('photo-2'),
    } });
    expect(await helper.getKycStatus('CUSTOMER-1')).toEqual({ status: 'pending' });
  });

  it('uses the native passport placeholder fields and one front upload', async () => {
    const { helper, input, writes, uploads } = fixture({ passport: true, afterStatus: 1 });
    await helper.createCustomer(input);
    expect(uploads).toEqual([1]);
    expect(writes).toEqual([{ path: '/kyc/submit', body: { customerNo: 'CUSTOMER-1', nationalityCode: 'KZ', documentType: 2,
      frontPhoto: 'photo-1', backPhoto: '*', holdFrontPhoto: '*' } }]);
    expect(await helper.getKycStatus('CUSTOMER-1')).toEqual({ status: 'approved' });
  });

  it('uses raw country code for a new marked customer as well as the native KYC payload', async () => {
    const { helper, input, writes } = fixture({ unbound: true });
    await helper.createCustomer(input);
    expect(writes[0]).toMatchObject({ path: '/customer/add', body: { idCardNationality: 'KZ', remark: `GUDEX-KYC:${submissionId}` } });
    expect(writes.map(write => write.path)).toEqual(['/customer/add', '/kyc/submit']);
  });

  it.each([1, 2, 3] as const)('maps selected primary status %s only with this submission’s exact document hashes', async afterStatus => {
    const { helper, input } = fixture({ afterStatus });
    await helper.createCustomer(input);
    const result = await helper.getKycStatus('CUSTOMER-1');
    expect(result.status).toBe(({ 1: 'approved', 2: 'rejected', 3: 'pending' } as const)[afterStatus]);
  });

  it.each([1, 2] as const)('does not adopt terminal status %s for older or different photos', async afterStatus => {
    const { helper, input } = fixture({ afterStatus, mismatch: true, topApproved: true });
    await helper.createCustomer(input);
    await expect(helper.getKycStatus('CUSTOMER-1')).rejects.toThrow('document');
  });

  it('does not treat unsubmitted status four or a top-level approval flag as receipt of the current photos', async () => {
    const { helper, input, journal } = fixture({ afterStatus: 4, noRemotePhotos: true, topApproved: true });
    await helper.createCustomer(input);
    expect(await helper.getKycStatus('CUSTOMER-1')).toEqual({ status: 'pending' });
    expect(await journal.get(`kyc:${submissionId}`)).toMatchObject({ state: 'acknowledged' });
  });

  it('never repeats a lost primary POST across helper recreation or invents a receipt for status four', async () => {
    const { helper, recreate, input, writes, journal } = fixture({ loseSubmit: true, afterStatus: 4, noRemotePhotos: true });
    await expect(helper.createCustomer(input)).rejects.toMatchObject({ customerNo: 'CUSTOMER-1' });
    await expect(recreate().createCustomer(input)).rejects.toThrow();
    expect(writes.map(write => write.path)).toEqual(['/kyc/submit']);
    expect(await journal.get(`kyc:${submissionId}`)).toMatchObject({ state: 'unknown', evidence: {
      kycProtocol: 'customer_primary', step: 'kyc_submit', upstreamCode: 987654, responseAck: 'rejected_envelope',
    } });
    expect(JSON.stringify(await journal.get(`kyc:${submissionId}`))).not.toContain('PRIVATE');
  });

  it.each([1, 3] as const)('does not submit against an already approved/pending primary item %s without a current receipt', async beforeStatus => {
    const { helper, input, writes, uploads } = fixture({ beforeStatus });
    await expect(helper.createCustomer(input)).rejects.toThrow();
    expect(writes).toEqual([]); expect(uploads).toEqual([]);
  });

  it('permits an explicitly created new submission after remote rejection without replaying its eventual POST', async () => {
    const { helper, recreate, input, writes } = fixture({ beforeStatus: 2 });
    await helper.createCustomer(input);
    await recreate().createCustomer(input);
    expect(writes.map(write => write.path)).toEqual(['/kyc/submit']);
  });

  it('rejects duplicate primary items before uploading any photos', async () => {
    const { helper, input, writes, uploads } = fixture({ duplicate: true });
    await expect(helper.createCustomer(input)).rejects.toThrow();
    expect(writes).toEqual([]); expect(uploads).toEqual([]);
  });

  it('fails closed for advanced product levels before customer creation or document upload', async () => {
    const { helper, input, writes, uploads } = fixture({ productLevel: 2, unbound: true });
    await expect(helper.createCustomer(input)).rejects.toThrow('primary');
    expect(writes).toEqual([]); expect(uploads).toEqual([]);
  });

  it('checks the worker lease for each native photo/verification POST', async () => {
    const { helper, input, writes, uploads } = fixture();
    let checks = 0;
    await expect(helper.createCustomer({ ...input, beforeSubmit: async () => { if (++checks > 1) throw new Error('expired lease'); } })).rejects.toThrow();
    expect(uploads).toEqual([1]); expect(writes).toEqual([]);
  });

  it('still polls unmarked legacy card journals through their original protocol in customer runtime mode', async () => {
    const { helper, reads, journal } = fixture({ afterStatus: 1 });
    await journal.begin({ reference: `kyc:${submissionId}`, kind: 'kyc', requestHash: 'legacy', evidence: {
      customerNo: 'CUSTOMER-1', submissionId, documentType: 1, documentFrontHash: hash('photo-1'), documentBackHash: hash('photo-2'),
    } });
    await journal.record(`kyc:${submissionId}`, { state: 'acknowledged' });
    expect(await helper.getKycStatus('CUSTOMER-1')).toEqual({ status: 'approved' });
    expect(reads).toContain('/card/get/kyc');
    expect(reads).not.toContain('/kyc/info');
  });

  it.each(['json', 'nested'] as const)('matches exact URI fields in %s metadata and ignores the preview URL', async photoShape => {
    const { helper, input } = fixture({ photoShape, afterStatus: 1 });
    await helper.createCustomer(input);
    expect(await helper.getKycStatus('CUSTOMER-1')).toEqual({ status: 'approved' });
  });

  it('does not accept a preview URL as a document receipt', async () => {
    const { helper, input } = fixture({ photoShape: 'display_only', afterStatus: 1 });
    await helper.createCustomer(input);
    await expect(helper.getKycStatus('CUSTOMER-1')).rejects.toThrow('document');
  });

  it.each([1, 3, 4] as const)('blocks a foreign passport back photo even at status %s with an accepted envelope', async afterStatus => {
    const { helper, input } = fixture({ passport: true, foreignPassportBack: true, afterStatus });
    await helper.createCustomer(input);
    await expect(helper.getKycStatus('CUSTOMER-1')).rejects.toThrow('document');
  });

  it.each(['OTHER', null])('does not accept approved exact photos with nationality %s differing from the submitted raw country', async nationality => {
    const { helper, input } = fixture({ nationality, afterStatus: 1 });
    await helper.createCustomer(input);
    await expect(helper.getKycStatus('CUSTOMER-1')).rejects.toThrow();
  });

  it('preserves a numeric raw country code and verifies its exact submitted type', async () => {
    const { helper, input, writes } = fixture({ countryCode: 398, unbound: true, afterStatus: 1 });
    await helper.createCustomer(input);
    expect(writes[0]!.body.idCardNationality).toBe(398);
    expect(writes[1]!.body.nationalityCode).toBe(398);
    expect(await helper.getKycStatus('CUSTOMER-1')).toEqual({ status: 'approved' });
  });

  it('does not treat primary approval as advanced readiness after the configured product changes', async () => {
    const { helper, input, setProductLevel } = fixture({ afterStatus: 1 });
    await helper.createCustomer(input);
    setProductLevel(2);
    await expect(helper.getKycStatus('CUSTOMER-1')).rejects.toThrow('primary');
  });
});
