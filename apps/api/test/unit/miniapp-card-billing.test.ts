import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import type { CardBillingAddressDto, CardDto } from '@gudex/shared';
import { cardBillingReady, validCardBillingAddress } from '../../../miniapp/src/lib/billing';
import { ApiError } from '../../../miniapp/src/lib/api';

const requireMiniapp = createRequire(new URL('../../../miniapp/package.json', import.meta.url));
const { createElement } = requireMiniapp('react') as typeof import('react');
const { renderToStaticMarkup } = requireMiniapp('react-dom/server') as { renderToStaticMarkup: (element: ReactNode) => string };
const { MemoryRouter } = requireMiniapp('react-router') as { MemoryRouter: ComponentType<{ children?: ReactNode }> };
const fixture = vi.hoisted(() => ({ billing: undefined as CardBillingAddressDto | undefined, fetching: false, error: null as unknown,
  source: 'wallet' as 'wallet' | 'broker', cards: [] as CardDto[] | undefined, cardsError: null as unknown,
  cardsFetching: false, walletAmount: '100', quoteError: null as unknown, issueError: null as unknown, issue: vi.fn(), save: vi.fn(), manual: false }));
vi.mock('react-i18next', async () => {
  const { ru } = await import('../../../miniapp/src/i18n/ru');
  return { useTranslation: () => ({ t: (key: string, values?: Record<string, string>) => String(key.split('.').reduce<any>((value, part) => value?.[part], ru) ?? key)
    .replace(/\{\{(\w+)\}\}/g, (match, name: string) => values?.[name] ?? match), i18n: { language: 'ru' } }) };
});
vi.mock('../../../miniapp/src/lib/telegram', () => ({ inTelegram: false, backButton: { show: () => undefined }, haptic: { success: vi.fn(), error: vi.fn(), tap: vi.fn() } }));
vi.mock('../../../miniapp/src/lib/format', () => ({ useFormat: () => ({ amount: (value: string, asset: string) => `${value} ${asset}`, error: () => 'Ошибка загрузки' }) }));
vi.mock('../../../miniapp/src/components/misc', () => ({ AssetPicker: () => null, NetworkPicker: () => null, ServiceNotice: () => null, TestModeBanner: () => null }));
vi.mock('../../../miniapp/src/lib/queries', () => ({
  useCardBillingAddress: () => ({ data: fixture.billing, isFetching: fixture.fetching, error: fixture.error, refetch: vi.fn() }),
  useCardBillingCountries: () => ({ data: [{ id: 'fixture-zimbabwe', name: 'Zimbabwe', code: 'ZW' },
    { id: 'fixture-country', name: 'Kazakhstan', code: 'KZ' }, { id: 'fixture-australia', name: 'Australia', code: 'AU' }], refetch: vi.fn() }),
  useSaveCardBillingAddress: () => ({ mutate: fixture.save, reset: vi.fn(), isPending: false }),
  useConfig: () => ({ data: { card: { productName: 'Fixture Visa' }, integration: { capabilities: { issue: true }, deposits: 'disabled',
    ...(fixture.manual ? { issuanceMode: 'manual', feeWallet: { fee: '10', networks: [{ network: 'TRC20', assets: ['USDT'] }] } } : {}) } } }),
  useFeePayment: () => ({ data: null, isPending: false, error: null, refetch: vi.fn() }),
  useCreateFeePayment: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
  useInvalidateMoney: () => vi.fn(),
  useWallet: () => ({ data: { balances: [{ asset: 'USDT', amount: fixture.walletAmount }] } }),
  useMe: () => ({ data: undefined }),
  useCards: () => ({ data: fixture.cards, isFetching: fixture.cardsFetching, error: fixture.cardsError, refetch: vi.fn() }),
  useIssueCard: () => ({ mutate: fixture.issue, isPending: false, error: fixture.issueError }),
  useIssueQuote: () => ({ data: { asset: 'USDT', fee: '10', customerCharge: fixture.source === 'broker' ? '0' : '10', fundingSource: fixture.source },
    isFetching: false, isStale: false, error: fixture.quoteError }),
  useOperation: (id: string) => ({ data: fixture.cards?.some(card => card.pendingOperationId === id) ? { id, status: fixture.cards[0]?.pendingOperationStatus } : undefined }),
  useAdditionalAttemptQuote: () => ({ data: { eligible: false, reason: 'unavailable' } }),
  useDepositAddress: () => ({}), useSimulateDeposit: () => ({}), useTopupCard: () => ({}), useTopupQuote: () => ({}),
}));
const { CardIssue } = await vi.importActual<{ CardIssue: () => ReactElement }>('../../../miniapp/src/screens/Wallet');
const { CardBilling } = await vi.importActual<{ CardBilling: () => ReactElement }>('../../../miniapp/src/screens/CardBilling');
const address = { countryId: 'fixture-country', postalCode: '0500', address: 'Almaty, Abay Ave 10, Apt 5' };
const screen = (component: () => ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(component)));
beforeEach(() => {
  vi.clearAllMocks(); fixture.billing = { required: true, status: 'missing', address: null }; fixture.fetching = false; fixture.error = null; fixture.source = 'wallet';
  fixture.cards = []; fixture.cardsError = null; fixture.cardsFetching = false;
  fixture.quoteError = null; fixture.issueError = null; fixture.walletAmount = '100'; fixture.manual = false;
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No HTTP in customer billing fixtures'); }));
});
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); expect(fixture.issue).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('card billing address before issuance', () => {
  it.each(['quote', 'preflight'] as const)('explains a typed phone-code restriction from %s and disables issuance without showing raw upstream text', source => {
    fixture.billing = { required: false, status: 'ready', address: null };
    const error = new ApiError('card_region_restricted', 'PRIVATE phone region upstream error', 422);
    if (source === 'quote') fixture.quoteError = error; else fixture.issueError = error;
    const html = screen(CardIssue);
    expect(html).toContain('Для этой карты не поддерживается телефонный код, указанный в ваших данных.');
    expect(html).not.toContain('PRIVATE'); expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Выпустить/);
  });
  it('does not imply that adding wallet funds can remove a known card region restriction', () => {
    fixture.billing = { required: false, status: 'ready', address: null }; fixture.walletAmount = '0';
    fixture.issueError = new ApiError('card_region_restricted', 'Private raw reason', 422);
    const html = screen(CardIssue);
    expect(html).toContain('не поддерживается телефонный код'); expect(html).not.toContain('Для выпуска не хватает');
    expect(html).not.toContain('Пополнение пока недоступно');
  });
  it.each(['pending', 'processing', 'unknown'] as const)('resumes the exact own %s issue after a relock or lost response without a new issuance confirmation', status => {
    const id = '00000000-0000-4000-8000-000000000043';
    fixture.cards = [{ id: 'fixture-own-card', status: 'pending', pendingOperationId: id, pendingOperationStatus: status,
      productName: 'Fixture Visa', last4: null, holderName: null, expiryMonth: null, expiryYear: null, currency: 'USD', balance: '0', failureReason: null, topupAddresses: [], createdAt: '2026-10-17T00:00:00Z' }];
    const html = screen(CardIssue);
    expect(html).toContain(status === 'unknown' ? 'Проверяем заявку на карту' : 'Запрос на выпуск принят.');
    expect(html).not.toContain('Укажите свой адрес латиницей.');
    expect(html).not.toContain('Сохранить адрес'); expect(html).not.toContain('Выпустить за'); expect(html).not.toContain(id);
  });
  it('waits for the initial own-card read and refuses another issue confirmation when that read fails', () => {
    fixture.billing = { required: false, status: 'ready', address: null };
    fixture.cards = undefined; expect(screen(CardIssue)).not.toContain('Выпустить за');
    fixture.cardsError = new Error('Private card read failure'); expect(screen(CardIssue)).not.toContain('Выпустить за');
  });
  it('disables issuance while refreshing cached empty cards without unmounting the address editor', () => {
    fixture.cardsFetching = true;
    fixture.billing = { required: false, status: 'ready', address: null };
    const html = screen(CardIssue);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Выпустить за 10 USDT<\/button>/);
    fixture.billing = { required: true, status: 'missing', address: null };
    expect(screen(CardIssue)).toContain('Сохранить адрес');
  });
  it('collects the required own address before showing the financial confirmation', () => {
    const html = screen(CardIssue);
    expect(html).toContain('Страна проживания'); expect(html).toContain('Укажите свой адрес латиницей.');
    expect(html).toContain('Почтовый индекс'); expect(html).toContain('Город, улица, дом, квартира'); expect(html).toContain('Сохранить адрес');
    expect(html).not.toContain('Выпустить за'); expect(html).not.toContain('Fixture Visa'); expect(html).not.toContain('UPay');
  });
  it.each(['loading', 'refreshing', 'error', 'pending'] as const)('does not let a %s address authorize a financial action', state => {
    if (state === 'loading') fixture.billing = undefined;
    if (state === 'refreshing') { fixture.billing = { required: true, status: 'ready', address }; fixture.fetching = true; }
    if (state === 'error') fixture.error = new Error('PRIVATE upstream message');
    if (state === 'pending') fixture.billing = { required: true, status: 'pending', address };
    const html = screen(CardIssue);
    expect(html).not.toContain('Fixture Visa'); expect(html).not.toContain('PRIVATE'); expect(html).not.toContain('Выпустить за');
  });
  it('offers the app wallet payment instead of a deposit when manual issuance lacks the fee', () => {
    fixture.billing = { required: true, status: 'ready', address }; fixture.walletAmount = '0'; fixture.manual = true;
    const html = screen(CardIssue);
    expect(html).toContain('Оплатите выпуск на кошелёк GUDEX');
    expect(html).toContain('Получить адрес для оплаты');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Выпустить/);
  });
  it('shows the actual 10 USDT consent only after the required address is ready', () => {
    fixture.billing = { required: true, status: 'ready', address };
    const html = screen(CardIssue);
    expect(html).toContain('Fixture Visa'); expect(html).toContain('10 USDT'); expect(html).toContain(address.address);
    expect(html).not.toContain('Выпуск за счёт брокера');
  });
  it('preserves the single test-account sponsorship notice with a zero customer charge', () => {
    fixture.billing = { required: true, status: 'ready', address }; fixture.source = 'broker';
    const html = screen(CardIssue);
    expect(html).toContain('Выпуск за счёт брокера — один раз для тестового аккаунта'); expect(html).toContain('0 USDT');
    expect(html).not.toContain('Выпустить за 10');
  });
  it('keeps a provider without an address requirement usable', () => {
    fixture.billing = { required: false, status: 'ready', address: null };
    expect(screen(CardIssue)).toContain('Fixture Visa');
  });
  it('lets an existing unknown-card customer save their address independently without promising or triggering issuance', () => {
    const html = screen(CardBilling);
    expect(html).not.toContain('Сохранение адреса не запускает выпуск карты.'); expect(html).toContain('Сохранить адрес');
    expect(html.indexOf('Australia')).toBeLessThan(html.indexOf('Kazakhstan'));
    expect(html.indexOf('Kazakhstan')).toBeLessThan(html.indexOf('Zimbabwe'));
    expect(html).not.toContain('Выпустить карту'); expect(html).not.toContain('Выпустить за');
  });
  it.each([
    { ...address, postalCode: '123' }, { ...address, postalCode: '12345678901' }, { ...address, postalCode: 'А123' },
    { ...address, address: 'Алматы, Абая 10' }, { ...address, address: 'A'.repeat(201) }, { ...address, address: '   ' },
    { ...address, countryId: '' },
  ])('rejects invalid address input and cannot mark it ready', input => {
    expect(validCardBillingAddress(input)).toBe(false);
    expect(cardBillingReady({ required: true, status: 'ready', address: input })).toBe(false);
  });
  it('accepts the native postal boundaries and a complete Latin address', () => {
    expect(validCardBillingAddress(address)).toBe(true);
    expect(validCardBillingAddress({ ...address, postalCode: 'AB 12-34.5' })).toBe(true);
    expect(cardBillingReady(undefined)).toBe(false);
    expect(cardBillingReady({ required: true, status: 'ready', address: null })).toBe(false);
  });
});
