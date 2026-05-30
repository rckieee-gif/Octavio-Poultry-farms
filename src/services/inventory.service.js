const { toDateOnly } = require('../utils/validation');
const { toNumber } = require('../utils/money');

function mapInventoryItem(row) {
  const currentStock = Number(row.currentStock ?? row.current_stock ?? 0);
  const targetQuantity = Number(row.targetQuantity ?? row.target_quantity ?? 0);
  const reorderLevel = Number(row.reorderLevel ?? row.reorder_level ?? 0);
  const lowStockWarning = reorderLevel > 0 && currentStock < reorderLevel;
  const neededStockWarning = targetQuantity > 0 && currentStock < targetQuantity;
  const warningType = lowStockWarning ? 'low-stock' : neededStockWarning ? 'needed-stock' : 'ok';

  return {
    id: row.id,
    name: row.name,
    category: row.category,
    unit: row.unit,
    targetQuantity,
    reorderLevel,
    currentStock,
    needsWarning: warningType !== 'ok',
    warningType,
    isActive: row.isActive ?? row.is_active ?? true,
  };
}

function mapInventoryMovement(row) {
  return {
    id: row.id,
    batchId: row.batchId || row.batch_id || null,
    itemId: row.itemId || row.item_id,
    itemName: row.itemName || row.item_name || '',
    category: row.category || '',
    unit: row.unit || '',
    movementDate: toDateOnly(row.movementDate || row.movement_date),
    movementType: row.movementType || row.movement_type,
    quantity: toNumber(row.quantity),
    unitCost: row.unitCost == null && row.unit_cost == null ? null : toNumber(row.unitCost ?? row.unit_cost),
    amount: row.amount == null ? null : Number(row.amount || 0),
    building: row.building || 'All',
    sourceType: row.sourceType || row.source_type || '',
    sourceId: row.sourceId || row.source_id || '',
    linkedTransactionId: row.linkedTransactionId || row.linked_transaction_id || '',
    remarks: row.remarks || '',
    createdAt: row.createdAt || row.created_at,
  };
}

const { getBuilding } = require('../db');

async function getInventoryItem(client, farmId, itemId) {
  const result = await client.query(
    `SELECT id, name, category, unit, target_quantity, reorder_level
     FROM inventory_items
     WHERE id = $1
       AND farm_id = $2
       AND is_active = true`,
    [itemId, farmId]
  );

  return result.rows[0] || null;
}

async function getInventoryItemByName(client, farmId, name) {
  const result = await client.query(
    `SELECT id, name, category, unit, target_quantity, reorder_level
     FROM inventory_items
     WHERE farm_id = $1
       AND lower(name) = lower($2)
       AND is_active = true
     LIMIT 1`,
    [farmId, name]
  );

  return result.rows[0] || null;
}

async function insertInventoryMovement(client, req, {
  farmId,
  batchId = null,
  itemId,
  movementDate,
  movementType,
  quantity,
  unitCost = null,
  amount = null,
  building = 'All',
  sourceType = null,
  sourceId = null,
  linkedTransactionId = null,
  remarks = null,
}) {
  const buildingRecord = await getBuilding(client, building);
  const result = await client.query(
    `INSERT INTO inventory_movements
       (farm_id, batch_id, item_id, movement_date, movement_type, quantity, unit_cost, amount,
        building_id, source_type, source_id, linked_transaction_id, remarks, created_by_user_id)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14)
     ON CONFLICT (source_type, source_id, item_id)
     WHERE source_type IS NOT NULL AND source_id IS NOT NULL
     DO UPDATE SET
       movement_date = EXCLUDED.movement_date,
       movement_type = EXCLUDED.movement_type,
       quantity = EXCLUDED.quantity,
       unit_cost = EXCLUDED.unit_cost,
       amount = EXCLUDED.amount,
       building_id = EXCLUDED.building_id,
       linked_transaction_id = EXCLUDED.linked_transaction_id,
       remarks = EXCLUDED.remarks
     RETURNING id`,
    [
      farmId,
      batchId,
      itemId,
      movementDate,
      movementType,
      quantity,
      unitCost,
      amount,
      buildingRecord?.id || null,
      sourceType,
      sourceId == null ? null : String(sourceId),
      linkedTransactionId,
      remarks,
      req.user?.id || null,
    ]
  );

  return result.rows[0].id;
}

const { pool } = require('../db');

async function getInventoryItems(farmId, category = null) {
  const params = [farmId];
  const where = ['ii.farm_id = $1', 'ii.is_active = true'];

  if (category) {
    params.push(category);
    where.push(`ii.category = $${params.length}`);
  }

  const result = await pool.query(
    `SELECT
       ii.id,
       ii.name,
       ii.category,
       ii.unit,
       ii.target_quantity AS "targetQuantity",
       ii.reorder_level AS "reorderLevel",
       ii.is_active AS "isActive",
       COALESCE(SUM(
         CASE
           WHEN im.movement_type = 'Stock In' THEN im.quantity
           WHEN im.movement_type = 'Stock Out' THEN -im.quantity
           WHEN im.movement_type = 'Adjustment' THEN im.quantity
           ELSE 0
         END
       ), 0) AS "currentStock"
     FROM inventory_items ii
     LEFT JOIN inventory_movements im ON im.item_id = ii.id
     WHERE ${where.join(' AND ')}
     GROUP BY ii.id
     ORDER BY
       CASE ii.category
         WHEN 'Feed' THEN 1
         WHEN 'Chicks' THEN 2
         WHEN 'Medicine' THEN 3
         WHEN 'Supplies' THEN 4
         WHEN 'Equipment' THEN 5
         ELSE 9
       END,
       ii.name`,
    params
  );

  return result.rows.map(mapInventoryItem);
}

module.exports = {
  mapInventoryItem,
  mapInventoryMovement,
  getInventoryItem,
  getInventoryItemByName,
  insertInventoryMovement,
  getInventoryItems,
};
