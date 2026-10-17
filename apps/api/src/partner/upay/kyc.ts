import { createHash, createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { kycProfiles } from '../../db/schema';
import type { DbKycDocumentStore, KycDocumentKind } from '../../kyc/document-store';
import { PartnerError, type PartnerCustomerInput, type PartnerKycStatus } from '../types';
import type { UpayClient } from './client';
import { UpayError } from './transport';
import { assertNewCustomerCanUseCard } from './native-validation';
import { assertPrimarySubmissionReady, primaryIssuerReviewPending, primaryIssuerSubjectApproval, primaryNationalityCode, primaryNationalityCodeHash,
  primaryReviewObserved, primarySubmissionBody, primaryVerificationStatus } from './primary-customer-kyc';
import type { SubmissionEvidence, UpaySubmission, UpaySubmissionStore } from './submissions';

type KycApi = Pick<UpayClient, 'configured' | 'readRequest' | 'submitRequest' | 'uploadRequest'>;
type DocumentAccess = Pick<DbKycDocumentStore, 'getOwned' | 'markUploaded'>;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value : Array.isArray(object(value).list) ? object(value).list as unknown[] : []).map(object);
const id = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value
  : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
const uriHash = (value: string) => createHash('sha256').update(value).digest('hex');
type SubmissionStep = 'customer_add' | 'file_upload' | 'kyc_submit';
const accepted = (step: SubmissionStep): SubmissionEvidence => ({ step, dispatchPhase: 'post_dispatched', responseAck: 'accepted_envelope' });
function failed(step: SubmissionStep, error: unknown): SubmissionEvidence {
  const metadata = error instanceof UpayError ? error.metadata : undefined;
  return { step, responseAck: metadata?.ack ?? 'unconfirmed',
    ...(metadata ? { dispatchPhase: metadata.phase } : {}),
    ...(error instanceof UpayError && error.code !== undefined ? { upstreamCode: error.code } : {}),
    ...(metadata?.httpStatus !== undefined ? { httpStatus: metadata.httpStatus } : {}) };
}

export class UpayKycUnknownError extends PartnerError {
  constructor(message = 'UPay verification result requires reconciliation', readonly customerNo?: string) { super(message, true); }
}

// Public SPA evidence: customer/add -> file/upload -> card/submit/kyc -> get/kycStatus.
// Every outbound POST gets a durable journal entry first. A repeat only performs lookups.
export class UpayKycIntegration {
  constructor(private readonly config: Config, private readonly client: KycApi, private readonly journal: UpaySubmissionStore,
    private readonly documents: DocumentAccess, private readonly db: Db, private readonly workflow: 'card' | 'customer' = 'card') {}

  assertReady(): void {
    if (!this.config.UPAY_KYC_ENABLED || !this.client.configured) throw new PartnerError('UPay KYC is not enabled or credentials are missing', false);
  }

  async getKycRequirements(): Promise<{ selfieRequired: boolean; documentTypes: ('id_card' | 'passport')[] }> {
    const product = object(await this.client.readRequest('GET', '/card/getMayApplyCardDetail', { query: { agentCardId: this.config.UPAY_PRODUCT_ID } }));
    const level = Number(product.kycLevel);
    if (!Number.isInteger(level) || level < 0) throw new PartnerError('UPay product verification requirements are unavailable', false);
    // Customer workflow currently implements primary level one only. Advanced KYC is not enabled by collecting a selfie.
    if (this.workflow === 'customer') {
      if (level !== 1) throw new PartnerError('UPay customer primary verification supports only level-one products', false);
      return { selfieRequired: false, documentTypes: ['id_card', 'passport'] };
    }
    return { selfieRequired: this.config.UPAY_KYC_REQUIRE_SELFIE || level > 1, documentTypes: ['id_card', 'passport'] };
  }

  async getDocumentType(customerNo: string): Promise<1 | 2> {
    const profile = await this.binding(customerNo);
    if (profile.status !== 'approved' || !profile.submissionId) throw new PartnerError('Approved live verification document binding is required', false);
    if (profile.documentType === 'id_card') return 1;
    if (profile.documentType === 'passport') return 2;
    throw new PartnerError('Approved live verification document type is unavailable', false);
  }

  async reconcileKycSubmission(input: PartnerCustomerInput): Promise<{ customerNo?: string; submitted: boolean } | null> {
    const kyc = input.kyc;
    if (!kyc?.submissionId) return null;
    const submitted = await this.journal.get(`kyc:${kyc.submissionId}`);
    if (submitted) {
      const customerNo = id(submitted.evidence.customerNo);
      return customerNo ? { customerNo, submitted: true } : null;
    }
    // No KYC journal entry proves this backend has not dispatched that KYC POST.
    if (kyc.customerNo) {
      const binding = await this.binding(kyc.customerNo);
      return binding.userId === input.externalRef ? { customerNo: kyc.customerNo, submitted: false } : null;
    }
    const reference = `customer:${kyc.submissionId}`;
    const customer = await this.journal.get(reference);
    if (!customer) return { submitted: false };
    const known = customer.state === 'confirmed' ? id(customer.evidence.customerNo) : null;
    const customerNo = known ?? await this.findMarkedCustomer(input, `GUDEX-KYC:${kyc.submissionId}`);
    if (!customerNo) return null;
    await this.journal.record(reference, { state: 'confirmed', partnerReceiptId: customerNo, evidence: { customerNo } });
    return { customerNo, submitted: false };
  }

  async createCustomer(input: PartnerCustomerInput): Promise<string> {
    this.assertReady();
    const kyc = input.kyc;
    if (!kyc?.submissionId || !kyc.phone || !kyc.globalCode || !kyc.documentIds.front) throw new PartnerError('Complete verification details and document photos are required', false);
    if (kyc.documentType === 'id_card' && !kyc.documentIds.back) throw new PartnerError('ID card back photo is required', false);
    if ((await this.getKycRequirements()).selfieRequired && !kyc.documentIds.selfie) throw new PartnerError('Selfie is required for this product', false);

    const previous = await this.journal.get(`kyc:${kyc.submissionId}`);
    if (previous) {
      const knownNo = id(previous.evidence.customerNo);
      if (!knownNo) throw new UpayKycUnknownError();
      if (previous.state === 'rejected') throw Object.assign(new PartnerError('UPay verification submission was rejected', false), { customerNo: knownNo });
      if (previous.state === 'acknowledged' || previous.state === 'confirmed') return knownNo;
      await this.getKycStatus(knownNo);
      return knownNo;
    }
    // Check all files before creating a remote customer. Ownership and expiry are checked by the store.
    for (const [kind, documentId] of Object.entries(kyc.documentIds)) await this.documents.getOwned(input.externalRef, documentId, kind as KycDocumentKind);
    const countries = list(await this.client.readRequest('GET', '/common/countryAndRegion', { query: { level: 2 } }));
    const country = countries.find(item => String(item.codeAlpha2 ?? item.alpha2 ?? item.code).toUpperCase() === kyc.documentCountry.toUpperCase());
    const countryCode = this.workflow === 'customer' ? primaryNationalityCode(country?.code)
      : country && typeof country.codeAlpha3 === 'string' && /^[A-Z]{3}$/i.test(country.codeAlpha3) ? country.codeAlpha3.toUpperCase() : null;
    if (!countryCode) throw new PartnerError('Document country is not supported by UPay', false);
    const groups = list(await this.client.readRequest('GET', '/customer/group/all'));
    const defaults = groups.filter(group => Number(group.isDefault) === 1);
    const groupId = this.config.UPAY_CUSTOMER_GROUP_ID ?? (defaults.length === 1 ? id(defaults[0]!.id) : null);
    if (!groupId || !groups.some(group => id(group.id) === groupId)) {
      throw new PartnerError('Set UPAY_CUSTOMER_GROUP_ID or provide exactly one valid default UPay customer group', false);
    }

    let customerNo = kyc.customerNo;
    if (customerNo) {
      const binding = await this.binding(customerNo);
      if (binding.userId !== input.externalRef) throw new UpayKycUnknownError('UPay customer binding does not match this user');
    } else {
      customerNo = await this.createMarkedCustomer(input, countryCode, groupId);
    }
    try {
      if (this.workflow === 'customer') return await this.submitPrimaryCustomerKyc(input, customerNo, countryCode);
      const requirements = object(await this.client.readRequest('GET', '/card/get/kyc', { query: { customerNo, agentCardId: this.config.UPAY_PRODUCT_ID } }));
      const documentType = kyc.documentType === 'id_card' ? 1 : 2;
      if (!Array.isArray(requirements.documentType) || !requirements.documentType.some(value => Number(value) === documentType)) {
        throw Object.assign(new PartnerError('Selected identity document is not supported by this UPay product', false), { customerNo });
      }
      if (Number(requirements.needKycLevel) > 1 && !kyc.documentIds.selfie) {
        throw Object.assign(new PartnerError('This UPay product requires a selfie', false), { customerNo });
      }
      const front = await this.upload(input.externalRef, kyc.submissionId, 'front', kyc.documentIds.front, documentType === 2 ? 1 : 2, customerNo, input.beforeSubmit);
      const back = kyc.documentIds.back ? await this.upload(input.externalRef, kyc.submissionId, 'back', kyc.documentIds.back, 2, customerNo, input.beforeSubmit) : front;
      const face = kyc.documentIds.selfie ? await this.upload(input.externalRef, kyc.submissionId, 'selfie', kyc.documentIds.selfie, 3, customerNo, input.beforeSubmit) : '';
      const body = { agentCardId: this.config.UPAY_PRODUCT_ID, facePath: face, documentFrontPath: front, documentBackPath: back,
        documentType, customerNo, countryCode };
      const evidence: SubmissionEvidence = { customerNo, submissionId: kyc.submissionId, documentType,
        documentFrontHash: uriHash(front), documentBackHash: uriHash(back), faceHash: face ? uriHash(face) : null };
      const begun = await this.journal.begin({ reference: `kyc:${kyc.submissionId}`, kind: 'kyc', requestHash: this.hash(body), evidence });
      if (!begun.created) {
        if (!['acknowledged', 'confirmed'].includes(begun.submission.state)) await this.getKycStatus(customerNo);
        return customerNo;
      }
      try {
        await this.client.submitRequest('/card/submit/kyc', body, { beforeDispatch: input.beforeSubmit });
        await this.journal.record(`kyc:${kyc.submissionId}`, { state: 'acknowledged', evidence: accepted('kyc_submit') });
      } catch (error) {
        await this.journal.record(`kyc:${kyc.submissionId}`, { state: 'unknown', evidence: failed('kyc_submit', error) });
        throw new UpayKycUnknownError(undefined, customerNo);
      }
      return customerNo;
    } catch (error) {
      if (error instanceof PartnerError && !error.retryable) throw error;
      throw new UpayKycUnknownError(error instanceof UpayKycUnknownError ? error.message : undefined, customerNo);
    }
  }

  private async submitPrimaryCustomerKyc(input: PartnerCustomerInput, customerNo: string, nationalityCode: string | number): Promise<string> {
    const kyc = input.kyc!;
    const documentType = kyc.documentType === 'id_card' ? 1 : 2;
    const info = await this.client.readRequest('GET', '/kyc/info', { query: { customerNo } });
    const primaryInitialStatus = assertPrimarySubmissionReady(info, documentType);
    const primaryInitialObservedAt = Date.now();
    const front = await this.upload(input.externalRef, kyc.submissionId, 'front', kyc.documentIds.front, 1, customerNo, input.beforeSubmit);
    const back = documentType === 1 ? await this.upload(input.externalRef, kyc.submissionId, 'back', kyc.documentIds.back!, 2, customerNo, input.beforeSubmit) : '*';
    const body = primarySubmissionBody(customerNo, nationalityCode, documentType, front, back);
    const reference = `kyc:${kyc.submissionId}`;
    const evidence: SubmissionEvidence = { kycProtocol: 'customer_primary', customerNo, submissionId: kyc.submissionId, documentType,
      primaryInitialStatus, primaryInitialObservedAt,
      nationalityCodeHash: primaryNationalityCodeHash(nationalityCode), documentFrontHash: uriHash(front), documentBackHash: uriHash(back) };
    const begun = await this.journal.begin({ reference, kind: 'kyc', requestHash: this.hash(body), evidence });
    if (!begun.created) {
      if (!['acknowledged', 'confirmed'].includes(begun.submission.state)) await this.getKycStatus(customerNo);
      return customerNo;
    }
    try {
      await this.client.submitRequest('/kyc/submit', body, { beforeDispatch: input.beforeSubmit });
      await this.journal.record(reference, { state: 'acknowledged', evidence: accepted('kyc_submit') });
    } catch (error) {
      await this.journal.record(reference, { state: 'unknown', evidence: failed('kyc_submit', error) });
      throw new UpayKycUnknownError(undefined, customerNo);
    }
    // This optional read observes review; its failure cannot turn an accepted POST
    // into an unknown dispatch or authorize a second submission.
    try {
      const observed = await this.client.readRequest('GET', '/kyc/info', { query: { customerNo } });
      await this.observePrimaryReview(reference, observed, documentType);
    } catch { /* The next read-only poll may observe review instead. */ }
    return customerNo;
  }

  private async observePrimaryReview(reference: string, info: unknown, documentType: 1 | 2): Promise<UpaySubmission> {
    const submission = await this.journal.get(reference);
    if (!submission) throw new UpayKycUnknownError();
    if (primaryReviewObserved(info, documentType) && submission.state === 'acknowledged' && submission.evidence.kycProtocol === 'customer_primary' &&
      submission.evidence.step === 'kyc_submit' && submission.evidence.responseAck === 'accepted_envelope' &&
      submission.evidence.dispatchPhase === 'post_dispatched' && submission.evidence.primaryReviewObserved !== true) {
      try {
        await this.journal.record(reference, { state: 'acknowledged', evidence: { primaryReviewObserved: true,
          primaryObservationSource: 'live_response', primaryReviewObservedAt: Date.now() } });
      } catch (error) {
        // Another reader may have persisted its first observation under the same
        // immutable generation. Reuse that evidence instead of replacing its time.
        const observed = await this.journal.get(reference);
        if (observed?.evidence.primaryReviewObserved === true && typeof observed.evidence.primaryReviewObservedAt === 'number' &&
          ['live_response', 'operator_observed_transition'].includes(String(observed.evidence.primaryObservationSource)) &&
          observed.evidence.customerNo === submission.evidence.customerNo && observed.evidence.submissionId === submission.evidence.submissionId &&
          observed.evidence.documentType === documentType && observed.evidence.kycProtocol === 'customer_primary') return observed;
        throw error;
      }
      return (await this.journal.get(reference))!;
    }
    return submission;
  }

  private async createMarkedCustomer(input: PartnerCustomerInput, countryCode: string | number, groupId: string): Promise<string> {
    const kyc = input.kyc!;
    const marker = `GUDEX-KYC:${kyc.submissionId}`;
    const body = { email: input.email, givenName: input.firstName, lastName: input.lastName,
      groupId, globalCode: kyc.globalCode, phone: kyc.phone, remark: marker,
      authType: [kyc.documentType === 'id_card' ? 1 : 2],
      ...(kyc.documentType === 'id_card' ? { idCardNationality: countryCode } : { passportNationality: countryCode }), signaturePhoto: '*' };
    const reference = `customer:${kyc.submissionId}`;
    // Only a genuinely new customer can be rejected by this new preflight.
    // An older uncertain send must keep its lookup-only recovery semantics.
    if (!await this.journal.get(reference)) assertNewCustomerCanUseCard(input);
    const begun = await this.journal.begin({ reference, kind: 'customer', requestHash: this.hash(body), evidence: { submissionId: kyc.submissionId } });
    if (!begun.created && begun.submission.state === 'confirmed') {
      const stored = id(begun.submission.evidence.customerNo);
      if (stored) return stored;
    }
    if (begun.created) {
      let outcome = accepted('customer_add');
      try { await this.client.submitRequest('/customer/add', body, { beforeDispatch: input.beforeSubmit }); }
      catch (error) { outcome = failed('customer_add', error); }
      // An accepted envelope is not a customer receipt. Keep the operation uncertain until exact-marker lookup succeeds.
      const current = await this.journal.get(reference);
      if (current && current.state !== 'confirmed' && current.state !== 'rejected') await this.journal.record(reference, { state: 'unknown', evidence: outcome });
    }
    // Exact marker + matching identity. Never adopt an arbitrary customer merely sharing an email.
    const found = await this.findMarkedCustomer(input, marker);
    if (!found) {
      await this.journal.record(reference, { state: 'unknown' });
      throw new UpayKycUnknownError('UPay customer creation has no confirmed matching receipt');
    }
    await this.journal.record(reference, { state: 'confirmed', partnerReceiptId: found, evidence: { customerNo: found } });
    return found;
  }

  private async findMarkedCustomer(input: PartnerCustomerInput, marker: string): Promise<string | null> {
    let candidate: Record<string, unknown> | undefined;
    let complete = false;
    for (let pageNo = 1; pageNo <= 20; pageNo++) {
      // Scan without an email filter: uniqueness must include markers under other identities.
      const page = object(await this.client.readRequest('GET', '/customer/list', { query: { pageNo, pageSize: 100 } }));
      if (!Array.isArray(page.list) || (page.totalPages !== undefined &&
        (!Number.isSafeInteger(page.totalPages) || Number(page.totalPages) < 0))) throw new UpayKycUnknownError('UPay customer marker scan is incomplete');
      const rows = list(page);
      for (const row of rows) {
        if (row.remark !== marker) continue;
        if (candidate) throw new UpayKycUnknownError('UPay customer marker is not unique');
        candidate = row;
      }
      if ((typeof page.totalPages === 'number' && pageNo >= page.totalPages) || (page.totalPages === undefined && rows.length < 100)) {
        complete = true;
        break;
      }
    }
    if (!complete) throw new UpayKycUnknownError('UPay customer marker scan is incomplete');
    if (!candidate) return null;
    const number = (row: Record<string, unknown>) => {
      const value = id(row.no ?? row.customerNo);
      return value && (row.no === undefined || id(row.no) === value) && (row.customerNo === undefined || id(row.customerNo) === value) ? value : null;
    };
    const identityMatches = (row: Record<string, unknown>) => typeof row.email === 'string' && row.email.toLowerCase() === input.email.toLowerCase() &&
      typeof row.givenName === 'string' && row.givenName.toUpperCase() === input.firstName.toUpperCase() &&
      typeof row.lastName === 'string' && row.lastName.toUpperCase() === input.lastName.toUpperCase();
    const customerNo = number(candidate);
    const customerId = id(candidate.customerId);
    if (!customerNo || (candidate.customerId !== undefined && !customerId)) throw new UpayKycUnknownError('UPay customer receipt identifier is invalid');
    if (identityMatches(candidate)) return customerNo;
    // The production list masks identity fields; the SPA's Info page uses customerId.
    if (!customerId) throw new UpayKycUnknownError('UPay customer receipt identifier is missing');
    const detail = object(await this.client.readRequest('GET', '/customer/get', { query: { customerId } }));
    if (detail.remark !== marker || !identityMatches(detail) || id(detail.customerId) !== customerId || number(detail) !== customerNo) {
      throw new UpayKycUnknownError('UPay customer detail does not match the marked receipt');
    }
    return customerNo;
  }

  private async upload(userId: string, submissionId: string, role: KycDocumentKind, documentId: string, fileType: number, customerNo: string,
    beforeDispatch?: () => Promise<void>): Promise<string> {
    const image = await this.documents.getOwned(userId, documentId, role);
    const reference = `upload:${submissionId}:${role}`;
    const begun = await this.journal.begin({ reference, kind: 'upload', requestHash: this.hash({ documentId, fileType, size: image.size }),
      evidence: { customerNo, submissionId, documentRole: role } });
    if (image.remoteUri) {
      await this.journal.record(reference, { state: 'confirmed' });
      return image.remoteUri;
    }
    if (!begun.created) throw new UpayKycUnknownError('UPay document upload receipt requires reconciliation', customerNo);
    try {
      const result = await this.client.uploadRequest(image.bytes, image.mimeType, fileType, { beforeDispatch });
      await this.documents.markUploaded(userId, documentId, result.uri);
      await this.journal.record(reference, { state: 'confirmed', evidence: accepted('file_upload') });
      return result.uri;
    } catch (error) {
      await this.journal.record(reference, { state: 'unknown', evidence: failed('file_upload', error) });
      throw new UpayKycUnknownError('UPay document upload result requires reconciliation', customerNo);
    }
  }

  async getKycStatus(customerNo: string): Promise<PartnerKycStatus> {
    const binding = await this.binding(customerNo);
    if (!binding.submissionId || !['id_card', 'passport'].includes(binding.documentType ?? '')) throw new UpayKycUnknownError('UPay document binding is missing', customerNo);
    const reference = `kyc:${binding.submissionId}`;
    const submission = await this.journal.get(reference);
    if (!submission || submission.evidence.customerNo !== customerNo) throw new UpayKycUnknownError('UPay verification receipt is missing', customerNo);
    if (submission.evidence.kycProtocol === 'customer_primary') {
      const [info, product] = await Promise.all([
        this.client.readRequest('GET', '/kyc/info', { query: { customerNo } }),
        this.client.readRequest('GET', '/card/getMayApplyCardDetail', { query: { agentCardId: this.config.UPAY_PRODUCT_ID } }),
      ]);
      if (Number(object(product).kycLevel) !== 1) throw new UpayKycUnknownError('UPay customer primary verification does not satisfy this product', customerNo);
      const documentType = binding.documentType === 'id_card' ? 1 : 2;
      let current = await this.observePrimaryReview(reference, info, documentType);
      let result: PartnerKycStatus;
      let proof: SubmissionEvidence = {};
      try {
        result = primaryVerificationStatus(info, current, documentType);
        if (result.status === 'approved') proof = { approvalBasis: 'document_hashes', photoReceiptMatched: true };
      } catch {
        const [requirements, ...uploads] = await Promise.all([
          this.client.readRequest('GET', '/card/get/kyc', { query: { customerNo, agentCardId: this.config.UPAY_PRODUCT_ID } }),
          ...['front', ...(documentType === 1 ? ['back'] : [])].map(role => this.journal.get(`upload:${binding.submissionId}:${role}`)),
        ]);
        current = (await this.journal.get(reference))!;
        const context = { customerNo, submissionId: binding.submissionId, productLevel: 1, requirements, uploads: uploads as (UpaySubmission | null)[] };
        result = primaryReviewObserved(info, documentType) ? primaryIssuerReviewPending(info, current, documentType, context)
          : primaryIssuerSubjectApproval(info, current, documentType, context);
        if (result.status === 'approved') proof = { approvalBasis: 'issuer_subject_status', photoReceiptMatched: false };
      }
      const fresh = await this.binding(customerNo);
      if (fresh.userId !== binding.userId || fresh.submissionId !== binding.submissionId || fresh.documentType !== binding.documentType) {
        throw new UpayKycUnknownError('UPay verification binding changed during receipt lookup', customerNo);
      }
      // Confirmed provenance is immutable; later issuer reads never replace stronger
      // document proof with subject approval or rewrite any submitted hashes.
      if (current.state !== 'confirmed') {
        if (current.evidence.approvalBasis !== undefined || current.evidence.photoReceiptMatched !== undefined) proof = {};
        await this.journal.record(reference, { state: result.status === 'approved' ? 'confirmed' : result.status === 'rejected' ? 'rejected' : 'acknowledged',
          evidence: { status: result.status, ...proof } });
      }
      return result;
    }
    if (submission.evidence.kycProtocol !== undefined && submission.evidence.kycProtocol !== 'card') throw new UpayKycUnknownError('UPay verification protocol is unsupported', customerNo);
    const [details, result, product] = await Promise.all([
      this.client.readRequest('GET', '/card/get/kyc', { query: { customerNo, agentCardId: this.config.UPAY_PRODUCT_ID } }),
      this.client.readRequest('GET', '/card/get/kycStatus', { query: { customerNo, agentCardId: this.config.UPAY_PRODUCT_ID } }),
      this.client.readRequest('GET', '/card/getMayApplyCardDetail', { query: { agentCardId: this.config.UPAY_PRODUCT_ID } }),
    ]);
    const doc = object(details), status = object(result);
    const passport = binding.documentType === 'passport';
    const documentState = Number(status[passport ? 'passport' : 'idCard']);
    const level = Number(object(product).kycLevel);
    if (!Number.isInteger(level) || level < 0) throw new UpayKycUnknownError('UPay product verification requirements are unavailable', customerNo);
    // An explicit local collection policy must not invent an issuer face-approval requirement.
    const requireFace = level > 1;
    const faceState = requireFace ? Number(status.face) : 1;
    const front = doc[passport ? 'passportFrontPath' : 'idCardFrontPath'];
    const back = passport ? front : doc.idCardBackPath;
    const match = typeof front === 'string' && typeof back === 'string' && uriHash(front) === submission.evidence.documentFrontHash &&
      uriHash(back) === submission.evidence.documentBackHash && (!requireFace || (typeof doc.facePath === 'string' && uriHash(doc.facePath) === submission.evidence.faceHash));
    if (!match) {
      if ([1, 4].includes(documentState) || ['sending', 'unknown'].includes(submission.state)) throw new UpayKycUnknownError('UPay document receipt does not match this submission', customerNo);
      return { status: 'pending' };
    }
    if (documentState === 4 || faceState === 4) {
      await this.journal.record(reference, { state: 'rejected', evidence: { status: 'rejected' } });
      return { status: 'rejected', reason: 'Identity verification was rejected by the issuer' };
    }
    if (documentState === 1 && faceState === 1) {
      await this.journal.record(reference, { state: 'confirmed', evidence: { status: 'approved' } });
      return { status: 'approved' };
    }
    if (documentState === 2 || faceState === 2 || ['acknowledged', 'confirmed'].includes(submission.state)) {
      await this.journal.record(reference, { state: 'acknowledged', evidence: { status: 'pending' } });
      return { status: 'pending' };
    }
    throw new UpayKycUnknownError('UPay has not confirmed receipt of the submitted documents', customerNo);
  }

  private async binding(customerNo: string) {
    const rows = await this.db.select().from(kycProfiles).where(and(eq(kycProfiles.partnerCustomerId, customerNo), eq(kycProfiles.partnerProvider, 'upay'))).limit(2);
    if (rows.length !== 1) throw new UpayKycUnknownError('UPay customer has no unique local verification binding', customerNo);
    return rows[0]!;
  }

  private hash(value: object): string { return createHmac('sha256', this.config.appSecret).update('gudex:upay:kyc:').update(JSON.stringify(value)).digest('hex'); }
}
