-- Existing rows were generated only by the demo deposit/withdrawal integrations.
ALTER TABLE "deposit_addresses" ADD COLUMN "provider_id" text DEFAULT 'mock' NOT NULL;
--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN "provider_id" text DEFAULT 'mock' NOT NULL;
--> statement-breakpoint
ALTER TABLE "withdrawals" ADD COLUMN "provider_id" text DEFAULT 'mock' NOT NULL;
--> statement-breakpoint
CREATE TRIGGER "deposit_addresses_guard_demo" BEFORE INSERT OR UPDATE ON "deposit_addresses"
FOR EACH ROW WHEN (NEW.provider_id = 'mock') EXECUTE FUNCTION "gudex_guard_demo_write"();
--> statement-breakpoint
CREATE TRIGGER "deposits_guard_provider_demo" BEFORE INSERT OR UPDATE ON "deposits"
FOR EACH ROW WHEN (NEW.provider_id = 'mock') EXECUTE FUNCTION "gudex_guard_demo_write"();
--> statement-breakpoint
CREATE TRIGGER "withdrawals_guard_demo" BEFORE INSERT ON "withdrawals"
FOR EACH ROW WHEN (NEW.provider_id = 'mock') EXECUTE FUNCTION "gudex_guard_demo_write"();
