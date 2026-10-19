-- Proof that a client accepted the Terms of Use and the Privacy Policy (consent to personal-data processing).
ALTER TABLE users ADD COLUMN terms_version text;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN terms_accepted_at timestamptz;
