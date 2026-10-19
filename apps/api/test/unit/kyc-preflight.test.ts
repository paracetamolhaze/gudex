import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { Db } from '../../src/db/client';
import type { DbKycDocumentStore } from '../../src/kyc/document-store';
import type { Services } from '../../src/app';
import { AppError } from '../../src/lib/errors';
import { accountRoutes } from '../../src/routes/account';
import { KycService, type KycInput } from '../../src/services/kyc';

const identity: KycInput = { firstName: 'ANNE', lastName: 'NEIL', email: 'anne@example.com', birthDate: '1990-01-01', citizenship: 'KZ',
  phone: '7771234567', globalCode: '+7', documentType: 'id_card', documentCountry: 'KZ', documentIds: { front: 'front', back: 'back' } };
afterEach(() => vi.useRealTimers());

describe('verification preflight', () => {
  it.each([{ firstName: 'ANNE-MARIE' }, { lastName: "O'NEIL" }, { phone: '12345678901234' }, { email: 'anne..neil@example.com' }])(
    'rejects native-incompatible contacts before storing a pending submission: %j', async change => {
      const transaction = vi.fn(async () => { throw new Error('Database must not be reached'); });
      const service = new KycService({ transaction } as unknown as Db, {} as never, 2, {} as DbKycDocumentStore,
        { live: true, enabled: true, requireSelfie: false });
      await expect(service.submit('user', { ...identity, ...change })).rejects.toMatchObject({ code: 'validation' });
      expect(transaction).not.toHaveBeenCalled();
    });

  it('accepts the exact eighteenth birthday according to the calendar', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));
    const submit = vi.fn(async () => ({ status: 'pending' }));
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.status(error instanceof AppError ? error.status : 500).send({ error: error instanceof Error ? error.message : 'Internal error' }));
    await app.register(accountRoutes({ auth: { verifySession: async () => ({ userId: 'user', unlocked: true }), assertTermsAccepted: async () => {} }, kyc: { submit } } as unknown as Services), { prefix: '/v1' });
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/kyc', headers: { authorization: 'Bearer fixture' },
        payload: { firstName: 'ANNE', lastName: 'NEIL', email: 'anne@example.com', birthDate: '2008-03-01', citizenship: 'KZ' } });
      expect(response.statusCode, response.body).toBe(200);
      expect(submit).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });
});
