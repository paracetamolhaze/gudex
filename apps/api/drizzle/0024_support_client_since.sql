-- The client sees only the conversation since this moment: a closed conversation the client has read is cleared
-- from their screen the next time they open support. The operator still sees the whole history.
ALTER TABLE support_threads ADD COLUMN client_since timestamptz;
