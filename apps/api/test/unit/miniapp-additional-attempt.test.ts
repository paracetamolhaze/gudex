import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import type { CardAdditionalAttemptQuoteDto } from '@gudex/shared';
import { additionalAttemptConsent, freshAdditionalAttempt } from '../../../miniapp/src/lib/additional-attempt';

const req = createRequire(new URL('../../../miniapp/package.json', import.meta.url));
const { createElement } = req('react') as typeof import('react');
const { renderToStaticMarkup } = req('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
const { MemoryRouter } = req('react-router') as { MemoryRouter: ComponentType<{ children?: ReactNode }> };
const fixture = vi.hoisted(() => ({ quote: undefined as CardAdditionalAttemptQuoteDto | undefined,
  language: 'ru', fetching: false, error: null as unknown, mutate: vi.fn(), observed: [] as string[] }));
vi.mock('react-i18next', async () => {
  const { ru } = await import('../../../miniapp/src/i18n/ru'); const { en } = await import('../../../miniapp/src/i18n/en');
  return { useTranslation: () => ({ t: (key: string, values?: Record<string, string>) => String(key.split('.').reduce<any>((v, p) => v?.[p], fixture.language === 'ru' ? ru : en) ?? key)
    .replace(/\{\{(\w+)\}\}/g, (match, name: string) => values?.[name] ?? match) }) };
});
vi.mock('../../../miniapp/src/lib/format', () => ({ useFormat: () => ({ amount: (value: string, asset: string) => `${value} ${asset}`, error: () => 'Ошибка связи' }) }));
vi.mock('../../../miniapp/src/lib/telegram', () => ({ inTelegram: false, backButton: { show: vi.fn() }, haptic: { tap: vi.fn(), error: vi.fn() } }));
vi.mock('../../../miniapp/src/lib/queries', () => ({
  useAdditionalAttemptQuote: () => ({ data: fixture.quote, isFetching: fixture.fetching, error: fixture.error, refetch: vi.fn() }),
  useAdditionalAttempt: () => ({ mutate: fixture.mutate, isPending: false }),
}));
// The existing progress has its own DTO fixture suite; assert this screen selects the exact new operation.
vi.mock('../../../miniapp/src/screens/Wallet', () => ({ CardOperationProgress: ({ operationId }: { operationId: string }) => {
  fixture.observed.push(operationId); return createElement('div', null, 'Fixture operation progress');
} }));
const { CardAdditionalAttempt } = await vi.importActual<{ CardAdditionalAttempt: () => ReactElement }>('../../../miniapp/src/screens/CardAdditionalAttempt');
const { AdditionalAttemptEntry } = await vi.importActual<{ AdditionalAttemptEntry: () => ReactElement }>('../../../miniapp/src/components/AdditionalAttemptEntry');
const now = Date.parse('2026-10-17T00:00:00Z');
const valid = (): Extract<CardAdditionalAttemptQuoteDto, { eligible: true }> => ({ eligible: true, quoteToken: 'fixture-signed-risk-quote',
  expiresAt: '2099-10-17T00:05:00Z', termsVersion: 'additional-issue-v1', asset: 'USDT', fundingSource: 'broker',
  customerCharge: '0', additionalBrokerCostUsd: '10', retainedBrokerReserveUsd: '10', maximumCumulativeCostUsd: '20' });
const screen = (component = CardAdditionalAttempt) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(component)));
beforeEach(() => { vi.clearAllMocks(); fixture.quote = valid(); fixture.language = 'ru'; fixture.fetching = false; fixture.error = null; fixture.observed = [];
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No HTTP in risk consent fixture'); })); });
afterEach(() => { expect(fixture.mutate).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('human-only additional issuance consent', () => {
  it('shows the exact risk terms with an unchecked acknowledgement and disabled financial button', () => {
    const html = screen();
    expect(html).toContain('Результат первой попытки пока не подтверждён');
    expect(html).toContain('0 USDT'); expect(html).toContain('10 USD'); expect(html).toContain('20 USD');
    expect(html).toContain('две карты'); expect(html).toContain('Разрешить попытку за 10 USD от брокера');
    expect(html).toContain('type="checkbox"'); expect(html).not.toContain('checked=""');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Разрешить попытку за 10 USD от брокера<\/button>/);
    expect(html).not.toContain(valid().quoteToken); expect(html).not.toContain('Карта выпущена.');
  });
  it('keeps the English acknowledgement and costs explicit', () => {
    fixture.language = 'en'; const html = screen();
    expect(html).toContain('two cards'); expect(html).toContain('0 USDT'); expect(html).toContain('20 USD');
    expect(html).toContain('Authorize a 10 USD broker-funded attempt'); expect(html).not.toContain('checked=""');
  });
  it.each(['loading', 'refreshing', 'error', 'expired', 'unavailable'] as const)('cannot show a financial confirmation for %s terms', state => {
    if (state === 'loading') fixture.quote = undefined;
    if (state === 'refreshing') fixture.fetching = true;
    if (state === 'error') fixture.error = new Error('Private raw upstream error');
    if (state === 'expired') fixture.quote = { ...valid(), expiresAt: '2020-01-01T00:00:00Z' };
    if (state === 'unavailable') fixture.quote = { eligible: false, reason: 'unavailable' };
    const html = screen(); expect(html).not.toContain('Разрешить попытку за'); expect(html).not.toContain('Private raw');
  });
  it('shows an entry only for server eligibility and recovers the existing new operation after a lost response', () => {
    expect(screen(AdditionalAttemptEntry)).toContain('Рассмотреть дополнительную попытку');
    fixture.quote = { eligible: false, reason: 'unavailable' }; expect(screen(AdditionalAttemptEntry)).toBe('');
    const id = 'fixture-new-operation';
    fixture.quote = { eligible: false, reason: 'already_requested', existingOperation: { id, type: 'issue', status: 'processing', cardId: 'fixture-new-card',
      asset: 'USDT', amount: '0', fee: '0', error: null, createdAt: '2026-10-17T00:00:00Z' } };
    expect(screen()).toContain('Fixture operation progress'); expect(fixture.observed).toEqual([id]);
    expect(screen()).not.toContain(id);
  });
  it('requires acknowledgement of this exact unexpired quote for the explicit request body', () => {
    const quote = valid();
    expect(additionalAttemptConsent(quote, null, 'fixture-key', now)).toBeNull();
    expect(additionalAttemptConsent(quote, 'old-quote-token', 'fixture-key', now)).toBeNull();
    expect(additionalAttemptConsent(quote, quote.quoteToken, 'fixture-key', now)).toEqual({ quoteToken: quote.quoteToken,
      idempotencyKey: 'fixture-key', acceptedRisk: true, termsVersion: 'additional-issue-v1' });
    expect(additionalAttemptConsent(quote, quote.quoteToken, 'fixture-key', Date.parse(quote.expiresAt))).toBeNull();
  });
  it.each([{ ...valid(), customerCharge: '10' }, { ...valid(), fundingSource: 'wallet' }, { ...valid(), maximumCumulativeCostUsd: '30' },
    { ...valid(), expiresAt: 'not-a-date' }, { ...valid(), termsVersion: 'other' }])('fails closed instead of accepting malformed or changed risk terms', quote => {
    expect(freshAdditionalAttempt(quote as CardAdditionalAttemptQuoteDto, now)).toBeNull();
  });
});
