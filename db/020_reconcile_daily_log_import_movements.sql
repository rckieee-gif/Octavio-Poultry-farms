WITH starter_feed AS (
  SELECT ii.farm_id, ii.id AS item_id
  FROM inventory_items ii
  WHERE lower(ii.name) = lower('Starter Feed')
)
UPDATE daily_logs dl
SET feed_item_id = sf.item_id
FROM batches b, starter_feed sf
WHERE dl.batch_id = b.id
  AND sf.farm_id = b.farm_id
  AND dl.feed_item_id IS NULL
  AND dl.feed_consumed > 0;

DELETE FROM inventory_movements im
USING daily_logs dl
WHERE im.source_type = 'daily_log_feed'
  AND im.source_id = dl.id::text
  AND (
    dl.feed_consumed <= 0
    OR dl.feed_item_id IS NULL
    OR im.item_id <> dl.feed_item_id
  );

INSERT INTO inventory_movements (
  farm_id,
  batch_id,
  item_id,
  movement_date,
  movement_type,
  quantity,
  building_id,
  source_type,
  source_id,
  remarks,
  created_by_user_id
)
SELECT
  b.farm_id,
  dl.batch_id,
  dl.feed_item_id,
  dl.date,
  'Stock Out',
  dl.feed_consumed,
  dl.building_id,
  'daily_log_feed',
  dl.id::text,
  'Feed consumed by ' || COALESCE(s.display_name, s.name, 'employee'),
  dl.created_by_user_id
FROM daily_logs dl
JOIN batches b ON b.id = dl.batch_id
LEFT JOIN stakeholders s ON s.id = dl.employee_id
WHERE dl.feed_consumed > 0
  AND dl.feed_item_id IS NOT NULL
ON CONFLICT (source_type, source_id, item_id)
WHERE source_type IS NOT NULL AND source_id IS NOT NULL
DO UPDATE SET
  farm_id = EXCLUDED.farm_id,
  batch_id = EXCLUDED.batch_id,
  movement_date = EXCLUDED.movement_date,
  movement_type = EXCLUDED.movement_type,
  quantity = EXCLUDED.quantity,
  building_id = EXCLUDED.building_id,
  remarks = EXCLUDED.remarks;

WITH doc_chicks AS (
  SELECT ii.farm_id, ii.id AS item_id
  FROM inventory_items ii
  WHERE lower(ii.name) = lower('DOC Chicks')
)
DELETE FROM inventory_movements im
USING daily_logs dl
JOIN batches b ON b.id = dl.batch_id
LEFT JOIN doc_chicks dc ON dc.farm_id = b.farm_id
WHERE im.source_type = 'daily_log_mortality'
  AND im.source_id = dl.id::text
  AND (
    dl.mortality <= 0
    OR dc.item_id IS NULL
    OR im.item_id <> dc.item_id
  );

INSERT INTO inventory_movements (
  farm_id,
  batch_id,
  item_id,
  movement_date,
  movement_type,
  quantity,
  building_id,
  source_type,
  source_id,
  remarks,
  created_by_user_id
)
SELECT
  b.farm_id,
  dl.batch_id,
  ii.id,
  dl.date,
  'Stock Out',
  dl.mortality,
  dl.building_id,
  'daily_log_mortality',
  dl.id::text,
  'Mortality recorded for ' || COALESCE(s.display_name, s.name, 'employee'),
  dl.created_by_user_id
FROM daily_logs dl
JOIN batches b ON b.id = dl.batch_id
JOIN inventory_items ii
  ON ii.farm_id = b.farm_id
 AND lower(ii.name) = lower('DOC Chicks')
LEFT JOIN stakeholders s ON s.id = dl.employee_id
WHERE dl.mortality > 0
ON CONFLICT (source_type, source_id, item_id)
WHERE source_type IS NOT NULL AND source_id IS NOT NULL
DO UPDATE SET
  farm_id = EXCLUDED.farm_id,
  batch_id = EXCLUDED.batch_id,
  movement_date = EXCLUDED.movement_date,
  movement_type = EXCLUDED.movement_type,
  quantity = EXCLUDED.quantity,
  building_id = EXCLUDED.building_id,
  remarks = EXCLUDED.remarks;
