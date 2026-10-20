import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { FeePaymentDto, FeeWalletDto } from '@gudex/shared';

const requireMiniapp = createRequire(new URL('../../../miniapp/package.json', import.meta.url));
const { createElement } = requireMiniapp('react') as typeof import('react');
const { renderToStaticMarkup } = requireMiniapp('react-dom/server') as { renderToStaticMarkup: (element: ReactNode) => string };
const fixture = vi.hoisted(() => ({ payment: null as FeePaymentDto | null }));
vi.mock('react-i18next', async () => {
  const { ru } = await import('../../../miniapp/src/i18n/ru');
  return { useTranslation: () => ({ t: (key: string, values?: Record<string, string>) => String(key.split('.').reduce<any>((value, part) => value?.[part], ru) ?? key)
    .replace(/\{\{(\w+)\}\}/g, (match, name: string) => String(values?.[name] ?? match)), i18n: { language: 'ru' } }) };
});
vi.mock('../../../miniapp/src/lib/telegram', () => ({ haptic: { success: vi.fn(), error: vi.fn(), select: vi.fn() } }));
vi.mock('../../../miniapp/src/lib/format', () => ({ useFormat: () => ({ error: () => 'Ошибка' }) }));
vi.mock('../../../miniapp/src/lib/queries', () => ({
  useFeePayment: () => ({ data: fixture.payment, dataUpdatedAt: Date.now(), isPending: false, error: null, refetch: vi.fn() }),
  useCreateFeePayment: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
  useInvalidateMoney: () => vi.fn(),
}));
const { FeePaymentPanel } = await vi.importActual<{ FeePaymentPanel: (props: { wallet: FeeWalletDto; onPaid: () => void }) => ReactElement }>('../../../miniapp/src/components/FeePayment');
const wallet: FeeWalletDto = { fee: '10', networks: [{ network: 'TRC20', assets: ['USDT'] }] };
// serverAheadMs: how far the server clock is ahead of the phone's.
const lease = (createdAgoMs: number, leaseMs: number, serverAheadMs = 0): FeePaymentDto => {
  const createdAt = Date.now() + serverAheadMs - createdAgoMs;
  return { id: 'lease', asset: 'USDT', network: 'TRC20', address: 'TQ1TkHLPYPKn9wBRUySxD3pXZt4sb5bhZx', amount: '10', received: '0', missing: '10',
    status: 'awaiting', createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(createdAt + leaseMs).toISOString(),
    secondsLeft: Math.floor((leaseMs - createdAgoMs) / 1000), paidAt: null, txHash: null, explorerUrl: null };
};
const render = () => renderToStaticMarkup(createElement(FeePaymentPanel, { wallet, onPaid: () => undefined }));

describe('payment address countdown', () => {
  it('shows how much of the ten minutes is left to pay', () => {
    fixture.payment = lease(30_000, 10 * 60_000);
    const html = render();
    expect(html).toContain('Осталось времени на оплату');
    expect(html).toMatch(/>09:(2\d|30)</);
    expect(html).toContain('Адрес закреплён за вами на 10 минут. Не успели - получите адрес заново.');
    expect(html).not.toContain('color:var(--danger)');
  });

  it('counts by the server even when the phone clock is wrong', () => {
    fixture.payment = lease(60_000, 10 * 60_000, -30 * 60_000);
    expect(render()).toMatch(/>09:00</);
  });

  it('turns red in the last two minutes', () => {
    fixture.payment = lease(9 * 60_000, 10 * 60_000);
    const html = render();
    expect(html).toMatch(/>0[01]:\d\d</);
    expect(html).toContain('color:var(--danger)');
  });
});
