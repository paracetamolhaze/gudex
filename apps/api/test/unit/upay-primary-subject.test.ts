import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { primaryIssuerReviewPending, primaryIssuerSubjectApproval } from '../../src/partner/upay/primary-customer-kyc';
import { MemoryUpaySubmissionStore, type UpaySubmission, type SubmissionEvidence } from '../../src/partner/upay/submissions';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const customerNo = 'fixture-customer', submissionId = 'fixture-submission';
  const submission: UpaySubmission = { reference: `kyc:${submissionId}`, kind: 'kyc', requestHash: 'fixture-request', state: 'acknowledged',
    partnerReceiptId: null, partnerCardId: null, evidence: { customerNo, submissionId, kycProtocol: 'customer_primary', documentType: 1,
      primaryInitialStatus: 4, primaryInitialObservedAt: 1700000000000, primaryReviewObserved: true, primaryReviewObservedAt: 1700000001000,
      primaryObservationSource: 'live_response', step: 'kyc_submit', dispatchPhase: 'post_dispatched', responseAck: 'accepted_envelope',
      nationalityCodeHash: hash('"KZ"'), documentFrontHash: hash('fixture-front'), documentBackHash: hash('fixture-back') } };
  const item: Record<string, unknown> = { documentType: 1, level: 1, status: 1, nationalityCode: null, frontPhoto: null, backPhoto: null };
  const info = { authResult: 1, primaryApprovedNum: 1, items: [item] };
  const uploads: UpaySubmission[] = ['front', 'back'].map(documentRole => ({ reference: `upload:${submissionId}:${documentRole}`, kind: 'upload',
    requestHash: 'fixture-upload', state: 'confirmed', partnerReceiptId: null, partnerCardId: null, evidence: { customerNo, submissionId, documentRole } }));
  const context = { customerNo, submissionId, productLevel: 1, requirements: { customerNo, certifiedDocumentType: [1] }, uploads };
  return { submission, item, info, context };
}

describe('issuer subject approval without a document receipt', () => {
  it('recognizes current issuer approval only with the accepted submission and observed primary review chain', () => {
    const { info, submission, context } = fixture();
    expect(primaryIssuerSubjectApproval(info, submission, 1, context)).toEqual({ status: 'approved' });
  });

  it('keeps accepted hidden primary review pending without claiming document receipt or approval', () => {
    const { info, item, submission, context } = fixture();
    item.status = 3;
    expect(primaryIssuerReviewPending(info, submission, 1, context)).toEqual({ status: 'pending' });
    expect(() => primaryIssuerSubjectApproval(info, submission, 1, context)).toThrow();
  });

  it('does not require certification for pending review but still requires it for approval', () => {
    const { info, item, submission, context } = fixture();
    context.requirements.certifiedDocumentType = [];
    item.status = 3;
    expect(primaryIssuerReviewPending(info, submission, 1, context)).toEqual({ status: 'pending' });
    item.status = 1;
    expect(() => primaryIssuerSubjectApproval(info, submission, 1, context)).toThrow();
  });

  it('retains historical confirmed document proof when issuer fields later become null', () => {
    const { info, submission, context } = fixture();
    submission.state = 'confirmed'; submission.evidence.approvalBasis = 'document_hashes'; submission.evidence.photoReceiptMatched = true;
    for (const key of ['primaryInitialStatus', 'primaryInitialObservedAt', 'primaryReviewObserved', 'primaryReviewObservedAt', 'primaryObservationSource']) delete submission.evidence[key];
    expect(primaryIssuerSubjectApproval(info, submission, 1, context)).toEqual({ status: 'approved' });
    delete submission.evidence.approvalBasis;
    expect(() => primaryIssuerSubjectApproval(info, submission, 1, context)).toThrow();
  });

  const invalid: [string, (value: ReturnType<typeof fixture>) => void][] = [
    ['unknown POST', f => { f.submission.state = 'unknown'; }],
    ['sending POST', f => { f.submission.state = 'sending'; }],
    ['rejected POST', f => { f.submission.state = 'rejected'; }],
    ['unconfirmed response', f => { f.submission.evidence.responseAck = 'unconfirmed'; }],
    ['rejected envelope', f => { f.submission.evidence.responseAck = 'rejected_envelope'; }],
    ['pre-dispatch rejection', f => { f.submission.evidence.dispatchPhase = 'pre_dispatch'; }],
    ['wrong dispatch step', f => { f.submission.evidence.step = 'customer_add'; }],
    ['missing baseline', f => { delete f.submission.evidence.primaryInitialStatus; }],
    ['previously approved baseline', f => { f.submission.evidence.primaryInitialStatus = 1; }],
    ['missing review observation', f => { delete f.submission.evidence.primaryReviewObserved; }],
    ['missing observation source', f => { delete f.submission.evidence.primaryObservationSource; }],
    ['unknown observation source', f => { f.submission.evidence.primaryObservationSource = 'guessed'; }],
    ['missing initial observation time', f => { delete f.submission.evidence.primaryInitialObservedAt; }],
    ['missing review observation time', f => { delete f.submission.evidence.primaryReviewObservedAt; }],
    ['review before initial status', f => { f.submission.evidence.primaryReviewObservedAt = 1600000000000; }],
    ['operator observation without attestation time', f => { f.submission.evidence.primaryObservationSource = 'operator_observed_transition'; }],
    ['attestation before observed review', f => { f.submission.evidence.primaryObservationSource = 'operator_observed_transition'; f.submission.evidence.primaryAttestedAt = 1600000000000; }],
    ['different generation', f => { f.submission.evidence.submissionId = 'other'; }],
    ['different reference', f => { f.submission.reference = 'kyc:other'; }],
    ['different customer', f => { f.submission.evidence.customerNo = 'other'; }],
    ['wrong protocol', f => { f.submission.evidence.kycProtocol = 'card'; }],
    ['wrong document type', f => { f.submission.evidence.documentType = 2; }],
    ['missing submitted hash', f => { delete f.submission.evidence.documentFrontHash; }],
    ['missing upload', f => { f.context.uploads.pop(); }],
    ['unknown upload', f => { f.context.uploads[0]!.state = 'unknown'; }],
    ['foreign upload', f => { f.context.uploads[0]!.evidence.customerNo = 'other'; }],
    ['old upload generation', f => { f.context.uploads[0]!.evidence.submissionId = 'other'; }],
    ['duplicate upload reference', f => { f.context.uploads.push({ ...f.context.uploads[0]! }); }],
    ['advanced product', f => { f.context.productLevel = 2; }],
    ['foreign mirror customer', f => { f.context.requirements.customerNo = 'other'; }],
    ['uncertified selected type', f => { f.context.requirements.certifiedDocumentType = [2]; }],
    ['mixed certified type representations', f => { Object.assign(f.context.requirements, { certifiedDocumentType: [1, '2'] }); }],
    ['visible wrong country', f => { f.item.nationalityCode = 'OTHER'; }],
    ['visible exact country', f => { f.item.nationalityCode = 'KZ'; }],
    ['visible different photo', f => { f.item.frontPhoto = 'other'; }],
    ['masked photo', f => { f.item.backPhoto = '*'; }],
    ['absent country key', f => { delete f.item.nationalityCode; }],
    ['undefined front photo', f => { f.item.frontPhoto = undefined; }],
    ['duplicate selected item', f => { f.info.items.push({ ...f.item }); }],
    ['advanced item', f => { f.item.level = 2; }],
    ['unsubmitted item', f => { f.item.status = 4; }],
    ['rejected item', f => { f.item.status = 2; }],
    ['top status disagreement', f => { f.info.authResult = 4; }],
    ['no primary approval count', f => { f.info.primaryApprovedNum = 0; }],
  ];
  it.each(invalid)('does not approve %s', (_name, change) => {
    const value = fixture(); change(value);
    expect(() => primaryIssuerSubjectApproval(value.info, value.submission, 1, value.context)).toThrow();
  });

  it('supports a confirmed accepted journal and an explicit operator observation without rewriting evidence', () => {
    const { info, submission, context } = fixture();
    submission.state = 'confirmed'; submission.evidence.primaryInitialStatus = 2;
    submission.evidence.primaryObservationSource = 'operator_observed_transition';
    submission.evidence.primaryAttestedAt = 1700000002000;
    const before = JSON.stringify(submission);
    expect(primaryIssuerSubjectApproval(info, submission, 1, context)).toEqual({ status: 'approved' });
    expect(JSON.stringify(submission)).toBe(before);
  });

  it('requires only the current front upload for a passport with its exact submitted back placeholder hash', () => {
    const { info, item, submission, context } = fixture();
    item.documentType = 2; submission.evidence.documentType = 2; submission.evidence.documentBackHash = hash('*');
    context.requirements.certifiedDocumentType = [2]; context.uploads.pop();
    expect(primaryIssuerSubjectApproval(info, submission, 2, context)).toEqual({ status: 'approved' });
    submission.evidence.documentBackHash = hash('foreign-back');
    expect(() => primaryIssuerSubjectApproval(info, submission, 2, context)).toThrow();
  });
});

describe('primary journal proof provenance', () => {
  it('persists closed baseline, observation and explicit non-photo approval without allowing contradictory rewrites', async () => {
    const { submission } = fixture();
    const journal = new MemoryUpaySubmissionStore();
    await journal.begin({ reference: submission.reference, kind: 'kyc', requestHash: submission.requestHash, evidence: submission.evidence });
    await journal.record(submission.reference, { state: 'acknowledged' });
    await journal.record(submission.reference, { state: 'confirmed', evidence: { approvalBasis: 'issuer_subject_status', photoReceiptMatched: false } });
    expect(await journal.get(submission.reference)).toMatchObject({ state: 'confirmed', evidence: { primaryInitialStatus: 4,
      primaryReviewObserved: true, primaryObservationSource: 'live_response', approvalBasis: 'issuer_subject_status', photoReceiptMatched: false } });
    const invalid: SubmissionEvidence[] = [{ primaryInitialStatus: 1 }, { primaryInitialStatus: '4' }, { primaryReviewObserved: false },
      { primaryObservationSource: 'guessed' }, { primaryInitialObservedAt: -1 }, { primaryReviewObservedAt: Number.NaN },
      { primaryAttestedAt: 1.1 }, { approvalBasis: 'guessed', photoReceiptMatched: false }, { approvalBasis: 'issuer_subject_status', photoReceiptMatched: true }];
    for (const evidence of invalid) await expect(journal.record(submission.reference, { state: 'confirmed', evidence })).rejects.toThrow();
    await expect(journal.record(submission.reference, { state: 'confirmed', evidence: { primaryInitialStatus: 2 } })).rejects.toThrow('immutable');
    await expect(journal.record(submission.reference, { state: 'confirmed', evidence: { approvalBasis: 'document_hashes', photoReceiptMatched: true } })).rejects.toThrow('immutable');
  });
});
