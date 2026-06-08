ALTER TABLE batches
  ADD COLUMN IF NOT EXISTS actual_chicks_arrived integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS doa_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_chicks_placed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS arrival_sample_weight_g numeric(8,2);

ALTER TABLE batches
  DROP CONSTRAINT IF EXISTS batches_actual_chicks_arrived_nonnegative,
  DROP CONSTRAINT IF EXISTS batches_doa_count_nonnegative,
  DROP CONSTRAINT IF EXISTS batches_net_chicks_placed_nonnegative,
  DROP CONSTRAINT IF EXISTS batches_arrival_sample_weight_positive,
  ADD CONSTRAINT batches_actual_chicks_arrived_nonnegative CHECK (actual_chicks_arrived >= 0),
  ADD CONSTRAINT batches_doa_count_nonnegative CHECK (doa_count >= 0),
  ADD CONSTRAINT batches_net_chicks_placed_nonnegative CHECK (net_chicks_placed >= 0),
  ADD CONSTRAINT batches_arrival_sample_weight_positive CHECK (arrival_sample_weight_g IS NULL OR arrival_sample_weight_g > 0);

ALTER TABLE batch_building_loadings
  ADD COLUMN IF NOT EXISTS doa_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_chicks_placed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sample_weight_g numeric(8,2);

ALTER TABLE batch_building_loadings
  DROP CONSTRAINT IF EXISTS batch_building_loadings_doa_count_nonnegative,
  DROP CONSTRAINT IF EXISTS batch_building_loadings_net_chicks_placed_nonnegative,
  DROP CONSTRAINT IF EXISTS batch_building_loadings_sample_weight_positive,
  DROP CONSTRAINT IF EXISTS batch_building_loadings_doa_not_above_loaded,
  ADD CONSTRAINT batch_building_loadings_doa_count_nonnegative CHECK (doa_count >= 0),
  ADD CONSTRAINT batch_building_loadings_net_chicks_placed_nonnegative CHECK (net_chicks_placed >= 0),
  ADD CONSTRAINT batch_building_loadings_sample_weight_positive CHECK (sample_weight_g IS NULL OR sample_weight_g > 0),
  ADD CONSTRAINT batch_building_loadings_doa_not_above_loaded CHECK (doa_count <= chicks_loaded);

UPDATE batch_building_loadings
SET net_chicks_placed = GREATEST(chicks_loaded - doa_count, 0)
WHERE net_chicks_placed = 0 AND chicks_loaded > 0;

UPDATE batches b
SET
  doa_count = COALESCE(NULLIF(b.doa_count, 0), loading_totals.doa_count, 0),
  net_chicks_placed = COALESCE(
    NULLIF(b.net_chicks_placed, 0),
    GREATEST(b.total_chicks_loaded - COALESCE(loading_totals.doa_count, 0), 0)
  ),
  arrival_sample_weight_g = COALESCE(b.arrival_sample_weight_g, loading_totals.arrival_sample_weight_g)
FROM (
  SELECT
    batch_id,
    SUM(doa_count)::integer AS doa_count,
    CASE
      WHEN SUM(chicks_loaded) FILTER (WHERE sample_weight_g IS NOT NULL AND sample_weight_g > 0) > 0 THEN
        ROUND(
          SUM(chicks_loaded * sample_weight_g) FILTER (WHERE sample_weight_g IS NOT NULL AND sample_weight_g > 0)
          / SUM(chicks_loaded) FILTER (WHERE sample_weight_g IS NOT NULL AND sample_weight_g > 0),
          2
        )
      ELSE NULL
    END AS arrival_sample_weight_g
  FROM batch_building_loadings
  GROUP BY batch_id
) loading_totals
WHERE loading_totals.batch_id = b.id;
