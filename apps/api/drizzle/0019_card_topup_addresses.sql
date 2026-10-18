-- Crypto addresses UPay gives a card for top-ups, entered by the operator; the client sees them in the Mini App.
ALTER TABLE "cards" ADD COLUMN "topup_addresses" jsonb;
