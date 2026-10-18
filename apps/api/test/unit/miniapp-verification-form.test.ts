import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentType, ReactElement, ReactNode } from 'react';

const requireMiniapp = createRequire(new URL('../../../miniapp/package.json', import.meta.url));
const { createElement } = requireMiniapp('react') as typeof import('react');
const { renderToStaticMarkup } = requireMiniapp('react-dom/server') as { renderToStaticMarkup: (element: ReactNode) => string };
const { MemoryRouter } = requireMiniapp('react-router') as { MemoryRouter: ComponentType<{ children?: ReactNode }> };
vi.mock('react-i18next', async () => {
  const { ru } = await import('../../../miniapp/src/i18n/ru');
  return { useTranslation: () => ({ t: (key: string, values?: Record<string, string>) => String(key.split('.').reduce<any>((value, part) => value?.[part], ru) ?? key)
    .replace(/\{\{(\w+)\}\}/g, (match, name: string) => values?.[name] ?? match), i18n: { language: 'ru' } }) };
});
vi.mock('../../../miniapp/src/lib/telegram', () => ({ inTelegram: false, platform: 'unknown', backButton: { show: () => undefined }, haptic: { success: vi.fn(), error: vi.fn(), select: vi.fn(), tap: vi.fn() } }));
vi.mock('../../../miniapp/src/lib/format', () => ({ useFormat: () => ({ amount: (value: string, asset: string) => `${value} ${asset}`, error: () => 'Ошибка' }) }));
vi.mock('../../../miniapp/src/components/misc', () => ({ ActivityRow: () => null, AssetPicker: () => null, LanguageSwitch: () => null }));
vi.mock('../../../miniapp/src/components/security', () => ({ BIOMETRY_ICON: 'shield', PinCreateFlow: () => null, useBiometricEnrollment: () => ({}) }));
vi.mock('../../../miniapp/src/components/FeePayment', () => ({ FeePaymentPanel: () => null }));
vi.mock('../../../miniapp/src/lib/session', () => ({ useSession: () => ({}) }));
vi.mock('../../../miniapp/src/lib/admin', () => ({ useAdminAccess: () => ({ data: undefined }) }));
vi.mock('../../../miniapp/src/screens/Card', () => ({ CardDetails: () => null, useRevealDetails: () => ({}), walletName: () => '' }));
vi.mock('../../../miniapp/src/lib/queries', () => ({
  useMe: () => ({ data: { kyc: { status: 'none', submissionState: 'none', rejectionReason: null } }, isLoading: false, error: null, refetch: vi.fn() }),
  useRecheckKyc: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useCards: () => ({ data: [], error: null, refetch: vi.fn() }),
  useConfig: () => ({ data: { integration: { issuanceMode: 'manual', deposits: 'disabled', capabilities: { kyc: true },
    feeWallet: { fee: '10', networks: [{ network: 'TRC20', assets: ['USDT'] }] } } }, error: null, refetch: vi.fn() }),
  useKycRequirements: () => ({ data: { enabled: true, live: true, documentsRequired: true, selfieRequired: false, documentTypes: ['passport', 'id_card'], maxUploadBytes: 5_000_000 }, error: null }),
  useSubmitKyc: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useSubmitCardApplication: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
  useWallet: () => ({ data: { balances: [{ asset: 'USDT', amount: '0' }] }, error: null }),
  useIssueQuote: () => ({ data: { asset: 'USDT', fee: '10', customerCharge: '10', fundingSource: 'wallet' }, isFetching: false, isStale: false, error: null }),
  useCardBillingCountries: () => ({ data: [{ id: 'KZ', name: 'Kazakhstan', code: 'KZ' }, { id: 'JP', name: 'Japan', code: 'JP' }], error: null, refetch: vi.fn() }),
  useActivity: () => ({}), useUpdateLocale: () => ({}),
}));
const { Kyc } = await vi.importActual<{ Kyc: () => ReactElement }>('../../../miniapp/src/screens/Other');
const options = (html: string, label: string) => {
  const field = html.slice(html.indexOf(label));
  return [...field.slice(0, field.indexOf('</select>')).matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(match => ({ code: match[1], name: match[2] }));
};

describe('verification form of a new client', () => {
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Kyc)));

  it('is called verification, without the old intro and photo texts', () => {
    expect(html).toContain('Верификация');
    expect(html).not.toContain('нкет');
    expect(html).not.toContain('Фото отправляются');
    expect(html).not.toContain('Адрес для карты');
    expect(html).toContain('Отправить на проверку');
  });

  it('offers every country for citizenship in a dropdown, alphabetically', () => {
    const citizenship = options(html, 'Гражданство');
    expect(citizenship[0]).toEqual({ code: '', name: 'Выберите страну' });
    expect(citizenship.length).toBeGreaterThan(240);
    const names = citizenship.slice(1).map(option => option.name);
    expect(names).toEqual([...names].sort(new Intl.Collator('ru', { sensitivity: 'base' }).compare));
    expect(citizenship).toContainEqual({ code: 'KZ', name: 'Казахстан' });
    expect(citizenship).toContainEqual({ code: 'JP', name: 'Япония' });
  });

  it('asks the country once, in the documents section; the address is plain fields without a country', () => {
    expect(html.match(/<select/g)).toHaveLength(1);
    expect(html).not.toContain('Страна проживания');
    expect(html).not.toContain('Страна выдачи документа');
    expect(html.indexOf('Документы')).toBeLessThan(html.indexOf('Гражданство'));
    expect(html.indexOf('Гражданство')).toBeLessThan(html.indexOf('>Документ</span>'));
    expect(html.indexOf('Почтовый индекс')).toBeLessThan(html.indexOf('Документы'));
  });
});
