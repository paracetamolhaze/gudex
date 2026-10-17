import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { UpayClient } from '../../src/partner/upay/client';
import type { UpaySessionStore } from '../../src/partner/upay/session-store';
import { MemoryUpaySubmissionStore, type SubmissionEvidence } from '../../src/partner/upay/submissions';
import { UpayError, type UpayErrorMetadata, UpayTransport } from '../../src/partner/upay/transport';

const billingRegionMessage = "The mobile phone area code of the customer's billing address is restricted!";

function fixture(outcome: 'rejected' | 'http' | 'timeout' | 'malformed' | 'auth' | 'lease') {
  const requests: string[] = [];
  const config = loadConfig({ DATABASE_URL: 'unused', JWT_SECRET: 'fixture-key-for-unit-tests', UPAY_KYC_ENABLED: 'true',
    UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ' });
  const store: UpaySessionStore = { withLock: async fn => fn({ get: async () => null, set: async () => {} }) };
  const transport = new UpayTransport({ baseUrl: config.UPAY_BASE_URL, deviceId: 'fixture', timeoutMs: 1000,
    fetch: async url => {
      const path = new URL(String(url)).pathname.replace('/api/v1', '');
      requests.push(path);
      const ok = (data: unknown) => Response.json({ code: 200, data });
      if (path === '/sys/member/login') return outcome === 'auth' ? Response.json({ code: 456789, msg: 'PRIVATE credentials' }) : ok({ token: 'PRIVATE-token', googleState: 1 });
      if (path === '/sys/member/validateGoogle' || path === '/sys/member/loginInfo') return ok({ id: 'fixture' });
      if (outcome === 'timeout') throw new Error('PRIVATE network data');
      if (outcome === 'http') return new Response('PRIVATE identity', { status: 503 });
      if (outcome === 'malformed') return new Response('PRIVATE malformed body', { status: 200 });
      return Response.json({ code: 987654, msg: 'PRIVATE validation details' });
    } });
  return { client: new UpayClient(config, store, transport), requests };
}

describe('private UPay dispatch diagnostics', () => {
  it.each(['msg', 'message'])('classifies only the exact native billing-region rejection in %s without exposing its text', async field => {
    const transport = new UpayTransport({ baseUrl: 'https://fixture.invalid/api/v1', deviceId: 'fixture', timeoutMs: 1000,
      fetch: async () => Response.json({ code: 987654, [field]: billingRegionMessage, data: { phone: 'PRIVATE-phone', address: 'PRIVATE-address' } }) });
    const failure = await transport.request('POST', '/card/applyOpenCard', { body: {} }).catch(error => error);
    expect(failure).toBeInstanceOf(UpayError);
    if (!(failure instanceof UpayError)) throw new Error('Expected the sanitized UPay transport error');
    expect(failure).toMatchObject({ code: 987654, metadata: { phase: 'post_dispatched', ack: 'rejected_envelope', httpStatus: 200,
      businessCategory: 'billing_phone_region_restricted' } });
    expect(failure.message).not.toContain(billingRegionMessage);
    expect(JSON.stringify(failure)).not.toContain('PRIVATE');
  });

  it.each([
    { name: 'different endpoint', method: 'POST', endpoint: '/customer/add', code: 987654, msg: billingRegionMessage },
    { name: 'read endpoint', method: 'GET', endpoint: '/card/applyOpenCard', code: 987654, msg: billingRegionMessage },
    { name: 'private text', method: 'POST', endpoint: '/card/applyOpenCard', code: 987654, msg: 'PRIVATE-phone-region' },
    { name: 'near match', method: 'POST', endpoint: '/card/applyOpenCard', code: 987654, msg: `${billingRegionMessage} PRIVATE-phone` },
    { name: 'same code alone', method: 'POST', endpoint: '/card/applyOpenCard', code: 987654, msg: null },
    { name: 'accepted envelope', method: 'POST', endpoint: '/card/applyOpenCard', code: 200, msg: billingRegionMessage },
  ] as const)('does not classify $name as a billing-region rejection', async input => {
    const transport = new UpayTransport({ baseUrl: 'https://fixture.invalid/api/v1', deviceId: 'fixture', timeoutMs: 1000,
      fetch: async () => Response.json({ code: input.code, msg: input.msg }) });
    const result = await transport.request(input.method, input.endpoint).catch(error => error);
    expect(result instanceof UpayError ? result.metadata?.businessCategory : undefined).toBeUndefined();
    if (result instanceof Error) expect(result.message).not.toContain('PRIVATE');
  });

  it('drops arbitrary business categories and categories outside rejected post-dispatch metadata', () => {
    for (const metadata of [
      { phase: 'post_dispatched', ack: 'rejected_envelope', businessCategory: 'PRIVATE-phone' },
      { phase: 'pre_dispatch', ack: 'rejected_envelope', businessCategory: 'billing_phone_region_restricted' },
      { phase: 'post_dispatched', ack: 'unconfirmed', businessCategory: 'billing_phone_region_restricted' },
    ]) {
      expect(new UpayError('Sanitized fixture', false, undefined, metadata as UpayErrorMetadata).metadata).not.toHaveProperty('businessCategory');
    }
  });

  it.each([
    ['rejected', { code: 987654, metadata: { phase: 'post_dispatched', ack: 'rejected_envelope', httpStatus: 200 } }],
    ['http', { metadata: { phase: 'post_dispatched', ack: 'http_error', httpStatus: 503 } }],
    ['timeout', { metadata: { phase: 'post_dispatched', ack: 'unconfirmed' } }],
    ['malformed', { metadata: { phase: 'post_dispatched', ack: 'unconfirmed', httpStatus: 200 } }],
    ['auth', { code: 456789, metadata: { phase: 'pre_dispatch', ack: 'rejected_envelope', httpStatus: 200 } }],
    ['lease', { metadata: { phase: 'pre_dispatch', ack: 'unconfirmed' } }],
  ] as const)('distinguishes %s without replaying the customer request or exposing response text', async (outcome, expected) => {
    const { client, requests } = fixture(outcome);
    const promise = client.submitRequest('/customer/add', { email: 'PRIVATE-customer@example.test' }, {
      beforeDispatch: outcome === 'lease' ? async () => { throw new Error('PRIVATE lease context'); } : undefined,
    });
    await expect(promise).rejects.toMatchObject(expected);
    await expect(promise).rejects.not.toThrow('PRIVATE');
    expect(requests.filter(path => path === '/customer/add')).toHaveLength(['auth', 'lease'].includes(outcome) ? 0 : 1);
    expect(requests.filter(path => path === '/sys/member/login')).toHaveLength(1);
  });

  it('accepts only the closed diagnostic enum and numeric fields in submission evidence', async () => {
    const journal = new MemoryUpaySubmissionStore();
    const evidence = { step: 'card_issue', dispatchPhase: 'post_dispatched', responseAck: 'rejected_envelope', upstreamCode: 987654, httpStatus: 200,
      businessCategory: 'billing_phone_region_restricted' };
    await expect(journal.begin({ reference: 'fixture', kind: 'customer', requestHash: 'fixture', evidence })).resolves.toMatchObject({ created: true });
    const invalidEvidence: SubmissionEvidence[] = [{ step: 'PRIVATE' }, { dispatchPhase: 'PRIVATE' }, { responseAck: 'PRIVATE' },
      { upstreamCode: 'PRIVATE' }, { upstreamCode: 1.5 }, { upstreamCode: Number.MAX_SAFE_INTEGER + 1 },
      { httpStatus: 99 }, { httpStatus: 600 }, { httpStatus: 200.5 }, { businessCategory: 'PRIVATE-phone' }, { businessCategory: null }];
    for (const invalid of invalidEvidence) {
      await expect(journal.record('fixture', { state: 'unknown', evidence: invalid })).rejects.toThrow('Unsafe');
    }
  });

  it('does not turn an invalid upstream code into stored text or a guessed numeric code', async () => {
    const transport = new UpayTransport({ baseUrl: 'https://fixture.invalid/api/v1', deviceId: 'fixture', timeoutMs: 1000,
      fetch: async () => Response.json({ code: 'PRIVATE-customer-data', msg: 'PRIVATE' }) });
    const promise = transport.request('POST', '/customer/add', { body: {} });
    await expect(promise).rejects.toMatchObject({ metadata: { phase: 'post_dispatched', ack: 'rejected_envelope', httpStatus: 200 } });
    await expect(promise).rejects.toMatchObject({ code: undefined });
    await expect(promise).rejects.not.toThrow('PRIVATE');
  });
});
