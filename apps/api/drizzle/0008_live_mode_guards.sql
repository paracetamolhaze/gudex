-- A warm deployment from before activation must not mint demo funds in a sealed live DB.
ALTER TABLE "card_operations" ADD COLUMN "partner_provider" text DEFAULT 'mock' NOT NULL;
--> statement-breakpoint
CREATE FUNCTION "gudex_guard_demo_write"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(727276);
  IF EXISTS (SELECT 1 FROM app_settings WHERE key = 'financial_mode' AND value = '"live"'::jsonb) THEN
    RAISE EXCEPTION 'Demo writes are prohibited in a live financial database';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "deposits_guard_demo" BEFORE INSERT OR UPDATE ON "deposits"
FOR EACH ROW WHEN (NEW.external_id LIKE 'mock:%') EXECUTE FUNCTION "gudex_guard_demo_write"();
--> statement-breakpoint
CREATE TRIGGER "customers_guard_demo" BEFORE INSERT OR UPDATE ON "mock_upay_customers"
FOR EACH ROW EXECUTE FUNCTION "gudex_guard_demo_write"();
--> statement-breakpoint
CREATE TRIGGER "cards_guard_demo" BEFORE INSERT OR UPDATE ON "mock_upay_cards"
FOR EACH ROW EXECUTE FUNCTION "gudex_guard_demo_write"();
--> statement-breakpoint
CREATE TRIGGER "recharges_guard_demo" BEFORE INSERT OR UPDATE ON "mock_upay_recharges"
FOR EACH ROW EXECUTE FUNCTION "gudex_guard_demo_write"();
--> statement-breakpoint
CREATE TRIGGER "transactions_guard_demo" BEFORE INSERT OR UPDATE ON "mock_upay_transactions"
FOR EACH ROW EXECUTE FUNCTION "gudex_guard_demo_write"();
--> statement-breakpoint
CREATE TRIGGER "kyc_guard_demo" BEFORE INSERT OR UPDATE ON "kyc_profiles"
FOR EACH ROW WHEN (NEW.partner_provider = 'mock') EXECUTE FUNCTION "gudex_guard_demo_write"();
--> statement-breakpoint
CREATE TRIGGER "operations_guard_demo" BEFORE INSERT ON "card_operations"
FOR EACH ROW WHEN (NEW.partner_provider <> 'upay') EXECUTE FUNCTION "gudex_guard_demo_write"();
--> statement-breakpoint
CREATE FUNCTION "gudex_guard_live_seal"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.key = 'financial_mode' AND OLD.value = '"live"'::jsonb THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'The live financial database seal is immutable'; END IF;
    IF NEW.key IS DISTINCT FROM OLD.key OR NEW.value IS DISTINCT FROM OLD.value THEN
      RAISE EXCEPTION 'The live financial database seal is immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "app_settings_guard_live_seal" BEFORE UPDATE OR DELETE ON "app_settings"
FOR EACH ROW EXECUTE FUNCTION "gudex_guard_live_seal"();
--> statement-breakpoint
ALTER TABLE "kyc_documents" RENAME CONSTRAINT "kyc_documents_user_id_fkey" TO "kyc_documents_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "upay_submission_aliases" RENAME CONSTRAINT "upay_submission_aliases_reference_fkey" TO "upay_submission_aliases_reference_upay_submissions_reference_fk";
