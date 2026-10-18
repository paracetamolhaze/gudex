import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType, ReactElement, ReactNode } from 'react';

const req = createRequire(new URL('../../../miniapp/package.json', import.meta.url));
const { createElement } = req('react') as typeof import('react');
const { renderToStaticMarkup } = req('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
const { MemoryRouter } = req('react-router') as { MemoryRouter: ComponentType<{ children?: ReactNode }> };
const fixture = vi.hoisted(() => ({ flow: 'checkout' as string | undefined, readable: false, address: vi.fn(), create: vi.fn(), manual: false,
  cards: [] as { status: string; topupAddresses: { asset: string; network: string; address: string }[] }[] }));
vi.mock('react-i18next', async () => { const { ru } = await import('../../../miniapp/src/i18n/ru'); return { useTranslation: () => ({
  t: (key: string) => String(key.split('.').reduce<any>((value, part) => value?.[part], ru) ?? key), i18n: { language: 'ru' } }) }; });
vi.mock('../../../miniapp/src/lib/telegram', () => ({ inTelegram: false, backButton: { show: vi.fn() }, haptic: { tap: vi.fn(), success: vi.fn() } }));
vi.mock('../../../miniapp/src/lib/format', () => ({ useFormat: () => ({ amount: (value: string) => value, error: () => 'Fixture error' }) }));
vi.mock('../../../miniapp/src/components/misc', () => ({ ServiceNotice: () => null, TestModeBanner: () => null, NetworkPicker: () => null, AssetPicker: () => null }));
vi.mock('../../../miniapp/src/lib/queries', () => ({
  useConfig: () => ({ data: { integration: { deposits: 'live', depositFlow: fixture.flow, depositInvoiceRead: fixture.readable,
    ...(fixture.manual ? { issuanceMode: 'manual' } : {}) }, exchange: { ready: true } } }),
  useDepositAddress: (...args: unknown[]) => { fixture.address(...args); return { data: { asset: 'USDT', network: 'TRC20', demo: false,
    address: 'T'.repeat(34), minAmount: '10' } }; }, useSimulateDeposit: () => ({}), useCards: () => ({ data: fixture.cards }),
}));
// This suite checks the routing boundary; invoice details are covered by their own customer fixtures.
vi.mock('../../../miniapp/src/screens/DepositCheckout', () => ({ DepositCheckout: ({ creationEnabled }: { creationEnabled: boolean }) => createElement('div',
  { 'data-creation-enabled': String(creationEnabled) }, 'Own invoice checkout fixture') }));
const { Deposit } = await vi.importActual<{ Deposit: () => ReactElement }>('../../../miniapp/src/screens/Wallet');
const screen = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Deposit)));
beforeEach(() => { vi.clearAllMocks(); fixture.flow = 'checkout'; fixture.readable = false; fixture.manual = false; fixture.cards = []; vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No HTTP in deposit routing fixture'); })); });
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('checkout funding cannot fall back to a wallet address', () => {
  it('branches to the invoice checkout without allocating a blockchain address or showing WhiteBird', () => {
    const html = screen();
    expect(fixture.address).not.toHaveBeenCalled(); expect(html).toContain('Own invoice checkout fixture');
    expect(html).not.toContain('Ваш адрес для пополнения'); expect(html).not.toContain('Купить картой'); expect(html).not.toContain('<svg');
  });
  it.each(['disabled', undefined])('fails closed when depositFlow is %s even if a legacy mode says live', flow => {
    fixture.flow = flow; const html = screen(); expect(fixture.address).not.toHaveBeenCalled();
    expect(html).not.toContain('Ваш адрес для пополнения'); expect(html).not.toContain('Own invoice checkout fixture');
  });
  it('with manual issuance shows the addresses UPay gave the active card instead of any balance funding', () => {
    fixture.manual = true;
    fixture.cards = [{ status: 'active', topupAddresses: [{ asset: 'USDT', network: 'TRC20', address: 'TFjNAkJfs8GTz3f7Zf34jXvyPnbka1Ev6y' }] }];
    const html = screen();
    expect(html).toContain('Пополнение карты'); expect(html).toContain('TFjNAkJfs8GTz3f7Zf34jXvyPnbka1Ev6y');
    expect(html).not.toContain('Own invoice checkout fixture'); expect(fixture.address).not.toHaveBeenCalled();
  });
  it('preserves the existing address integration only when it is explicitly selected', () => {
    fixture.flow = 'address'; expect(screen()).toContain('Ваш адрес для пополнения'); expect(fixture.address).toHaveBeenCalledOnce();
  });
  it('keeps own invoice reads reachable with creation disabled without claiming that new funding is enabled', () => {
    fixture.flow = 'disabled'; fixture.readable = true;
    const html = screen(); expect(html).toContain('Own invoice checkout fixture');
    expect(html).toContain('data-creation-enabled="false"'); expect(fixture.address).not.toHaveBeenCalled();
  });
});
