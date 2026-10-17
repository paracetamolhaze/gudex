import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client';
import { kycProfiles, users } from '../../src/db/schema';
import type { DbKycDocumentStore } from '../../src/kyc/document-store';
import type { CardPartner } from '../../src/partner/types';
import type { JobContext } from '../../src/queue/queue';
import { notifyAdmins } from '../../src/services/admin-notify';
import { KycService } from '../../src/services/kyc';

vi.mock('../../src/services/admin-notify', () => ({ notifyAdmins: vi.fn().mockResolvedValue(undefined) }));

function fixture() {
  const userId = randomUUID();
  const profile = { userId, partnerProvider: 'upay', status: 'pending', submissionState: 'queued', submissionId: randomUUID(),
    partnerCustomerId: 'existing-customer', documentsSubmittedAt: null, documentIds: { front: 'owned-front', back: 'owned-back' },
    updatedAt: new Date('2026-10-17T00:00:00.000Z') };
  const locks: unknown[] = [];
  const update = vi.fn((patch: object) => { Object.assign(profile, patch); });
  const db = {
    transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      const previous = structuredClone(profile);
      try { return await run(db); }
      catch (error) { Object.assign(profile, previous); throw error; }
    },
    select: () => {
      let table: unknown;
      const rows = () => table === users ? [{ id: userId }] : table === kycProfiles ? [profile]
        : (() => { throw new Error('Unexpected mode-switch query'); })();
      const query = { from: (value: unknown) => { table = value; return query; }, where: () => query,
        for: async (mode: string) => { expect(mode).toBe('update'); locks.push(table); return rows(); },
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows()).then(resolve) };
      return query;
    },
    update: (table: unknown) => ({ set: (patch: object) => ({ where: async () => {
      expect(table).toBe(kycProfiles); update(patch);
    } }) }),
  };
  const partner = { createCustomer: vi.fn(), getKycStatus: vi.fn(), reconcileKycSubmission: vi.fn() };
  const documents = { getOwned: vi.fn(), removeOwned: vi.fn() };
  const service = new KycService(db as unknown as Db, partner as unknown as CardPartner, 2,
    documents as unknown as DbKycDocumentStore, { live: true, enabled: true, manual: true, requireSelfie: false, adminTelegramIds: ['999'] });
  const run = (submissionId = profile.submissionId, context?: JobContext) => service.handlers()['kyc.submit']!.run({ userId, submissionId }, context);
  return { profile, userId, locks, update, service, partner, documents, run };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(notifyAdmins).mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in manual mode-switch tests'); }));
});
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('automatic KYC jobs after switching to manual fulfilment', () => {
  it('preserves old queued work for reconciliation and alerts administrators without any provider call', async () => {
    const f = fixture();
    const documentIds = structuredClone(f.profile.documentIds);
    await f.run();
    await f.run();
    expect(f.profile).toMatchObject({ status: 'unknown', submissionState: 'unknown', partnerCustomerId: 'existing-customer',
      documentIds, documentsSubmittedAt: null });
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.locks.slice(0, 2)).toEqual([users, kycProfiles]);
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
    expect(notifyAdmins).toHaveBeenCalledWith(expect.anything(), { adminTelegramIds: ['999'] }, {
      userId: f.userId, eventKey: `verification:${f.profile.submissionId}:manual-reconciliation`, stage: 'verification',
    });
    for (const call of Object.values(f.partner)) expect(call).not.toHaveBeenCalled();
    expect(f.documents.removeOwned).not.toHaveBeenCalled();
  });

  it.each([
    ['pending', 'submitted'], ['unknown', 'unknown'], ['unknown', 'queued'],
    ['pending', 'manual_review'], ['approved', 'manual_verified'],
  ])('does not convert or overwrite an existing %s/%s generation', async (status, submissionState) => {
    const f = fixture();
    Object.assign(f.profile, { status, submissionState });
    const before = structuredClone(f.profile);
    await f.run();
    expect(f.profile).toEqual(before);
    expect(notifyAdmins).not.toHaveBeenCalled();
    for (const call of Object.values(f.partner)) expect(call).not.toHaveBeenCalled();
  });

  it('does not let a stale submission or a different provider overwrite the current application', async () => {
    const f = fixture();
    await f.run(randomUUID());
    f.profile.partnerProvider = 'mock';
    await f.run();
    expect(f.update).not.toHaveBeenCalled();
    expect(notifyAdmins).not.toHaveBeenCalled();
  });

  it('does not change the profile when the worker has lost its lease', async () => {
    const f = fixture();
    const context = { signal: new AbortController().signal, assertActive: vi.fn().mockRejectedValue(new Error('Lease lost')) };
    await f.run(f.profile.submissionId, context);
    expect(context.assertActive).toHaveBeenCalledTimes(1);
    expect(f.update).not.toHaveBeenCalled();
    expect(notifyAdmins).not.toHaveBeenCalled();
  });

  it('rolls back the state change when its durable administrator notification fails', async () => {
    const f = fixture();
    vi.mocked(notifyAdmins).mockRejectedValueOnce(new Error('Outbox unavailable'));
    await expect(f.run()).rejects.toThrow('Outbox unavailable');
    expect(f.profile).toMatchObject({ status: 'pending', submissionState: 'queued' });
    await f.run();
    expect(f.profile).toMatchObject({ status: 'unknown', submissionState: 'unknown' });
  });

  it('does not let an exhausted old automatic job erase a manual review', async () => {
    const f = fixture();
    f.profile.submissionState = 'manual_review';
    await f.service.handlers()['kyc.submit']!.onExhausted!({ userId: f.userId, submissionId: f.profile.submissionId }, new Error('Old job exhausted'));
    expect(f.profile).toMatchObject({ status: 'pending', submissionState: 'manual_review' });
    expect(f.update).not.toHaveBeenCalled();
  });
});
