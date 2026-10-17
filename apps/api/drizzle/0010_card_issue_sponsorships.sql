CREATE TABLE "card_issue_sponsorships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "telegram_id" bigint NOT NULL,
  "partner_provider" text DEFAULT 'upay' NOT NULL,
  "budget_usd" bigint DEFAULT 1000 NOT NULL,
  "operation_id" uuid,
  "consumed_at" timestamp with time zone,
  "reason" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "card_issue_sponsorships_telegram_id_unique" UNIQUE ("telegram_id"),
  CONSTRAINT "card_issue_sponsorships_operation_id_unique" UNIQUE ("operation_id"),
  CONSTRAINT "card_issue_sponsorships_operation_id_card_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "card_operations"("id"),
  CONSTRAINT "card_issue_sponsorships_budget" CHECK ("budget_usd" = 1000),
  CONSTRAINT "card_issue_sponsorships_provider" CHECK ("partner_provider" = 'upay'),
  CONSTRAINT "card_issue_sponsorships_consumed" CHECK ("consumed_at" IS NULL OR "operation_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "card_operations" ADD COLUMN "sponsorship_id" uuid;
--> statement-breakpoint
ALTER TABLE "card_operations" ADD CONSTRAINT "card_operations_sponsorship_id_card_issue_sponsorships_id_fk" FOREIGN KEY ("sponsorship_id") REFERENCES "card_issue_sponsorships"("id");
--> statement-breakpoint
ALTER TABLE "card_operations" ADD CONSTRAINT "card_operations_sponsorship_fields" CHECK (
  "sponsorship_id" IS NULL OR ("type" = 'issue' AND "partner_provider" = 'upay' AND "asset" IS NOT NULL AND "asset" = 'USDT'
    AND "amount" IS NOT NULL AND "amount" = 10000000 AND "fee" IS NOT NULL AND "fee" = "amount")
);
--> statement-breakpoint
CREATE FUNCTION "gudex_sponsored_operation"(event_reference text) RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE raw_id text; operation_id uuid;
BEGIN
  IF event_reference ~ '^card_issue_(hold|settle|refund):' THEN raw_id := split_part(event_reference, ':', 2);
  ELSIF event_reference ~ '^referral_reward:card_issue:' THEN raw_id := split_part(event_reference, ':', 3);
  ELSE RETURN NULL; END IF;
  IF raw_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN RETURN NULL; END IF;
  SELECT o.id INTO operation_id FROM card_operations o WHERE o.id = raw_id::uuid AND o.sponsorship_id IS NOT NULL;
  RETURN operation_id;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "gudex_guard_sponsored_transaction"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE operation_id uuid;
BEGIN
  operation_id := gudex_sponsored_operation(NEW.reference);
  IF operation_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.reference LIKE 'referral_reward:%' THEN RAISE EXCEPTION 'Broker sponsorship cannot create referral income'; END IF;
  IF current_setting('gudex.sponsorship_v1', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Broker sponsorship requires a compatible worker';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ledger_transactions_guard_sponsored" BEFORE INSERT ON "ledger_transactions"
FOR EACH ROW EXECUTE FUNCTION "gudex_guard_sponsored_transaction"();
--> statement-breakpoint
CREATE FUNCTION "gudex_guard_sponsored_entry"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref text; operation_id uuid; account_code text; account_asset text;
BEGIN
  SELECT reference INTO ref FROM ledger_transactions WHERE id = NEW.transaction_id;
  operation_id := gudex_sponsored_operation(ref);
  IF operation_id IS NULL THEN RETURN NEW; END IF;
  IF current_setting('gudex.sponsorship_v1', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Broker sponsorship requires a compatible worker';
  END IF;
  SELECT code, asset INTO account_code, account_asset FROM ledger_accounts WHERE id = NEW.account_id;
  IF NEW.asset <> 'USDT' OR account_asset <> 'USDT' OR abs(NEW.amount) > 10000000 THEN
    RAISE EXCEPTION 'Invalid broker sponsorship posting';
  END IF;
  IF ref = 'card_issue_hold:' || operation_id THEN
    IF NOT ((account_code = 'system:broker_issue_expense:USDT' AND NEW.amount = -10000000) OR
            (account_code = 'system:clearing:USDT' AND NEW.amount = 10000000)) THEN
      RAISE EXCEPTION 'Broker sponsorship hold cannot use user funds';
    END IF;
  ELSIF ref = 'card_issue_refund:' || operation_id THEN
    IF NOT ((account_code = 'system:broker_issue_expense:USDT' AND NEW.amount = 10000000) OR
            (account_code = 'system:clearing:USDT' AND NEW.amount = -10000000)) THEN
      RAISE EXCEPTION 'Broker sponsorship refund cannot credit user funds';
    END IF;
  ELSIF ref = 'card_issue_settle:' || operation_id THEN
    IF NOT ((account_code = 'system:clearing:USDT' AND NEW.amount = -10000000) OR
            (account_code IN ('system:broker_issue_expense:USDT', 'system:partner_funding:USDT') AND NEW.amount > 0)) THEN
      RAISE EXCEPTION 'Broker sponsorship settlement cannot create fees or user funds';
    END IF;
  ELSE
    RAISE EXCEPTION 'Broker sponsorship cannot create referral income';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ledger_entries_guard_sponsored" BEFORE INSERT ON "ledger_entries"
FOR EACH ROW EXECUTE FUNCTION "gudex_guard_sponsored_entry"();
--> statement-breakpoint
CREATE FUNCTION "gudex_guard_sponsored_operation"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE grant_row card_issue_sponsorships%ROWTYPE; ref text; clearing_total bigint; expense_total bigint; funding_total bigint;
BEGIN
  IF OLD.sponsorship_id IS DISTINCT FROM NEW.sponsorship_id THEN RAISE EXCEPTION 'The issuance payer is immutable'; END IF;
  IF NEW.sponsorship_id IS NULL THEN RETURN NEW; END IF;
  IF current_setting('gudex.sponsorship_v1', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Broker sponsorship requires a compatible worker';
  END IF;
  IF NEW.status NOT IN ('succeeded', 'failed') OR NEW.status = OLD.status THEN RETURN NEW; END IF;
  SELECT * INTO grant_row FROM card_issue_sponsorships WHERE id = NEW.sponsorship_id;
  IF NEW.status = 'succeeded' THEN
    IF grant_row.operation_id IS DISTINCT FROM NEW.id OR grant_row.consumed_at IS NULL THEN
      RAISE EXCEPTION 'Broker sponsorship success requires the exact consumed grant';
    END IF;
    ref := 'card_issue_settle:' || NEW.id;
  ELSE
    IF grant_row.operation_id IS NOT NULL OR grant_row.consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Broker sponsorship rejection requires a released grant';
    END IF;
    ref := 'card_issue_refund:' || NEW.id;
  END IF;
  SELECT coalesce(sum(e.amount) FILTER (WHERE a.code = 'system:clearing:USDT'), 0),
         coalesce(sum(e.amount) FILTER (WHERE a.code = 'system:broker_issue_expense:USDT'), 0),
         coalesce(sum(e.amount) FILTER (WHERE a.code = 'system:partner_funding:USDT'), 0)
    INTO clearing_total, expense_total, funding_total
    FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id JOIN ledger_accounts a ON a.id = e.account_id
    WHERE t.reference = ref;
  IF clearing_total <> -10000000 OR expense_total < 0 OR funding_total < 0 OR clearing_total + expense_total + funding_total <> 0 OR
     (NEW.status = 'failed' AND (expense_total <> 10000000 OR funding_total <> 0)) THEN
    RAISE EXCEPTION 'Broker sponsorship terminal state requires its exact financial settlement';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "card_operations_guard_sponsored" BEFORE UPDATE ON "card_operations"
FOR EACH ROW EXECUTE FUNCTION "gudex_guard_sponsored_operation"();
