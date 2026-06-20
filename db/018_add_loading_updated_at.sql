ALTER TABLE batch_building_loadings
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
