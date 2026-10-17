import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardAdditionalAttemptInput } from '@gudex/shared';

type QueryOptions = { queryKey: readonly unknown[]; queryFn: () => Promise<unknown>; enabled?: boolean; gcTime?: number; staleTime?: number; refetchOnMount?: string };
type TopupInput = { asset: 'USDT'; amount: string; idempotencyKey: string; expectedFee: string; expectedNetUsd: string };
type MutationOptions = { mutationFn: (body: CardAdditionalAttemptInput | TopupInput) => Promise<unknown> };
const fixture = vi.hoisted(() => ({ id: 'fixture-user' as string | undefined, query: undefined as QueryOptions | undefined,
  mutation: undefined as MutationOptions | undefined }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (options: QueryOptions) => options.queryKey[0] === 'me' ? { data: fixture.id ? { id: fixture.id } : undefined }
  : (fixture.query = options, {}), useMutation: (options: MutationOptions) => { fixture.mutation = options; return {}; },
  useQueryClient: () => ({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }) }));
const req = createRequire(new URL('../../../miniapp/package.json', import.meta.url));
const { createElement } = req('react') as typeof import('react');
const { renderToStaticMarkup } = req('react-dom/server') as { renderToStaticMarkup: (node: unknown) => string };
const { useAdditionalAttemptQuote, useAdditionalAttempt, useTopupCard } = await vi.importActual<{
  useAdditionalAttemptQuote: (enabled?: boolean) => unknown; useAdditionalAttempt: () => unknown; useTopupCard: (id: string) => unknown;
}>('../../../miniapp/src/lib/queries');
const fetch = vi.fn(async () => Response.json({ eligible: false, reason: 'unavailable' }));
beforeEach(() => { vi.clearAllMocks(); fixture.id = 'fixture-user'; fixture.query = undefined; fixture.mutation = undefined; vi.stubGlobal('fetch', fetch); });
afterEach(() => vi.unstubAllGlobals());
function render(hook: () => unknown) { function Probe() { hook(); return null; } renderToStaticMarkup(createElement(Probe)); }
describe('separate read-only quotes and explicit financial consent', () => {
  it('reads fresh private eligibility through GET without creating a reserve or attempt', async () => {
    render(() => useAdditionalAttemptQuote());
    expect(fetch).not.toHaveBeenCalled(); expect(fixture.mutation).toBeUndefined();
    expect(fixture.query).toMatchObject({ queryKey: ['card-additional-attempt', 'fixture-user'], gcTime: 0, staleTime: 0, refetchOnMount: 'always', enabled: true });
    await fixture.query!.queryFn();
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/v1/cards/additional-attempt-quote', { method: 'GET', headers: {}, body: undefined });
    fixture.id = 'other-user'; render(() => useAdditionalAttemptQuote()); expect(fixture.query!.queryKey).toEqual(['card-additional-attempt', 'other-user']);
  });
  it('does not enable the quote without identity or while the new operation is displayed', () => {
    fixture.id = undefined; render(() => useAdditionalAttemptQuote()); expect(fixture.query!.enabled).toBe(false);
    fixture.id = 'fixture-user'; render(() => useAdditionalAttemptQuote(false)); expect(fixture.query!.enabled).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('sends the signed terms and affirmative acknowledgement only when the mutation is explicitly called', async () => {
    render(useAdditionalAttempt); expect(fetch).not.toHaveBeenCalled();
    const body: CardAdditionalAttemptInput = { quoteToken: 'fixture-token', idempotencyKey: 'same-key-for-response-retry', acceptedRisk: true, termsVersion: 'additional-issue-v1' };
    await fixture.mutation!.mutationFn(body);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/v1/cards/additional-attempt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  });
  it('sends the fee and net amount shown by the accepted top-up quote', async () => {
    render(() => useTopupCard('fixture-owned-card')); expect(fetch).not.toHaveBeenCalled();
    const body: TopupInput = { asset: 'USDT', amount: '20', idempotencyKey: 'fixture-topup-key', expectedFee: '0.3', expectedNetUsd: '19.7' };
    await fixture.mutation!.mutationFn(body);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/v1/cards/fixture-owned-card/topup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  });
});
