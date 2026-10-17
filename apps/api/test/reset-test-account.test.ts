import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { appSettings, biometricTokens, cardIssueSponsorships, cardOperations, cards, depositAddresses, deposits, jobs, kycDocuments,
  kycProfiles, ledgerAccounts, referralRewards, transfers, upaySubmissionAliases, upaySubmissions, users, withdrawals } from '../src/db/schema';
import { accounts, ensureAccount, move, post } from '../src/ledger/ledger';
import { inspectResetTestAccount, resetTestAccount } from '../src/ops/reset-test-account';
import { createTestContext, telegramLogin, type TestContext } from './helpers';

const target = '514468501';
let ctx: TestContext | undefined;
afterEach(async () => { await ctx?.close(); ctx = undefined; });

async function setup() {
  ctx = await createTestContext();
  const session = await telegramLogin(ctx, Number(target));
  const { userId } = await ctx.services.auth.verifySession(session.accessToken);
  const submissionId = randomUUID(), historicalId = randomUUID();
  await ctx.db.update(kycProfiles).set({ partnerProvider: 'upay', status: 'none', submissionState: 'none', submissionId,
    partnerCustomerId: 'fixture-customer-current' }).where(eq(kycProfiles.userId, userId));
  for (const [sid, customerNo] of [[submissionId, 'fixture-customer-current'], [historicalId, 'fixture-customer-old']]) {
    await ctx.db.insert(jobs).values({ queue: 'kyc.submit', payload: { userId, submissionId: sid }, status: 'done' });
    await ctx.db.insert(upaySubmissions).values({ reference: `customer:${sid}`, kind: 'customer', requestHash: 'fixture', state: 'confirmed',
      partnerReceiptId: customerNo, evidence: { submissionId: sid, customerNo } });
    await ctx.db.insert(upaySubmissionAliases).values({ kind: 'customer', alias: `record:${customerNo}`, reference: `customer:${sid}` });
  }
  const documentIds = [randomUUID(), randomUUID()];
  for (const id of documentIds) {
    await ctx.db.insert(kycDocuments).values({ id, userId, kind: 'front', mimeType: 'image/png', size: 8,
      ciphertext: 'encrypted-fixture', iv: 'fixture', tag: 'fixture', expiresAt: new Date(Date.now() + 86400000) });
    await ctx.db.insert(jobs).values({ queue: 'kyc.cleanup', payload: {}, dedupeKey: `kyc.cleanup:${id}` });
  }
  await ctx.db.update(kycProfiles).set({ documentIds: { front: documentIds[0]!, back: documentIds[1]! } }).where(eq(kycProfiles.userId, userId));
  await ctx.db.insert(biometricTokens).values({ userId, tokenHash: 'fixture-private-biometric-hash' });
  await ensureAccount(ctx.db, accounts.userWallet(userId, 'USDT'));
  await ctx.db.insert(cardIssueSponsorships).values({ telegramId: BigInt(target), reason: 'Explicit one-time launch test fixture' });
  return { userId, submissionId, historicalId, documentIds, session };
}

async function allRows() {
  const result = await ctx!.db.execute(sql`select jsonb_build_object(
    'users', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]'::jsonb) from users t),
    'kyc', (select coalesce(jsonb_agg(to_jsonb(t) order by user_id), '[]'::jsonb) from kyc_profiles t),
    'docs', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]'::jsonb) from kyc_documents t),
    'bio', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]'::jsonb) from biometric_tokens t),
    'jobs', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]'::jsonb) from jobs t),
    'journals', (select coalesce(jsonb_agg(to_jsonb(t) order by reference), '[]'::jsonb) from upay_submissions t),
    'aliases', (select coalesce(jsonb_agg(to_jsonb(t) order by kind, alias), '[]'::jsonb) from upay_submission_aliases t),
    'accounts', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]'::jsonb) from ledger_accounts t),
    'sponsors', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]'::jsonb) from card_issue_sponsorships t),
    'settings', (select coalesce(jsonb_agg(to_jsonb(t) order by key), '[]'::jsonb) from app_settings t)
  ) as data`);
  return result.rows[0]!.data as Record<string, Record<string, unknown>[]>;
}

describe('one explicitly authorized customer-only launch reset', () => {
  it('deletes only the exact account graph, invalidates its old session and preserves all foreign rows', async () => {
    const { userId, submissionId, session, documentIds } = await setup();
    const foreignSession = await telegramLogin(ctx!, Number(target) + 1);
    const { userId: foreignId } = await ctx!.services.auth.verifySession(foreignSession.accessToken);
    await ctx!.db.insert(biometricTokens).values({ userId: foreignId, tokenHash: 'foreign-biometric-hash' });
    await ensureAccount(ctx!.db, accounts.userWallet(foreignId, 'USDC'));
    await ctx!.db.insert(jobs).values([
      { queue: 'notify', payload: { userId: foreignId, event: { type: 'kyc_approved' } }, status: 'running', lockedUntil: new Date(Date.now() + 120000), lockToken: randomUUID() },
      { queue: 'cards.sync_all', payload: {}, status: 'queued', dedupeKey: 'cards.sync_all' },
      { queue: 'kyc.cleanup', payload: {}, status: 'queued', dedupeKey: `kyc.cleanup:${randomUUID()}` },
    ]);
    await ctx!.db.insert(appSettings).values({ key: 'upay:session:v1', value: { ciphertext: 'foreign-shared-encrypted-session' } });
    const before = await allRows();
    const preview = await inspectResetTestAccount(ctx!.db, target);
    expect(preview).toMatchObject({ status: 'eligible', userId, submissionId, blockedReasons: [], remoteCustomerRetained: true,
      counts: { users: 1, upaySubmissions: 2, upaySubmissionAliases: 2, sponsorships: 1, kycDocuments: 2, ledgerEntries: 0 } });
    const result = await resetTestAccount(ctx!.db, target, userId, submissionId);
    expect(result).toMatchObject({ status: 'reset', userAbsent: true, scopedRemaining: 0, remoteCustomerRetained: true });
    await expect(ctx!.services.auth.verifySession(session.accessToken)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(ctx!.services.auth.verifySession(foreignSession.accessToken)).resolves.toMatchObject({ userId: foreignId });
    const after = await allRows();
    for (const key of ['users', 'kyc', 'bio', 'accounts']) {
      expect(after[key]).toEqual(before[key]!.filter(row => row.id === foreignId || row.user_id === foreignId));
    }
    expect(after.jobs).toEqual(before.jobs!.filter(row => (row.payload as Record<string, unknown>).userId === foreignId ||
      row.queue === 'cards.sync_all' || (row.queue === 'kyc.cleanup' && !documentIds.some(id => row.dedupe_key === `kyc.cleanup:${id}`))));
    expect(after.docs).toEqual([]);
    expect(after.journals).toEqual([]);
    expect(after.aliases).toEqual([]);
    expect(after.sponsors).toEqual([]);
    expect(after.settings).toEqual(before.settings);
  });

  it('binds reset to the inspected UUID and submission generation and cannot erase a recreated account', async () => {
    const { userId, submissionId } = await setup();
    const before = await allRows();
    await expect(resetTestAccount(ctx!.db, target, userId, randomUUID())).rejects.toThrow('generation changed');
    expect(await allRows()).toEqual(before);
    await resetTestAccount(ctx!.db, target, userId, submissionId);
    const fresh = await telegramLogin(ctx!, Number(target));
    const { userId: newId } = await ctx!.services.auth.verifySession(fresh.accessToken);
    expect(newId).not.toBe(userId);
    await expect(resetTestAccount(ctx!.db, target, userId, submissionId)).rejects.toThrow('generation changed');
    expect(await ctx!.services.auth.verifySession(fresh.accessToken)).toMatchObject({ userId: newId });
  });

  it.each(['pending', 'unknown'] as const)('blocks %s KYC and leaves the complete local graph unchanged', async status => {
    const { userId, submissionId } = await setup();
    await ctx!.db.update(kycProfiles).set({ status, submissionState: status === 'pending' ? 'submitted' : 'unknown' }).where(eq(kycProfiles.userId, userId));
    const before = await allRows();
    expect((await inspectResetTestAccount(ctx!.db, target)).blockedReasons).toContain('kyc_not_idle_customer_only');
    await expect(resetTestAccount(ctx!.db, target, userId, submissionId)).rejects.toThrow('blocked');
    expect(await allRows()).toEqual(before);
  });

  it('blocks a running user job even with an expired lease', async () => {
    const { userId, submissionId } = await setup();
    await ctx!.db.insert(jobs).values({ queue: 'notify', payload: { userId }, status: 'running', lockedUntil: new Date(0), lockToken: randomUUID() });
    const before = await allRows();
    expect((await inspectResetTestAccount(ctx!.db, target)).blockedReasons).toContain('running_user_job');
    await expect(resetTestAccount(ctx!.db, target, userId, submissionId)).rejects.toThrow('running_user_job');
    expect(await allRows()).toEqual(before);
  });

  it.each(['unknown', 'sending'] as const)('blocks an uncertain %s customer journal', async state => {
    const { userId, submissionId } = await setup();
    await ctx!.db.update(upaySubmissions).set({ state }).where(eq(upaySubmissions.reference, `customer:${submissionId}`));
    await expect(resetTestAccount(ctx!.db, target, userId, submissionId)).rejects.toThrow('unconfirmed_partner_journal');
    expect((await ctx!.db.select().from(users)).length).toBe(1);
  });

  it('blocks shared submission/customer bindings and unscoped extra journals without deleting foreign data', async () => {
    const { userId, submissionId } = await setup();
    const foreign = await telegramLogin(ctx!, Number(target) + 1);
    const { userId: foreignId } = await ctx!.services.auth.verifySession(foreign.accessToken);
    await ctx!.db.update(kycProfiles).set({ submissionId }).where(eq(kycProfiles.userId, foreignId));
    await ctx!.db.insert(jobs).values({ queue: 'kyc.submit', payload: { userId: foreignId, submissionId }, status: 'done' });
    await ctx!.db.insert(upaySubmissions).values({ reference: 'unscoped-fixture-operation', kind: 'issue', requestHash: 'fixture', state: 'unknown', evidence: { customerNo: 'fixture-customer-current' } });
    const before = await allRows();
    const preview = await inspectResetTestAccount(ctx!.db, target);
    expect(preview.blockedReasons).toEqual(expect.arrayContaining(['shared_job_binding', 'shared_kyc_binding', 'unscoped_partner_journal']));
    await expect(resetTestAccount(ctx!.db, target, userId, submissionId)).rejects.toThrow('blocked');
    expect(await allRows()).toEqual(before);
  });

  it.each(['upload', 'kyc'] as const)('blocks already dispatched remote %s documents', async kind => {
    const { userId, submissionId } = await setup();
    await ctx!.db.insert(upaySubmissions).values({ reference: kind === 'kyc' ? `kyc:${submissionId}` : `upload:${submissionId}:front`,
      kind, requestHash: 'fixture', state: 'confirmed', evidence: { submissionId, customerNo: 'fixture-customer-current' } });
    await expect(resetTestAccount(ctx!.db, target, userId, submissionId)).rejects.toThrow('remote_documents_or_financial_journal');
  });

  it('preserves a financial alias incorrectly attached to a customer journal and blocks the reset', async () => {
    const { userId, submissionId } = await setup();
    await ctx!.db.insert(upaySubmissionAliases).values({ kind: 'issue', alias: 'order:conflicting-fixture-order', reference: `customer:${submissionId}` });
    const before = await allRows();
    expect((await inspectResetTestAccount(ctx!.db, target)).blockedReasons).toContain('conflicting_journal_alias');
    await expect(resetTestAccount(ctx!.db, target, userId, submissionId)).rejects.toThrow('conflicting_journal_alias');
    expect(await allRows()).toEqual(before);
  });

  it('blocks financial history even after balances return to zero', async () => {
    const { userId, submissionId } = await setup();
    await ctx!.db.transaction(async tx => {
      await post(tx, { kind: 'fixture', reference: 'fixture-in', postings: move(accounts.external('USDT'), accounts.userWallet(userId, 'USDT'), 10n) });
      await post(tx, { kind: 'fixture', reference: 'fixture-out', postings: move(accounts.userWallet(userId, 'USDT'), accounts.external('USDT'), 10n) });
    });
    const before = await allRows();
    expect((await inspectResetTestAccount(ctx!.db, target)).blockedReasons).toContain('ledgerEntries');
    await expect(resetTestAccount(ctx!.db, target, userId, submissionId)).rejects.toThrow('ledgerEntries');
    expect(await allRows()).toEqual(before);
  });

  it('blocks inbound referrals rather than changing another user', async () => {
    const { userId, submissionId } = await setup();
    await ctx!.db.insert(users).values({ telegramId: BigInt(target) + 1n, referredBy: userId });
    const before = await allRows();
    await expect(resetTestAccount(ctx!.db, target, userId, submissionId)).rejects.toThrow('inboundReferrals');
    expect(await allRows()).toEqual(before);
  });

  it('blocks every card and reserved sponsor instead of releasing issuance coverage', async () => {
    const { userId, submissionId } = await setup();
    const [card] = await ctx!.db.insert(cards).values({ userId, productName: 'Fixture', status: 'failed' }).returning();
    const [operation] = await ctx!.db.insert(cardOperations).values({ userId, cardId: card!.id, type: 'issue', status: 'failed', idempotencyKey: 'fixture' }).returning();
    await ctx!.db.update(cardIssueSponsorships).set({ operationId: operation!.id }).where(eq(cardIssueSponsorships.telegramId, BigInt(target)));
    const before = await allRows();
    const preview = await inspectResetTestAccount(ctx!.db, target);
    expect(preview.blockedReasons).toEqual(expect.arrayContaining(['cards', 'cardOperations', 'sponsorship_reserved_or_consumed']));
    await expect(resetTestAccount(ctx!.db, target, userId, submissionId)).rejects.toThrow('blocked');
    expect(await allRows()).toEqual(before);
  });

  it.each(['deposit address', 'deposit', 'withdrawal', 'transfer', 'referral reward', 'nonzero account'])('blocks %s records', async kind => {
    const { userId, submissionId } = await setup();
    const [foreign] = await ctx!.db.insert(users).values({ telegramId: BigInt(target) + 1n }).returning();
    if (kind === 'deposit address') await ctx!.db.insert(depositAddresses).values({ userId, asset: 'USDT', network: 'TON', address: 'fixture-address' });
    if (kind === 'deposit') await ctx!.db.insert(deposits).values({ userId, asset: 'USDT', network: 'TON', address: 'fixture-address', externalId: 'fixture-event', amount: 0n });
    if (kind === 'withdrawal') await ctx!.db.insert(withdrawals).values({ userId, asset: 'USDT', network: 'TON', address: 'fixture-address', amount: 0n, fee: 0n, status: 'failed', idempotencyKey: 'fixture' });
    if (kind === 'transfer') await ctx!.db.insert(transfers).values({ fromUserId: foreign!.id, toUserId: userId, asset: 'USDT', amount: 0n, idempotencyKey: 'fixture' });
    if (kind === 'referral reward') await ctx!.db.insert(referralRewards).values({ referrerId: foreign!.id, refereeId: userId, asset: 'USDT', amount: 0n, source: 'fixture' });
    if (kind === 'nonzero account') await ctx!.db.update(ledgerAccounts).set({ balance: 1n }).where(eq(ledgerAccounts.userId, userId));
    const before = await allRows();
    await expect(resetTestAccount(ctx!.db, target, userId, submissionId)).rejects.toThrow('blocked');
    expect(await allRows()).toEqual(before);
  });

  it('refuses every Telegram identity outside the explicit authorization', async () => {
    const { userId, submissionId } = await setup();
    const before = await allRows();
    await expect(inspectResetTestAccount(ctx!.db, String(Number(target) + 1))).rejects.toThrow('not authorized');
    await expect(resetTestAccount(ctx!.db, String(Number(target) + 1), userId, submissionId)).rejects.toThrow('not authorized');
    expect(await allRows()).toEqual(before);
  });
});
