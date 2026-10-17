CREATE TABLE "upay_submissions" (
  "reference" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "request_hash" text NOT NULL,
  "state" text NOT NULL,
  "partner_receipt_id" text,
  "partner_card_id" text,
  "evidence" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "upay_submissions_receipt_unique" ON "upay_submissions" ("kind", "partner_receipt_id") WHERE partner_receipt_id IS NOT NULL;
