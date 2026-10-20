-- In-app support: one conversation per client, messages from the client and from GUDEX support.
CREATE TABLE support_threads (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  last_client_message_at timestamptz,
  last_support_message_at timestamptz,
  client_read_at timestamptz,
  support_read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX support_threads_last_message_idx ON support_threads(last_message_at);
--> statement-breakpoint
CREATE TABLE support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES support_threads(user_id),
  author text NOT NULL CHECK (author IN ('client', 'support')),
  -- Who answered; no foreign key, so removing an administrator's own account never touches other conversations.
  admin_user_id uuid,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX support_messages_thread_idx ON support_messages(user_id, created_at);
--> statement-breakpoint
-- Administrators are told about a new support message through the same outbox as applications.
ALTER TABLE admin_notifications DROP CONSTRAINT admin_notifications_stage;
--> statement-breakpoint
ALTER TABLE admin_notifications ADD CONSTRAINT admin_notifications_stage CHECK (stage IN ('verification', 'issuance', 'card_request', 'support'));
