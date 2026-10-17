import { createHmac } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config';
import type { Db } from '../../src/db/client';
import { cardOperations, cards, kycProfiles, upaySubmissions } from '../../src/db/schema';
import { post } from '../../src/ledger/ledger';
import { UpayClient } from '../../src/partner/upay/client';
import { UpayFinancialPartner } from '../../src/partner/upay/financial-partner';
import { MemoryUpaySubmissionStore } from '../../src/partner/upay/submissions';
import type { UpaySessionStore } from '../../src/partner/upay/session-store';
import type { UpayTransport } from '../../src/partner/upay/transport';
import { JobRunner } from '../../src/queue/queue';
import { CardService } from '../../src/services/cards';

vi.mock('../../src/ledger/ledger', async importActual => ({
  ...await importActual<typeof import('../../src/ledger/ledger')>(),
  post: vi.fn().mockResolvedValue({ transactionId: 'fixture-refund' }),
}));
vi.mock('../../src/services/notify', () => ({ notify: vi.fn().mockResolvedValue(undefined) }));

// Diagnostic fixture: the real runner, card handler and protocol adapter run against
// in-memory SQL/query outlets, a synthetic session/transport, and fake time only.
// No DB client/runtime factory is instantiated; global HTTP is forbidden.
const epoch = new Date('2026-10-16T00:00:00.000Z').getTime();
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const elapsed = () => Date.now() - epoch;
const config = { CARD_PARTNER: 'upay', CARD_ISSUE_FEE_USD: '10', CARD_MIN_TOPUP_USD: '10',
  UPAY_WRITES_ENABLED: true, UPAY_PAYMENT_PASSWORD: '123456', UPAY_PRODUCT_ID: 'fixture-product',
  UPAY_LOGIN: 'fixture@example.test', UPAY_PASSWORD: 'fixture-only', UPAY_TOTP_SECRET: 'fixture-only',
  UPAY_DEVICE_ID: 'fixture-device', appSecret: 'fixture-session-key',
} as Config;
const fingerprint = createHmac('sha256', config.appSecret).update(JSON.stringify([
  config.UPAY_LOGIN, config.UPAY_PASSWORD, config.UPAY_TOTP_SECRET, config.UPAY_DEVICE_ID,
])).digest('hex');

interface MemoryJob { id: string; queue: string; payload: object; attempts: number; max_attempts: number;
  lock_token: string | null; expired: boolean; status: 'queued' | 'running' | 'done' | 'failed'; lockedUntil: number | null; lastError?: string; }
function setup(priorWorkMs: number, transientOwnershipRead = 0) {
  const op = { id: 'fixture-operation', userId: 'fixture-user', cardId: 'fixture-card', type: 'issue', status: 'pending',
    asset: 'USDT', amount: 10_000_000n, fee: 10_000_000n, attempts: 0, partnerProvider: 'upay', sponsorshipId: null,
    createdAt: new Date(), updatedAt: new Date(), error: null };
  const card = { id: op.cardId, userId: op.userId, status: 'pending' };
  const jobs: MemoryJob[] = [
    { id: '1', queue: 'fixture.prior', payload: {}, attempts: 0, max_attempts: 8, lock_token: null, expired: false, status: 'queued', lockedUntil: null },
    { id: '2', queue: 'card.issue', payload: { operationId: op.id }, attempts: 0, max_attempts: 8, lock_token: null, expired: false, status: 'queued', lockedUntil: null },
  ];
  const timeline: { event: string; at: number }[] = [];
  const logs: { message: string; extra?: object; at: number }[] = [];
  const dialect = new PgDialect();
  const insertedJobs: string[] = [];
  let ownershipReads = 0;
  const dbOutlet = {
    transaction: async (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => run(dbOutlet),
    select: () => {
      let table: unknown;
      const rows = async () => {
        if (table === upaySubmissions) {
          const row = await journal.get(op.id);
          return row ? [{ ...row, receiptId: row.partnerReceiptId }] : [];
        }
        return table === cardOperations ? [structuredClone(op)] : table === cards ? [structuredClone(card)]
          : table === kycProfiles ? [{ partnerCustomerId: 'fixture-customer' }] : (() => { throw new Error('Unexpected fixture table'); })();
      };
      const query = { from: (value: unknown) => { table = value; return query; }, where: () => query,
        for: async () => rows(), then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows()).then(resolve) };
      return query;
    },
    update: (table: unknown) => ({ set: (patch: object) => ({ where: async () => {
      if (table !== cardOperations && table !== cards) throw new Error('Unexpected fixture update');
      Object.assign(table === cardOperations ? op : card, patch);
    } }) }),
    execute: async (query: SQL) => {
      const { sql, params } = dialect.sqlToQuery(query);
      const text = sql.replace(/\s+/g, ' ').trim();
      if (text.startsWith('with candidate as')) {
        const job = jobs.find(item => item.status === 'queued');
        if (!job) return { rows: [] };
        job.status = 'running'; job.attempts++; job.lock_token = String(params.at(-1)); job.lockedUntil = Date.now() + Number(params[0]) * 1000;
        timeline.push({ event: `claim:${job.queue}`, at: elapsed() });
        return { rows: [{ ...job }] };
      }
      if (text.startsWith('select id from jobs where')) {
        const job = jobs.find(item => item.id === params[0] && item.lock_token === params[1] && item.status === 'running');
        if (job?.queue === 'card.issue' && text.includes('locked_until > now()')) {
          ownershipReads++;
          if (ownershipReads === transientOwnershipRead) {
            timeline.push({ event: 'fixture:ownership-read-error', at: elapsed() });
            throw new Error('Synthetic transient ownership read unavailable');
          }
        }
        const ownsLease = job && (!text.includes('locked_until > now()') || job.lockedUntil! > Date.now());
        return { rows: ownsLease ? [{ id: job.id }] : [] };
      }
      if (text.startsWith('update jobs set status')) {
        const status = text.includes("status = 'done'") ? 'done' : text.includes("status = 'failed'") ? 'failed' : null;
        if (!status) throw new Error('Unexpected fixture queue transition');
        const job = jobs.find(item => item.status === 'running' && params.includes(item.id) && params.includes(item.lock_token));
        if (job) { job.status = status; job.lockedUntil = null; job.lock_token = null; if (status === 'failed') job.lastError = String(params[0]); }
        return { rows: [] };
      }
      if (text.startsWith('insert into jobs')) { insertedJobs.push(String(params[0])); return { rows: [] }; }
      throw new Error(`Unexpected fixture SQL: ${text}`);
    },
  };
  const journal = new MemoryUpaySubmissionStore();
  const realBegin = journal.begin.bind(journal), realRecord = journal.record.bind(journal);
  vi.spyOn(journal, 'begin').mockImplementation(async input => {
    const value = await realBegin(input); if (value.created) timeline.push({ event: 'journal:begin', at: elapsed() }); return value;
  });
  vi.spyOn(journal, 'record').mockImplementation(async (reference, update) => {
    await realRecord(reference, update); timeline.push({ event: `journal:${update.state}`, at: elapsed() });
  });
  let submittingAfterPinInfo = false;
  const session: UpaySessionStore = { withLock: async run => {
    // Delay the authentication check immediately following PIN-info preflight,
    // independently of whether parallel reads share a cached-session lookup.
    if (submittingAfterPinInfo) { submittingAfterPinInfo = false; await delay(308); }
    return run({ get: async () => ({ token: 'fixture-token', fingerprint, expiresAt: epoch + 1_000_000 }),
      set: async () => { throw new Error('The fixture must never authenticate a real account'); } });
  } };
  let dispatches = 0;
  const transport = { request: async (method: string, endpoint: string) => {
    if (method === 'GET' && endpoint === '/sys/member/loginInfo') { submittingAfterPinInfo = true; return { id: 'fixture-member', iv: '123456789012', pinCodeSet: true }; }
    if (method === 'GET' && endpoint === '/card/getMayApplyCardDetail') { await delay(3100); return { openFee: '10', defaultOpenAmount: '0', rechargeCurrency: 'USDT', cardCurrency: 'USD' }; }
    if (method === 'GET' && endpoint === '/card/getCardFee') { await delay(3100); return { customerNo: 'fixture-customer', defaultType: 1, needParams: [] }; }
    if (method === 'POST' && endpoint === '/card/applyOpenCard') { dispatches++; timeline.push({ event: 'fixture:dispatch', at: elapsed() }); return { orderNo: 'fixture-order' }; }
    if (method === 'POST' && endpoint === '/card/getPageToCardOperateRecord') return { totalPages: 1, list: [] };
    throw new Error(`Forbidden fixture transport ${method} ${endpoint}`);
  } } as unknown as UpayTransport;
  const client = new UpayClient(config, session, transport);
  const kyc = { assertReady: () => {}, createCustomer: async () => 'fixture-customer', getKycStatus: async () => ({ status: 'approved' as const }),
    getKycRequirements: async () => ({ selfieRequired: false, documentTypes: ['id_card' as const] }), reconcileKycSubmission: async () => null,
    getDocumentType: async () => 1 as const };
  const partner = new UpayFinancialPartner(config, client, journal, kyc);
  const service = new CardService(dbOutlet as unknown as Db, config, partner);
  const runner = new JobRunner(dbOutlet as unknown as Db, { ...service.handlers(), 'fixture.prior': { run: () => delay(priorWorkMs) } },
    (message, extra) => logs.push({ message, extra, at: elapsed() }));
  return { op, card, jobs, timeline, logs, journal, insertedJobs, runner, dispatches: () => dispatches, ownershipReads: () => ownershipReads };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(epoch); vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No HTTP in deadline fixture'); })); });
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('financial execution budget at the end of a shared drain', () => {
  it('reaches the synthetic submit when the same preflight starts early in the drain', async () => {
    const f = setup(0);
    const drain = f.runner.drain({ maxDurationMs: 20_000, maxJobs: 2 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await drain).toBe(2);
    expect(f.dispatches()).toBe(1);
    expect(f.op.status).toBe('processing');
    expect(f.jobs[1]!.status).toBe('done');
    expect(f.insertedJobs).toEqual(['card.reconcile']);
    expect(f.timeline).toContainEqual({ event: 'journal:begin', at: 3100 });
  });
  it('fences an expired context from submission and marks the queue job FAILED rather than DONE', async () => {
    const f = setup(16_592);
    const drain = f.runner.drain({ maxDurationMs: 20_000, maxJobs: 2 });
    await vi.advanceTimersByTimeAsync(20_000);
    await drain;
    const journal = await f.journal.get(f.op.id);
    expect({ operation: f.op.status, job: f.jobs[1]!.status, dispatches: f.dispatches(), journal: journal?.state ?? null,
      timeline: f.timeline.filter(item => item.event.startsWith('journal:')) }).toEqual({
      operation: 'failed', job: 'failed', dispatches: 0, journal: 'rejected', timeline: [
        { event: 'journal:begin', at: 19692 }, { event: 'journal:rejected', at: 20000 },
      ],
    });
    expect(journal?.evidence).toMatchObject({ step: 'card_issue', dispatchPhase: 'pre_dispatch', responseAck: 'unconfirmed' });
    expect(f.op.amount).toBe(10_000_000n);
    expect(f.card.status).toBe('failed');
    expect(post).toHaveBeenCalledTimes(1);
    expect(f.jobs[1]!.lastError).toBe('Job execution deadline or lease lost');
    expect(f.insertedJobs).toEqual([]);
    // A historical DONE job is evidence against this exact deadline-abort mechanism:
    // the real runner's final assertActive would reject, so it cannot acknowledge DONE.
  });
  it('can finish DONE after a transient ownership-read error, with durable non-dispatch proof and one refund', async () => {
    // Read1: CardService before entering the partner. Read2: partner before entering
    // the client. Read3: client beforeDispatch. Read4: runner final acknowledgement.
    const f = setup(0, 3);
    const drain = f.runner.drain({ maxDurationMs: 20_000, maxJobs: 2 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await drain).toBe(2);
    expect(f.dispatches()).toBe(0);
    expect(f.ownershipReads()).toBe(4);
    expect(f.timeline).toContainEqual({ event: 'fixture:ownership-read-error', at: 3408 });
    expect(f.jobs[1]!.status).toBe('done');
    expect(f.jobs[1]!.lastError).toBeUndefined();
    expect(f.op.status).toBe('failed');
    expect(f.op.amount).toBe(10_000_000n);
    expect(f.card.status).toBe('failed');
    expect(post).toHaveBeenCalledTimes(1);
    expect(await f.journal.get(f.op.id)).toMatchObject({ state: 'rejected', partnerReceiptId: null, partnerCardId: null,
      evidence: { step: 'card_issue', dispatchPhase: 'pre_dispatch', responseAck: 'unconfirmed' } });
    expect(f.insertedJobs).toEqual([]);
    expect(f.logs).toEqual([]);
  });
});
