import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request, session } from '../../../miniapp/src/lib/api';

const deferredResponse = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('Mini App session generation', () => {
  beforeEach(() => session.set(null));
  afterEach(() => {
    session.onLost(() => {});
    vi.unstubAllGlobals();
  });

  it.each(['unauthorized', 'unlock_required'] as const)('ignores a stale %s response after a fresh token is installed', async (code) => {
    const lost = vi.fn();
    const response = deferredResponse();
    const fetch = vi.fn<typeof globalThis.fetch>(() => response.promise);
    vi.stubGlobal('fetch', fetch);
    session.onLost(lost);
    session.set('old-token');

    const pending = request('/v1/wallet');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ headers: { Authorization: 'Bearer old-token' } });
    session.set('fresh-token');
    response.resolve(Response.json({ error: { code, message: 'Expired request' } }, { status: 401 }));

    await expect(pending).rejects.toMatchObject({ code, status: 401 });
    expect(lost).not.toHaveBeenCalled();
  });

  it('uses the session generation even when the same token string is installed again', async () => {
    const lost = vi.fn();
    const response = deferredResponse();
    vi.stubGlobal('fetch', vi.fn(() => response.promise));
    session.onLost(lost);
    session.set('same-token');
    const pending = request('/v1/wallet');

    session.set('same-token');
    response.resolve(Response.json({ error: { code: 'unauthorized', message: 'Expired request' } }, { status: 401 }));

    await expect(pending).rejects.toMatchObject({ code: 'unauthorized' });
    expect(lost).not.toHaveBeenCalled();
  });

  it.each(['unauthorized', 'unlock_required'] as const)('reports a current %s without replaying a financial POST', async (code) => {
    const lost = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: { code, message: 'Authentication required' } }, { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    session.onLost(lost);
    session.set('current-token');

    await expect(request('/v1/cards/card-id/topup', {
      method: 'POST', body: { asset: 'USDT', amount: '50', idempotencyKey: 'financial-request' },
    })).rejects.toMatchObject({ code });

    expect(lost).toHaveBeenCalledExactlyOnceWith(code);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
