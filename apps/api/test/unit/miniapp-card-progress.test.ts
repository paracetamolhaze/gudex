import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import type { CardDto, OperationDto } from '@gudex/shared';
import { ApiError } from '../../../miniapp/src/lib/api';

// Use the MiniApp's React instance for its real SSR components; every API hook is a fixture.
const requireMiniapp = createRequire(new URL('../../../miniapp/package.json', import.meta.url));
const { createElement } = requireMiniapp('react') as typeof import('react');
const { renderToStaticMarkup } = requireMiniapp('react-dom/server') as { renderToStaticMarkup: (element: ReactNode) => string };
const { MemoryRouter } = requireMiniapp('react-router') as { MemoryRouter: ComponentType<{ children?: ReactNode }> };
// Vitest loads TSX; MiniApp's own typecheck checks its JSX without changing the API's TS config.
const { CardScreen } = await vi.importActual<{ CardScreen: () => ReactElement }>('../../../miniapp/src/screens/Card');
const { CardOperationProgress } = await vi.importActual<{ CardOperationProgress: (props: {
  operationId: string; title: string; kind: 'issue' | 'topup';
}) => ReactElement }>('../../../miniapp/src/screens/Wallet');
const fixture = vi.hoisted(() => ({ language: 'ru', operation: undefined as OperationDto | undefined,
  card: undefined as CardDto | undefined, quoteError: null as unknown, additionalRead: vi.fn() }));

vi.mock('react-i18next', async () => {
  const { ru } = await import('../../../miniapp/src/i18n/ru');
  const { en } = await import('../../../miniapp/src/i18n/en');
  return { useTranslation: () => ({ t: (key: string, values?: Record<string, string>) => {
    const message = key.split('.').reduce<any>((value, part) => value?.[part], fixture.language === 'ru' ? ru : en) ?? key;
    return String(message).replace(/\{\{(\w+)\}\}/g, (match, name: string) => values?.[name] ?? match);
  },
    i18n: { language: fixture.language } }) };
});
vi.mock('../../../miniapp/src/lib/telegram', () => ({ platform: 'web', inTelegram: false,
  backButton: { show: () => undefined }, haptic: { success: vi.fn(), error: vi.fn(), tap: vi.fn() } }));
vi.mock('../../../miniapp/src/lib/format', () => ({ useFormat: () => ({ amount: (value: string) => value, error: () => 'Fixture error' }) }));
vi.mock('../../../miniapp/src/components/security', () => ({ useConfirmation: () => ({ confirm: vi.fn(), element: null }) }));
vi.mock('../../../miniapp/src/components/misc', () => ({ ActivityRow: () => null, KycBanner: () => null,
  ServiceNotice: () => null, TestModeBanner: () => null, AssetPicker: () => null, NetworkPicker: () => null }));
vi.mock('../../../miniapp/src/components/Mascot', () => ({ Mascot: () => null, Celebrate: () => null }));
vi.mock('../../../miniapp/src/lib/queries', () => ({
  useOperation: (id: string | null) => ({ data: id ? fixture.operation : undefined, refetch: vi.fn() }),
  useCards: () => ({ data: fixture.card ? [fixture.card] : [], isLoading: false, refetch: vi.fn() }),
  useConfig: () => ({ data: { integration: { capabilities: { topup: true, freeze: true } } } }),
  useActivity: () => ({ data: [] }), useSetFrozen: () => ({ isPending: false }),
  useSimulatePurchase: () => ({ isPending: false }), useCardSensitive: () => ({ isPending: false }),
  useMe: () => ({}), useWallet: () => ({}), useIssueCard: () => ({}), useIssueQuote: () => ({}),
  useDepositAddress: () => ({}), useSimulateDeposit: () => ({}), useTopupCard: () => ({}), useTopupQuote: () => ({}),
  useAdditionalAttemptQuote: () => { fixture.additionalRead(); return { data: { eligible: false, reason: 'unavailable' }, error: fixture.quoteError }; },
}));

const operationId = '00000000-0000-4000-8000-000000000001';
const fetch = vi.fn(() => { throw new Error('Customer status fixtures must not use HTTP'); });
beforeEach(() => {
  fetch.mockClear();
  fixture.additionalRead.mockClear(); fixture.quoteError = null;
  vi.stubGlobal('fetch', fetch);
  fixture.language = 'ru';
  fixture.operation = { id: operationId, type: 'issue', status: 'unknown' } as OperationDto;
  fixture.card = { id: 'fixture-card', status: 'pending', pendingOperationStatus: 'unknown', balance: '0', last4: null } as CardDto;
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
const progress = (kind: 'issue' | 'topup' = 'issue') => renderToStaticMarkup(createElement(MemoryRouter, null,
  createElement(CardOperationProgress, { operationId, title: kind === 'issue' ? 'Выпуск карты' : 'Пополнение карты', kind })));

describe('customer card issuance progress', () => {
  it('shows the closed documented restriction on a pending card and operation without inventing failure or offering another attempt', () => {
    const raw = "The mobile phone area code of the customer's billing address is restricted!";
    fixture.operation = { ...fixture.operation!, issueRestriction: 'billing_phone_region_restricted', error: raw };
    fixture.card = { ...fixture.card!, issueRestriction: 'billing_phone_region_restricted', failureReason: raw };
    const cardHtml = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CardScreen)));
    for (const html of [progress(), cardHtml]) {
      expect(html).toContain('Для этой карты не поддерживается телефонный код, указанный в ваших данных.');
      expect(html).not.toContain('Проверяем результат выпуска.'); expect(html).not.toContain('Не удалось выпустить карту.');
      expect(html).not.toContain('Карта выпущена.'); expect(html).not.toContain(raw); expect(html).not.toContain(operationId);
    }
    expect(fixture.additionalRead).not.toHaveBeenCalled();
  });
  it('keeps the old unknown result intact while explaining a current typed restriction from the additional quote', () => {
    fixture.quoteError = new ApiError('card_region_restricted', 'PRIVATE upstream payload', 422);
    const html = progress();
    expect(html).toContain('Проверяем результат выпуска.');
    expect(html).toContain('Для этой карты не поддерживается телефонный код, указанный в ваших данных.');
    expect(html).not.toContain('PRIVATE'); expect(html).not.toContain('Разрешить попытку');
    expect(fixture.operation?.status).toBe('unknown'); expect(fixture.operation?.issueRestriction).toBeUndefined();
  });
  it('explains the documented restriction in English while retaining the operation state', () => {
    fixture.language = 'en'; fixture.operation = { ...fixture.operation!, issueRestriction: 'billing_phone_region_restricted' };
    const html = progress(); expect(html).toContain('The phone country code in your details is not supported for this card.');
    expect(html).not.toContain('We’re checking the issuance result.'); expect(fixture.operation.status).toBe('unknown');
  });
  it('does not infer a region restriction from an untyped upstream string or apply it to top-ups', () => {
    fixture.quoteError = new ApiError('provider_unavailable', 'billing address restricted', 503);
    expect(progress()).not.toContain('не поддерживается телефонный код');
    fixture.operation = { ...fixture.operation!, type: 'topup', issueRestriction: 'billing_phone_region_restricted' };
    expect(progress('topup')).toContain('Проверяем результат пополнения.');
  });
  it('shows a neutral unknown issuance result without a raw operation ID or a false success', () => {
    const html = progress();
    expect(html).toContain('Проверяем результат выпуска. Статус обновится автоматически.');
    expect(html).not.toContain(operationId);
    expect(html).not.toContain('зарезервирован');
    expect(html).not.toContain('Операция выполнена');
  });
  it('keeps the pending card as issuance and places its refresh action outside the status text', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CardScreen)));
    expect(html).toContain('Выпуск карты');
    expect(html).toContain('Проверяем результат выпуска. Статус обновится автоматически.');
    expect(html).not.toContain('На проверке');
    expect(html).not.toContain('Карта готова');
    expect(html).not.toMatch(/<div class="notice[^"]*">(?:(?!<\/div>)[\s\S])*<button[^>]*>Обновить[^<]*<\/button><\/div>/);
  });
  it.each(['pending', 'processing', undefined] as const)('does not announce success or failure while the issue DTO status is %s', status => {
    fixture.operation = status ? { ...fixture.operation!, status } : undefined;
    const html = progress();
    expect(html).toContain('Завершаем выпуск карты');
    expect(html).toContain('Запрос на выпуск принят. Статус обновится автоматически.');
    expect(html).not.toContain('Карта выпущена.');
    expect(html).not.toContain('Не удалось выпустить карту.');
    expect(html).not.toContain(operationId);
  });
  it('announces issuance only when the operation DTO succeeds', () => {
    fixture.operation = { ...fixture.operation!, status: 'succeeded' };
    const html = progress();
    expect(html).toContain('Карта выпущена.');
    expect(html).not.toContain('Завершаем выпуск карты');
    expect(html).not.toContain('Проверяем результат выпуска.');
  });
  it('shows a failed issue only for a failed DTO without inventing a customer refund', () => {
    fixture.operation = { ...fixture.operation!, status: 'failed' };
    const html = progress();
    expect(html).toContain('Не удалось выпустить карту.');
    expect(html).not.toContain('Карта выпущена.');
    expect(html).not.toContain('средства возвращены');
    expect(html).not.toContain('Завершаем выпуск карты');
  });
  it('uses a separate top-up message for an unknown top-up instead of announcing issuance', () => {
    fixture.operation = { ...fixture.operation!, type: 'topup' };
    const html = progress('topup');
    expect(html).toContain('Проверяем результат пополнения. Статус обновится автоматически.');
    expect(html).not.toContain('Проверяем результат выпуска.');
    expect(html).not.toContain('Карта пополнена.');
    expect(html).not.toContain('зарезервирован');
    expect(html).not.toContain(operationId);
  });
  it('keeps the English unknown issue and card placeholder neutral too', () => {
    fixture.language = 'en';
    const operationHtml = progress();
    const cardHtml = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CardScreen)));
    for (const html of [operationHtml, cardHtml]) {
      expect(html).toContain('We’re checking the issuance result. The status updates automatically.');
      expect(html).not.toContain('Funds remain reserved');
      expect(html).not.toContain('Card issued.');
      expect(html).not.toContain(operationId);
    }
    expect(cardHtml).toContain('Card issuance');
    expect(cardHtml).not.toContain('Under review');
  });
});
