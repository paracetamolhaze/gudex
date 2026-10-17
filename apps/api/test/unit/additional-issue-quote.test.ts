import { describe, expect, it } from 'vitest';
import { signAdditionalIssueQuote, verifyAdditionalIssueQuote } from '../../src/services/additional-issue-quote';

const secret = 'local-fixture-quote-secret';
const snapshot = { userId: 'fixture-user', authVersion: 2, kycHash: 'a'.repeat(64), originalHash: 'b'.repeat(64), productId: 'fixture-product', feeUsd: '1000' };
describe('explicit additional issuance quote integrity and freshness', () => {
  it('authenticates the exact user, KYC, original state, product and amount snapshot for five minutes', () => {
    const quote = signAdditionalIssueQuote(secret, snapshot, 1_000_000);
    expect(verifyAdditionalIssueQuote(secret, quote.token, 1_299_999)).toEqual(snapshot);
    expect(() => verifyAdditionalIssueQuote(secret, quote.token, 1_300_000)).toThrow('expired');
  });
  it('rejects another signing key, a modified fee/user and a future-dated quote', () => {
    const quote = signAdditionalIssueQuote(secret, snapshot, 1_000_000);
    expect(() => verifyAdditionalIssueQuote('wrong-key', quote.token, 1_000_001)).toThrow('expired');
    const [body, signature] = quote.token.split('.');
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'));
    payload.feeUsd = '0'; payload.userId = 'another-user';
    expect(() => verifyAdditionalIssueQuote(secret, `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`, 1_000_001)).toThrow('expired');
    expect(() => verifyAdditionalIssueQuote(secret, quote.token, 999_999)).toThrow('expired');
  });
});
