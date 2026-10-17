import { createHash } from 'node:crypto';
import { PartnerError, type PartnerKycStatus } from '../types';
import type { UpaySubmission } from './submissions';

type ObjectRow = Record<string, unknown>;
const object = (value: unknown): ObjectRow | null => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectRow : null;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const uncertain = () => new PartnerError('UPay primary verification document receipt is unconfirmed', true);

export function primaryNationalityCode(value: unknown): string | number {
  if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  throw new PartnerError('UPay primary verification nationality code is unavailable', false);
}

export const primaryNationalityCodeHash = (value: string | number): string => hash(JSON.stringify(value));

function selectedPrimaryItem(info: unknown, documentType: 1 | 2): ObjectRow | null {
  const items = object(info)?.items;
  if (!Array.isArray(items)) return null;
  const matches = items.map(object).filter(item => item?.documentType === documentType);
  return matches.length === 1 ? matches[0]! : null;
}

function primaryItem(info: unknown, documentType: 1 | 2): ObjectRow {
  const item = selectedPrimaryItem(info, documentType);
  if (!item || item.level !== 1 || ![1, 2, 3, 4].includes(Number(item.status))) throw uncertain();
  return item;
}

export function assertPrimarySubmissionReady(info: unknown, documentType: 1 | 2): 2 | 4 {
  const item = primaryItem(info, documentType);
  // The SPA enables an explicit new submission for rejected/unsubmitted primary items.
  // A current journal is checked by the caller first; this never authorizes replay.
  if (item.status !== 2 && item.status !== 4) throw new PartnerError('UPay primary verification already exists and requires receipt reconciliation', true);
  return item.status;
}

export function primaryReviewObserved(info: unknown, documentType: 1 | 2): boolean {
  const item = selectedPrimaryItem(info, documentType);
  return item?.level === 1 && item.status === 3;
}

export function primarySubmissionBody(customerNo: string, nationalityCode: string | number, documentType: 1 | 2, front: string, back: string) {
  if (!front || front === '*' || (documentType === 1 && (!back || back === '*'))) throw uncertain();
  return { customerNo, nationalityCode, documentType, frontPhoto: front, backPhoto: documentType === 1 ? back : '*',
    holdFrontPhoto: '*', ...(documentType === 1 ? { holdBackPhoto: '*' } : {}) };
}

// The SPA separates its URI extractor from the fullUrl/url preview extractor.
// Support only known URI fields and bounded metadata wrappers, never a display URL fallback.
function photoUri(value: unknown, depth = 0): string | null {
  if (depth > 3) return null;
  if (typeof value === 'string') {
    if (!value || value.length > 16384) return null;
    if (/^\s*[\[{]/.test(value)) {
      try { return photoUri(JSON.parse(value), depth + 1); } catch { return null; }
    }
    return value.length <= 4096 ? value : null;
  }
  const row = object(value);
  if (!row) return null;
  for (const key of ['uri', 'fileUri', 'path']) if (typeof row[key] === 'string' && row[key] && row[key].length <= 4096) return row[key];
  for (const key of ['data', 'result', 'file']) {
    const uri = photoUri(row[key], depth + 1);
    if (uri) return uri;
  }
  return null;
}

function receiptMatches(item: ObjectRow | null, submission: Pick<UpaySubmission, 'evidence'>, documentType: 1 | 2) {
  let countryHashMatches = false;
  try { countryHashMatches = primaryNationalityCodeHash(primaryNationalityCode(item?.nationalityCode)) === submission.evidence.nationalityCodeHash; }
  catch { /* Missing or unsupported raw country values cannot establish a receipt. */ }
  const front = photoUri(item?.frontPhoto);
  const passportBackEmpty = item !== null && (item.backPhoto === undefined || item.backPhoto === null || item.backPhoto === '' || item.backPhoto === '*' || photoUri(item.backPhoto) === '*');
  const back = documentType === 1 ? photoUri(item?.backPhoto) : passportBackEmpty ? '*' : null;
  return { protocolMatches: submission.evidence.kycProtocol === 'customer_primary', documentTypeMatches: submission.evidence.documentType === documentType,
    countryHashMatches, frontHashMatches: front !== null && hash(front) === submission.evidence.documentFrontHash,
    backHashMatches: back !== null && hash(back) === submission.evidence.documentBackHash, passportBackEmpty };
}

type PhotoShape = 'rawstring' | 'json' | 'object' | 'array' | 'null' | 'other';
const PHOTO_KEYS = ['uri', 'fileUri', 'path', 'data', 'result', 'file', 'response', 'fullUrl', 'url', 'fileUrl', 'downloadUrl'] as const;
function photoDescription(value: unknown): { shape: PhotoShape; knownKeys: string[] } {
  const shape: PhotoShape = value === null || value === undefined ? 'null' : typeof value === 'string' ? /^\s*[\[{]/.test(value) ? 'json' : 'rawstring'
    : Array.isArray(value) ? 'array' : object(value) ? 'object' : 'other';
  const keys = new Set<string>();
  const collect = (candidate: unknown, depth: number): void => {
    if (depth > 3) return;
    if (typeof candidate === 'string' && candidate.length <= 16384 && /^\s*[\[{]/.test(candidate)) {
      try { collect(JSON.parse(candidate), depth + 1); } catch { /* Malformed metadata has no known keys. */ }
      return;
    }
    const row = object(candidate);
    if (!row) return;
    for (const key of PHOTO_KEYS) if (Object.hasOwn(row, key)) keys.add(key);
    for (const key of ['data', 'result', 'file', 'response']) collect(row[key], depth + 1);
  };
  collect(value, 0);
  return { shape, knownKeys: [...keys].sort() };
}

// Evidence-only comparisons for a raw signed URL. Never used by receiptMatches or
// primaryVerificationStatus: URL path transformations do not prove document identity.
function rawPhotoPathDescription(value: unknown, expectedHash: unknown) {
  const result = { empty: value === '', placeholder: value === '*', absoluteHttpUrl: false,
    nullLiteral: value === 'null', undefinedLiteral: value === 'undefined',
    maskedStars: typeof value === 'string' && /^\*{2,}$/.test(value), maskedX: typeof value === 'string' && /^x{2,}$/i.test(value),
    looksBase64Envelope: typeof value === 'string' && value.length >= 24 && value.length <= 16384 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
    pathnameHashMatches: false, pathnameWithoutLeadingSlashHashMatches: false,
    decodedPathnameHashMatches: false, decodedPathnameWithoutLeadingSlashHashMatches: false };
  if (typeof value !== 'string' || value.length > 16384 || !/^https?:\/\//i.test(value)) return result;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return result;
    result.absoluteHttpUrl = true;
    const withoutLeadingSlash = (path: string) => path.startsWith('/') ? path.slice(1) : path;
    result.pathnameHashMatches = hash(url.pathname) === expectedHash;
    result.pathnameWithoutLeadingSlashHashMatches = hash(withoutLeadingSlash(url.pathname)) === expectedHash;
    try {
      const decoded = decodeURIComponent(url.pathname);
      result.decodedPathnameHashMatches = hash(decoded) === expectedHash;
      result.decodedPathnameWithoutLeadingSlashHashMatches = hash(withoutLeadingSlash(decoded)) === expectedHash;
    } catch { /* Invalid percent encoding cannot establish a decoded-path match. */ }
  } catch { /* Malformed URLs have no derived-path evidence. */ }
  return result;
}

// OPS diagnostics deliberately expose only booleans, closed shape labels and known field names.
// The exact URI/country/hash comparisons below are shared with the terminal status decision.
export function inspectPrimaryReceipt(info: unknown, submission: Pick<UpaySubmission, 'evidence'>, documentType: 1 | 2) {
  const item = selectedPrimaryItem(info, documentType);
  const { passportBackEmpty: _passportBackEmpty, ...matches } = receiptMatches(item, submission, documentType);
  const country = item?.nationalityCode;
  const countryType: 'string' | 'number' | 'null' | 'other' = country === null || country === undefined ? 'null'
    : typeof country === 'string' ? 'string' : typeof country === 'number' ? 'number' : 'other';
  return { ...matches, itemUnique: item !== null, itemLevelMatches: item?.level === 1,
    itemStatusSupported: item !== null && [1, 2, 3, 4].includes(Number(item.status)), countryType,
    frontPhoto: photoDescription(item?.frontPhoto), backPhoto: photoDescription(item?.backPhoto) };
}

// Read-only observation of the separate card requirements mirror. These flags do not
// establish primary status or authorize any fallback when /kyc/info omits its photos.
export function inspectPrimaryCardMirror(requirements: unknown, submission: Pick<UpaySubmission, 'evidence'>,
  documentType: 1 | 2, expectedCustomerNo: string) {
  const row = object(requirements) ?? {};
  const passport = documentType === 2;
  const country = row[passport ? 'passportCountryCode' : 'idCardCountryCode'];
  const front = row[passport ? 'passportFrontPath' : 'idCardFrontPath'];
  const remoteBack = passport ? undefined : row.idCardBackPath;
  const { passportBackEmpty: _passportBackEmpty, ...matches } = receiptMatches({ nationalityCode: country, frontPhoto: front,
    backPhoto: passport ? '*' : remoteBack }, submission, documentType);
  const certified = row.certifiedDocumentType;
  const certifiedDocumentTypeShape: 'array' | 'object' | 'number' | 'string' | 'null' | 'other' = certified === null || certified === undefined ? 'null'
    : Array.isArray(certified) ? 'array' : object(certified) ? 'object' : typeof certified === 'number' ? 'number' : typeof certified === 'string' ? 'string' : 'other';
  const countryType: 'string' | 'number' | 'null' | 'other' = country === null || country === undefined ? 'null'
    : typeof country === 'string' ? 'string' : typeof country === 'number' ? 'number' : 'other';
  return { ...matches, customerMatches: typeof expectedCustomerNo === 'string' && expectedCustomerNo.length > 0 &&
      row.customerNo === expectedCustomerNo && submission.evidence.customerNo === expectedCustomerNo,
    certifiedDocumentTypeMatches: Array.isArray(certified) && certified.every(value => typeof value === 'number' && Number.isSafeInteger(value)) && certified.includes(documentType), certifiedDocumentTypeShape,
    countryType, countryEmpty: country === '', countryPlaceholder: country === '*', backPlaceholder: passport,
    countryNullLiteral: country === 'null', countryUndefinedLiteral: country === 'undefined', countryMaskedStars: typeof country === 'string' && /^\*{2,}$/.test(country),
    frontPhoto: photoDescription(front), backPhoto: photoDescription(remoteBack),
    frontPhotoPath: rawPhotoPathDescription(front, submission.evidence.documentFrontHash),
    backPhotoPath: rawPhotoPathDescription(remoteBack, submission.evidence.documentBackHash) };
}

export interface PrimarySubjectContext {
  customerNo: string;
  submissionId: string;
  productLevel: number;
  requirements: unknown;
  uploads: readonly (UpaySubmission | null)[];
}

function primarySubjectItem(info: unknown, submission: UpaySubmission, documentType: 1 | 2, context: PrimarySubjectContext, requireCertification = true): ObjectRow {
  const item = primaryItem(info, documentType), evidence = submission.evidence;
  if (context.productLevel !== 1 || submission.reference !== `kyc:${context.submissionId}` || submission.kind !== 'kyc' ||
    !['acknowledged', 'confirmed'].includes(submission.state) || evidence.submissionId !== context.submissionId ||
    evidence.customerNo !== context.customerNo || evidence.kycProtocol !== 'customer_primary' || evidence.documentType !== documentType ||
    evidence.step !== 'kyc_submit' || evidence.dispatchPhase !== 'post_dispatched' || evidence.responseAck !== 'accepted_envelope') throw uncertain();
  const historicalDocumentProof = submission.state === 'confirmed' && evidence.approvalBasis === 'document_hashes' && evidence.photoReceiptMatched === true;
  if (!historicalDocumentProof) {
    if ((evidence.primaryInitialStatus !== 2 && evidence.primaryInitialStatus !== 4) || evidence.primaryReviewObserved !== true ||
      !['live_response', 'operator_observed_transition'].includes(String(evidence.primaryObservationSource))) throw uncertain();
    const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
    if (!timestamp(evidence.primaryInitialObservedAt) || !timestamp(evidence.primaryReviewObservedAt) ||
      evidence.primaryInitialObservedAt > evidence.primaryReviewObservedAt ||
      (evidence.primaryObservationSource === 'operator_observed_transition' &&
        (!timestamp(evidence.primaryAttestedAt) || evidence.primaryReviewObservedAt > evidence.primaryAttestedAt))) throw uncertain();
  }
  for (const key of ['nationalityCodeHash', 'documentFrontHash', 'documentBackHash']) {
    if (typeof evidence[key] !== 'string' || !/^[a-f0-9]{64}$/.test(evidence[key])) throw uncertain();
  }
  if (documentType === 2 && evidence.documentBackHash !== hash('*')) throw uncertain();
  // Missing keys, masks and mixed visible/hidden fields cannot authorize this separate policy.
  if (!['nationalityCode', 'frontPhoto', 'backPhoto'].every(key => Object.hasOwn(item, key) && item[key] === null)) throw uncertain();
  const mirror = inspectPrimaryCardMirror(context.requirements, submission, documentType, context.customerNo);
  if (!mirror.customerMatches || (requireCertification && !mirror.certifiedDocumentTypeMatches)) throw uncertain();
  for (const role of documentType === 1 ? ['front', 'back'] : ['front']) {
    const matches = context.uploads.filter(upload => upload?.reference === `upload:${context.submissionId}:${role}`);
    const upload = matches.length === 1 ? matches[0] : null;
    if (!upload || upload.kind !== 'upload' || upload.state !== 'confirmed' || upload.evidence.customerNo !== context.customerNo ||
      upload.evidence.submissionId !== context.submissionId || upload.evidence.documentRole !== role) throw uncertain();
  }
  return item;
}

// This proves issuer approval of the bound subject, explicitly not a match to stored photos.
export function primaryIssuerSubjectApproval(info: unknown, submission: UpaySubmission, documentType: 1 | 2,
  context: PrimarySubjectContext): PartnerKycStatus {
  const item = primarySubjectItem(info, submission, documentType, context), top = object(info)!;
  if (item.status !== 1 || top.authResult !== 1 || !Number.isSafeInteger(top.primaryApprovedNum) || Number(top.primaryApprovedNum) < 1) throw uncertain();
  return { status: 'approved' };
}

export function primaryIssuerReviewPending(info: unknown, submission: UpaySubmission, documentType: 1 | 2,
  context: PrimarySubjectContext): PartnerKycStatus {
  if (primarySubjectItem(info, submission, documentType, context, false).status !== 3) throw uncertain();
  return { status: 'pending' };
}

export function primaryVerificationStatus(info: unknown, submission: UpaySubmission, documentType: 1 | 2): PartnerKycStatus {
  const item = primaryItem(info, documentType);
  const receipt = receiptMatches(item, submission, documentType);
  if (!receipt.protocolMatches || !receipt.documentTypeMatches || !receipt.countryHashMatches || (documentType === 2 && !receipt.passportBackEmpty)) throw uncertain();
  const matches = receipt.frontHashMatches && receipt.backHashMatches;
  if (matches && item.status === 1) return { status: 'approved' };
  if (matches && item.status === 2) return { status: 'rejected', reason: 'Identity verification was rejected by the issuer' };
  if (matches && item.status === 3) return { status: 'pending' };
  // A successful envelope may precede photo/status propagation. It cannot prove approval.
  if ([3, 4].includes(Number(item.status)) && submission.state === 'acknowledged') return { status: 'pending' };
  throw uncertain();
}
