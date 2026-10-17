ALTER TYPE "kyc_status" ADD VALUE IF NOT EXISTS 'unknown';
--> statement-breakpoint
ALTER TABLE "kyc_profiles" ADD COLUMN "phone" text;
ALTER TABLE "kyc_profiles" ADD COLUMN "global_code" text;
ALTER TABLE "kyc_profiles" ADD COLUMN "document_type" text;
ALTER TABLE "kyc_profiles" ADD COLUMN "document_country" text;
ALTER TABLE "kyc_profiles" ADD COLUMN "document_ids" jsonb;
ALTER TABLE "kyc_profiles" ADD COLUMN "submission_id" uuid;
ALTER TABLE "kyc_profiles" ADD COLUMN "submission_state" text DEFAULT 'none' NOT NULL;
ALTER TABLE "kyc_profiles" ADD COLUMN "documents_submitted_at" timestamp with time zone;
ALTER TABLE "kyc_profiles" ADD COLUMN "partner_provider" text DEFAULT 'mock' NOT NULL;
--> statement-breakpoint
CREATE TABLE "kyc_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "kind" text NOT NULL,
  "mime_type" text NOT NULL,
  "size" integer NOT NULL,
  "ciphertext" text NOT NULL,
  "iv" text NOT NULL,
  "tag" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "kyc_documents_user_idx" ON "kyc_documents" ("user_id");
CREATE INDEX "kyc_documents_expiry_idx" ON "kyc_documents" ("expires_at");
