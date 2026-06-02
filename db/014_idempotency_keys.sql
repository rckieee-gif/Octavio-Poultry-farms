CREATE TABLE IF NOT EXISTS idempotency_keys (
  key text PRIMARY KEY,
  status_code integer NOT NULL,
  response_body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys (created_at);
