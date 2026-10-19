-- Client mail addresses on our domain (the email UPay knows the client by). Letters to them arrive through
-- Cloudflare Email Routing; codes from allowed senders go to the owner's Telegram chat. Letter bodies are never stored.
CREATE TABLE mail_addresses (
  address text PRIMARY KEY CHECK (address = lower(address) AND length(address) <= 254),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Who may send codes: an exact address (noreply@upay.com) or a whole domain (upay.com). Optional own code pattern.
CREATE TABLE mail_senders (
  pattern text PRIMARY KEY CHECK (pattern = lower(pattern) AND length(pattern) <= 254),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  code_pattern text CHECK (code_pattern IS NULL OR length(code_pattern) <= 200),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE inbound_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One letter is handled once, however many times the Worker delivers it.
  dedupe_key text NOT NULL UNIQUE,
  recipient text NOT NULL,
  user_id uuid REFERENCES users(id),
  sender text NOT NULL,
  subject text CHECK (subject IS NULL OR length(subject) <= 200),
  sent_at timestamptz,
  status text NOT NULL CHECK (status IN ('queued', 'delivered', 'unknown_sender', 'stale', 'rate_limited', 'expired', 'failed')),
  has_code boolean NOT NULL DEFAULT false,
  -- The code only, sealed to this row, wiped once sent or expired.
  code_ciphertext text,
  code_iv text,
  code_tag text,
  code_expires_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  CHECK ((code_ciphertext IS NULL) = (code_iv IS NULL) AND (code_iv IS NULL) = (code_tag IS NULL))
);
--> statement-breakpoint
CREATE INDEX inbound_emails_user_idx ON inbound_emails(user_id, created_at);
--> statement-breakpoint
CREATE INDEX inbound_emails_created_idx ON inbound_emails(created_at);
--> statement-breakpoint
CREATE INDEX inbound_emails_status_idx ON inbound_emails(status, created_at);
