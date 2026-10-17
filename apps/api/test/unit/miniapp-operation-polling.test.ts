import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationStatus } from '@gudex/shared';

type QueryOptions = { enabled: boolean; refetchIntervalInBackground?: boolean; queryFn: () => Promise<unknown>;
  refetchInterval: (query: { state: { data?: { status: OperationStatus } } }) => number | false };
const fixture = vi.hoisted(() => ({ options: undefined as QueryOptions | undefined }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (options: QueryOptions) => { fixture.options = options; return {}; },
  useQueryClient: () => ({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }), useMutation: () => { throw new Error('Status polling must not create a mutation'); } }));
const requireMiniapp = createRequire(new URL('../../../miniapp/package.json', import.meta.url));
const { createElement } = requireMiniapp('react') as typeof import('react');
const { renderToStaticMarkup } = requireMiniapp('react-dom/server') as { renderToStaticMarkup: (element: unknown) => string };
const { useOperation } = await vi.importActual<{ useOperation: (id: string | null) => unknown }>('../../../miniapp/src/lib/queries');
const operationId = '00000000-0000-4000-8000-000000000002';
const fetch = vi.fn(async () => Response.json({ id: operationId, type: 'issue', status: 'unknown' }));
beforeEach(() => { fixture.options = undefined; fetch.mockClear(); vi.stubGlobal('fetch', fetch); });
afterEach(() => vi.unstubAllGlobals());
function options(id: string | null = operationId) {
  function Probe() { useOperation(id); return null; }
  renderToStaticMarkup(createElement(Probe));
  return fixture.options!;
}

describe('operation status observation', () => {
  it.each([['pending', 1500], ['processing', 1500], ['unknown', 30000], ['succeeded', false], ['failed', false]] as const)(
    'uses interval %s → %s without resubmitting an operation', (status, expected) => {
      expect(options().refetchInterval({ state: { data: { status } } })).toBe(expected);
      expect(fetch).not.toHaveBeenCalled();
    });
  it('observes only while the MiniApp is visible', () => {
    expect(options().refetchIntervalInBackground).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('polls the existing operation with GET and no request body', async () => {
    const result = await options().queryFn();
    expect(result).toMatchObject({ id: operationId, status: 'unknown' });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/v1/operations/${operationId}`, { method: 'GET', headers: {}, body: undefined });
  });
  it('does not enable status requests until an operation exists', () => {
    expect(options(null).enabled).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
