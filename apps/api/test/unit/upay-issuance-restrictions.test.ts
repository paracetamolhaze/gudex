import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config';
import { PartnerCardRegionRestrictedError, PartnerError } from '../../src/partner/types';
import { UpayFinancialPartner } from '../../src/partner/upay/financial-partner';
import { assertBillingCallingCodeAllowed } from '../../src/partner/upay/issuance-restrictions';
import { MemoryUpaySubmissionStore } from '../../src/partner/upay/submissions';

// Public product policy from the fixed GET on 2026-10-16. No customer data.
const OBSERVED_POLICY = '+93,+263,+961,+218,+960,+223,+968,+880,+95,+373,+212,+977,+505,+227,+20,+381,+357,+251,+966,+1-869,+94,+249,+597,+252,+992,+216,+90,+678,+502,+58,+380,+64,+963,+374,+967,+964,+98,+972,+91,+236,+852,+853,+382,+92,+55,+375,+387,+975,+257,+85,+7,+243,+355,+53,+509,+213,+996,+224,+245,+86';

describe('UPay billing calling-code restrictions before issuance', () => {
  it('rejects an exact restricted owned billing prefix using the whole observed policy, including its hyphenated entry', () => {
    expect(() => assertBillingCallingCodeAllowed('+7', OBSERVED_POLICY)).toThrow(PartnerCardRegionRestrictedError);
    expect(() => assertBillingCallingCodeAllowed('+33', OBSERVED_POLICY)).not.toThrow();
  });

  it('normalizes the native hyphen within a calling-code token without broadening it to the parent dial code', () => {
    expect(() => assertBillingCallingCodeAllowed('+1869', '+1-869')).toThrow(PartnerCardRegionRestrictedError);
    expect(() => assertBillingCallingCodeAllowed('+1-869', '+1-869')).toThrow(PartnerCardRegionRestrictedError);
    expect(() => assertBillingCallingCodeAllowed('+1', '+1-869')).not.toThrow();
    expect(() => assertBillingCallingCodeAllowed('+74', '+7')).not.toThrow();
  });

  it.each([undefined, null, '', '   '])('preserves compatibility when no calling-code policy exists: %j', policy => {
    expect(() => assertBillingCallingCodeAllowed('+7', policy)).not.toThrow();
  });

  it.each([{}, ['+7'], 7, '+7,', '7', '+07', '+1--869', '{"codes":["+7"]}', 'opaque-policy'])('fails closed on an unknown policy format without inventing a restriction match: %j', policy => {
    let error: unknown;
    try { assertBillingCallingCodeAllowed('+7', policy); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(PartnerError);
    expect(error).not.toBeInstanceOf(PartnerCardRegionRestrictedError);
  });

  it('uses the exact current product policy at the owned-billing preflight seam before any financial request', async () => {
    const submitRequest = vi.fn(async () => { throw new Error('No external writes in this fixture'); });
    const billing = { getVerifiedAddressId: vi.fn(async (customerNo: string, policy?: unknown) => {
      expect(customerNo).toBe('fixture-own-customer');
      assertBillingCallingCodeAllowed('+7', policy);
      return 'fixture-owned-address';
    }) };
    const client = { configured: true, submitRequest, readRequest: vi.fn(async (_method: string, endpoint: string) => {
      if (endpoint === '/card/getMayApplyCardDetail') return { openFee: '10', defaultOpenAmount: '0', rechargeCurrency: 'USDT', currency: 'USD', restrictedCallingCode: OBSERVED_POLICY };
      if (endpoint === '/card/getCardFee') return { customerNo: 'fixture-own-customer', requiredInfo: true, addressType: '3', addressId: null, needParams: ['lastName', 'givenName', 'documentType'], givenName: 'Fixture', lastName: 'Person' };
      throw new Error('Unexpected read');
    }) };
    const journal = new MemoryUpaySubmissionStore();
    const partner = new UpayFinancialPartner({ UPAY_WRITES_ENABLED: true, UPAY_PAYMENT_PASSWORD: '123456', UPAY_PRODUCT_ID: 'fixture-product' } as Config,
      client as never, journal, { getKycStatus: async () => ({ status: 'approved' }), getDocumentType: async () => 1 } as never, billing);
    await expect(partner.validateIssue({ partnerCustomerId: 'fixture-own-customer', maxFeeUsd: 1000n })).rejects.toBeInstanceOf(PartnerCardRegionRestrictedError);
    expect(billing.getVerifiedAddressId).toHaveBeenCalledWith('fixture-own-customer', OBSERVED_POLICY);
    expect(submitRequest).not.toHaveBeenCalled();
    expect(await journal.get('fixture-reference')).toBeNull();
  });
});
