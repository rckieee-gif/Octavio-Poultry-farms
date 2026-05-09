ALTER TABLE daily_logs
  ADD COLUMN IF NOT EXISTS average_weight_g numeric(8,2);
