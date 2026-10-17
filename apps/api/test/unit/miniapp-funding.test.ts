import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardIssueQuoteDto, DepositAddressDto, WalletAsset } from '@gudex/shared';
import { cardIssueFunding, cardIssueQuote, fundingEnabled, liveDepositAddress } from '../../../miniapp/src/lib/funding';
import { fetchIssueQuote, requestIssueCard } from '../../../miniapp/src/lib/queries';

afterEach(() => vi.unstubAllGlobals());

const walletQuote = (asset: WalletAsset = 'USDT', customerCharge = '10', fee = '10'): CardIssueQuoteDto => ({
  asset, fee, customerCharge, fundingSource: 'wallet',
});

const address: DepositAddressDto = {
  asset: 'USDT', network: 'TRC20', address: `T${'1'.repeat(33)}`, minAmount: '1', demo: false,
};

describe('Mini App live funding readiness', () => {
  it('hides a previously issued address immediately when its provider is disabled or readiness is unknown', () => {
    for (const mode of ['disabled', undefined, null, '', 'unrecognized']) {
      expect(fundingEnabled(mode)).toBe(false);
      expect(liveDepositAddress(mode, 'USDT', 'TRC20', address)).toBeNull();
    }
  });

  it('never promotes a cached demo address into a live transfer destination', () => {
    expect(liveDepositAddress('live', 'USDT', 'TRC20', { ...address, demo: true })).toBeNull();
    expect(liveDepositAddress('live', 'USDT', 'TRC20', { ...address, address: 'GUDEX-DEMO:USDT:TRC20' })).toBeNull();
    expect(liveDepositAddress('demo', 'USDT', 'TRC20', address)).toBeNull();
  });

  it('requires the address response to match both the selected asset and network', () => {
    expect(liveDepositAddress('live', 'USDC', 'TRC20', address)).toBeNull();
    expect(liveDepositAddress('live', 'USDT', 'ERC20', address)).toBeNull();
    expect(liveDepositAddress('live', 'USDT', 'TRC20', { ...address, address: `0x${'1'.repeat(40)}` })).toBeNull();
  });

  it('exposes an explicit live destination only after valid matching data arrives', () => {
    expect(liveDepositAddress('live', 'USDT', 'TRC20', undefined)).toBeNull();
    expect(liveDepositAddress('live', 'USDT', 'TRC20', address)).toBe(address);
  });
});

describe('Mini App card issue balance', () => {
  it.each([
    ['9.999999', false, '0.000001'],
    ['10', true, '0'],
    ['10.000001', true, '0'],
  ] as const)('compares %s with the quoted customer charge exactly', (amount, enough, shortage) => {
    expect(cardIssueFunding({ balances: [{ asset: 'USDT', amount }] }, 'USDT', walletQuote())).toEqual({ enough, shortage });
  });

  it('uses only the selected asset and the server-quoted customer charge', () => {
    const wallet = { balances: [{ asset: 'USDT' as const, amount: '100' }, { asset: 'USDC' as const, amount: '9.5' }] };
    expect(cardIssueFunding(wallet, 'USDC', walletQuote('USDC', '10.01'))).toEqual({ enough: false, shortage: '0.51' });
    expect(cardIssueFunding(wallet, 'USDT', walletQuote('USDT', '10.01'))).toEqual({ enough: true, shortage: '0' });
    expect(cardIssueFunding(wallet, 'USDC', walletQuote('USDC', '9.4', '10'))).toEqual({ enough: true, shortage: '0' });
  });

  it('allows an existing funded balance even when new deposits are disabled', () => {
    expect(fundingEnabled('disabled')).toBe(false);
    expect(cardIssueFunding({ balances: [{ asset: 'USDT', amount: '10' }] }, 'USDT', walletQuote()).enough).toBe(true);
  });

  it.each(['', '-1', 'NaN', 'Infinity', '1e3', '10.0000001'])('fails closed for an invalid selected balance %s', (amount) => {
    expect(cardIssueFunding({ balances: [{ asset: 'USDT', amount }] }, 'USDT', walletQuote())).toEqual({ enough: false, shortage: null });
  });

  it.each(['', '-1', 'NaN', 'Infinity', '1e3', '10.001'])('fails closed for an invalid USD issue fee %s', (fee) => {
    expect(cardIssueFunding({ balances: [{ asset: 'USDT', amount: '100' }] }, 'USDT', walletQuote('USDT', '10', fee))).toEqual({ enough: false, shortage: null });
  });

  it('does not treat a missing selected wallet balance as funded', () => {
    expect(cardIssueFunding({ balances: [{ asset: 'USDC', amount: '100' }] }, 'USDT', walletQuote())).toEqual({ enough: false, shortage: null });
  });

  it('accepts a server-quoted zero customer charge funded by the broker without a wallet balance', () => {
    const quote: CardIssueQuoteDto = { asset: 'USDT', fee: '10', customerCharge: '0', fundingSource: 'broker' };
    expect(cardIssueQuote('USDT', quote)).toBe(quote);
    expect(cardIssueFunding({ balances: [] }, 'USDT', quote)).toEqual({ enough: true, shortage: '0' });
  });

  it('does not infer broker funding from a zero balance or a cached quote for another asset', () => {
    const wallet = { balances: [{ asset: 'USDT' as const, amount: '0' }] };
    expect(cardIssueFunding(wallet, 'USDT', walletQuote())).toEqual({ enough: false, shortage: '10' });
    expect(cardIssueQuote('USDT', undefined)).toBeNull();
    expect(cardIssueFunding(wallet, 'USDT', undefined)).toEqual({ enough: false, shortage: null });
    expect(cardIssueFunding(wallet, 'USDT', { asset: 'USDC', fee: '10', customerCharge: '0', fundingSource: 'broker' })).toEqual({ enough: false, shortage: null });
  });

  it.each(['', '-1', 'NaN', 'Infinity', '1e3', '10.0000001'])('rejects an invalid server-quoted customer charge %s', (customerCharge) => {
    const quote = walletQuote('USDT', customerCharge);
    expect(cardIssueQuote('USDT', quote)).toBeNull();
    expect(cardIssueFunding({ balances: [{ asset: 'USDT', amount: '100' }] }, 'USDT', quote)).toEqual({ enough: false, shortage: null });
  });

  it('rejects contradictory broker charges and unknown funding sources', () => {
    expect(cardIssueQuote('USDT', { ...walletQuote(), fundingSource: 'broker' })).toBeNull();
    expect(cardIssueQuote('USDT', { ...walletQuote(), fundingSource: 'unrecognized' } as unknown as CardIssueQuoteDto)).toBeNull();
  });
});

describe('Mini App card issuance quote request', () => {
  it('sends the displayed funding source and exact customer charge with an issuance request', async () => {
    const body = { asset: 'USDT' as const, idempotencyKey: 'fixture-idempotency-key', expectedFundingSource: 'broker' as const, expectedCustomerCharge: '0' };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ card: { id: 'fixture-card' }, operation: { id: 'fixture-operation' } }));
    vi.stubGlobal('fetch', fetch);
    await requestIssueCard(body);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('/v1/cards');
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(body);
  });

  it('requests a server quote for the selected wallet asset', async () => {
    const quote = { asset: 'USDC', fee: '10', customerCharge: '0', fundingSource: 'broker' };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(quote));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchIssueQuote('USDC')).resolves.toEqual(quote);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('/v1/cards/issue-quote?asset=USDC');
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('does not fall back to a cached price or broker grant after a quote error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: { code: 'provider_unavailable', message: 'Quote unavailable' } }, { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchIssueQuote('USDT')).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
