ALTER TABLE daily_logs
  ADD COLUMN IF NOT EXISTS import_source_key text;

CREATE UNIQUE INDEX IF NOT EXISTS daily_logs_batch_import_source_key
  ON daily_logs (batch_id, import_source_key)
  WHERE import_source_key IS NOT NULL;
