CREATE TABLE card_operation_request_aliases (
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL,
  operation_id uuid NOT NULL REFERENCES card_operations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idempotency_key)
);
--> statement-breakpoint
CREATE INDEX card_operation_request_aliases_operation_idx ON card_operation_request_aliases(operation_id);
--> statement-breakpoint
CREATE FUNCTION gudex_guard_card_operation_request_alias() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'Card operation request aliases are immutable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM card_operations o WHERE o.id = NEW.operation_id AND o.user_id = NEW.user_id
    AND o.type = 'issue' AND o.sponsorship_id IS NULL AND o.status IN ('pending', 'processing')) THEN
    RAISE EXCEPTION 'Card operation request alias requires an owned pending issuance';
  END IF;
  IF EXISTS (SELECT 1 FROM card_operations o WHERE o.user_id = NEW.user_id AND o.idempotency_key = NEW.idempotency_key) THEN
    RAISE EXCEPTION 'Card operation request key is already bound';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER card_operation_request_aliases_guard BEFORE INSERT OR UPDATE OR DELETE ON card_operation_request_aliases
FOR EACH ROW EXECUTE FUNCTION gudex_guard_card_operation_request_alias();
--> statement-breakpoint
CREATE FUNCTION gudex_guard_card_operation_aliased_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM card_operation_request_aliases a WHERE a.user_id = NEW.user_id AND a.idempotency_key = NEW.idempotency_key) THEN
    RAISE EXCEPTION 'Card operation request key is already bound';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER card_operations_guard_aliased_key BEFORE INSERT ON card_operations
FOR EACH ROW EXECUTE FUNCTION gudex_guard_card_operation_aliased_key();
