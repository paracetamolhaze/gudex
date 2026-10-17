import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { DbUpaySubmissionStore } from '../src/partner/upay/submissions';
import { createTestContext, type TestContext } from './helpers';

let ctx: TestContext;
afterEach(async () => { await ctx?.close(); });

describe('durable UPay submissions', () => {
  it('persists the send-once claim across store instances and concurrent attempts', async () => {
    ctx = await createTestContext();
    const first = new DbUpaySubmissionStore(ctx.db), second = new DbUpaySubmissionStore(ctx.db);
    const input = { reference: 'operation-once', kind: 'recharge' as const, requestHash: 'fixture-hash' };
    const claims = await Promise.all([first.begin(input), second.begin(input)]);
    expect(claims.filter((claim) => claim.created)).toHaveLength(1);
    await first.record(input.reference, { state: 'unknown' });
    expect(await new DbUpaySubmissionStore(ctx.db).begin(input)).toMatchObject({ created: false, submission: { state: 'unknown' } });
  });
  it('atomically assigns both receipt aliases to one winner during concurrent reconciliation', async () => {
    ctx = await createTestContext();
    const first = new DbUpaySubmissionStore(ctx.db), second = new DbUpaySubmissionStore(ctx.db);
    await first.begin({ reference: 'by-record', kind: 'recharge', requestHash: 'one' });
    await second.begin({ reference: 'by-order', kind: 'recharge', requestHash: 'two' });
    const results = await Promise.allSettled([
      first.claimAliases('by-record', ['record:R', 'order:O']),
      second.claimAliases('by-order', ['order:O', 'record:R']),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const aliases = await ctx.db.execute(sql`select alias, reference from upay_submission_aliases order by alias`);
    expect(aliases.rows).toHaveLength(2);
    expect(new Set(aliases.rows.map((r) => r.reference)).size).toBe(1);
  });
  it('rolls back a partial alias claim and prevents one card satisfying two issuance references', async () => {
    ctx = await createTestContext();
    const journal = new DbUpaySubmissionStore(ctx.db);
    await journal.begin({ reference: 'issue-a', kind: 'issue', requestHash: 'one' });
    await journal.begin({ reference: 'issue-b', kind: 'issue', requestHash: 'two' });
    await journal.claimAliases('issue-a', ['record:R', 'card:C']);
    await expect(journal.claimAliases('issue-b', ['order:O', 'record:R'])).rejects.toMatchObject({ retryable: true });
    expect((await ctx.db.execute(sql`select alias from upay_submission_aliases where alias = 'order:O'`)).rows).toEqual([]);
    await expect(journal.claimAliases('issue-b', ['card:C'])).rejects.toMatchObject({ retryable: true });
    await journal.claimAliases('issue-a', ['order:O', 'record:R', 'card:C']);
    expect((await ctx.db.execute(sql`select count(*)::int as count from upay_submission_aliases`)).rows[0]).toEqual({ count: 3 });
  });
});
