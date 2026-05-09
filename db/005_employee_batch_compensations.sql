CREATE TABLE IF NOT EXISTS employee_batch_compensations (
  id serial PRIMARY KEY,
  farm_id uuid REFERENCES farms(id),
  batch_id varchar(50) NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  employee_id integer NOT NULL REFERENCES stakeholders(id),
  handled_birds integer NOT NULL DEFAULT 0,
  rate_per_bird numeric(6,2) NOT NULL DEFAULT 1.50,
  corpo_group text,
  remarks text,
  created_by_user_id integer REFERENCES users(id),
  updated_by_user_id integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, employee_id),
  CHECK (handled_birds >= 0),
  CHECK (rate_per_bird >= 1.50 AND rate_per_bird <= 3.00)
);

CREATE INDEX IF NOT EXISTS idx_employee_batch_comp_batch
  ON employee_batch_compensations (batch_id);

CREATE INDEX IF NOT EXISTS idx_employee_batch_comp_employee
  ON employee_batch_compensations (employee_id);
