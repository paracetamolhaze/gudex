import { eq, sql } from 'drizzle-orm';
import type { Config } from './config';
import type { Db } from './db/client';
import { appSettings } from './db/schema';

// Existing demo balances must never become spendable at the real card issuer.
// Activate financial writes against a clean, separate database and seal it against mock runtime use.
export async function prepareRuntimeMode(config: Config, db: Db): Promise<void> {
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(727276)`);
    const [setting] = await tx.select().from(appSettings).where(eq(appSettings.key, 'financial_mode'));
    if (setting?.value === 'live' && config.CARD_PARTNER === 'mock') throw new Error('This database is sealed for live financial operations; mock runtime is prohibited');
    if (config.CARD_PARTNER !== 'upay' || !(config.UPAY_WRITES_ENABLED || config.UPAY_INVOICE_DEPOSITS_ENABLED)) return;
    const result = await tx.execute(sql`
      select exists(select 1 from deposits where external_id like 'mock:%' or provider_id = 'mock')
          or exists(select 1 from mock_upay_cards)
          or exists(select 1 from kyc_profiles where partner_provider = 'mock' and status = 'approved')
          or exists(select 1 from card_operations where partner_provider <> 'upay' and status in ('pending', 'processing', 'unknown'))
          or exists(select 1 from withdrawals where provider_id = 'mock' and status in ('pending', 'processing', 'unknown')) as contaminated
    `);
    if (result.rows[0]?.contaminated) throw new Error('Real UPay writes require a clean live database; demo balances and approved mock identities cannot be migrated into spendable funds');
    await tx.insert(appSettings).values({ key: 'financial_mode', value: 'live' }).onConflictDoUpdate({ target: appSettings.key, set: { value: 'live', updatedAt: new Date() } });
  });
}
