import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import type { DepositInvoiceDto, DepositInvoiceOptionDto } from '@gudex/shared';
import { creditedInvoiceAmount, invoiceAmount, invoiceOptions, invoicePaymentLink, invoicePollMs, invoiceResumeId, invoiceResumeSearch, paymentLink } from '../../../miniapp/src/lib/deposit-invoice';

const req = createRequire(new URL('../../../miniapp/package.json', import.meta.url));
const { createElement } = req('react') as typeof import('react');
const { renderToStaticMarkup } = req('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
const { MemoryRouter } = req('react-router') as { MemoryRouter: ComponentType<{ children?: ReactNode; initialEntries?: string[] }> };
const fixture = vi.hoisted(() => ({ active: null as DepositInvoiceDto | null | undefined, options: [] as DepositInvoiceOptionDto[],
  observedData: undefined as DepositInvoiceDto | undefined, activeError: null as unknown, observedError: null as unknown, activeFetching: false, observedFetching: false,
  activeRead: vi.fn(), observedRead: vi.fn(), optionsRead: vi.fn(), create: vi.fn(), retry: vi.fn(), open: vi.fn() }));
vi.mock('react-i18next', async () => { const { ru } = await import('../../../miniapp/src/i18n/ru'); return { useTranslation: () => ({
  t: (key: string, values?: Record<string, string>) => String(key.split('.').reduce<any>((value, part) => value?.[part], ru) ?? key)
    .replace(/\{\{(\w+)\}\}/g, (match, name: string) => values?.[name] ?? match), i18n: { language: 'ru' } }) }; });
vi.mock('../../../miniapp/src/lib/telegram', () => ({ inTelegram: false, backButton: { show: vi.fn() }, openLink: (...args: unknown[]) => fixture.open(...args),
  haptic: { tap: vi.fn(), success: vi.fn(), error: vi.fn(), select: vi.fn() } }));
vi.mock('../../../miniapp/src/lib/format', () => ({ useFormat: () => ({ error: () => 'Ошибка связи' }) }));
vi.mock('../../../miniapp/src/i18n', () => ({ setLocale: vi.fn() }));
vi.mock('../../../miniapp/src/lib/queries', () => ({
  useDepositInvoiceOptions: (enabled?: boolean) => { fixture.optionsRead(enabled); return { data: fixture.options, refetch: vi.fn() }; },
  useActiveDepositInvoice: (enabled?: boolean) => { fixture.activeRead(enabled); return { data: fixture.active, error: fixture.activeError, isFetching: fixture.activeFetching, refetch: vi.fn() }; },
  useDepositInvoice: (id: string | null) => { fixture.observedRead(id); return { data: id ? fixture.observedData ?? fixture.active : undefined,
    error: fixture.observedError, isFetching: fixture.observedFetching, refetch: vi.fn() }; },
  useCreateDepositInvoice: () => ({ mutate: fixture.create, isPending: false, reset: vi.fn() }), useInvalidateMoney: () => vi.fn(), useNotice: () => ({}),
  useRetryDepositInvoice: () => ({ mutate: fixture.retry, isPending: false }),
}));
const { DepositCheckout } = await vi.importActual<{ DepositCheckout: (props: { creationEnabled?: boolean }) => ReactElement }>('../../../miniapp/src/screens/DepositCheckout');
const option: DepositInvoiceOptionDto = { asset: 'USDT', network: 'TRC20', decimals: 2, minAmount: '10', maxAmount: '100' };
const invoice = (state: DepositInvoiceDto['state'] = 'awaiting_payment'): DepositInvoiceDto => ({ id: 'fixture-private-invoice-id', state,
  asset: 'USDT', network: 'TRC20', requestedAmount: '10', creditedAmount: null,
  paymentUrl: 'https://quick.upay.best/payment?token=fixture-private-token#opaque-spa', expiresAt: '2099-01-01T00:00:00Z', createdAt: '2026-10-17T00:00:00Z' });
const screen = (creationEnabled = true, route = '/deposit?asset=USDT&amount=10&returnTo=issue') => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [route] }, createElement(DepositCheckout, { creationEnabled })));
beforeEach(() => { vi.clearAllMocks(); fixture.active = null; fixture.options = [option]; fixture.activeError = null; fixture.observedError = null;
  fixture.observedData = undefined; fixture.activeFetching = false; fixture.observedFetching = false; vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No HTTP in invoice UI fixtures'); })); });
afterEach(() => { expect(fixture.create).not.toHaveBeenCalled(); expect(fixture.retry).not.toHaveBeenCalled(); expect(fixture.open).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('invoice checkout customer journey', () => {
  it('restores an exact credited invoice and issue intent after query cache was cleared and active is already null', () => {
    const id = '00000000-0000-4000-8000-000000000042';
    fixture.active = null; fixture.observedData = { ...invoice('credited'), id, creditedAmount: '9.123456' };
    const html = screen(false, `/deposit?invoiceId=${id}&returnTo=issue`);
    expect(fixture.activeRead).toHaveBeenCalledWith(false); expect(fixture.observedRead).toHaveBeenCalledWith(id);
    expect(html).toContain('Пополнение зачислено'); expect(html).toContain('Продолжить выпуск карты');
    expect(html).not.toContain(id); expect(html).not.toContain('Создать счёт на оплату');
  });
  it('does not replace an exact restored invoice with a different cached active invoice or a new creation form', () => {
    const id = '00000000-0000-4000-8000-000000000042'; fixture.active = invoice();
    const html = screen(true, `/deposit?invoiceId=${id}&returnTo=issue`);
    expect(html).not.toContain('Счёт готов к оплате'); expect(html).not.toContain('Создать счёт на оплату');
  });
  it('reads a prior unpaid invoice while creation is disabled and never requests the disabled catalog', () => {
    fixture.active = invoice(); const html = screen(false);
    expect(html).toContain('Счёт готов к оплате'); expect(html).toContain('Открыть оплату');
    expect(fixture.optionsRead).toHaveBeenCalledWith(false); expect(html).not.toContain('Создать счёт на оплату');
  });
  it.each([null, 'prepared', 'expired'] as const)('does not offer creation or retry when disabled and the own invoice is %s', state => {
    fixture.active = state ? invoice(state) : null; const html = screen(false);
    expect(html).not.toContain('Создать счёт на оплату'); expect(html).not.toContain('Создать новый счёт');
    expect(html).not.toMatch(/<button[^>]*>Повторить<\/button>/); expect(fixture.optionsRead).toHaveBeenCalledWith(false);
  });
  it('waits for a fresh own-active read and never creates an invoice while resuming or after a read error', () => {
    for (const state of ['loading', 'refreshing', 'error'] as const) {
      fixture.active = state === 'loading' ? undefined : null;
      fixture.activeFetching = state === 'refreshing'; fixture.activeError = state === 'error' ? new Error('Private upstream reason') : null;
      const html = screen(); expect(html).not.toContain('Создать счёт на оплату'); expect(html).not.toContain('Private upstream');
    }
  });
  it('shows only provider-supported choices and waits for an explicit create action even with a prefilled shortage', () => {
    const html = screen(); expect(html).toContain('Создать счёт на оплату'); expect(html).toContain('value="10"');
    expect(html).toContain('TRC20'); expect(html).not.toContain('USDC'); expect(html).not.toContain('BEP20');
    expect(html).toContain('Итоговая сумма зачисления может быть меньше'); expect(html).not.toContain('Ваш адрес для пополнения');
  });
  it('resumes an unpaid invoice without exposing its private link or internal ID and never opens payment automatically', () => {
    fixture.active = invoice(); const html = screen();
    expect(html).toContain('Счёт готов к оплате'); expect(html).toContain('Открыть оплату'); expect(html).not.toContain('Создать счёт на оплату');
    expect(html).not.toContain(fixture.active.id); expect(html).not.toContain('fixture-private-token'); expect(html).not.toContain('quick.upay.best');
    expect(html).not.toContain('qr'); expect(html).not.toContain('Ваш адрес для пополнения');
  });
  it.each(['prepared', 'sending', 'confirming', 'unknown', 'expired'] as const)('keeps %s distinct from credited and hides any stale payment URL', state => {
    fixture.active = invoice(state); const html = screen();
    expect(html).not.toContain('Открыть оплату'); expect(html).not.toContain('Пополнение зачислено');
    expect(html).not.toContain('Продолжить выпуск карты'); expect(html).not.toContain('Создать счёт на оплату');
    expect(html).toContain('Проверить статус');
    expect(html.includes('Создать новый счёт')).toBe(state === 'expired');
    expect(/<button[^>]*>Повторить<\/button>/.test(html)).toBe(state === 'prepared');
  });
  it.each(['refreshing', 'error', 'expiredLink'] as const)('does not use retained unpaid data when %s', state => {
    fixture.active = invoice(); fixture.observedFetching = state === 'refreshing';
    fixture.observedError = state === 'error' ? new Error('Private error') : null;
    if (state === 'expiredLink') fixture.active.expiresAt = '2020-01-01T00:00:00Z';
    expect(screen()).not.toContain('Открыть оплату');
  });
  it('shows the actual net credit and offers a separate card action without issuing automatically', () => {
    fixture.active = { ...invoice('credited'), creditedAmount: '9.123456' }; const html = screen();
    expect(html).toContain('Пополнение зачислено'); expect(html).toContain('9.123456 USDT'); expect(html).toContain('Продолжить выпуск карты');
    expect(html).not.toContain('Открыть оплату'); expect(html).not.toContain('Выпустить карту');
    fixture.active.creditedAmount = null; expect(screen()).not.toContain('Пополнение зачислено');
  });
});

describe('invoice amount and payment boundaries', () => {
  it('keeps only an invoice identifier and safe continuation fields in memory navigation', () => {
    const id = '00000000-0000-4000-8000-000000000042';
    const params = new URLSearchParams('asset=USDT&amount=10&returnTo=issue&paymentUrl=https://evil.test&token=private&pin=1234');
    expect(invoiceResumeSearch(params, id).toString()).toBe(`asset=USDT&amount=10&returnTo=issue&invoiceId=${id}`);
    expect(invoiceResumeSearch(params, null).toString()).toBe('asset=USDT&amount=10&returnTo=issue');
    expect(invoiceResumeId('not-an-invoice')).toBeNull(); expect(invoiceResumeId(id)).toBe(id);
  });
  it('uses exact minor amounts and the selected native option boundaries', () => {
    expect(invoiceAmount(option, '10,00')).toBe('10'); expect(invoiceAmount(option, '9.999999')).toBeNull();
    expect(invoiceAmount(option, '10.001')).toBeNull();
    expect(invoiceAmount(option, '100')).toBe('100'); expect(invoiceAmount(option, '100.000001')).toBeNull();
    expect(invoiceAmount(option, 'NaN')).toBeNull(); expect(invoiceAmount(option, '10.0000001')).toBeNull();
    expect(invoiceOptions([option, { ...option, minAmount: '0' }])).toEqual([]);
  });
  it('preserves opaque provider query/fragment on the exact approved HTTPS origin', () => {
    expect(paymentLink(invoice().paymentUrl)).toBe(invoice().paymentUrl);
    expect(paymentLink('https://quick.upay.best:443/payment?token=opaque')).toBe('https://quick.upay.best:443/payment?token=opaque');
  });
  it.each(['javascript:alert(1)', 'http://quick.upay.best/pay', 'https://quick.upay.best.evil.test/pay',
    'https://user:secret@quick.upay.best/pay', 'https://quick.upay.best:444/pay', 'https://evil.test/?next=https://quick.upay.best',
    ' https://quick.upay.best/pay'])('rejects an unapproved payment URL', value => { expect(paymentLink(value)).toBeNull(); });
  it('opens only an unexpired unpaid invoice and observes every nonterminal state through read-only polling', () => {
    const now = Date.parse('2026-10-17T00:00:00Z');
    expect(invoicePaymentLink(invoice(), now)).toBe(invoice().paymentUrl);
    for (const state of ['prepared', 'sending', 'confirming', 'unknown', 'credited', 'expired'] as const) expect(invoicePaymentLink(invoice(state), now)).toBeNull();
    expect(invoicePaymentLink({ ...invoice(), expiresAt: new Date(now).toISOString() }, now)).toBeNull();
    expect(invoicePollMs(invoice('awaiting_payment'))).toBe(5000); expect(invoicePollMs(invoice('unknown'))).toBe(15000);
    expect(invoicePollMs(invoice('credited'))).toBe(false); expect(invoicePollMs(invoice('expired'))).toBe(false);
    expect(creditedInvoiceAmount({ ...invoice('credited'), creditedAmount: '9.123456' })).toBe('9.123456');
    expect(creditedInvoiceAmount({ ...invoice('confirming'), creditedAmount: '10' })).toBeNull();
  });
});
