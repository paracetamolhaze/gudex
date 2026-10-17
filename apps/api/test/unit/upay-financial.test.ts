import { createHash, webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../src/config';
import { PartnerError, PartnerPendingError } from '../../src/partner/types';
import { UpayClient } from '../../src/partner/upay/client';
import type { UpaySession, UpaySessionStore } from '../../src/partner/upay/session-store';
import { UpayFinancialPartner, UpayNotDispatchedError } from '../../src/partner/upay/financial-partner';
import { encryptPaymentPin, issuancePayload, minimumRechargeNet, rechargeQuote } from '../../src/partner/upay/financial-protocol';
import { MemoryUpaySubmissionStore } from '../../src/partner/upay/submissions';
import { UpayError, UpayTransport } from '../../src/partner/upay/transport';

// Synthetic fixtures for the observed public SPA field contracts; never a live partner call.
const config = { UPAY_WRITES_ENABLED: true, UPAY_PAYMENT_PASSWORD: '123456', UPAY_PRODUCT_ID: 'product-1' } as Config;
const info = { id: 'bot-fixture', iv: '123456789012', pinCodeSet: true };
const recharge = { minRechargeAmount: '10', maxRechargeAmount: '1000', rechargeRate: '0.7', executeExchangeRate: '1', rechargeCurrency: 'USDT', cardCurrency: 'USD' };
const detail = { customerNo: 'customer-1', agentCardId: 'product-1', agentCustomerCardId: 'card-1', accountCardId: 'account-1', brokerCardId: 'broker-1', cardStatus: 1 };
const issueReceipt = (orderNo: string, overrides: Record<string, unknown> = {}) => ({ orderNo, status: 1, customerNo: 'customer-1', cardId: 'broker-1',
  currency: 'USDT', openCardAmount: '10.00', rechargeAmount: '0.00', paymentAmount: '10.00', ...overrides });
async function encrypted(value: string): Promise<string> {
  const keyBytes = new TextEncoder().encode(createHash('md5').update('account-1broker-manage').digest('hex'));
  const key = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  return Buffer.from(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: new TextEncoder().encode(info.iv) }, key, new TextEncoder().encode(value))).toString('base64');
}
async function setup() {
  const journal = new MemoryUpaySubmissionStore();
  const loginInfo = { ...info };
  const card = { ...detail, cardNumber: await encrypted('4000000000001234'), cvv: await encrypted('123'), expirationTime: await encrypted('12/29'), cardSignatureName: 'TEST HOLDER' };
  const requests: { endpoint: string; body: Record<string, unknown> }[] = [];
  let receipt: Record<string, unknown> | null = null;
  let response: unknown = {};
  let feeForm: Record<string, unknown> = { customerNo: 'customer-1', needParams: [], defaultType: 1, email: 'fixture@example.test' };
  let documentType: 1 | 2 = 1;
  let timeout = false;
  let submitError: Error | undefined;
  const client = {
    configured: true,
    loginInfo: async () => loginInfo,
    readRequest: async (_method: string, endpoint: string) => {
      if (endpoint === '/card/getMayApplyCardDetail') return { openFee: '10', defaultOpenAmount: '0', rechargeCurrency: 'USDT', cardCurrency: null, currency: 'USD' };
      if (endpoint === '/card/getCardFee') return feeForm;
      if (endpoint === '/card/getRechargeCardInfo') return recharge;
      if (endpoint === '/card/getAgentCustomerCardDetail') return card;
      if (endpoint === '/card/getPageToCardOperateRecord') return { pageNo: 1, totalPages: 1, list: receipt ? [receipt] : [] };
      if (endpoint === '/card/getPageToTransaction') return { pageNo: 1, totalPages: 1, list: [] };
      if (endpoint === '/card/list') return { pageNo: 1, totalPages: 1, list: [card] };
      throw new Error(`unexpected fixture read ${endpoint}`);
    },
    submitRequest: async (endpoint: string, body: Record<string, unknown>) => {
      requests.push({ endpoint, body });
      if (submitError) throw submitError;
      if (timeout) throw new Error('fixture lost response after dispatch');
      return response;
    },
  } as unknown as UpayClient;
  const kyc = { assertReady: () => {}, createCustomer: async () => 'customer-1', getKycStatus: async () => ({ status: 'approved' as const }),
    getKycRequirements: async () => ({ selfieRequired: false, documentTypes: ['id_card' as const, 'passport' as const] }),
    reconcileKycSubmission: async () => null, getDocumentType: async () => documentType };
  return { journal, card, client, kyc, loginInfo, partner: new UpayFinancialPartner(config, client, journal, kyc), requests,
    setResponse: (value: unknown) => { response = value; }, setReceipt: (value: Record<string, unknown>) => { receipt = value; }, setTimeout: () => { timeout = true; },
    setSubmitError: (value: Error) => { submitError = value; },
    setFeeForm: (value: Record<string, unknown>) => { feeForm = value; }, setDocumentType: (value: 1 | 2) => { documentType = value; } };
}

async function dispatchBoundary(outcome: 'auth' | 'before_dispatch' | 'before_client' | 'timeout' | 'rejected' | 'billing_region') {
  const f = await setup();
  const actualConfig = loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'financial-boundary-fixture-key', UPAY_WRITES_ENABLED: 'true',
    UPAY_PAYMENT_PASSWORD: '123456', UPAY_PRODUCT_ID: 'product-1', UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture',
    UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' });
  let session: UpaySession | null = null, tail: Promise<unknown> = Promise.resolve(), guards = 0, rejectLogin = false;
  const completedQuoteReads = new Set<string>();
  let financialAuthentication = false;
  const store: UpaySessionStore = { withLock: fn => {
    const result = tail.then(() => fn({ get: async () => {
      // Invalidate only after quote + PIN-info preflight has completed. The client
      // must refuse a financial dispatch; its new login cooldown also forbids an
      // immediate second login for the invalidated session.
      if (outcome === 'auth' && financialAuthentication) { session = null; rejectLogin = true; }
      return session;
    }, set: async value => { session = value; } }));
    tail = result.catch(() => {}); return result;
  } };
  const requests: { method: string; path: string }[] = [];
  const transport = new UpayTransport({ baseUrl: actualConfig.UPAY_BASE_URL, deviceId: 'fixture', timeoutMs: 1000,
    fetch: async (url, options) => {
      const path = new URL(String(url)).pathname.replace('/api/v1', '');
      requests.push({ method: options?.method ?? 'GET', path });
      const ok = (data: unknown) => Response.json({ code: 200, data });
      if (path === '/sys/member/login') return rejectLogin ? Response.json({ code: 10003, msg: 'PRIVATE identity or credential' }) : ok({ token: 'PRIVATE-fixture-token', googleState: 1 });
      if (path === '/sys/member/validateGoogle') return ok({});
      if (path === '/sys/member/loginInfo') { if (completedQuoteReads.size === 2) financialAuthentication = true; return ok(info); }
      if (path === '/card/getMayApplyCardDetail') { completedQuoteReads.add(path); return ok({ openFee: '10', defaultOpenAmount: '0', rechargeCurrency: 'USDT', currency: 'USD' }); }
      if (path === '/card/getCardFee') { completedQuoteReads.add(path); return ok({ customerNo: 'customer-1', defaultType: 1, needParams: [] }); }
      if (path === '/card/applyOpenCard') {
        if (outcome === 'timeout') throw new Error('PRIVATE network failure');
        if (outcome === 'billing_region') return Response.json({ code: 987654, msg: "The mobile phone area code of the customer's billing address is restricted!", data: { phone: 'PRIVATE-phone', pinCode: 'PRIVATE-pin' } });
        return Response.json({ code: 10003, msg: 'PRIVATE business response' });
      }
      throw new Error('Unexpected fixture endpoint');
    } });
  const client = new UpayClient(actualConfig, store, transport);
  const partner = new UpayFinancialPartner(actualConfig, client, f.journal, f.kyc);
  const beforeSubmit = async () => {
    guards++;
    if (outcome === 'before_client' && guards === 1 || outcome === 'before_dispatch' && guards === 2) throw new Error('PRIVATE expired lease');
  };
  return { ...f, partner, client, actualConfig, requests, beforeSubmit };
}

describe('UPay financial protocol', () => {
  it.each([{ givenName: 'ANNE-MARIE', lastName: 'TEST' }, { givenName: 'TEST', lastName: "O'NEIL" }])
    ('rejects the same required cardholder names as the native form before a financial POST', name => {
      expect(() => issuancePayload({ openFee: '10', defaultOpenAmount: '0', rechargeCurrency: 'USDT', currency: 'USD' },
        { ...name, documentType: 1, requiredInfo: true, needParams: ['givenName', 'lastName', 'documentType'] }, 'customer-1', 'product-1', 1000n)).toThrow('Latin letters and spaces');
    });

  it('validates a rendered mandatory contact using native national phone rules before a financial POST', () => {
    const product = { openFee: '10', defaultOpenAmount: '0', rechargeCurrency: 'USDT', currency: 'USD', isNeedBindPhone: true, isNeedBindEmail: true };
    const form = { defaultType: 1, needParams: [], requiredInfo: true, phone: '12345678901234', globalCode: '+7', email: 'fixture@example.test' };
    expect(() => issuancePayload(product, form, 'customer-1', 'product-1', 1000n)).toThrow('national phone');
    expect(issuancePayload(product, { ...form, phone: '1234567890123' }, 'customer-1', 'product-1', 1000n).payload).toMatchObject({ phone: '1234567890123', globalCode: '+7' });
  });

  it('sends the currently verified document type instead of a stale fee-form default', async () => {
    const f = await setup();
    f.setFeeForm({ defaultType: 2, documentType: 2, needParams: ['documentType'] });
    f.setDocumentType(1);
    await f.partner.issueCard({ externalRef: 'verified-type-over-default', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n }).catch(() => {});
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.body).toMatchObject({ defaultType: 2, documentType: 1 });
  });

  it('mirrors native user selection priority without rewriting the fee-form default', () => {
    const form = { defaultType: 2, documentType: 1, needParams: ['documentType'] };
    expect(issuancePayload({ openFee: '10', defaultOpenAmount: '0', rechargeCurrency: 'USDT', currency: 'USD' }, form,
      'customer-1', 'product-1', 1000n).payload).toMatchObject({ defaultType: 2, documentType: 1 });
    expect(form).toEqual({ defaultType: 2, documentType: 1, needParams: ['documentType'] });
  });

  it('does not use an unverified nonnull default document type when the local document binding is unavailable', async () => {
    const f = await setup();
    const { getDocumentType: _unused, ...kyc } = f.kyc;
    const partner = new UpayFinancialPartner(config, f.client, f.journal, kyc);
    await expect(partner.issueCard({ externalRef: 'missing-verified-doc', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n })).rejects.toThrow('verified KYC document type');
    expect(f.requests).toHaveLength(0);
    expect(await f.journal.get('missing-verified-doc')).toBeNull();
  });

  it.each(['auth', 'before_dispatch', 'before_client'] as const)('persists a refundable non-dispatch proof after %s, with no financial POST or replay', async outcome => {
    const f = await dispatchBoundary(outcome);
    const input = { externalRef: `unsent-${outcome}`, partnerCustomerId: 'customer-1', maxFeeUsd: 1000n, beforeSubmit: f.beforeSubmit };
    await expect(f.partner.issueCard(input)).rejects.toMatchObject({ retryable: false, message: 'UPay submission was not sent' });
    const proof = await f.journal.get(input.externalRef);
    expect(proof).toMatchObject({ state: 'rejected', partnerReceiptId: null, partnerCardId: null,
      evidence: { step: 'card_issue', dispatchPhase: 'pre_dispatch', responseAck: 'unconfirmed' } });
    expect(f.requests.some(request => request.path === '/card/applyOpenCard')).toBe(false);
    if (outcome === 'auth') expect(f.requests.filter(request => request.path === '/sys/member/login')).toHaveLength(1);
    const requests = structuredClone(f.requests);
    const restarted = new UpayFinancialPartner(f.actualConfig, f.client, f.journal, f.kyc);
    for (const partner of [f.partner, restarted]) {
      await expect(partner.issueCard(input)).rejects.toMatchObject({ retryable: false, message: 'UPay submission was not sent' });
      await expect(partner.findCardByExternalRef(input.externalRef)).rejects.toMatchObject({ retryable: false, message: 'UPay submission was not sent' });
      await expect(partner.findCardByExternalRef(input.externalRef)).rejects.toBeInstanceOf(UpayNotDispatchedError);
    }
    expect(f.requests).toEqual(requests); expect(await f.journal.get(input.externalRef)).toEqual(proof);
    expect(JSON.stringify(proof)).not.toContain('PRIVATE');
  });
  it.each(['timeout', 'rejected'] as const)('keeps an actual post-dispatch %s unknown and never replays it', async outcome => {
    const f = await dispatchBoundary(outcome);
    const input = { externalRef: `dispatched-${outcome}`, partnerCustomerId: 'customer-1', maxFeeUsd: 1000n, beforeSubmit: f.beforeSubmit };
    await expect(f.partner.issueCard(input)).rejects.toMatchObject({ retryable: true });
    const journal = await f.journal.get(input.externalRef);
    expect(journal).toMatchObject({ state: 'unknown', evidence: { dispatchPhase: 'post_dispatched', responseAck: outcome === 'timeout' ? 'unconfirmed' : 'rejected_envelope' } });
    expect(f.requests.filter(request => request.path === '/card/applyOpenCard')).toHaveLength(1);
    const restarted = new UpayFinancialPartner(f.actualConfig, f.client, f.journal, f.kyc);
    await expect(restarted.issueCard(input)).rejects.toMatchObject({ retryable: true });
    expect(f.requests.filter(request => request.path === '/card/applyOpenCard')).toHaveLength(1);
    expect(await f.journal.get(input.externalRef)).toEqual(journal); expect(JSON.stringify(journal)).not.toContain('PRIVATE');
  });
  it('retains only the closed billing phone-region category through the real client while preserving unknown and no replay', async () => {
    const f = await dispatchBoundary('billing_region');
    const input = { externalRef: 'billing-region-restriction', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n, beforeSubmit: f.beforeSubmit };
    await expect(f.partner.issueCard(input)).rejects.toMatchObject({ retryable: true });
    const journal = await f.journal.get(input.externalRef);
    expect(journal).toMatchObject({ state: 'unknown', partnerReceiptId: null, partnerCardId: null,
      evidence: { step: 'card_issue', dispatchPhase: 'post_dispatched', responseAck: 'rejected_envelope', upstreamCode: 987654,
        httpStatus: 200, businessCategory: 'billing_phone_region_restricted' } });
    expect(JSON.stringify(journal)).not.toContain('PRIVATE');
    expect(JSON.stringify(journal)).not.toContain("The mobile phone area code of the customer's billing address is restricted!");
    const restarted = new UpayFinancialPartner(f.actualConfig, f.client, f.journal, f.kyc);
    await expect(restarted.issueCard(input)).rejects.toMatchObject({ retryable: true });
    expect(await restarted.findCardByExternalRef(input.externalRef)).toBeNull();
    expect(f.requests.filter(request => request.path === '/card/applyOpenCard')).toHaveLength(1);
    expect(await f.journal.get(input.externalRef)).toEqual(journal);
  });
  it('does not annotate a historical unknown with a newly available billing-region diagnosis', async () => {
    const f = await setup();
    await f.journal.begin({ reference: 'historic-unclassified', kind: 'issue', requestHash: 'original-fixture', evidence: { customerNo: 'customer-1' } });
    await f.journal.record('historic-unclassified', { state: 'unknown' });
    const before = await f.journal.get('historic-unclassified');
    f.setSubmitError(new UpayError('Sanitized fixture', true, 987654, { phase: 'post_dispatched', ack: 'rejected_envelope', businessCategory: 'billing_phone_region_restricted' }));
    await expect(f.partner.issueCard({ externalRef: 'historic-unclassified', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n })).rejects.toMatchObject({ retryable: true });
    expect(await f.journal.get('historic-unclassified')).toEqual(before);
    expect(f.requests).toHaveLength(0);
  });
  it('does not trust a forged generic error carrying a billing-region category', async () => {
    const f = await setup();
    f.setSubmitError(Object.assign(new Error('PRIVATE upstream text'), { metadata: { phase: 'post_dispatched', ack: 'rejected_envelope', businessCategory: 'billing_phone_region_restricted' } }));
    await expect(f.partner.issueCard({ externalRef: 'forged-business-category', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n })).rejects.toMatchObject({ retryable: true });
    const journal = await f.journal.get('forged-business-category');
    expect(journal).toMatchObject({ state: 'unknown', evidence: { responseAck: 'unconfirmed' } });
    expect(journal!.evidence).not.toHaveProperty('businessCategory');
    expect(JSON.stringify(journal)).not.toContain('PRIVATE');
  });
  it.each(['historical_unknown', 'bound_receipt', 'receipt_evidence', 'wrong_step'] as const)('never upgrades %s to a refundable non-dispatch proof', async mode => {
    const f = await setup(), reference = `older-${mode}`;
    await f.journal.begin({ reference, kind: 'issue', requestHash: 'fixture', evidence: { customerNo: 'customer-1', step: 'card_issue' } });
    await f.journal.record(reference, { state: mode === 'historical_unknown' ? 'unknown' : 'rejected',
      ...(mode === 'bound_receipt' ? { partnerReceiptId: 'receipt-fixture' } : {}), evidence: { dispatchPhase: 'pre_dispatch', responseAck: 'unconfirmed',
        ...(mode === 'receipt_evidence' ? { orderNo: 'order-fixture' } : {}), ...(mode === 'wrong_step' ? { step: 'card_recharge' } : {}) } });
    const before = await f.journal.get(reference);
    const restarted = new UpayFinancialPartner(config, f.client, f.journal, f.kyc);
    await expect(restarted.issueCard({ externalRef: reference, partnerCustomerId: 'customer-1', maxFeeUsd: 1000n })).rejects.toMatchObject({ retryable: true });
    const lookup = await restarted.findCardByExternalRef(reference).catch(error => error);
    expect(lookup).not.toBeInstanceOf(UpayNotDispatchedError);
    expect(f.requests).toEqual([]); expect(await f.journal.get(reference)).toEqual(before);
  });
  it.each([new Error('PRIVATE forged metadata'), new PartnerError('PRIVATE nonretryable error', false)])('does not trust a generic error carrying forged pre-dispatch fields', async error => {
    const f = await setup();
    f.setSubmitError(Object.assign(error, { metadata: { phase: 'pre_dispatch', ack: 'unconfirmed' } }));
    await expect(f.partner.issueCard({ externalRef: 'forged-phase', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n })).rejects.toMatchObject({ retryable: true });
    expect(await f.journal.get('forged-phase')).toMatchObject({ state: 'unknown', evidence: { dispatchPhase: 'post_dispatched' } });
    expect(f.requests).toHaveLength(1); expect(JSON.stringify(await f.journal.get('forged-phase'))).not.toContain('PRIVATE');
  });
  it('matches the panel WebCrypto AES-GCM payment PIN format', async () => {
    const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(createHash('md5').update(`${info.id}broker-manage`).digest('hex')), 'AES-GCM', false, ['encrypt']);
    const expected = Buffer.from(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: new TextEncoder().encode(info.iv) }, key, new TextEncoder().encode('123456'))).toString('base64');
    expect(encryptPaymentPin('123456', info)).toBe(expected);
  });
  it('derives the gross recharge with integer arithmetic and guards the reserved budget', () => {
    expect(rechargeQuote(recharge, 4925n, 5000n)).toMatchObject({ grossUsdt: '49.60', netUsd: 4925n, partnerFeeUsdt: '0.3472' });
    expect(() => rechargeQuote({ ...recharge, rechargeRate: '5' }, 4925n, 5000n)).toThrow('reserved budget');
    const liveMinimum = { ...recharge, minRechargeAmount: '20.00' };
    expect(minimumRechargeNet(liveMinimum)).toBe(1986n);
    expect(() => rechargeQuote(liveMinimum, 1970n, 2000n)).toThrow('between 20.00');
    expect(rechargeQuote(liveMinimum, 1986n, 2017n)).toMatchObject({ grossUsdt: '20.00', netUsd: 1986n });
  });
  it('rejects unpriced or unsupported initial issuance recharge before any mutation', () => {
    const form = { customerNo: 'customer-1', needParams: [] };
    expect(() => issuancePayload({ openFee: '20', defaultOpenAmount: '0', rechargeCurrency: 'USDT', cardCurrency: 'USD' }, form, 'customer-1', 'product-1', 1000n)).toThrow('reserved fee');
    expect(() => issuancePayload({ openFee: '10', defaultOpenAmount: '1' }, form, 'customer-1', 'product-1', 2000n)).toThrow('initial recharge');
  });
  it('mirrors the native fee-form contact copies and overrides stale copies without mutating the read response', () => {
    // Public Index-C2cTNQvb.rs assigns copyPhone=o.phone and copyEmail=o.email
    // after replacing the form with getCardFee, then ls deep-copies that form.
    const form = { customerNo: 'customer-1', needParams: ['givenName', 'lastName', 'documentType'], defaultType: 1,
      givenName: 'SYNTHETIC', lastName: 'FIXTURE', phone: '0000000000', email: 'fixture@example.test',
      copyPhone: 'stale-phone-fixture', copyEmail: 'stale@example.test', workYear: 'null' };
    const original = structuredClone(form);
    const quote = issuancePayload({ openFee: '10', defaultOpenAmount: '0', rechargeCurrency: 'USDT', currency: 'USD' },
      form, 'customer-1', 'product-1', 1000n);
    const nativeContacts = { copyPhone: form.phone, copyEmail: form.email };
    expect(quote.payload).toMatchObject({ ...nativeContacts, givenName: form.givenName, lastName: form.lastName,
      phone: form.phone, email: form.email, workYear: '', documentType: 1, agentCardId: 'product-1', number: 1 });
    expect(form).toEqual(original);
  });
  it('rejects the native required billing address even when needParams omits addressId', async () => {
    // Native Index-C2cTNQvb: addressType.split(',').length renders addressId;
    // P('addressId') applies required validation when requiredInfo is true.
    const f = await setup();
    f.setFeeForm({ customerNo: 'customer-1', needParams: ['givenName', 'lastName', 'documentType'], defaultType: 1,
      givenName: 'TEST', lastName: 'HOLDER', requiredInfo: true, addressType: '3' });
    await expect(f.partner.issueCard({ externalRef: 'missing-billing', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n }))
      .rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/billing address/i) });
    expect(f.requests).toEqual([]);
    expect(await f.journal.get('missing-billing')).toBeNull();
  });
  it('does not accept a fee-form address without a verified local customer binding', async () => {
    const f = await setup();
    f.setFeeForm({ customerNo: 'customer-1', needParams: [], defaultType: 1,
      requiredInfo: true, addressType: '3', addressId: 'unowned-address-fixture' });
    await expect(f.partner.issueCard({ externalRef: 'unowned-billing', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n }))
      .rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/billing address/i) });
    expect(f.requests).toEqual([]);
    expect(await f.journal.get('unowned-billing')).toBeNull();
  });
  it('validates the required owned billing address without a journal entry or financial POST', async () => {
    const f = await setup();
    const form = { customerNo: 'customer-1', needParams: [], defaultType: 1,
      requiredInfo: true, addressType: '3', addressId: 'unowned-fee-address' };
    f.setFeeForm(form);
    const calls: string[] = [];
    const billing = { getVerifiedAddressId: async (customerNo: string) => { calls.push(customerNo); return 'owned-billing-fixture'; } };
    const partner = new UpayFinancialPartner(config, f.client, f.journal, f.kyc, billing);
    await partner.validateIssue({ partnerCustomerId: 'customer-1', maxFeeUsd: 1000n });
    expect(calls).toEqual(['customer-1']);
    expect(f.requests).toEqual([]);
    f.setResponse({ agentCustomerCardId: 'card-1', orderNo: 'billing-order' });
    f.setReceipt(issueReceipt('billing-order'));
    await partner.issueCard({ externalRef: 'owned-billing', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.body.addressId).toBe('owned-billing-fixture');
    expect(form.addressId).toBe('unowned-fee-address');
  });
  it.each(['1', '2', '3', '1,3'])('checks required address type %s independently of needParams', addressType => {
    expect(() => issuancePayload({ openFee: '10', defaultOpenAmount: '0', rechargeCurrency: 'USDT', currency: 'USD' },
      { needParams: [], requiredInfo: true, addressType }, 'customer-1', 'product-1', 1000n)).toThrow(/billing address/i);
  });
  it('allows a product without an address requirement and rejects malformed requirement metadata', () => {
    const product = { openFee: '10', defaultOpenAmount: '0', rechargeCurrency: 'USDT', currency: 'USD' };
    expect(issuancePayload(product, { needParams: [], requiredInfo: false, addressType: '3' }, 'customer-1', 'product-1', 1000n).payload)
      .not.toHaveProperty('addressId');
    for (const form of [{ requiredInfo: 'false', addressType: '3' }, { requiredInfo: true, addressType: 3 }, { requiredInfo: true, addressType: '9' }]) {
      expect(() => issuancePayload(product, { needParams: [], ...form }, 'customer-1', 'product-1', 1000n)).toThrow(/billing address requirements/i);
    }
  });
  it('omits a stored fee-form signature exactly as the native rs -> ls path does before a new signature is drawn', () => {
    // Executed independently against the cached original rs/Xt/ls/It functions:
    // rs replaces a truthy signPath with [{fullUrl: placeholder}], then It returns
    // undefined because that preview has neither response.data.uri nor uri.
    const form = { customerNo: 'customer-1', needParams: ['givenName', 'lastName', 'documentType'], defaultType: 1,
      givenName: 'SYNTHETIC', lastName: 'FIXTURE', signPath: 'stored-signature-fixture',
      holdFrontPath: 'stored-front-fixture', holdBackPath: null, holdPassportPath: '' };
    const quote = issuancePayload({ openFee: '10', defaultOpenAmount: '0', rechargeCurrency: 'USDT', currency: 'USD' },
      form, 'customer-1', 'product-1', 1000n);
    const wire = JSON.parse(JSON.stringify(quote.payload));
    expect(wire).not.toHaveProperty('signPath');
    expect(wire).toMatchObject({ holdFrontPath: 'stored-front-fixture', holdBackPath: '', holdPassportPath: '', number: 1 });
    expect(Number(wire.amount)).toBe(10); // Native Jt=(defaultOpenAmount + openFee)*number, not initial recharge alone.
    expect(JSON.stringify(wire)).not.toContain('stored-signature-fixture');
    expect(form.signPath).toBe('stored-signature-fixture');
  });
  it('does not submit a required signature using an old fee-form preview in place of a newly captured URI', async () => {
    const f = await setup();
    f.setFeeForm({ customerNo: 'customer-1', defaultType: 1, needParams: ['signPath'], signPath: 'stored-signature-fixture' });
    await expect(f.partner.issueCard({ externalRef: 'requires-new-signature', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n }))
      .rejects.toMatchObject({ retryable: false });
    expect(f.requests).toEqual([]);
    expect(await f.journal.get('requires-new-signature')).toBeNull();
  });
  it('sends issuance once, preserves only exact response IDs and verifies the issued card', async () => {
    const f = await setup();
    f.setResponse({ agentCustomerCardId: 'card-1', orderNo: 'issue-order-1', pinCode: 'NEVER STORE', cardNumber: 'NEVER STORE' });
    f.setReceipt(issueReceipt('issue-order-1'));
    const result = await f.partner.issueCard({ externalRef: 'local-issue-1', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n });
    expect(result).toEqual({ partnerCardId: 'card-1', last4: '1234', expiryMonth: 12, expiryYear: 2029 });
    expect(f.requests[0]!.body).toMatchObject({ customerNo: 'customer-1', agentCardId: 'product-1', number: 1, amount: '10.00' });
    expect(JSON.stringify(await f.journal.get('local-issue-1'))).not.toContain('NEVER STORE');
    expect((await f.partner.issueCard({ externalRef: 'local-issue-1', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n })).partnerCardId).toBe('card-1');
    expect(f.requests).toHaveLength(1);
    expect(await f.partner.getIssueSettlement('local-issue-1')).toEqual({ grossUsd: 1000n });
  });
  it.each([1, 2] as const)('uses verified KYC document type %s when the real fee form has null defaultType', async (documentType) => {
    const f = await setup();
    f.setDocumentType(documentType);
    f.setFeeForm({ customerNo: 'customer-1', defaultType: null, needParams: ['lastName', 'givenName', 'documentType'], lastName: 'HOLDER', givenName: 'TEST' });
    f.setResponse({ agentCustomerCardId: 'card-1', orderNo: 'document-order' });
    f.setReceipt(issueReceipt('document-order'));
    await f.partner.issueCard({ externalRef: 'null-default-doc', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n });
    expect(f.requests[0]!.body.documentType).toBe(documentType);
  });
  it('never resends after a lost response, including after adapter restart', async () => {
    const f = await setup();
    f.setTimeout();
    const input = { externalRef: 'local-lost-1', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n };
    await expect(f.partner.issueCard(input)).rejects.toMatchObject({ retryable: true });
    expect((await f.journal.get(input.externalRef))?.state).toBe('unknown');
    const restarted = new UpayFinancialPartner(config, f.client, f.journal, f.kyc);
    await expect(restarted.issueCard(input)).rejects.toBeInstanceOf(PartnerError);
    expect(f.requests).toHaveLength(1);
  });
  it.each([null, true, false, 'accepted', 1, {}, []].map(response => ({ response })))
    ('retains an accepted envelope without exact receipt IDs ($response), and never submits it twice', async ({ response }) => {
    const f = await setup();
    f.setResponse(response);
    const input = { externalRef: 'accepted-no-receipt', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n };
    await expect(f.partner.issueCard(input)).rejects.toMatchObject({ retryable: true });
    const journal = await f.journal.get(input.externalRef);
    expect(journal).toMatchObject({ state: 'unknown', partnerReceiptId: null, partnerCardId: null,
      evidence: { step: 'card_issue', dispatchPhase: 'post_dispatched', responseAck: 'accepted_envelope' } });
    expect(journal?.evidence).not.toHaveProperty('response');
    await expect(f.partner.issueCard(input)).rejects.toMatchObject({ retryable: true });
    const restarted = new UpayFinancialPartner(config, f.client, f.journal, f.kyc);
    await expect(restarted.issueCard(input)).rejects.toMatchObject({ retryable: true });
    expect(f.requests).toHaveLength(1);
    expect(await f.journal.get(input.externalRef)).toEqual(journal);
  });
  it.each([
    { phase: 'post_dispatched', ack: 'rejected_envelope', httpStatus: 200, code: 10041 },
    { phase: 'post_dispatched', ack: 'http_error', httpStatus: 502, code: undefined },
    { phase: 'post_dispatched', ack: 'unconfirmed', httpStatus: undefined, code: undefined },
  ] as const)('retains only closed transport metadata for $phase/$ack without marking a refundable rejection', async metadata => {
    const f = await setup();
    f.setSubmitError(new UpayError('DO NOT STORE issuer text PIN 123456', true, metadata.code, metadata));
    const input = { externalRef: 'failed-submit-metadata', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n };
    await expect(f.partner.issueCard(input)).rejects.toMatchObject({ retryable: true });
    const row = await f.journal.get(input.externalRef);
    expect(row).toMatchObject({ state: 'unknown', evidence: { step: 'card_issue', dispatchPhase: metadata.phase, responseAck: metadata.ack,
      ...(metadata.code === undefined ? {} : { upstreamCode: metadata.code }), ...(metadata.httpStatus === undefined ? {} : { httpStatus: metadata.httpStatus }) } });
    expect(JSON.stringify(row)).not.toContain('DO NOT STORE');
    expect(JSON.stringify(row)).not.toContain('123456');
    const restarted = new UpayFinancialPartner(config, f.client, f.journal, f.kyc);
    await expect(restarted.issueCard(input)).rejects.toMatchObject({ retryable: true });
    expect(f.requests).toHaveLength(1);
  });
  it('does not lose the accepted ACK when exact response alias verification fails', async () => {
    const f = await setup();
    await f.journal.begin({ reference: 'other-op', kind: 'issue', requestHash: 'fixture-other' });
    await f.journal.claimAliases('other-op', ['order:already-owned']);
    f.setResponse({ orderNo: 'already-owned', pinCode: 'DO NOT STORE' });
    const input = { externalRef: 'accepted-alias-conflict', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n };
    await expect(f.partner.issueCard(input)).rejects.toMatchObject({ retryable: true });
    expect(await f.journal.get(input.externalRef)).toMatchObject({ state: 'unknown', evidence: { step: 'card_issue',
      dispatchPhase: 'post_dispatched', responseAck: 'accepted_envelope' } });
    expect(JSON.stringify(await f.journal.get(input.externalRef))).not.toContain('DO NOT STORE');
    await expect(f.partner.issueCard(input)).rejects.toMatchObject({ retryable: true });
    expect(f.requests).toHaveLength(1);
  });
  it('does not call an acknowledged asynchronous issuance active before the exact card exists', async () => {
    const f = await setup();
    f.setResponse({ orderNo: 'pending-order-1' });
    await expect(f.partner.issueCard({ externalRef: 'local-pending-1', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n })).rejects.toBeInstanceOf(PartnerPendingError);
    expect(await f.partner.findCardByExternalRef('local-pending-1')).toBeNull();
    expect((await f.journal.get('local-pending-1'))?.state).toBe('acknowledged');
  });
  it('confirms recharge only from an exact successful receipt with matching target/gross/net', async () => {
    const f = await setup();
    f.setResponse({ orderNo: 'recharge-order-1' });
    f.setReceipt({ orderNo: 'recharge-order-1', status: 1, agentCustomerCardId: 'card-1', rechargeAmount: '49.60', receivedAmount: '49.250000', actualAmount: '49.60', rechargeCurrency: 'USDT', receivedCurrency: 'USD' });
    await f.partner.rechargeCard({ externalRef: 'local-topup-1', partnerCardId: 'card-1', amountUsd: 4925n, maxDebitUsd: 5000n });
    expect(f.requests[0]).toMatchObject({ endpoint: '/card/recharge', body: { amount: '49.60', agentCustomerCardId: 'card-1' } });
    expect(await f.partner.getRechargeSettlement('local-topup-1')).toEqual({ grossUsd: 4960n });
    expect(await f.partner.isRechargeDone('local-topup-1')).toBe(true);
    expect(f.requests).toHaveLength(1);
  });
  it('does not adopt a receipt for another card or one sharing only the same amount', async () => {
    const f = await setup();
    f.setResponse({ orderNo: 'wrong-target' });
    f.setReceipt({ orderNo: 'wrong-target', status: 1, agentCustomerCardId: 'another-card', rechargeAmount: '49.60', receivedAmount: '49.250000', actualAmount: '49.60', rechargeCurrency: 'USDT', receivedCurrency: 'USD' });
    await expect(f.partner.rechargeCard({ externalRef: 'local-wrong-1', partnerCardId: 'card-1', amountUsd: 4925n, maxDebitUsd: 5000n })).rejects.toBeInstanceOf(PartnerPendingError);
    expect(await f.partner.isRechargeDone('local-wrong-1')).toBe(false);
  });
  it('classifies malformed accepted receipt amounts as unknown rather than a refundable rejection', async () => {
    const f = await setup();
    f.setResponse({ orderNo: 'malformed-order' });
    f.setReceipt({ orderNo: 'malformed-order', status: 1, agentCustomerCardId: 'card-1', rechargeAmount: '49.60', rechargeCurrency: 'USDT', receivedCurrency: 'USD' });
    await expect(f.partner.rechargeCard({ externalRef: 'malformed-ref', partnerCardId: 'card-1', amountUsd: 4925n, maxDebitUsd: 5000n })).rejects.toMatchObject({ retryable: true });
    expect(f.requests).toHaveLength(1);
    expect((await f.journal.get('malformed-ref'))?.evidence).toMatchObject({ step: 'card_recharge', dispatchPhase: 'post_dispatched', responseAck: 'accepted_envelope' });
    await expect(f.partner.isRechargeDone('malformed-ref')).rejects.toMatchObject({ retryable: true });
  });
  it('does not bind an issuance receipt to an older card sharing only its customer', async () => {
    const f = await setup();
    await f.journal.begin({ reference: 'bind-old', kind: 'issue', requestHash: 'fixture', evidence: { customerNo: 'customer-1', agentCardId: 'product-1', openFeeUsdt: '10.00', maxFeeBudgetUsdt: '10.00' } });
    f.setReceipt(issueReceipt('new-issuance', { agentCustomerCardId: 'new-card', cardId: 'new-broker' }));
    await expect(f.partner.bindReceipt('bind-old', 'new-issuance', 'card-1')).rejects.toMatchObject({ retryable: true });
    expect((await f.journal.get('bind-old'))?.partnerCardId).toBeNull();
  });
  it('claims both receipt record and order aliases so the same recharge cannot settle twice', async () => {
    const f = await setup();
    const evidence = { agentCustomerCardId: 'card-1', grossUsdt: '49.60', netUsd: '49.25' };
    await f.journal.begin({ reference: 'by-record', kind: 'recharge', requestHash: 'first', evidence });
    await f.journal.record('by-record', { state: 'acknowledged', partnerReceiptId: 'record-R', evidence: { receiptRecordId: 'record-R' } });
    f.setReceipt({ id: 'record-R', orderNo: 'order-O', status: 1, agentCustomerCardId: 'card-1', rechargeAmount: '49.60', receivedAmount: '49.25', rechargeCurrency: 'USDT', receivedCurrency: 'USD' });
    expect(await f.partner.isRechargeDone('by-record')).toBe(true);
    await f.journal.begin({ reference: 'by-order', kind: 'recharge', requestHash: 'second', evidence });
    await expect(f.partner.bindReceipt('by-order', 'order-O')).rejects.toMatchObject({ retryable: true });
    expect((await f.journal.get('by-order'))?.state).toBe('sending');
  });
  it('checks the bot payment-password enrollment before submitting', async () => {
    const f = await setup();
    f.loginInfo.pinCodeSet = false;
    await expect(f.partner.issueCard({ externalRef: 'no-payment-pin', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n })).rejects.toMatchObject({ retryable: false });
    expect(f.requests).toEqual([]);
    expect(await f.journal.get('no-payment-pin')).toBeNull();
  });
  it('uses the verified historical receipt identity fields without guessing card associations', async () => {
    const f = await setup();
    f.setResponse({ orderNo: 'issue-live-shape' });
    f.setReceipt(issueReceipt('issue-live-shape'));
    expect((await f.partner.issueCard({ externalRef: 'issue-live', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n })).partnerCardId).toBe('card-1');
    f.setResponse({ orderNo: 'recharge-live-shape' });
    f.setReceipt({ orderNo: 'recharge-live-shape', status: 1, accountCardId: 'account-1', cardId: 'unrelated-provider-id', rechargeAmount: '49.60', actualAmount: '49.60', receivedAmount: '49.250000', rechargeFee: '0.34', rechargeCurrency: 'USDT', receivedCurrency: 'USD' });
    await f.partner.rechargeCard({ externalRef: 'recharge-live', partnerCardId: 'card-1', amountUsd: 4925n, maxDebitUsd: 5000n });
    expect(await f.partner.isRechargeDone('recharge-live')).toBe(true);
  });
  it('blocks a dispatch after the worker lease expires during preflight', async () => {
    const f = await setup();
    await expect(f.partner.issueCard({ externalRef: 'expired-lease', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n,
      beforeSubmit: async () => { throw new Error('lease lost'); } })).rejects.toBeInstanceOf(UpayNotDispatchedError);
    expect(f.requests).toEqual([]);
    expect((await f.journal.get('expired-lease'))?.state).toBe('rejected');
  });
  it('does not assign the same exact issued card to two operation references', async () => {
    const f = await setup();
    f.setResponse({ agentCustomerCardId: 'card-1', orderNo: 'unique-order-a' });
    f.setReceipt(issueReceipt('unique-order-a'));
    await f.partner.issueCard({ externalRef: 'unique-card-a', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n });
    f.setResponse({ agentCustomerCardId: 'card-1', orderNo: 'unique-order-b' });
    f.setReceipt(issueReceipt('unique-order-b'));
    await expect(f.partner.issueCard({ externalRef: 'unique-card-b', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n })).rejects.toMatchObject({ retryable: true });
    expect((await f.journal.get('unique-card-b'))?.state).toBe('unknown');
  });
  it('keeps a direct acknowledged card ID pending until its exact successful cost receipt exists', async () => {
    const f = await setup();
    f.setResponse({ agentCustomerCardId: 'card-1' });
    await expect(f.partner.issueCard({ externalRef: 'card-only-ack', partnerCustomerId: 'customer-1', maxFeeUsd: 1000n })).rejects.toBeInstanceOf(PartnerPendingError);
    expect(await f.partner.findCardByExternalRef('card-only-ack')).toBeNull();
    expect((await f.journal.get('card-only-ack'))?.state).toBe('acknowledged');
    await expect(f.partner.getIssueSettlement('card-only-ack')).rejects.toMatchObject({ retryable: true });
  });
  it('settles the verified receipt payment rather than the preflight issuance quote', async () => {
    const f = await setup();
    f.setResponse({ agentCustomerCardId: 'card-1', orderNo: 'actual-cost' });
    f.setReceipt(issueReceipt('actual-cost', { paymentAmount: '12.00' }));
    await f.partner.issueCard({ externalRef: 'actual-cost-ref', partnerCustomerId: 'customer-1', maxFeeUsd: 2000n });
    expect(await f.partner.getIssueSettlement('actual-cost-ref')).toEqual({ grossUsd: 1200n });
    expect((await f.journal.get('actual-cost-ref'))?.evidence).toMatchObject({ openFeeUsdt: '10.00', actualIssueCostUsdt: '12.00', maxFeeBudgetUsdt: '20.00' });
  });
  it.each(['20.01', 'malformed'])('keeps an accepted issuance unconfirmed when its actual payment is %s', async (paymentAmount) => {
    const f = await setup();
    f.setResponse({ agentCustomerCardId: 'card-1', orderNo: 'bad-cost' });
    f.setReceipt(issueReceipt('bad-cost', { paymentAmount }));
    await expect(f.partner.issueCard({ externalRef: 'bad-cost-ref', partnerCustomerId: 'customer-1', maxFeeUsd: 2000n })).rejects.toMatchObject({ retryable: true });
    expect((await f.journal.get('bad-cost-ref'))?.state).not.toBe('confirmed');
    expect((await f.journal.get('bad-cost-ref'))?.evidence).toMatchObject({ step: 'card_issue', dispatchPhase: 'post_dispatched', responseAck: 'accepted_envelope' });
    await expect(f.partner.getIssueSettlement('bad-cost-ref')).rejects.toMatchObject({ retryable: true });
    expect(f.requests).toHaveLength(1);
  });
  it('uses action1/2 and observes state4/1 for user locking/unlocking', async () => {
    const f = await setup();
    f.card.cardStatus = 4;
    await f.partner.freezeCard('card-1', 'local-freeze-1');
    expect(f.requests[0]).toMatchObject({ endpoint: '/card/thawFrozen', body: { state: 1, agentCustomerCardIds: ['card-1'] } });
    expect((await f.journal.get('local-freeze-1'))?.evidence).toMatchObject({ step: 'card_freeze', dispatchPhase: 'post_dispatched', responseAck: 'accepted_envelope' });
    f.card.cardStatus = 1;
    await f.partner.unfreezeCard('card-1', 'local-unfreeze-1');
    expect(f.requests[1]!.body.state).toBe(2);
    expect((await f.journal.get('local-unfreeze-1'))?.evidence).toMatchObject({ step: 'card_unfreeze', dispatchPhase: 'post_dispatched', responseAck: 'accepted_envelope' });
  });
  it('authenticates decrypted sensitive fields and never falls back to unchecked ciphertext', async () => {
    const f = await setup();
    expect(await f.partner.getCardSensitive('card-1')).toMatchObject({ pan: '4000000000001234', cvv: '123', expiryMonth: 12, expiryYear: 2029 });
    f.card.cvv = 'corrupt';
    await expect(f.partner.getCardSensitive('card-1')).rejects.toBeInstanceOf(PartnerError);
  });
  it('enforces immutable request references, receipt uniqueness and journal evidence minimization', async () => {
    const journal = new MemoryUpaySubmissionStore();
    await journal.begin({ reference: 'a', kind: 'issue', requestHash: 'one' });
    await expect(journal.begin({ reference: 'a', kind: 'issue', requestHash: 'two' })).rejects.toThrow('another request');
    await journal.record('a', { state: 'acknowledged', partnerReceiptId: 'receipt-1' });
    await journal.begin({ reference: 'b', kind: 'issue', requestHash: 'three' });
    await expect(journal.record('b', { state: 'acknowledged', partnerReceiptId: 'receipt-1' })).rejects.toThrow('already bound');
    await expect(journal.record('a', { state: 'unknown', evidence: { pinCode: 'never' } })).rejects.toThrow('Unsafe');
  });
});
