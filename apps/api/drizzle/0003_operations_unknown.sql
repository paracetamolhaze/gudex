ALTER TYPE operation_status ADD VALUE IF NOT EXISTS 'unknown';
--> statement-breakpoint
ALTER TYPE withdrawal_status ADD VALUE IF NOT EXISTS 'unknown';
--> statement-breakpoint
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lock_token uuid;
