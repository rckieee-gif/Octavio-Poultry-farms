DELETE FROM inventory_movements im
USING batches b, inventory_items ii
WHERE im.batch_id = b.id
  AND im.item_id = ii.id
  AND ii.farm_id = b.farm_id
  AND lower(ii.name) = lower('DOC Chicks')
  AND im.source_type IN ('batch_loading', 'batch_loading_chicks')
  AND im.source_id = b.id::text
  AND b.actual_chicks_arrived = 0;

DELETE FROM inventory_movements legacy
USING batches b, inventory_items ii
WHERE legacy.batch_id = b.id
  AND legacy.item_id = ii.id
  AND ii.farm_id = b.farm_id
  AND lower(ii.name) = lower('DOC Chicks')
  AND legacy.source_type = 'batch_loading_chicks'
  AND legacy.source_id = b.id::text
  AND EXISTS (
    SELECT 1
    FROM inventory_movements canonical
    WHERE canonical.source_type = 'batch_loading'
      AND canonical.source_id = legacy.source_id
      AND canonical.item_id = legacy.item_id
  );

UPDATE inventory_movements im
SET
  movement_date = b.start_date,
  quantity = b.actual_chicks_arrived,
  source_type = 'batch_loading',
  remarks = 'Arrived DOC recorded for batch ' || b.id
FROM batches b, inventory_items ii
WHERE im.batch_id = b.id
  AND im.item_id = ii.id
  AND ii.farm_id = b.farm_id
  AND lower(ii.name) = lower('DOC Chicks')
  AND im.source_type IN ('batch_loading', 'batch_loading_chicks')
  AND im.source_id = b.id::text
  AND b.actual_chicks_arrived > 0;
