import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DepositInvoiceDto, DepositInvoiceInput } from '@gudex/shared';
type QueryOptions = { queryKey: readonly unknown[]; queryFn: () => Promise<unknown>; enabled?: boolean; gcTime?: number; staleTime?: number;
  refetchOnMount?: string; refetchIntervalInBackground?: boolean; refetchInterval?: (query: { state: { data?: DepositInvoiceDto | null } }) => number | false };
type MutationOptions = { gcTime: number; mutationFn: (body: DepositInvoiceInput) => Promise<unknown>;
  onSuccess: (invoice: DepositInvoiceDto) => void; onSettled: () => unknown };
const fixture = vi.hoisted(() => ({ user: 'fixture-user-a' as string | undefined, query: undefined as QueryOptions | undefined,
  mutation: undefined as MutationOptions | undefined, set: vi.fn(), invalidate: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (options: QueryOptions) => options.queryKey[0] === 'me' ? { data: fixture.user ? { id: fixture.user } : undefined }
  : (fixture.query = options, {}), useMutation: (options: MutationOptions) => { fixture.mutation = options; return {}; },
  useQueryClient: () => ({ setQueryData: fixture.set, invalidateQueries: fixture.invalidate }) }));
const req = createRequire(new URL('../../../miniapp/package.json', import.meta.url));
const { createElement } = req('react') as typeof import('react');
const { renderToStaticMarkup } = req('react-dom/server') as { renderToStaticMarkup: (node: unknown) => string };
const { useActiveDepositInvoice, useDepositInvoice, useDepositInvoiceOptions, useCreateDepositInvoice, useRetryDepositInvoice, useCards } = await vi.importActual<{
  useActiveDepositInvoice: (enabled?: boolean) => unknown; useDepositInvoice: (id: string | null) => unknown;
  useDepositInvoiceOptions: (enabled?: boolean) => unknown; useCreateDepositInvoice: () => unknown; useRetryDepositInvoice: (id: string | null) => unknown;
  useCards: (fresh?: boolean) => unknown;
}>('../../../miniapp/src/lib/queries');
const fetch = vi.fn(async () => Response.json(null));
beforeEach(() => { vi.clearAllMocks(); fixture.user = 'fixture-user-a'; fixture.query = undefined; fixture.mutation = undefined; vi.stubGlobal('fetch', fetch); });
afterEach(() => vi.unstubAllGlobals());
function render(hook: () => unknown) { function Probe() { hook(); return null; } renderToStaticMarkup(createElement(Probe)); }
describe('owner-only invoice requests', () => {
  it('disables catalog reads when invoice creation is off and obtains a fresh own-card read before new issuance', async () => {
    render(() => useDepositInvoiceOptions(false)); expect(fixture.query!.enabled).toBe(false); expect(fetch).not.toHaveBeenCalled();
    render(() => useCards(true)); expect(fixture.query!.refetchOnMount).toBe('always');
    await fixture.query!.queryFn(); expect(fetch).toHaveBeenCalledExactlyOnceWith('/v1/cards', { method: 'GET', headers: {}, body: undefined });
  });
  it('reads the supported catalog and resumes only the current user through bodyless GET', async () => {
    render(useDepositInvoiceOptions); await fixture.query!.queryFn();
    expect(fetch).toHaveBeenLastCalledWith('/v1/deposit-invoices/options', { method: 'GET', headers: {}, body: undefined });
    render(() => useActiveDepositInvoice());
    expect(fixture.query).toMatchObject({ queryKey: ['active-deposit-invoice', 'fixture-user-a'], enabled: true, staleTime: 0, gcTime: 0, refetchOnMount: 'always', refetchIntervalInBackground: false });
    await fixture.query!.queryFn(); expect(fetch).toHaveBeenLastCalledWith('/v1/deposit-invoices/active', { method: 'GET', headers: {}, body: undefined });
    fixture.user = 'fixture-user-b'; render(() => useActiveDepositInvoice()); expect(fixture.query!.queryKey).toEqual(['active-deposit-invoice', 'fixture-user-b']);
    expect(fixture.mutation).toBeUndefined();
  });
  it('observes only the exact own invoice and stops read-only polling at terminal states', async () => {
    render(() => useDepositInvoice('fixture-invoice-id'));
    expect(fixture.query!.queryKey).toEqual(['deposit-invoice', 'fixture-user-a', 'fixture-invoice-id']);
    await fixture.query!.queryFn(); expect(fetch).toHaveBeenCalledExactlyOnceWith('/v1/deposit-invoices/fixture-invoice-id', { method: 'GET', headers: {}, body: undefined });
    const interval = fixture.query!.refetchInterval!;
    expect(interval({ state: { data: { state: 'confirming' } as DepositInvoiceDto } })).toBe(5000);
    expect(interval({ state: { data: { state: 'credited' } as DepositInvoiceDto } })).toBe(false);
    expect(interval({ state: { data: { state: 'expired' } as DepositInvoiceDto } })).toBe(false);
    expect(fixture.query!.refetchIntervalInBackground).toBe(false);
  });
  it('disables private reads without identity, stops active polling after binding an exact invoice, and never requests a null id', () => {
    fixture.user = undefined; render(() => useActiveDepositInvoice()); expect(fixture.query!.enabled).toBe(false);
    render(() => useDepositInvoice('fixture-invoice')); expect(fixture.query!.enabled).toBe(false);
    fixture.user = 'fixture-user-a'; render(() => useActiveDepositInvoice(false)); expect(fixture.query!.enabled).toBe(false);
    render(() => useDepositInvoice(null)); expect(fixture.query!.enabled).toBe(false); expect(fetch).not.toHaveBeenCalled();
  });
  it('creates only after an explicit invocation, reuses the supplied key and updates no wallet balance on invoice creation', async () => {
    render(useCreateDepositInvoice); expect(fetch).not.toHaveBeenCalled();
    const body: DepositInvoiceInput = { asset: 'USDT', network: 'TRC20', amount: '10', idempotencyKey: 'fixture-stable-invoice-key' };
    await fixture.mutation!.mutationFn(body);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/v1/deposit-invoices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const created = { id: 'fixture-invoice', state: 'awaiting_payment' } as DepositInvoiceDto;
    fixture.mutation!.onSuccess(created); await fixture.mutation!.onSettled();
    expect(fixture.set.mock.calls).toEqual([[['active-deposit-invoice', 'fixture-user-a'], created], [['deposit-invoice', 'fixture-user-a', 'fixture-invoice'], created]]);
    expect(fixture.invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ['active-deposit-invoice', 'fixture-user-a'] });
  });
  it('retries only through an explicit empty-body POST for the same own invoice without a new key or altered terms', async () => {
    render(() => useRetryDepositInvoice('fixture-invoice'));
    expect(fetch).not.toHaveBeenCalled();
    await (fixture.mutation!.mutationFn as unknown as () => Promise<unknown>)();
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/v1/deposit-invoices/fixture-invoice/retry', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{}' });
  });
});
