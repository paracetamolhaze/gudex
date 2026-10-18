-- A pool of app wallet addresses: each address is lent to one client at a time; no unique amounts.
DROP INDEX fee_payments_active_amount;
--> statement-breakpoint
ALTER TABLE fee_payments ADD COLUMN family text;
--> statement-breakpoint
UPDATE fee_payments SET family = CASE WHEN network = 'TRC20' THEN 'tron' ELSE 'evm' END;
--> statement-breakpoint
ALTER TABLE fee_payments ALTER COLUMN family SET NOT NULL;
--> statement-breakpoint
ALTER TABLE fee_payments ADD CONSTRAINT fee_payments_family CHECK (family IN ('tron', 'evm'));
--> statement-breakpoint
ALTER TABLE fee_payments ADD COLUMN received bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE fee_payments ADD COLUMN ended_at timestamptz;
--> statement-breakpoint
UPDATE fee_payments SET ended_at = coalesce(paid_at, expires_at) WHERE status <> 'awaiting';
--> statement-breakpoint
CREATE UNIQUE INDEX fee_payments_active_address ON fee_payments(lower(address)) WHERE status = 'awaiting';
