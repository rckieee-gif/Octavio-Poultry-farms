ALTER TABLE batches
  ADD COLUMN IF NOT EXISTS mortality_allowance integer NOT NULL DEFAULT 0;

ALTER TABLE batches
  DROP CONSTRAINT IF EXISTS batches_mortality_allowance_nonnegative,
  ADD CONSTRAINT batches_mortality_allowance_nonnegative CHECK (mortality_allowance >= 0);
