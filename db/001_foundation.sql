CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS farms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  legal_name text,
  timezone text NOT NULL DEFAULT 'Asia/Manila',
  currency text NOT NULL DEFAULT 'PHP',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE buildings
  ADD COLUMN IF NOT EXISTS farm_id uuid REFERENCES farms(id),
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

ALTER TABLE stakeholders
  ADD COLUMN IF NOT EXISTS farm_id uuid REFERENCES farms(id),
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS legal_name text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

UPDATE stakeholders
SET display_name = name
WHERE display_name IS NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS farm_id uuid REFERENCES farms(id),
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE batches
  ADD COLUMN IF NOT EXISTS farm_id uuid REFERENCES farms(id),
  ADD COLUMN IF NOT EXISTS status_override text,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS mortality_allowance integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_by_user_id integer REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE batches
  DROP CONSTRAINT IF EXISTS batches_mortality_allowance_nonnegative,
  ADD CONSTRAINT batches_mortality_allowance_nonnegative CHECK (mortality_allowance >= 0);

CREATE TABLE IF NOT EXISTS categories (
  id serial PRIMARY KEY,
  farm_id uuid REFERENCES farms(id),
  funding_nature varchar(50) NOT NULL,
  name varchar(100) NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS categories_unique_name
  ON categories (farm_id, funding_nature, lower(name));

CREATE TABLE IF NOT EXISTS batch_building_loadings (
  id serial PRIMARY KEY,
  batch_id varchar(50) NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  building_id integer NOT NULL REFERENCES buildings(id),
  loading_date date NOT NULL,
  chicks_loaded integer NOT NULL DEFAULT 0,
  loading_share_pct numeric(7,4),
  remarks text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, building_id),
  CHECK (chicks_loaded >= 0),
  CHECK (loading_share_pct IS NULL OR (loading_share_pct >= 0 AND loading_share_pct <= 100))
);

ALTER TABLE daily_transactions
  ADD COLUMN IF NOT EXISTS building_scope varchar(20) NOT NULL DEFAULT 'Specific',
  ADD COLUMN IF NOT EXISTS category_id integer REFERENCES categories(id),
  ADD COLUMN IF NOT EXISTS manual_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS reference text,
  ADD COLUMN IF NOT EXISTS is_void boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS void_reason text,
  ADD COLUMN IF NOT EXISTS created_by_user_id integer REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS updated_by_user_id integer REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS transaction_code_sequences (
  transaction_date date NOT NULL,
  building_key text NOT NULL,
  last_sequence integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transaction_date, building_key)
);

CREATE TABLE IF NOT EXISTS transaction_links (
  id serial PRIMARY KEY,
  source_transaction_id varchar(50) NOT NULL REFERENCES daily_transactions(transaction_id) ON DELETE CASCADE,
  target_transaction_id varchar(50) NOT NULL REFERENCES daily_transactions(transaction_id) ON DELETE CASCADE,
  link_type varchar(50) NOT NULL,
  amount_applied numeric(14,2) NOT NULL,
  created_by_user_id integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_applied >= 0)
);

CREATE TABLE IF NOT EXISTS user_building_assignments (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  building_id integer NOT NULL REFERENCES buildings(id),
  batch_id varchar(50) REFERENCES batches(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, building_id, batch_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id serial PRIMARY KEY,
  farm_id uuid REFERENCES farms(id),
  batch_id varchar(50) REFERENCES batches(id) ON DELETE SET NULL,
  actor_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_batches_farm_status ON batches (farm_id, status);
CREATE INDEX IF NOT EXISTS idx_batches_start_date ON batches (start_date DESC);
CREATE INDEX IF NOT EXISTS idx_buildings_farm ON buildings (farm_id);
CREATE INDEX IF NOT EXISTS idx_stakeholders_farm_type ON stakeholders (farm_id, type);
CREATE INDEX IF NOT EXISTS idx_transactions_batch_date ON daily_transactions (batch_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_batch_funding ON daily_transactions (batch_id, funding_nature, type);
CREATE INDEX IF NOT EXISTS idx_transactions_paid_by ON daily_transactions (paid_by);
CREATE INDEX IF NOT EXISTS idx_transactions_paid_to ON daily_transactions (paid_to);
CREATE INDEX IF NOT EXISTS idx_transactions_category_id ON daily_transactions (category_id);
CREATE INDEX IF NOT EXISTS idx_logs_batch_date ON daily_logs (batch_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_batch_date ON audit_logs (batch_id, created_at DESC);

CREATE OR REPLACE VIEW vw_batch_opex_summary AS
SELECT
  dt.batch_id,
  COALESCE(c.name, dt.category) AS category,
  SUM(dt.amount) AS total_amount
FROM daily_transactions dt
LEFT JOIN categories c ON c.id = dt.category_id
WHERE dt.is_void = false
  AND dt.type = 'Expense'
  AND dt.funding_nature = 'OPEX'
GROUP BY dt.batch_id, COALESCE(c.name, dt.category);

CREATE OR REPLACE VIEW vw_batch_capex_summary AS
SELECT
  dt.batch_id,
  COALESCE(c.name, dt.category) AS category,
  SUM(dt.amount) AS total_amount
FROM daily_transactions dt
LEFT JOIN categories c ON c.id = dt.category_id
WHERE dt.is_void = false
  AND dt.type = 'Expense'
  AND dt.funding_nature IN ('CAPEX', 'CAPEX-Recoverable')
GROUP BY dt.batch_id, COALESCE(c.name, dt.category);
