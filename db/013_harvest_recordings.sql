CREATE TABLE IF NOT EXISTS harvest_reports (
  id serial PRIMARY KEY,
  farm_id uuid REFERENCES farms(id),
  batch_id varchar(50) NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  source_filename text,
  status varchar(20) NOT NULL DEFAULT 'Draft',
  doc_add_on_rate_per_bird numeric(8,4) NOT NULL DEFAULT 3,
  trucking_fee_per_bird numeric(8,4) NOT NULL DEFAULT 2.7,
  notes text,
  ledger_transaction_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  posted_at timestamptz,
  posted_by_user_id integer REFERENCES users(id),
  created_by_user_id integer REFERENCES users(id),
  updated_by_user_id integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id),
  CHECK (status IN ('Draft', 'Posted'))
);

CREATE TABLE IF NOT EXISTS harvest_report_events (
  id serial PRIMARY KEY,
  report_id integer NOT NULL REFERENCES harvest_reports(id) ON DELETE CASCADE,
  harvest_order integer NOT NULL,
  harvest_date date,
  permit_shipping numeric(14,2) NOT NULL DEFAULT 0,
  tolling_fee numeric(14,2) NOT NULL DEFAULT 0,
  remarks text,
  UNIQUE (report_id, harvest_order),
  CHECK (harvest_order BETWEEN 1 AND 3)
);

CREATE TABLE IF NOT EXISTS harvest_chicken_sales (
  id serial PRIMARY KEY,
  report_id integer NOT NULL REFERENCES harvest_reports(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  item text NOT NULL,
  base_price_per_kg numeric(14,4),
  harvest1_birds integer NOT NULL DEFAULT 0,
  harvest1_kilos numeric(14,3) NOT NULL DEFAULT 0,
  harvest2_birds integer NOT NULL DEFAULT 0,
  harvest2_kilos numeric(14,3) NOT NULL DEFAULT 0,
  harvest3_birds integer NOT NULL DEFAULT 0,
  harvest3_kilos numeric(14,3) NOT NULL DEFAULT 0,
  final_rate numeric(14,4),
  notes text
);

CREATE TABLE IF NOT EXISTS harvest_byproduct_sales (
  id serial PRIMARY KEY,
  report_id integer NOT NULL REFERENCES harvest_reports(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  item text NOT NULL,
  original_rate numeric(14,4),
  harvest1_qty numeric(14,3) NOT NULL DEFAULT 0,
  harvest1_sales numeric(14,2) NOT NULL DEFAULT 0,
  harvest2_qty numeric(14,3) NOT NULL DEFAULT 0,
  harvest2_sales numeric(14,2) NOT NULL DEFAULT 0,
  harvest3_qty numeric(14,3) NOT NULL DEFAULT 0,
  harvest3_sales numeric(14,2) NOT NULL DEFAULT 0,
  final_rate numeric(14,4),
  notes text
);

CREATE TABLE IF NOT EXISTS harvest_financing_items (
  id serial PRIMARY KEY,
  report_id integer NOT NULL REFERENCES harvest_reports(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  item text NOT NULL,
  category text NOT NULL DEFAULT 'Miscellaneous',
  quantity numeric(14,3),
  unit_cost numeric(14,4),
  amount numeric(14,2),
  notes text
);

CREATE INDEX IF NOT EXISTS idx_harvest_reports_farm_batch
  ON harvest_reports (farm_id, batch_id);

CREATE INDEX IF NOT EXISTS idx_harvest_events_report
  ON harvest_report_events (report_id, harvest_order);

CREATE INDEX IF NOT EXISTS idx_harvest_chicken_report
  ON harvest_chicken_sales (report_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_harvest_byproducts_report
  ON harvest_byproduct_sales (report_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_harvest_financing_report
  ON harvest_financing_items (report_id, sort_order);
