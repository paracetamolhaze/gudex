-- One shared app wallet receives the card issuance fee; a unique exact amount identifies the payer.
CREATE TABLE fee_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  asset text NOT NULL,
  network text NOT NULL,
  address text NOT NULL,
  amount bigint NOT NULL,
  status text NOT NULL DEFAULT 'awaiting',
  transfer_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  CONSTRAINT fee_payments_asset CHECK (asset IN ('USDT', 'USDC')),
  CONSTRAINT fee_payments_network CHECK (network IN ('TRC20', 'BEP20', 'ERC20', 'POLYGON')),
  CONSTRAINT fee_payments_amount CHECK (amount > 0),
  CONSTRAINT fee_payments_status CHECK (status IN ('awaiting', 'paid', 'expired', 'cancelled')),
  CONSTRAINT fee_payments_paid CHECK (status <> 'paid' OR (transfer_id IS NOT NULL AND paid_at IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX fee_payments_active_amount ON fee_payments(network, asset, amount) WHERE status = 'awaiting';
--> statement-breakpoint
CREATE UNIQUE INDEX fee_payments_one_active ON fee_payments(user_id) WHERE status = 'awaiting';
--> statement-breakpoint
CREATE INDEX fee_payments_user_idx ON fee_payments(user_id);
--> statement-breakpoint
CREATE TABLE wallet_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network text NOT NULL,
  asset text NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL DEFAULT 0,
  from_address text NOT NULL,
  to_address text NOT NULL,
  amount bigint NOT NULL,
  exact boolean NOT NULL,
  block_number bigint,
  block_time timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'new',
  user_id uuid REFERENCES users(id),
  deposit_id uuid REFERENCES deposits(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT wallet_transfers_status CHECK (status IN ('new', 'matched', 'unmatched', 'assigned')),
  CONSTRAINT wallet_transfers_amount CHECK (amount >= 0),
  CONSTRAINT wallet_transfers_credit CHECK (status NOT IN ('matched', 'assigned') OR (user_id IS NOT NULL AND deposit_id IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX wallet_transfers_identity ON wallet_transfers(network, tx_hash, log_index);
--> statement-breakpoint
CREATE INDEX wallet_transfers_status_idx ON wallet_transfers(status);
--> statement-breakpoint
-- The UPay bot only reads card balances; card details are entered by an operator and kept encrypted.
ALTER TABLE cards ADD COLUMN partner_balance bigint;
--> statement-breakpoint
ALTER TABLE cards ADD COLUMN partner_balance_at timestamptz;
--> statement-breakpoint
ALTER TABLE cards ADD COLUMN requisites_ciphertext text;
--> statement-breakpoint
ALTER TABLE cards ADD COLUMN requisites_iv text;
--> statement-breakpoint
ALTER TABLE cards ADD COLUMN requisites_tag text;
--> statement-breakpoint
-- Top-ups and freezes become operator requests too; a manual operation still never dispatches.
ALTER TABLE card_operations DROP CONSTRAINT card_operations_manual_dispatch;
--> statement-breakpoint
ALTER TABLE card_operations ADD CONSTRAINT card_operations_manual_dispatch CHECK (fulfillment_mode <> 'manual' OR (attempts = 0 AND status IN ('pending', 'succeeded', 'failed')));
--> statement-breakpoint
ALTER TABLE admin_notifications DROP CONSTRAINT admin_notifications_stage_check;
--> statement-breakpoint
ALTER TABLE admin_notifications ADD CONSTRAINT admin_notifications_stage CHECK (stage IN ('verification', 'issuance', 'card_request'));
