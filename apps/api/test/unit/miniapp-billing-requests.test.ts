import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardBillingAddressDto, CardBillingAddressInput } from '@gudex/shared';

type QueryOptions = { queryKey: readonly unknown[]; queryFn: () => Promise<unknown>; enabled?: boolean; staleTime?: number; gcTime?: number;
  refetchOnMount?: string; refetchIntervalInBackground?: boolean; refetchInterval?: (query: { state: { data?: CardBillingAddressDto } }) => number | false };
type MutationOptions = { gcTime: number; mutationFn: (body: CardBillingAddressInput) => Promise<unknown>; onSuccess: (data: CardBillingAddressDto) => unknown; onSettled: () => unknown };
const fixture = vi.hoisted(() => ({ userId: 'fixture-user-a' as string | undefined, query: undefined as QueryOptions | undefined,
  mutation: undefined as MutationOptions | undefined, setQueryData: vi.fn(), invalidateQueries: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: QueryOptions) => options.queryKey[0] === 'me' ? { data: fixture.userId ? { id: fixture.userId } : undefined }
    : (fixture.query = options, {}),
  useMutation: (options: MutationOptions) => { fixture.mutation = options; return {}; },
  useQueryClient: () => ({ setQueryData: fixture.setQueryData, invalidateQueries: fixture.invalidateQueries }),
}));
const { useCardBillingAddress, useSaveCardBillingAddress } = await vi.importActual<{
  useCardBillingAddress: (enabled?: boolean) => unknown; useSaveCardBillingAddress: () => unknown;
}>('../../../miniapp/src/lib/queries');
const saved: CardBillingAddressDto = { required: true, status: 'ready', address: { countryId: 'fixture-country', postalCode: '0500', address: 'Almaty, Abay Ave 10' } };
const fetch = vi.fn(async () => Response.json(saved));
beforeEach(() => { vi.clearAllMocks(); fixture.userId = 'fixture-user-a'; fixture.query = undefined; fixture.mutation = undefined; vi.stubGlobal('fetch', fetch); });
afterEach(() => vi.unstubAllGlobals());

describe('private billing request and cache boundaries', () => {
  it('reads the current address through GET and scopes private cached data to the authenticated user', async () => {
    useCardBillingAddress();
    expect(fixture.query).toMatchObject({ queryKey: ['card-billing-address', 'fixture-user-a'], enabled: true,
      gcTime: 0, staleTime: 0, refetchOnMount: 'always', refetchIntervalInBackground: false });
    await fixture.query!.queryFn();
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/v1/cards/billing-address', { method: 'GET', headers: {}, body: undefined });
    fixture.userId = 'fixture-user-b'; useCardBillingAddress();
    expect(fixture.query!.queryKey).toEqual(['card-billing-address', 'fixture-user-b']);
  });
  it('does not request a private address before identity is known or while showing an existing operation', () => {
    fixture.userId = undefined; useCardBillingAddress(); expect(fixture.query!.enabled).toBe(false);
    fixture.userId = 'fixture-user-a'; useCardBillingAddress(false); expect(fixture.query!.enabled).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('saves only the three customer-entered address fields through PUT and never calls issuance', async () => {
    useSaveCardBillingAddress();
    await fixture.mutation!.mutationFn(saved.address!);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/v1/cards/billing-address', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(saved.address) });
    fixture.mutation!.onSuccess(saved);
    await fixture.mutation!.onSettled();
    expect(fixture.setQueryData).toHaveBeenCalledExactlyOnceWith(['card-billing-address', 'fixture-user-a'], saved);
    expect(fixture.invalidateQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: ['issue-quote'] });
    expect(fetch.mock.calls).toHaveLength(1);
  });
  it('observes a pending address with read-only polling and stops when ready', () => {
    useCardBillingAddress();
    const interval = fixture.query!.refetchInterval!;
    expect(interval({ state: { data: { ...saved, status: 'pending' } } })).toBe(30_000);
    expect(interval({ state: { data: saved } })).toBe(false);
    expect(interval({ state: { data: { ...saved, status: 'missing' } } })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
