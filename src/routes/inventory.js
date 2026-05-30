const express = require('express');
const { pool, getDefaultFarmId } = require('../db');
const { authenticate, requirePrimaryOwner } = require('../middleware/auth');
const { requireMinimumRole } = require('../middleware/roles');
const {
  mapInventoryItem,
  mapInventoryMovement,
  getInventoryItem,
  getInventoryItems,
  insertInventoryMovement,
} = require('../services/inventory.service');
const { insertLinkedLedgerTransaction, auditLog } = require('../services/transactions.service');

const router = express.Router();

router.get('/items', authenticate, async (req, res) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    res.json(await getInventoryItems(farmId, req.query.category || null));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/items', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  const { name, category, unit, targetQuantity, reorderLevel } = req.body;

  if (!name?.trim() || !category?.trim() || !unit?.trim()) {
    return res.status(400).json({ error: 'name, category, and unit are required' });
  }

  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const result = await pool.query(
      `INSERT INTO inventory_items
         (farm_id, name, category, unit, target_quantity, reorder_level)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING
         id,
         name,
         category,
         unit,
         target_quantity AS "targetQuantity",
         reorder_level AS "reorderLevel",
         is_active AS "isActive",
         0 AS "currentStock"`,
      [
        farmId,
        name.trim(),
        category.trim(),
        unit.trim(),
        Number(targetQuantity || 0),
        Number(reorderLevel || 0),
      ]
    );

    res.status(201).json(mapInventoryItem(result.rows[0]));
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Inventory item already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.patch('/items/:id', authenticate, requirePrimaryOwner, async (req, res) => {
  const { name, category, unit, targetQuantity, reorderLevel, isActive = true } = req.body;

  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const result = await pool.query(
      `UPDATE inventory_items
       SET
         name = $1,
         category = $2,
         unit = $3,
         target_quantity = $4,
         reorder_level = $5,
         is_active = $6,
         updated_at = now()
       WHERE id = $7
         AND farm_id = $8
       RETURNING
         id,
         name,
         category,
         unit,
         target_quantity AS "targetQuantity",
         reorder_level AS "reorderLevel",
         is_active AS "isActive",
         0 AS "currentStock"`,
      [
        name?.trim(),
        category?.trim(),
        unit?.trim(),
        Number(targetQuantity || 0),
        Number(reorderLevel || 0),
        Boolean(isActive),
        req.params.id,
        farmId,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Inventory item not found' });
    }

    res.json((await getInventoryItems(farmId)).find((item) => item.id === Number(req.params.id)) || mapInventoryItem(result.rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/movements', authenticate, async (req, res) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const params = [farmId];
    const where = ['im.farm_id = $1'];

    if (req.query.batchId) {
      params.push(req.query.batchId);
      where.push(`im.batch_id = $${params.length}`);
    }

    if (req.query.itemId) {
      params.push(req.query.itemId);
      where.push(`im.item_id = $${params.length}`);
    }

    const result = await pool.query(
      `SELECT
         im.id,
         im.batch_id AS "batchId",
         im.item_id AS "itemId",
         ii.name AS "itemName",
         ii.category,
         ii.unit,
         im.movement_date AS "movementDate",
         im.movement_type AS "movementType",
         im.quantity,
         im.unit_cost AS "unitCost",
         im.amount,
         COALESCE(b.name, 'All') AS building,
         im.source_type AS "sourceType",
         im.source_id AS "sourceId",
         im.linked_transaction_id AS "linkedTransactionId",
         im.remarks,
         im.created_at AS "createdAt"
       FROM inventory_movements im
       JOIN inventory_items ii ON ii.id = im.item_id
       LEFT JOIN buildings b ON b.id = im.building_id
       WHERE ${where.join(' AND ')}
       ORDER BY im.movement_date DESC, im.id DESC
       LIMIT 200`,
      params
    );

    res.json(result.rows.map(mapInventoryMovement));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/movements', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  const {
    batchId,
    itemId,
    movementDate,
    movementType,
    quantity,
    unitCost,
    amount,
    building = 'All',
    remarks,
    createLedger,
    fundingNature,
    ledgerCategory,
    paidBy,
    paidTo,
    reference,
  } = req.body;

  if (!itemId || !movementDate || !movementType || quantity === undefined || quantity === '') {
    return res.status(400).json({ error: 'item, movement date, movement type, and quantity are required' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const item = await getInventoryItem(client, farmId, itemId);

    if (!item) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Inventory item not found' });
    }

    let linkedTransactionId = null;
    const computedAmount = Number(amount || 0) || (unitCost ? Number(quantity || 0) * Number(unitCost || 0) : 0);

    if (createLedger && batchId && movementType === 'Stock In' && fundingNature) {
      linkedTransactionId = await insertLinkedLedgerTransaction(client, req, {
        farmId,
        batchId,
        date: movementDate,
        building,
        fundingNature,
        category: ledgerCategory || item.category,
        description: `${item.name} stock purchase`,
        quantity,
        unitCost,
        amount: computedAmount,
        paidBy,
        paidTo,
        reference,
        remarks,
      });
    }

    const movementId = await insertInventoryMovement(client, req, {
      farmId,
      batchId: batchId || null,
      itemId,
      movementDate,
      movementType,
      quantity: Number(quantity),
      unitCost: unitCost === '' || unitCost == null ? null : Number(unitCost),
      amount: computedAmount || null,
      building,
      linkedTransactionId,
      remarks,
    });

    await auditLog(client, req, 'create', 'inventory_movement', movementId, null, req.body, batchId || null);
    await client.query('COMMIT');

    const saved = await pool.query(
      `SELECT
         im.id,
         im.batch_id AS "batchId",
         im.item_id AS "itemId",
         ii.name AS "itemName",
         ii.category,
         ii.unit,
         im.movement_date AS "movementDate",
         im.movement_type AS "movementType",
         im.quantity,
         im.unit_cost AS "unitCost",
         im.amount,
         COALESCE(b.name, 'All') AS building,
         im.source_type AS "sourceType",
         im.source_id AS "sourceId",
         im.linked_transaction_id AS "linkedTransactionId",
         im.remarks,
         im.created_at AS "createdAt"
       FROM inventory_movements im
       JOIN inventory_items ii ON ii.id = im.item_id
       LEFT JOIN buildings b ON b.id = im.building_id
       WHERE im.id = $1`,
      [movementId]
    );

    res.status(201).json(mapInventoryMovement(saved.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
