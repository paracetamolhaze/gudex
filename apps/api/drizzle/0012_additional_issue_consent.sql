ALTER TABLE card_issue_sponsorships DROP CONSTRAINT card_issue_sponsorships_telegram_id_unique;
--> statement-breakpoint
ALTER TABLE card_issue_sponsorships ADD COLUMN retry_of_operation_id uuid UNIQUE REFERENCES card_operations(id);
--> statement-breakpoint
CREATE UNIQUE INDEX card_issue_sponsorships_primary_telegram_unique ON card_issue_sponsorships(telegram_id) WHERE retry_of_operation_id IS NULL;
--> statement-breakpoint
ALTER TABLE card_issue_sponsorships ADD CONSTRAINT card_issue_sponsorships_retry_target CHECK
  (retry_of_operation_id IS NULL OR (telegram_id = 514468501 AND retry_of_operation_id = '82c68578-6791-463f-9c6d-edbd4407a8ff'::uuid));
--> statement-breakpoint
CREATE TABLE card_issue_retry_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  original_operation_id uuid NOT NULL UNIQUE REFERENCES card_operations(id),
  new_operation_id uuid NOT NULL UNIQUE REFERENCES card_operations(id),
  sponsorship_id uuid NOT NULL UNIQUE REFERENCES card_issue_sponsorships(id),
  terms_version text NOT NULL,
  quote_hash text NOT NULL,
  auth_version integer NOT NULL,
  kyc_snapshot_hash text NOT NULL,
  original_snapshot_hash text NOT NULL,
  product_id text NOT NULL,
  additional_budget_usd bigint NOT NULL,
  cumulative_budget_usd bigint NOT NULL,
  consented_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT card_issue_retry_consents_terms CHECK (terms_version = 'additional-issue-v1'),
  CONSTRAINT card_issue_retry_consents_budgets CHECK (additional_budget_usd = 1000 AND cumulative_budget_usd = 2000)
);
--> statement-breakpoint
CREATE FUNCTION gudex_guard_retry_sponsorship() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.retry_of_operation_id IS DISTINCT FROM NEW.retry_of_operation_id OR OLD.telegram_id IS DISTINCT FROM NEW.telegram_id) THEN
    RAISE EXCEPTION 'Broker issuance authorization identity is immutable';
  END IF;
  IF NEW.retry_of_operation_id IS NOT NULL AND current_setting('gudex.sponsorship_v2', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Additional issuance requires a compatible consent-aware worker';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER card_issue_sponsorships_guard_retry BEFORE INSERT OR UPDATE ON card_issue_sponsorships FOR EACH ROW EXECUTE FUNCTION gudex_guard_retry_sponsorship();
--> statement-breakpoint
CREATE FUNCTION gudex_guard_retry_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE grant_row card_issue_sponsorships%ROWTYPE;
BEGIN
  SELECT * INTO grant_row FROM card_issue_sponsorships WHERE id = NEW.sponsorship_id;
  IF grant_row.retry_of_operation_id IS NOT NULL AND current_setting('gudex.sponsorship_v2', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Additional issuance requires a compatible consent-aware worker';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER card_operations_guard_retry BEFORE INSERT OR UPDATE ON card_operations FOR EACH ROW EXECUTE FUNCTION gudex_guard_retry_operation();
--> statement-breakpoint
CREATE FUNCTION gudex_guard_retry_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref text; retry_operation_id uuid; is_retry boolean;
BEGIN
  IF TG_TABLE_NAME = 'ledger_transactions' THEN ref := NEW.reference;
  ELSE SELECT reference INTO ref FROM ledger_transactions WHERE id = NEW.transaction_id; END IF;
  retry_operation_id := gudex_sponsored_operation(ref);
  SELECT g.retry_of_operation_id IS NOT NULL INTO is_retry FROM card_operations o JOIN card_issue_sponsorships g ON g.id = o.sponsorship_id WHERE o.id = retry_operation_id;
  IF is_retry AND current_setting('gudex.sponsorship_v2', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Additional issuance requires a compatible consent-aware worker';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_guard_retry BEFORE INSERT ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION gudex_guard_retry_ledger();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_guard_retry BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION gudex_guard_retry_ledger();
--> statement-breakpoint
CREATE FUNCTION gudex_verify_retry_consent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE grant_row card_issue_sponsorships%ROWTYPE; consent_row card_issue_retry_consents%ROWTYPE; owner_telegram bigint;
BEGIN
  SELECT * INTO grant_row FROM card_issue_sponsorships WHERE id = NEW.sponsorship_id;
  IF grant_row.retry_of_operation_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO consent_row FROM card_issue_retry_consents WHERE new_operation_id = NEW.id;
  SELECT telegram_id INTO owner_telegram FROM users WHERE id = NEW.user_id;
  IF consent_row.id IS NULL OR consent_row.user_id IS DISTINCT FROM NEW.user_id OR owner_telegram IS DISTINCT FROM 514468501::bigint
    OR consent_row.original_operation_id IS DISTINCT FROM grant_row.retry_of_operation_id
    OR consent_row.sponsorship_id IS DISTINCT FROM grant_row.id OR grant_row.operation_id IS DISTINCT FROM NEW.id
    OR consent_row.additional_budget_usd <> 1000 OR consent_row.cumulative_budget_usd <> 2000 THEN
    RAISE EXCEPTION 'Additional issuance requires the exact durable human consent';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER card_operations_verify_retry_consent AFTER INSERT ON card_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gudex_verify_retry_consent();
--> statement-breakpoint
CREATE FUNCTION gudex_retry_consent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Additional issuance consent audit is immutable'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER card_issue_retry_consents_immutable BEFORE UPDATE OR DELETE ON card_issue_retry_consents FOR EACH ROW EXECUTE FUNCTION gudex_retry_consent_immutable();
