import type { CardApplicationDto, CardBillingAddressInput, KycDocumentDto, KycDto, WalletAsset } from '@gudex/shared';
import { ApiError, request } from './api';

export type KycDocumentType = 'passport' | 'id_card' | 'driving_license';
export type KycDocumentKind = 'front' | 'back' | 'selfie';
export type KycImageError = 'fileType' | 'fileSize' | 'fileContent';

export interface KycSubmission {
  firstName: string;
  lastName: string;
  birthDate: string;
  citizenship: string;
  phone?: string;
  globalCode?: string;
  documentType?: KycDocumentType;
  documentCountry?: string;
  documents?: Partial<Record<KycDocumentKind, File>>;
}

// Keep upload bodies below the serverless request limit, including Base64 overhead.
export const KYC_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
export type KycUploadCache = Map<KycDocumentKind, { file: File; clientDocumentId: string; document?: KycDocumentDto }>;

export function kycApplicantValidity(value: Pick<KycSubmission, 'firstName' | 'lastName' | 'phone' | 'globalCode'>, live: boolean) {
  const name = live ? /^[A-Za-z][A-Za-z ]{0,48}$/ : /^[A-Za-z][A-Za-z '-]{0,48}$/;
  const phone = value.phone ?? '';
  const dial = value.globalCode ?? '';
  return { first: name.test(value.firstName.trim()), last: name.test(value.lastName.trim()),
    phone: /^\+\d{1,4}$/.test(dial) && /^\d{7,13}$/.test(phone) && dial.length - 1 + phone.length <= 15 &&
      (dial !== '+86' || /^1[3-9][0-9]{9}$/.test(phone)) };
}

function randomDocumentId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isKycBirthDateEligible(iso: string, now = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const birthDate = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(birthDate.getTime()) || birthDate.toISOString().slice(0, 10) !== iso) return false;
  let age = now.getUTCFullYear() - birthDate.getUTCFullYear();
  if (now.getUTCMonth() < birthDate.getUTCMonth() || (now.getUTCMonth() === birthDate.getUTCMonth() && now.getUTCDate() < birthDate.getUTCDate())) age--;
  return age >= 18 && age < 120;
}

export async function validateKycImage(file: File, maxBytes: number): Promise<KycImageError | null> {
  if (file.size === 0 || file.size > Math.min(maxBytes, KYC_UPLOAD_MAX_BYTES)) return 'fileSize';
  if (file.type !== 'image/jpeg' && file.type !== 'image/png') return 'fileType';
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const jpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => header[index] === byte);
  return (file.type === 'image/jpeg' ? jpeg : png) ? null : 'fileContent';
}

// Photos remain in memory only; encode one file at a time immediately before upload.
export async function kycImageBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(''));
}
export async function sendKycSubmission({ documents, ...body }: KycSubmission, uploads: KycUploadCache = new Map()): Promise<KycDto> {
  const documentIds = await uploadKycDocuments({ documents, ...body }, uploads);
  return request<KycDto>('/v1/kyc', { method: 'POST', body: { ...body, ...(documents ? { documentIds } : {}) } });
}

export interface CardApplicationSubmission {
  kyc: KycSubmission;
  billing: CardBillingAddressInput;
  asset: WalletAsset;
  idempotencyKey: string;
  expectedFundingSource?: 'wallet' | 'broker';
  expectedCustomerCharge?: string;
}

// Manual issuance: photos first, then one request saves the questionnaire, address and reserved fee together.
export async function sendCardApplication({ kyc: { documents, ...kyc }, ...rest }: CardApplicationSubmission, uploads: KycUploadCache = new Map()): Promise<CardApplicationDto> {
  const documentIds = await uploadKycDocuments({ documents, ...kyc }, uploads);
  return request<CardApplicationDto>('/v1/card-application', { method: 'POST', body: { ...rest, kyc: { ...kyc, documentIds } } });
}

async function uploadKycDocuments({ documents, ...body }: KycSubmission, uploads: KycUploadCache): Promise<Partial<Record<KycDocumentKind, string>>> {
  const kinds = ['front', 'back', 'selfie'] as const;
  if (!isKycBirthDateEligible(body.birthDate)) throw new ApiError('validation', 'Verification requires an eligible date of birth', 400);
  const live = body.phone !== undefined || body.globalCode !== undefined;
  const valid = kycApplicantValidity(body, live);
  if (!valid.first || !valid.last || (live && !valid.phone)) throw new ApiError('validation', 'Check applicant contact details', 400);
  // Validate every selected file before the first upload; the API validates them again.
  for (const kind of kinds) {
    const file = documents?.[kind];
    if (file && await validateKycImage(file, KYC_UPLOAD_MAX_BYTES)) throw new ApiError('validation', 'Invalid verification image', 400);
  }
  // Reuse successful stages after a failed submit; replace stale photos only on the next explicit submission.
  for (const [kind, cached] of uploads) {
    const expiresAt = cached.document ? new Date(cached.document.expiresAt).getTime() : null;
    if (cached.file === documents?.[kind] && (expiresAt === null || expiresAt > Date.now())) continue;
    if (expiresAt === null || expiresAt > Date.now()) await request(`/v1/kyc/documents/${cached.clientDocumentId}`, { method: 'DELETE' });
    uploads.delete(kind);
  }
  const documentIds: Partial<Record<KycDocumentKind, string>> = {};
  for (const kind of kinds) {
    const file = documents?.[kind];
    if (!file) continue;
    let cached = uploads.get(kind);
    if (!cached) {
      cached = { file, clientDocumentId: randomDocumentId() };
      uploads.set(kind, cached);
    }
    let uploaded = cached.document;
    if (!uploaded) {
      uploaded = await request<KycDocumentDto>('/v1/kyc/documents', {
        method: 'POST', body: { clientDocumentId: cached.clientDocumentId, kind, mimeType: file.type, base64: await kycImageBase64(file) },
      });
      if (uploaded?.id !== cached.clientDocumentId || uploaded.kind !== kind || !(new Date(uploaded.expiresAt).getTime() > Date.now())) {
        throw new ApiError('internal', 'Invalid verification upload receipt', 500);
      }
      cached.document = uploaded;
    }
    documentIds[kind] = uploaded.id;
  }
  return documentIds;
}
