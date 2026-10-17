import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../lib/errors';

export const ADDITIONAL_ISSUE_TELEGRAM_ID = 514468501n;
export const ADDITIONAL_ISSUE_ORIGINAL_ID = '82c68578-6791-463f-9c6d-edbd4407a8ff';
export const ADDITIONAL_ISSUE_TERMS = 'additional-issue-v1' as const;
const QUOTE_TTL_MS = 5 * 60_000;
export interface AdditionalIssueSnapshot {
  userId: string; authVersion: number; kycHash: string; originalHash: string; productId: string; feeUsd: string;
}
interface SignedQuote extends AdditionalIssueSnapshot { purpose: typeof ADDITIONAL_ISSUE_TERMS; issuedAt: number; expiresAt: number; nonce: string; }
const invalid = () => new AppError('validation', 'The additional issuance quote expired or changed; review it and explicitly confirm again');
const signature = (secret: string, body: string) => createHmac('sha256', secret).update('gudex:additional-issue-quote:v1:').update(body).digest();
export function signAdditionalIssueQuote(secret: string, snapshot: AdditionalIssueSnapshot, now = Date.now()): { token: string; expiresAt: string } {
  const quote: SignedQuote = { ...snapshot, purpose: ADDITIONAL_ISSUE_TERMS, issuedAt: now, expiresAt: now + QUOTE_TTL_MS, nonce: randomBytes(16).toString('hex') };
  const body = Buffer.from(JSON.stringify(quote)).toString('base64url');
  return { token: `${body}.${signature(secret, body).toString('base64url')}`, expiresAt: new Date(quote.expiresAt).toISOString() };
}
export function verifyAdditionalIssueQuote(secret: string, token: string, now = Date.now()): AdditionalIssueSnapshot {
  try {
    if (typeof token !== 'string' || token.length > 4096) throw invalid();
    const parts = token.split('.');
    if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw invalid();
    const expected = signature(secret, parts[0]!);
    const provided = Buffer.from(parts[1]!, 'base64url');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw invalid();
    const data = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as SignedQuote;
    if (data.purpose !== ADDITIONAL_ISSUE_TERMS || !Number.isSafeInteger(data.issuedAt) || !Number.isSafeInteger(data.expiresAt)
      || data.expiresAt - data.issuedAt !== QUOTE_TTL_MS || data.issuedAt > now || data.expiresAt <= now
      || typeof data.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(data.nonce)
      || !Number.isSafeInteger(data.authVersion) || data.authVersion < 0
      || ![data.userId, data.productId, data.feeUsd].every(value => typeof value === 'string' && value.length > 0 && value.length <= 128)
      || ![data.kycHash, data.originalHash].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) throw invalid();
    return { userId: data.userId, authVersion: data.authVersion, kycHash: data.kycHash, originalHash: data.originalHash, productId: data.productId, feeUsd: data.feeUsd };
  } catch { throw invalid(); }
}
