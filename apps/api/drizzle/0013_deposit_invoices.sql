CREATE TABLE deposit_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  provider_id text NOT NULL DEFAULT 'upay-invoice',
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  asset text NOT NULL,
  network text NOT NULL,
  requested_amount bigint NOT NULL,
  state text NOT NULL DEFAULT 'sending',
  order_no text UNIQUE,
  url_ciphertext text,
  url_iv text,
  url_tag text,
  expires_at timestamp with time zone,
  receipt_id text UNIQUE,
  credited_amount bigint,
  credited_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT deposit_invoices_provider CHECK (provider_id = 'upay-invoice'),
  CONSTRAINT deposit_invoices_amount CHECK (requested_amount > 0 AND (credited_amount IS NULL OR credited_amount > 0)),
  CONSTRAINT deposit_invoices_state CHECK (state IN ('prepared','sending','awaiting_payment','confirming','credited','expired','unknown')),
  CONSTRAINT deposit_invoices_credit_proof CHECK (state <> 'credited' OR (order_no IS NOT NULL AND receipt_id IS NOT NULL AND credited_amount IS NOT NULL AND credited_at IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX deposit_invoices_idempotency ON deposit_invoices(user_id, idempotency_key);
--> statement-breakpoint
CREATE INDEX deposit_invoices_user_idx ON deposit_invoices(user_id);
--> statement-breakpoint
CREATE FUNCTION gudex_guard_deposit_invoice_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.provider_id IS DISTINCT FROM NEW.provider_id OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR OLD.request_hash IS DISTINCT FROM NEW.request_hash OR OLD.asset IS DISTINCT FROM NEW.asset OR OLD.network IS DISTINCT FROM NEW.network
    OR OLD.requested_amount IS DISTINCT FROM NEW.requested_amount
    OR (OLD.order_no IS NOT NULL AND OLD.order_no IS DISTINCT FROM NEW.order_no)
    OR (OLD.receipt_id IS NOT NULL AND OLD.receipt_id IS DISTINCT FROM NEW.receipt_id)
    OR (OLD.state = 'credited' AND (NEW.state <> 'credited' OR OLD.credited_amount IS DISTINCT FROM NEW.credited_amount OR OLD.credited_at IS DISTINCT FROM NEW.credited_at)) THEN
    RAISE EXCEPTION 'Native invoice ownership and credit proof are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER deposit_invoices_guard_identity BEFORE UPDATE ON deposit_invoices FOR EACH ROW EXECUTE FUNCTION gudex_guard_deposit_invoice_identity();
