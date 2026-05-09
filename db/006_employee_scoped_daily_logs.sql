ALTER TABLE daily_logs
  ADD COLUMN IF NOT EXISTS employee_id integer REFERENCES stakeholders(id),
  ADD COLUMN IF NOT EXISTS handled_birds_snapshot integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_by_user_id integer REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_logs_batch_employee_date
  ON daily_logs (batch_id, employee_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_logs_building_employee_date
  ON daily_logs (building_id, employee_id, date DESC);
