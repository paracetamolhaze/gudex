-- Codes are accepted only from MAIL_ALLOWED_SENDERS (UPay by default): the editable sender list is no longer read.
-- mail_senders stays for now so the previous deployment can still serve after a rollback; drop it in a later release.
-- A letter from an allowed sender without a confident code is recorded as no_code and not forwarded.
ALTER TABLE inbound_emails DROP CONSTRAINT inbound_emails_status_check;
--> statement-breakpoint
ALTER TABLE inbound_emails ADD CONSTRAINT inbound_emails_status_check
  CHECK (status IN ('queued', 'delivered', 'no_code', 'unknown_sender', 'stale', 'rate_limited', 'expired', 'failed'));
