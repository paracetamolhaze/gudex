import { eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { kycProfiles, upaySubmissions, users } from '../db/schema';
import { AppError } from '../lib/errors';
import type { UpayClient } from '../partner/upay/client';
import { decimal, exactCents, formatCents, issuancePayload } from '../partner/upay/financial-protocol';
import { inspectPrimaryCardMirror, inspectPrimaryReceipt, primaryNationalityCode, primaryNationalityCodeHash } from '../partner/upay/primary-customer-kyc';
import { UpayError } from '../partner/upay/transport';

const ISSUANCE_FIELDS = new Set(['customerNo', 'givenName', 'lastName', 'email', 'phone', 'globalCode', 'phoneCountryCode',
  'documentType', 'annualIncome', 'company', 'position', 'profession', 'workYear', 'selfie', 'addressType', 'recipientAddressId',
  'holdBackPath', 'holdFrontPath', 'holdPassportPath', 'signPath', 'Modal']);
const currency = (value: unknown): string | null => typeof value === 'string' && ['USD', 'USDT', 'USDC'].includes(value) ? value : null;
const row = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

function primaryCardCountry(countriesValue: unknown, requirements: Record<string, unknown>, documentCountry: string | null,
  evidence: Record<string, string | number | boolean | null>, documentType: 1 | 2) {
  const mirrorCountry = requirements[documentType === 2 ? 'passportCountryCode' : 'idCardCountryCode'];
  const result = { countryRowUnique: false, submittedRawCodeMatches: false, mirrorCountryMatchesRawCode: false,
    mirrorCountryMatchesAlpha2: false, mirrorCountryMatchesAlpha3: false,
    mirrorCountryEmpty: mirrorCountry === '', mirrorCountryPlaceholder: mirrorCountry === '*' };
  const items = Array.isArray(countriesValue) ? countriesValue : row(countriesValue)?.list;
  const countries = Array.isArray(items) ? items.map(row).filter((item): item is Record<string, unknown> => item !== null) : [];
  const matches = countries.filter(item => {
    const selectedCode = item.codeAlpha2 ?? item.alpha2 ?? item.code;
    return typeof documentCountry === 'string' && String(selectedCode).toUpperCase() === documentCountry.toUpperCase();
  });
  if (matches.length !== 1) return result;
  result.countryRowUnique = true;
  const country = matches[0]!;
  try {
    const rawCode = primaryNationalityCode(country.code);
    result.submittedRawCodeMatches = primaryNationalityCodeHash(rawCode) === evidence.nationalityCodeHash;
    result.mirrorCountryMatchesRawCode = mirrorCountry === rawCode;
  } catch { /* An unsupported raw country value cannot establish receipt equivalence. */ }
  const alphaMatches = (value: unknown) => typeof mirrorCountry === 'string' && typeof value === 'string' &&
    mirrorCountry.toUpperCase() === value.toUpperCase();
  result.mirrorCountryMatchesAlpha2 = alphaMatches(country.codeAlpha2 ?? country.alpha2);
  result.mirrorCountryMatchesAlpha3 = alphaMatches(country.codeAlpha3 ?? country.alpha3);
  return result;
}

function issuanceReadiness(detailValue: unknown, formValue: unknown, customerNo: string, productId: string, documentType: 1 | 2 | null) {
  const detail = row(detailValue), form = row(formValue);
  const result = { feeReadOk: form !== null, issuanceFormReady: false,
    needParams: form && Array.isArray(form.needParams) ? form.needParams.filter((field): field is string => typeof field === 'string' && ISSUANCE_FIELDS.has(field)) : null,
    openFeeUsdt: null as string | null, defaultOpenUsdt: null as string | null,
    cardCurrency: currency(detail?.cardCurrency ?? detail?.currency), rechargeCurrency: currency(detail?.rechargeCurrency),
    openFeeCurrency: currency(detail?.openFeeCurrency), accountCoinBalanceSufficient: null as boolean | null };
  if (!form || !detail) return result;
  // Amounts are labelled USDT only when the observed currencies establish those units.
  try {
    const fee = exactCents(detail.openFee, 'openFee'), initial = exactCents(detail.defaultOpenAmount, 'defaultOpenAmount');
    if (result.openFeeCurrency === 'USDT') result.openFeeUsdt = formatCents(fee);
    if (result.rechargeCurrency === 'USDT') result.defaultOpenUsdt = formatCents(initial);
    if (result.openFeeCurrency === 'USDT' && result.rechargeCurrency === 'USDT' &&
        detail.accountCoinSymbol === 'USDT' && Object.hasOwn(detail, 'accountCoinBalance')) {
      const balance = decimal(detail.accountCoinBalance, 'accountCoinBalance');
      result.accountCoinBalanceSufficient = balance.value * 100n >= (fee + initial) * balance.scale;
    }
  } catch { /* Missing amounts, precision or balance shapes remain unconfirmed. */ }
  const probeForm = { ...form };
  if (probeForm.defaultType == null && probeForm.documentType == null && documentType !== null) probeForm.documentType = documentType;
  try {
    issuancePayload(detail, probeForm, customerNo, productId, 1000n);
    result.issuanceFormReady = true;
  } catch { /* A read-only form probe neither approves verification nor exposes raw errors. */ }
  return result;
}

function submissionDiagnostic(value: unknown, kind: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const expectedStep = ({ customer: 'customer_add', upload: 'file_upload', kyc: 'kyc_submit' } as Record<string, string>)[kind];
  if (!expectedStep || item.step !== expectedStep || !['pre_dispatch', 'post_dispatched'].includes(String(item.dispatchPhase)) ||
      !['accepted_envelope', 'rejected_envelope', 'http_error', 'unconfirmed'].includes(String(item.responseAck))) return undefined;
  return { step: expectedStep, dispatchPhase: item.dispatchPhase, responseAck: item.responseAck,
    ...(typeof item.upstreamCode === 'number' && Number.isSafeInteger(item.upstreamCode) ? { upstreamCode: item.upstreamCode } : {}),
    ...(typeof item.httpStatus === 'number' && Number.isInteger(item.httpStatus) && item.httpStatus >= 100 && item.httpStatus <= 599 ? { httpStatus: item.httpStatus } : {}),
    ...(kind === 'kyc' && typeof item.approvalBasis === 'string' && ['document_hashes', 'issuer_subject_status'].includes(item.approvalBasis) ? {
      approvalBasis: item.approvalBasis,
      ...(typeof item.photoReceiptMatched === 'boolean' ? { photoReceiptMatched: item.photoReceiptMatched } : {}),
    } : {}),
  };
}

// Observation only: never drains jobs, submits documents or returns identity data.
export async function inspectKycStatus(db: Db, telegramId: string, customerProbe?: Pick<UpayClient, 'readRequest'>, productId?: string) {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.telegramId, BigInt(telegramId)));
  if (!user) throw new AppError('not_found', 'User not found');
  const [profile] = await db.select({
    status: kycProfiles.status, submissionState: kycProfiles.submissionState,
    provider: kycProfiles.partnerProvider, customerId: kycProfiles.partnerCustomerId,
    submissionId: kycProfiles.submissionId, submittedAt: kycProfiles.submittedAt,
    documentsSubmittedAt: kycProfiles.documentsSubmittedAt, reviewedAt: kycProfiles.reviewedAt,
    updatedAt: kycProfiles.updatedAt,
    email: kycProfiles.email, firstName: kycProfiles.firstName, lastName: kycProfiles.lastName,
    phone: kycProfiles.phone, globalCode: kycProfiles.globalCode, documentType: kycProfiles.documentType,
    documentCountry: kycProfiles.documentCountry,
  }).from(kycProfiles).where(eq(kycProfiles.userId, user.id));
  if (!profile) throw new AppError('not_found', 'Verification profile not found');
  const references = profile.submissionId ? [
    `customer:${profile.submissionId}`, `customer-binding:${profile.submissionId}`, `kyc:${profile.submissionId}`,
    ...['front', 'back', 'selfie'].map(role => `upload:${profile.submissionId}:${role}`),
  ] : [];
  const journalRows = references.length ? await db.select({
    reference: upaySubmissions.reference, kind: upaySubmissions.kind, state: upaySubmissions.state,
    hasReceipt: sql<boolean>`${upaySubmissions.partnerReceiptId} is not null`,
    updatedAt: upaySubmissions.updatedAt, evidence: upaySubmissions.evidence,
  }).from(upaySubmissions).where(inArray(upaySubmissions.reference, references)) : [];
  const journal = journalRows.map(({ reference: _reference, evidence, ...entry }) => {
    const diagnostic = submissionDiagnostic(evidence, entry.kind);
    return { ...entry, ...(diagnostic ? { diagnostic } : {}) };
  });
  const queue = await db.execute(sql`select queue, status, count(*)::int as count,
    bool_or(last_error is not null) as error_present
    from jobs where queue in ('kyc.submit','kyc.poll') and payload->>'userId' = ${user.id}
      and (${profile.submissionId}::text is null or payload->>'submissionId' = ${profile.submissionId})
    group by queue, status order by queue, status`);
  let customerBinding: Record<string, unknown> | undefined;
  if (customerProbe && profile.submissionId && profile.email && profile.provider === 'upay') {
    try {
      const page = await customerProbe.readRequest<Record<string, unknown>>('GET', '/customer/list', { query: { pageNo: 1, pageSize: 100, email: profile.email } });
      const rows = Array.isArray(page.list) ? page.list.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
      const exact = rows.filter(item => item.remark === `GUDEX-KYC:${profile.submissionId}`);
      customerBinding = { ok: true, sampledRows: rows.length, exactMarkerMatches: exact.length,
        inputFormat: {
          givenNameMatchesPanel: /^[a-zA-Z][a-zA-Z]{1,49}(?:[-'., ]+[a-zA-Z]{1,50})*$/.test(profile.firstName ?? ''),
          lastNameMatchesPanel: /^[a-zA-Z][a-zA-Z]{1,49}(?:[-'., ]+[a-zA-Z]{1,50})*$/.test(profile.lastName ?? ''),
          phoneMatchesPanel: /^[0-9]{5,13}$/.test(profile.phone ?? ''),
        },
        remarkFieldPresent: rows.some(item => 'remark' in item),
        matches: exact.map(item => ({
          fields: Object.keys(item).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(key)),
          emailExact: String(item.email).toLowerCase() === profile.email!.toLowerCase(),
          givenNameExact: String(item.givenName).toUpperCase() === profile.firstName?.toUpperCase(),
          lastNameExact: String(item.lastName).toUpperCase() === profile.lastName?.toUpperCase(),
          emailMasked: typeof item.email === 'string' && /[*•]/.test(item.email),
          givenNameMasked: typeof item.givenName === 'string' && /[*•]/.test(item.givenName),
          lastNameMasked: typeof item.lastName === 'string' && /[*•]/.test(item.lastName),
          customerNumberPresent: item.no !== undefined || item.customerNo !== undefined,
          customerIdPresent: item.customerId !== undefined,
        })),
      };
      if (exact.length === 1) {
        const item = exact[0]!;
        const customerId = typeof item.customerId === 'string' ? item.customerId :
          typeof item.customerId === 'number' && Number.isSafeInteger(item.customerId) ? String(item.customerId) : null;
        if (customerId && /^[A-Za-z0-9_-]{1,128}$/.test(customerId)) {
          const detail = await customerProbe.readRequest<Record<string, unknown>>('GET', '/customer/get', { query: { customerId } });
          customerBinding.detail = {
            fields: Object.keys(detail).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(key)),
            markerExact: detail.remark === `GUDEX-KYC:${profile.submissionId}`,
            emailExact: String(detail.email).toLowerCase() === profile.email.toLowerCase(),
            givenNameExact: String(detail.givenName).toUpperCase() === profile.firstName?.toUpperCase(),
            lastNameExact: String(detail.lastName).toUpperCase() === profile.lastName?.toUpperCase(),
            customerIdMatches: detail.customerId !== undefined ? String(detail.customerId) === customerId : null,
            customerNumberMatches: detail.no !== undefined && item.no !== undefined ? String(detail.no) === String(item.no) : null,
          };
        }
      }
      // Diagnose a pre-existing row after a local account reset. Observation never binds it.
      if (exact.length === 0 && rows.length === 1) {
        const item = rows[0]!;
        const customerId = typeof item.customerId === 'string' ? item.customerId :
          typeof item.customerId === 'number' && Number.isSafeInteger(item.customerId) ? String(item.customerId) : null;
        if (customerId && /^[A-Za-z0-9_-]{1,128}$/.test(customerId)) {
          const detail = await customerProbe.readRequest<Record<string, unknown>>('GET', '/customer/get', { query: { customerId } });
          customerBinding.existingCustomer = {
            searchComplete: page.totalPages === 1 && page.totalSize === 1,
            emailExact: typeof detail.email === 'string' && detail.email.toLowerCase() === profile.email.toLowerCase(),
            givenNameExact: typeof detail.givenName === 'string' && detail.givenName.toUpperCase() === profile.firstName?.toUpperCase(),
            lastNameExact: typeof detail.lastName === 'string' && detail.lastName.toUpperCase() === profile.lastName?.toUpperCase(),
            phoneExact: typeof detail.phone === 'string' && detail.phone === profile.phone,
            globalCodeExact: typeof detail.globalCode === 'string' && detail.globalCode === profile.globalCode,
            legacyGudexMarker: typeof detail.remark === 'string' && /^GUDEX-KYC:[0-9a-f-]{36}$/i.test(detail.remark),
            currentMarker: detail.remark === `GUDEX-KYC:${profile.submissionId}`,
            customerIdMatches: String(detail.customerId) === customerId,
            customerNumberMatches: detail.no !== undefined && item.no !== undefined ? String(detail.no) === String(item.no) : null,
          };
        }
      }
      if (profile.customerId && productId) {
        const [requirements, product, customerKyc] = await Promise.all([
          customerProbe.readRequest<Record<string, unknown>>('GET', '/card/get/kyc', { query: { customerNo: profile.customerId, agentCardId: productId } }),
          customerProbe.readRequest<Record<string, unknown>>('GET', '/card/getMayApplyCardDetail', { query: { agentCardId: productId } }),
          customerProbe.readRequest<Record<string, unknown>>('GET', '/kyc/info', { query: { customerNo: profile.customerId } }),
        ]);
        const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
        customerBinding.productRequirements = {
          fields: Object.keys(requirements).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(key)),
          requestedDocumentType: profile.documentType,
          documentTypeShape: Array.isArray(requirements.documentType) ? 'array' : typeof requirements.documentType,
          documentTypes: Array.isArray(requirements.documentType) ? requirements.documentType.filter(item =>
            (typeof item === 'number' && Number.isSafeInteger(item)) || (typeof item === 'string' && /^\d{1,2}$/.test(item))) : [],
          needKycLevel: integer(requirements.needKycLevel),
          productKycLevel: integer(product.kycLevel),
          customerKycFields: Object.keys(customerKyc).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(key)),
          customerAuthResult: integer(customerKyc.authResult), customerPrimaryApproved: integer(customerKyc.primaryApprovedNum),
          customerKycItems: Array.isArray(customerKyc.items) ? customerKyc.items.filter(item => Boolean(item && typeof item === 'object')).map(item => {
            const row = item as Record<string, unknown>;
            return { fields: Object.keys(row).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(key)),
              documentType: integer(row.documentType), status: integer(row.status), state: integer(row.state), level: integer(row.level) };
          }) : [],
        };
        const documentType = profile.documentType === 'id_card' ? 1 : profile.documentType === 'passport' ? 2 : null;
        const currentReceipt = journalRows.find(entry => entry.reference === `kyc:${profile.submissionId}` && entry.kind === 'kyc');
        const receiptEvidence: Record<string, string | number | boolean | null> = {};
        const observedEvidence = row(currentReceipt?.evidence);
        for (const key of ['kycProtocol', 'customerNo', 'documentType', 'nationalityCodeHash', 'documentFrontHash', 'documentBackHash']) {
          const value = observedEvidence?.[key];
          if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') receiptEvidence[key] = value;
        }
        customerBinding.primaryReceipt = currentReceipt && documentType !== null
          ? inspectPrimaryReceipt(customerKyc, { evidence: receiptEvidence }, documentType) : null;
        customerBinding.primaryCardMirror = currentReceipt && documentType !== null
          ? inspectPrimaryCardMirror(requirements, { evidence: receiptEvidence }, documentType, profile.customerId) : null;
        customerBinding.primaryCardCountry = null;
        if (currentReceipt && documentType !== null) {
          let countries: unknown = null;
          try {
            countries = await customerProbe.readRequest<unknown>('GET', '/common/countryAndRegion', { query: { level: 2 } });
          } catch { /* Country lookup failure must not hide other receipt or form diagnostics. */ }
          customerBinding.primaryCardCountry = primaryCardCountry(countries, requirements, profile.documentCountry, receiptEvidence, documentType);
        }
        let feeForm: unknown = null;
        try {
          feeForm = await customerProbe.readRequest<unknown>('GET', '/card/getCardFee', { query: { agentCardId: productId, customerNo: profile.customerId } });
        } catch { /* Preserve other read-only diagnostics when the fee form is unavailable. */ }
        customerBinding.issuanceReadiness = issuanceReadiness(product, feeForm, profile.customerId, productId, documentType);
      }
    } catch (error) { customerBinding = { ok: false, ...(error instanceof UpayError && error.code !== undefined ? { code: error.code } : {}) }; }
  }
  return {
    remoteMutationsPerformed: false,
    status: profile.status, submissionState: profile.submissionState, provider: profile.provider,
    customerLinked: Boolean(profile.customerId), submissionRecorded: Boolean(profile.submissionId),
    submittedAt: profile.submittedAt, documentsSubmittedAt: profile.documentsSubmittedAt,
    reviewedAt: profile.reviewedAt, updatedAt: profile.updatedAt, journal, jobs: queue.rows,
    ...(customerBinding ? { customerBinding } : {}),
  };
}
