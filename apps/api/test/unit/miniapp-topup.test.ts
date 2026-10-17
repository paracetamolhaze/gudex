import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { ApiError, minimumAmountDetails } from '../../../miniapp/src/lib/api';
import { errorTranslation } from '../../../miniapp/src/lib/error-format';
import { fetchTopupQuote } from '../../../miniapp/src/lib/queries';
import { en } from '../../../miniapp/src/i18n/en';
import { ru } from '../../../miniapp/src/i18n/ru';

const translations = createInstance();
beforeAll(async () => { await translations.init({ resources: { en: { translation: en }, ru: { translation: ru } }, lng: 'en' }); });
const errorMessage = (error: unknown, language: string): string => {
  const { key, options } = errorTranslation(error, language);
  return translations.t(translations.exists(key) ? key : 'errors.internal', options);
};
afterEach(() => vi.unstubAllGlobals());

describe('card-specific top-up minimum', () => {
  it('requests the selected card tariff and normalizes the amount before quoting', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ asset: 'USDT', amount: '20.17', minAmount: '20.17', fee: '0.30255', netUsd: '19.86', rate: '1' }));
    vi.stubGlobal('fetch', fetch);
    const cardId = '71c360e0-6dcf-42fe-9686-0aa06306e44c';
    const quote = await fetchTopupQuote('USDT', '20,17', cardId);
    const url = new URL(String(fetch.mock.calls[0]?.[0]), 'https://example.test');
    expect(url.searchParams.get('cardId')).toBe(cardId);
    expect(url.searchParams.get('amount')).toBe('20.17');
    expect(quote.minAmount).toBe('20.17');
  });

  it('keeps the optional generic quote route available without a card', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ asset: 'USDC', amount: '50', minAmount: '10', fee: '0.75', netUsd: '49.25', rate: '1' }));
    vi.stubGlobal('fetch', fetch);
    await fetchTopupQuote('USDC', '50');
    expect(String(fetch.mock.calls[0]?.[0])).toBe('/v1/cards/topup-quote?asset=USDC&amount=50');
  });

  it('preserves structured minimum details and gives an actionable translated error', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: {
      code: 'amount_too_small', message: 'Below current provider minimum', minAmount: '20.17', asset: 'USDT',
    } }, { status: 422 })));
    const error = await fetchTopupQuote('USDT', '20', 'selected-card').catch((result: unknown) => result);
    expect(error).toMatchObject({ code: 'amount_too_small', minAmount: '20.17', asset: 'USDT' });
    expect(errorMessage(error, 'ru')).toBe('Минимальная сумма — 20,17 USDT');
    expect(errorMessage(error, 'en')).toBe('The minimum amount is 20.17 USDT');
  });

  it('does not round the required minimum down or invent minimum details', () => {
    const precise = new ApiError('amount_too_small', 'Below minimum', 422, undefined, undefined, '20.170001', 'USDC');
    expect(errorMessage(precise, 'en')).toContain('20.170001 USDC');
    expect(minimumAmountDetails(new ApiError('amount_too_small', 'Below minimum', 422))).toBeNull();
    expect(minimumAmountDetails(new ApiError('amount_too_small', 'Below minimum', 422, undefined, undefined, 'NaN', 'USDT'))).toBeNull();
    expect(minimumAmountDetails(new ApiError('validation', 'Different error', 400, undefined, undefined, '20.17', 'USDT'))).toBeNull();
  });
});
