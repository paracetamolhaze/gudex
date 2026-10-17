import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray, lte } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import { kycDocuments, users } from '../db/schema';
import { AppError } from '../lib/errors';
import { enqueue } from '../queue/queue';

export type KycDocumentKind = 'front' | 'back' | 'selfie';
export type KycImageMime = 'image/jpeg' | 'image/png';
export interface KycDocumentUpload { kind: KycDocumentKind; mimeType: KycImageMime; base64: string; clientDocumentId?: string; }
export interface KycDocumentMetadata { id: string; kind: KycDocumentKind; mimeType: KycImageMime; size: number; expiresAt: string; }
export interface KycStoredDocument extends KycDocumentMetadata { bytes: Buffer; remoteUri?: string; }
export type KycDocumentIds = { front: string; back?: string; selfie?: string };
export const MAX_KYC_UPLOAD_BYTES = 2 * 1024 * 1024;
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_ACTIVE_DOCUMENTS = 6;

export function validateKycDocumentUpload(input: KycDocumentUpload): { bytes: Buffer; mimeType: KycImageMime } {
  if (!['front', 'back', 'selfie'].includes(input.kind)) throw new AppError('validation', 'Invalid document kind');
  const maxEncodedLength = Math.ceil(MAX_KYC_UPLOAD_BYTES / 3) * 4;
  if (!input.base64 || input.base64.length > maxEncodedLength) throw new AppError('validation', 'Each image must be at most 2 MiB');
  if (input.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)) {
    throw new AppError('validation', 'Invalid base64 image');
  }
  const bytes = Buffer.from(input.base64, 'base64');
  if (bytes.toString('base64') !== input.base64) throw new AppError('validation', 'Invalid base64 image');
  if (bytes.length > MAX_KYC_UPLOAD_BYTES) throw new AppError('validation', 'Each image must be at most 2 MiB');
  const mimeType = bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_HEADER) ? 'image/png'
    : bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : null;
  if (!mimeType) throw new AppError('validation', 'Only JPEG or PNG image contents are supported');
  if (mimeType !== input.mimeType) throw new AppError('validation', 'Image MIME does not match its contents');
  return { bytes, mimeType };
}

// No public URLs or plaintext image bytes are persisted. Provider file references are encrypted too.
export class DbKycDocumentStore {
  private readonly key: Buffer;
  constructor(private readonly db: Db, appSecret: string, private readonly ttlSeconds = 86400) {
    this.key = createHmac('sha256', appSecret).update('gudex:kyc-documents:v1').digest();
  }

  async put(userId: string, input: KycDocumentUpload): Promise<KycDocumentMetadata> {
    const { bytes, mimeType } = validateKycDocumentUpload(input);
    const id = input.clientDocumentId ?? randomUUID();
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);
    const envelope = this.encrypt(userId, id, { data: bytes.toString('base64') });
    return this.db.transaction(async tx => {
      const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      if (!user) throw new AppError('unauthorized', 'User not found');
      const [existing] = await tx.select().from(kycDocuments).where(eq(kycDocuments.id, id));
      if (existing) {
        if (existing.userId !== userId || existing.kind !== input.kind || existing.mimeType !== mimeType) {
          throw new AppError('validation', 'Upload reference belongs to a different document');
        }
        const prior = await this.getOwned(userId, id, input.kind, tx);
        if (!prior.bytes.equals(bytes)) throw new AppError('validation', 'Upload reference belongs to a different document');
        return { id, kind: prior.kind, mimeType: prior.mimeType, size: prior.size, expiresAt: prior.expiresAt };
      }
      await tx.delete(kycDocuments).where(and(eq(kycDocuments.userId, userId), lte(kycDocuments.expiresAt, new Date())));
      const active = await tx.select({ id: kycDocuments.id }).from(kycDocuments).where(eq(kycDocuments.userId, userId));
      if (active.length >= MAX_ACTIVE_DOCUMENTS) throw new AppError('validation', 'Too many staged documents; remove unused photos before uploading');
      await tx.insert(kycDocuments).values({ id, userId, kind: input.kind, mimeType, size: bytes.length, ...envelope, expiresAt });
      await enqueue(tx, 'kyc.cleanup', {}, { runAt: expiresAt, dedupeKey: `kyc.cleanup:${id}` });
      return { id, kind: input.kind, mimeType, size: bytes.length, expiresAt: expiresAt.toISOString() };
    });
  }

  async getOwned(userId: string, id: string, expectedKind?: KycDocumentKind, db: DbOrTx = this.db): Promise<KycStoredDocument> {
    const [row] = await db.select().from(kycDocuments).where(and(eq(kycDocuments.id, id), eq(kycDocuments.userId, userId)));
    if (!row || row.expiresAt <= new Date() || (expectedKind && row.kind !== expectedKind)) {
      throw new AppError('validation', 'Document is missing, expired or belongs to a different upload slot');
    }
    try {
      const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv, 'base64'));
      cipher.setAAD(Buffer.from(`${userId}:${id}`));
      cipher.setAuthTag(Buffer.from(row.tag, 'base64'));
      const payload = JSON.parse(Buffer.concat([cipher.update(Buffer.from(row.ciphertext, 'base64')), cipher.final()]).toString('utf8')) as { data: string; remoteUri?: string };
      const validated = validateKycDocumentUpload({ kind: row.kind as KycDocumentKind, mimeType: row.mimeType as KycImageMime, base64: payload.data });
      return { id, kind: row.kind as KycDocumentKind, mimeType: validated.mimeType, size: validated.bytes.length,
        bytes: validated.bytes, expiresAt: row.expiresAt.toISOString(), remoteUri: payload.remoteUri };
    } catch {
      throw new AppError('validation', 'Document cannot be read; upload a new photo');
    }
  }

  async markUploaded(userId: string, id: string, remoteUri: string): Promise<void> {
    if (!remoteUri || remoteUri.length > 2048) throw new AppError('validation', 'Invalid provider file receipt');
    const image = await this.getOwned(userId, id);
    const envelope = this.encrypt(userId, id, { data: image.bytes.toString('base64'), remoteUri });
    await this.db.update(kycDocuments).set(envelope).where(and(eq(kycDocuments.id, id), eq(kycDocuments.userId, userId)));
  }

  async removeOwned(userId: string, ids: string[], db: DbOrTx = this.db): Promise<void> {
    if (ids.length) await db.delete(kycDocuments).where(and(eq(kycDocuments.userId, userId), inArray(kycDocuments.id, ids)));
  }

  async deleteExpired(): Promise<void> {
    await this.db.delete(kycDocuments).where(lte(kycDocuments.expiresAt, new Date()));
  }

  private encrypt(userId: string, id: string, payload: { data: string; remoteUri?: string }): { iv: string; tag: string; ciphertext: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${userId}:${id}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  }
}
