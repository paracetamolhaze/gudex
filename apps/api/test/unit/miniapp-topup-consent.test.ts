import { describe, expect, it } from 'vitest';
import type { TopupQuoteDto } from '@gudex/shared';
import { acceptedTopupQuote } from '../../../miniapp/src/lib/topup';

const quote: TopupQuoteDto = { asset: 'USDT', amount: '20', fee: '0.3', netUsd: '19.7', rate: '1' };
describe('top-up consent uses only the selected current quote', () => {
  it('rejects retained successful data after a failed refresh', () => {
    expect(acceptedTopupQuote('USDT', '20', '20', { data: quote, error: new Error('Refresh failed') })).toBeNull();
  });
  it('does not accept a quote while refreshing or while the input debounce is pending', () => {
    expect(acceptedTopupQuote('USDT', '20', '20', { data: quote, isFetching: true })).toBeNull();
    expect(acceptedTopupQuote('USDT', '30', '20', { data: quote })).toBeNull();
  });
  it('binds the quote to the selected asset and exact amount', () => {
    expect(acceptedTopupQuote('USDC', '20', '20', { data: quote })).toBeNull();
    expect(acceptedTopupQuote('USDT', '21', '21', { data: quote })).toBeNull();
    expect(acceptedTopupQuote('USDT', '20,000000', '20,000000', { data: quote })).toEqual(quote);
  });
  it.each([{ ...quote, fee: 'NaN' }, { ...quote, netUsd: '-1' }, { ...quote, amount: '20.0000001' }])('fails closed for invalid money fields', data => {
    expect(acceptedTopupQuote('USDT', '20', '20', { data })).toBeNull();
  });
});
