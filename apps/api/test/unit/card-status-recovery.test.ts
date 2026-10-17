import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config';
import type { Db } from '../../src/db/client';
import { cardOperations, cards, ledgerAccounts, upaySubmissions } from '../../src/db/schema';
import { post } from '../../src/ledger/ledger';
import { PartnerError, type CardPartner } from '../../src/partner/types';
import { UpayNotDispatchedError } from '../../src/partner/upay/financial-partner';
import { RetryLater } from '../../src/queue/queue';
import { CardService } from '../../src/services/cards';

vi.mock('../../src/ledger/ledger', async importActual => ({
  ...await importActual<typeof import('../../src/ledger/ledger')>(),
  ensureAccount: vi.fn().mockResolvedValue(undefined), post: vi.fn().mockResolvedValue({ transactionId: 'fixture-settlement' }),
}));
vi.mock('../../src/services/notify', () => ({ notify: vi.fn().mockResolvedValue(undefined) }));

const now = new Date('2026-10-17T00:00:00.000Z');
type Job = { queue: string; payload: { operationId: string }; runAt: Date; maxAttempts: number; dedupeKey: string; status: 'queued' | 'running' | 'done' };
function setup(status: 'unknown' | 'processing' = 'unknown', type: 'issue' | 'topup' = 'issue') {
  const op = { id: '00000000-0000-4000-8000-000000000011', userId: '00000000-0000-4000-8000-000000000012',
    cardId: '00000000-0000-4000-8000-000000000013', type, status: status as string, partnerProvider: 'upay',
    asset: 'USDT', amount: 10_000_000n, fee: type === 'topup' ? 150_000n : 10_000_000n, netUsd: type === 'topup' ? 985n : null, sponsorshipId: null,
    error: 'Partner result is unconfirmed; funds remain reserved', attempts: 1, createdAt: new Date(now), updatedAt: new Date(now) };
  const card = { id: op.cardId, userId: op.userId, productName: 'Fixture Visa', status: type === 'topup' ? 'active' : 'pending', partnerCardId: type === 'topup' ? 'fixture-card' : null,
    last4: null, holderName: 'FIXTURE USER', expiryMonth: null, expiryYear: null, failureReason: null,
    lastSyncedAt: null, createdAt: new Date(now), updatedAt: new Date(now) };
  const journal = { kind: type === 'topup' ? 'recharge' : 'issue', state: 'unknown', partnerReceiptId: 'fixture-exact-order' as string | null, partnerCardId: null as string | null, evidence: {
    orderNo: 'fixture-exact-order', customerNo: 'fixture-customer', dispatchPhase: 'post_dispatched', responseAck: 'accepted_envelope',
  } as Record<string, unknown> };
  const jobs: Job[] = [];
  const dialect = new PgDialect();
  const outlet = {
    transaction: async (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => run(outlet),
    select: () => {
      let table: unknown;
      const rows = () => table === cardOperations ? [structuredClone(op)] : table === cards ? [structuredClone(card)]
        : table === upaySubmissions ? [{ ...structuredClone(journal), receiptId: journal.partnerReceiptId }] : table === ledgerAccounts ? [{ balance: 0n }]
          : (() => { throw new Error('Unexpected recovery fixture table'); })();
      const query = { from: (value: unknown) => { table = value; return query; }, where: () => query, orderBy: () => query,
        limit: () => query, for: async () => rows(), then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows()).then(resolve) };
      return query;
    },
    update: (table: unknown) => ({ set: (patch: object) => ({ where: async () => {
      if (table !== cardOperations && table !== cards) throw new Error('Unexpected recovery fixture update');
      Object.assign(table === cardOperations ? op : card, patch);
    } }) }),
    execute: async (query: SQL) => {
      const { sql, params } = dialect.sqlToQuery(query);
      if (!sql.trim().startsWith('insert into jobs')) throw new Error('Only durable lookup enqueue SQL is allowed in this fixture');
      const dedupeKey = String(params[4]);
      if (!jobs.some(job => job.dedupeKey === dedupeKey && job.status !== 'done')) jobs.push({ queue: String(params[0]),
        payload: JSON.parse(String(params[1])), runAt: new Date(String(params[2])), maxAttempts: Number(params[3]), dedupeKey, status: 'queued' });
      return { rows: [] };
    },
  };
  let available = false;
  const issueCard = vi.fn(() => { throw new Error('A recovery must never submit a financial operation'); });
  const find = vi.fn(async (reference: string) => {
    expect(reference).toBe(op.id);
    return available ? { partnerCardId: 'fixture-confirmed-card', last4: '1234', expiryMonth: 12, expiryYear: 2029 } : null;
  });
  const rechargeCard = vi.fn(() => { throw new Error('A recovery must never repeat a recharge'); });
  const isRechargeDone = vi.fn(async () => available);
  const partner = { issueCard, rechargeCard, isRechargeDone, findCardByExternalRef: find, getIssueSettlement: vi.fn(async () => ({ grossUsd: 1000n })),
    getRechargeSettlement: vi.fn(async () => ({ grossUsd: 1000n })) } as unknown as CardPartner;
  const config = loadConfig({ DATABASE_URL: 'unused-no-connection', JWT_SECRET: 'isolated-recovery-fixture-key',
    CARD_PARTNER: 'upay', CARD_ISSUE_FEE_USD: '10', REFERRAL_SHARE_BPS: '0',
    UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture', UPAY_TOTP_SECRET: 'GEZDGNBVGY3TQOJQ' });
  const service = new CardService(outlet as unknown as Db, config, partner);
  return { op, card, journal, jobs, issueCard, rechargeCard, isRechargeDone, find, service, setAvailable: () => { available = true; },
    lookup: () => service.handlers()['card.reconcile']!.run({ operationId: op.id }) };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No HTTP in recovery fixture'); })); });
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('top-up recovery from its exact accepted receipt', () => {
  it('resumes status polling after a transient lookup error without another recharge', async () => {
    const f = setup('unknown', 'topup');
    await f.service.getOperation(f.op.userId, f.op.id);
    await f.service.getOperation(f.op.userId, f.op.id);
    expect(f.jobs.filter(job => job.queue === 'card.reconcile')).toHaveLength(1);
    await expect(f.lookup()).rejects.toBeInstanceOf(RetryLater);
    f.setAvailable();
    await f.lookup();
    expect(f.op.status).toBe('succeeded');
    expect(f.rechargeCard).not.toHaveBeenCalled();
    expect(f.issueCard).not.toHaveBeenCalled();
  });
  it('never schedules an identifier-free or stale top-up submission', async () => {
    const f = setup('unknown', 'topup');
    f.journal.partnerReceiptId = null;
    await f.service.getOperation(f.op.userId, f.op.id);
    expect(f.jobs).toHaveLength(0);
    f.journal.partnerReceiptId = 'fixture-exact-order';
    vi.setSystemTime(now.getTime() + 31 * 60_000);
    await f.service.getOperation(f.op.userId, f.op.id);
    expect(f.jobs).toHaveLength(0);
    expect(f.rechargeCard).not.toHaveBeenCalled();
  });
});

describe('customer-triggered exact issuance receipt recovery', () => {
  it('recovers a crash after durable pre-dispatch rejection and refunds exactly once', async () => {
    const f = setup();
    f.journal.state = 'rejected';
    f.journal.partnerReceiptId = null;
    f.journal.evidence = { step: 'card_issue', dispatchPhase: 'pre_dispatch', responseAck: 'unconfirmed' };
    f.find.mockRejectedValue(new UpayNotDispatchedError());
    expect((await f.service.reconcileUnknown(f.op.id)).status).toBe('failed');
    expect((await f.service.reconcileUnknown(f.op.id)).status).toBe('failed');
    expect(f.card.status).toBe('failed');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'card_issue_refund', reference: `card_issue_refund:${f.op.id}` }));
    expect(f.find).toHaveBeenCalledTimes(1);
    expect(f.issueCard).not.toHaveBeenCalled();
  });
  it('restores one crash-refund job even after the lookup budget, because durable non-dispatch proof never expires', async () => {
    const f = setup();
    f.journal.state = 'rejected';
    f.journal.partnerReceiptId = null;
    f.journal.evidence = { step: 'card_issue', dispatchPhase: 'pre_dispatch', responseAck: 'unconfirmed' };
    f.find.mockRejectedValue(new UpayNotDispatchedError());
    vi.setSystemTime(now.getTime() + 24 * 60 * 60_000);
    await f.service.getOperation(f.op.userId, f.op.id);
    await f.service.getOperation(f.op.userId, f.op.id);
    expect(f.jobs).toHaveLength(1);
    await f.lookup();
    await f.lookup();
    expect(f.op.status).toBe('failed');
    expect(post).toHaveBeenCalledTimes(1);
    expect(f.issueCard).not.toHaveBeenCalled();
  });
  it.each(['historical-unknown', 'wrong-step', 'accepted-ack', 'has-card-id', 'has-receipt-id'] as const)('does not schedule or refund an invalid non-dispatch proof: %s', async kind => {
    const f = setup();
    f.journal.state = 'rejected';
    f.journal.partnerReceiptId = null;
    f.journal.evidence = { step: 'card_issue', dispatchPhase: 'pre_dispatch', responseAck: 'unconfirmed' };
    if (kind === 'historical-unknown') f.journal.state = 'unknown';
    if (kind === 'wrong-step') f.journal.evidence.step = 'card_recharge';
    if (kind === 'accepted-ack') f.journal.evidence.responseAck = 'accepted_envelope';
    if (kind === 'has-card-id') f.journal.partnerCardId = 'fixture-existing-card';
    if (kind === 'has-receipt-id') f.journal.partnerReceiptId = 'fixture-existing-receipt';
    await f.service.getOperation(f.op.userId, f.op.id);
    await f.lookup();
    expect(f.jobs).toEqual([]);
    expect(f.find).not.toHaveBeenCalled();
    expect(f.op.status).toBe('unknown');
    expect(post).not.toHaveBeenCalled();
    expect(f.issueCard).not.toHaveBeenCalled();
  });
  it('never refunds an accepted or uncertain dispatch because a read throws a generic nonretryable error', async () => {
    const f = setup();
    f.find.mockRejectedValue(new PartnerError('Read access rejected', false));
    expect((await f.service.reconcileUnknown(f.op.id)).status).toBe('unknown');
    expect(f.card.status).toBe('pending');
    expect(post).not.toHaveBeenCalled();
    expect(f.issueCard).not.toHaveBeenCalled();
  });
  it.each(['unknown', 'processing'] as const)('durably schedules one lookup from repeated GET status reads for %s with an accepted exact receipt', async status => {
    const f = setup(status);
    expect((await f.service.getOperation(f.op.userId, f.op.id)).status).toBe(status);
    await f.service.getOperation(f.op.userId, f.op.id);
    expect(f.jobs).toHaveLength(1);
    expect(f.jobs[0]).toMatchObject({ queue: 'card.reconcile', payload: { operationId: f.op.id }, dedupeKey: `card.reconcile:${f.op.id}` });
    expect(f.find).not.toHaveBeenCalled();
    expect(f.issueCard).not.toHaveBeenCalled();
  });
  it('restores the durable lookup when a client reopens the pending card screen', async () => {
    const f = setup();
    const response = await f.service.list(f.op.userId);
    expect(response[0]).toMatchObject({ status: 'pending', pendingOperationStatus: 'unknown' });
    expect(f.jobs.map(job => job.queue)).toEqual(['card.reconcile']);
    expect(f.issueCard).not.toHaveBeenCalled();
  });
  it('keeps looking up the same exact receipt until its card appears and settles once without a second financial POST', async () => {
    const f = setup();
    await f.service.getOperation(f.op.userId, f.op.id);
    await expect(f.lookup()).rejects.toBeInstanceOf(RetryLater);
    expect(f.op.status).toBe('unknown');
    expect(post).not.toHaveBeenCalled();
    f.setAvailable();
    await f.lookup();
    await f.lookup();
    expect(f.op.status).toBe('succeeded');
    expect(f.card).toMatchObject({ status: 'active', partnerCardId: 'fixture-confirmed-card', last4: '1234' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(f.issueCard).not.toHaveBeenCalled();
  });
  it.each(['missing-id', 'unconfirmed-ack', 'mismatched-id', 'wrong-kind'] as const)('does not queue or adopt an operation with %s', async kind => {
    const f = setup();
    if (kind === 'missing-id') { f.journal.partnerReceiptId = ''; delete f.journal.evidence.orderNo; }
    if (kind === 'unconfirmed-ack') f.journal.evidence.responseAck = 'unconfirmed';
    if (kind === 'mismatched-id') f.journal.evidence.orderNo = 'a-different-order';
    if (kind === 'wrong-kind') f.journal.kind = 'recharge';
    await f.service.getOperation(f.op.userId, f.op.id);
    await f.lookup();
    expect(f.jobs).toEqual([]);
    expect(f.find).not.toHaveBeenCalled();
    expect(f.op.status).toBe('unknown');
    expect(post).not.toHaveBeenCalled();
    expect(f.issueCard).not.toHaveBeenCalled();
  });
  it('stops automatically after the original 30-minute budget, retains the hold, and never resets the clock on a refreshed read', async () => {
    const f = setup('processing');
    vi.setSystemTime(now.getTime() + 31 * 60_000);
    f.op.updatedAt = new Date();
    await f.service.getOperation(f.op.userId, f.op.id);
    await f.lookup();
    expect(f.jobs).toEqual([]);
    expect(f.op.status).toBe('unknown');
    expect(f.op.amount).toBe(10_000_000n);
    expect(f.card.status).toBe('pending');
    expect(f.find).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(f.issueCard).not.toHaveBeenCalled();
  });
  it.each([[0, 30], [6, 60], [11, 120], [16, 240], [25, 300]] as const)('uses a bounded lookup backoff after %s minutes', async (minutes, seconds) => {
    const f = setup();
    vi.setSystemTime(now.getTime() + minutes * 60_000);
    await expect(f.lookup()).rejects.toMatchObject({ delaySeconds: seconds });
    expect(f.issueCard).not.toHaveBeenCalled();
  });
});
