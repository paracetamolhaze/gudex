CREATE TABLE "card_billing_addresses" (
  "user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id"),
  "customer_no" text NOT NULL UNIQUE,
  "marker" varchar(20) NOT NULL UNIQUE,
  "request_hash" text NOT NULL,
  "ciphertext" text NOT NULL,
  "iv" text NOT NULL,
  "tag" text NOT NULL,
  "status" text NOT NULL DEFAULT 'prepared',
  "partner_address_id" text UNIQUE,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "card_billing_addresses_status" CHECK ("status" IN ('prepared', 'sending', 'acknowledged', 'unknown', 'ready', 'rejected')),
  CONSTRAINT "card_billing_addresses_marker" CHECK ("marker" ~ '^GDXB[a-f0-9]{16}$')
);
