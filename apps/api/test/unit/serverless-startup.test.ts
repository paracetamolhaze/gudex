import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  config: { DATABASE_URL: 'postgres://fixture@localhost:5442/gudex_test', DATABASE_URL_UNPOOLED: undefined as string | undefined,
    POSTGRES_URL_NON_POOLING: undefined as string | undefined, JOB_DRAIN_MS: 1000 },
  migrate: vi.fn(), prepare: vi.fn(), emit: vi.fn(), build: vi.fn(),
}));
vi.mock('../../src/config', () => ({ loadConfig: () => fixture.config }));
vi.mock('../../src/db/migrate', () => ({ runMigrations: fixture.migrate }));
vi.mock('../../src/db/client', () => ({ createDb: () => ({ db: {} }) }));
vi.mock('../../src/runtime-mode', () => ({ prepareRuntimeMode: fixture.prepare }));
vi.mock('../../src/runtime', () => ({ createRuntimeDeps: () => ({}) }));
vi.mock('../../src/app', () => ({ buildApp: fixture.build, createServices: () => ({}), jobHandlers: () => ({}) }));
vi.mock('../../src/queue/queue', () => ({ JobRunner: class { async drain() { return 0; } } }));
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.config.DATABASE_URL_UNPOOLED = undefined;
  fixture.config.POSTGRES_URL_NON_POOLING = undefined;
  fixture.migrate.mockResolvedValue(undefined);
  fixture.prepare.mockResolvedValue(undefined);
  fixture.build.mockResolvedValue({ ready: async () => {}, server: { emit: fixture.emit } });
});

const request = () => ({ url: '/health' }) as IncomingMessage;
const response = () => ({ statusCode: 200, setHeader: vi.fn(), end: vi.fn() });

describe('actual serverless startup boundary', () => {
  it.each([
    ['postgres://fixture@direct-primary.invalid/gudex', 'postgres://fixture@direct-secondary.invalid/gudex', 'postgres://fixture@direct-primary.invalid/gudex'],
    [undefined, 'postgres://fixture@direct-secondary.invalid/gudex', 'postgres://fixture@direct-secondary.invalid/gudex'],
    [undefined, undefined, 'postgres://fixture@localhost:5442/gudex_test'],
  ])('uses the direct migration credential before constructing the API: %s', async (primary, secondary, expected) => {
    fixture.config.DATABASE_URL_UNPOOLED = primary;
    fixture.config.POSTGRES_URL_NON_POOLING = secondary;
    const { default: handler } = await import('../../src/serverless');
    await handler(request(), response() as unknown as ServerResponse);
    expect(fixture.migrate).toHaveBeenCalledWith(expected, expect.any(String));
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.migrate.mock.invocationCallOrder[0]).toBeLessThan(fixture.prepare.mock.invocationCallOrder[0]!);
    expect(fixture.emit).toHaveBeenCalledTimes(1);
  });

  it('returns a sanitized 503 on startup failure and retries initialization on the next request', async () => {
    fixture.migrate.mockRejectedValueOnce(new Error('private postgres credential fixture'));
    const { default: handler } = await import('../../src/serverless');
    const failed = response();
    await expect(handler(request(), failed as unknown as ServerResponse)).resolves.toBeUndefined();
    expect(failed.statusCode).toBe(503);
    expect(failed.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(failed.end).toHaveBeenCalledWith(JSON.stringify({ error: { code: 'provider_unavailable', message: 'Service is starting; try again shortly' } }));
    expect(failed.end.mock.calls.flat().join('')).not.toContain('private postgres');
    expect(fixture.build).not.toHaveBeenCalled();
    expect(fixture.prepare).not.toHaveBeenCalled();

    await handler(request(), response() as unknown as ServerResponse);
    expect(fixture.migrate).toHaveBeenCalledTimes(2);
    expect(fixture.emit).toHaveBeenCalledTimes(1);
  });

  it('does not bypass the financial database seal when runtime mode preparation fails', async () => {
    fixture.prepare.mockRejectedValueOnce(new Error('Fixture financial mode seal failed'));
    const { default: handler } = await import('../../src/serverless');
    const failed = response();
    await handler(request(), failed as unknown as ServerResponse);
    expect(failed.statusCode).toBe(503);
    expect(fixture.build).not.toHaveBeenCalled();
    expect(fixture.emit).not.toHaveBeenCalled();
  });
});
