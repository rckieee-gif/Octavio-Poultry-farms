UPDATE batches b
SET actual_chicks_arrived = COALESCE(
  NULLIF((
    SELECT SUM(bbl.chicks_loaded)::integer
    FROM batch_building_loadings bbl
    WHERE bbl.batch_id = b.id
  ), 0),
  b.total_chicks_loaded
)
WHERE b.actual_chicks_arrived = 0
  AND b.total_chicks_loaded > 0
  AND UPPER(REPLACE(COALESCE(b.status, ''), ' ', '_')) IN ('CLOSED', 'HARVESTED', 'POSTED');
