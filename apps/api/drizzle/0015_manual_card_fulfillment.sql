ALTER TABLE card_operations ADD COLUMN fulfillment_mode text NOT NULL DEFAULT 'automatic';
--> statement-breakpoint
ALTER TABLE card_operations ADD CONSTRAINT card_operations_fulfillment_mode CHECK (fulfillment_mode IN ('automatic', 'manual'));
--> statement-breakpoint
ALTER TABLE card_operations ADD CONSTRAINT card_operations_manual_dispatch CHECK (fulfillment_mode <> 'manual' OR (type = 'issue' AND attempts = 0 AND status IN ('pending', 'succeeded', 'failed')));
--> statement-breakpoint
CREATE TABLE admin_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL,
  recipient_telegram_id bigint NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  stage text NOT NULL CHECK (stage IN ('verification', 'issuance')),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CONSTRAINT admin_notifications_event_recipient UNIQUE (event_key, recipient_telegram_id)
);
--> statement-breakpoint
CREATE TABLE admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  target_user_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL,
  reference text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_audit_action_reference UNIQUE (action, reference)
);
--> statement-breakpoint
CREATE INDEX admin_audit_target_idx ON admin_audit_log(target_user_id);
