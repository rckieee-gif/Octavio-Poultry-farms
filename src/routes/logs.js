const express = require('express');
const { pool, getDefaultFarmId, getBuilding } = require('../db');
const { authenticate, requirePrimaryOwner } = require('../middleware/auth');
const { requireMinimumRole } = require('../middleware/roles');
const { validate, dailyLogSchema } = require('../middleware/validate');
const { getInventoryItem, getInventoryItemByName, insertInventoryMovement } = require('../services/inventory.service');
const { auditLog } = require('../services/transactions.service');
const { toDateOnly } = require('../utils/validation');
const { toNumber } = require('../utils/money');

const router = express.Router();

function mapDailyLog(row) {
  return {
    id: row.id,
    batchId: row.batchId,
    date: toDateOnly(row.date),
    building: row.building || 'All',
    employeeId: row.employeeId || null,
    employeeName: row.employeeName || '',
    handledBirds: Number(row.handledBirds || 0),
    feedItemId: row.feedItemId || row.feed_item_id || null,
    feedItemName: row.feedItemName || row.feed_item_name || '',
    feed: toNumber(row.feed),
    mortality: Number(row.mortality || 0),
    averageWeightGrams: row.averageWeightGrams == null ? null : toNumber(row.averageWeightGrams),
    remarks: row.remarks || '',
  };
}

router.get('/', authenticate, async (req, res, next) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const params = [farmId];
    const where = ['ba.farm_id = $1'];

    if (req.query.batchId) {
      params.push(req.query.batchId);
      where.push(`l.batch_id = $${params.length}`);
    }

    const result = await pool.query(
      `SELECT
         l.id,
         l.batch_id AS "batchId",
         l.date,
         b.name AS building,
         s.id AS "employeeId",
         COALESCE(s.display_name, s.name) AS "employeeName",
         l.handled_birds_snapshot AS "handledBirds",
         l.feed_item_id AS "feedItemId",
         ii.name AS "feedItemName",
         l.feed_consumed AS feed,
         l.mortality,
         l.average_weight_g AS "averageWeightGrams",
         l.remarks
       FROM daily_logs l
       JOIN batches ba ON ba.id = l.batch_id
       LEFT JOIN buildings b ON l.building_id = b.id
       LEFT JOIN stakeholders s ON s.id = l.employee_id
       LEFT JOIN inventory_items ii ON ii.id = l.feed_item_id
       WHERE ${where.join(' AND ')}
       ORDER BY l.date DESC, l.id DESC`,
      params
    );

    res.json(result.rows.map(mapDailyLog));
  } catch (err) {
    next(err);
  }
});

router.post('/', authenticate, requireMinimumRole('DataEntry'), validate(dailyLogSchema), async (req, res, next) => {
  const {
    batchId,
    date,
    building,
    employeeId,
    handledBirds,
    feedItemId,
    feed,
    mortality,
    averageWeightGrams,
    remarks
  } = req.body;

  if (!batchId || !date || !building || !employeeId) {
    return res.status(400).json({ error: 'batchId, date, building, and employee are required' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const batch = await client.query(
      'SELECT id FROM batches WHERE id = $1 AND farm_id = $2',
      [batchId, farmId]
    );

    if (batch.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Batch not found' });
    }

    const buildingRecord = await getBuilding(client, building);

    if (!buildingRecord) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Select a specific building for employee daily logs.' });
    }

    const employee = await client.query(
      `SELECT id, COALESCE(display_name, name) AS "employeeName", metadata
       FROM stakeholders
       WHERE id = $1
         AND farm_id = $2
         AND type = 'Employee'
         AND is_active = true`,
      [employeeId, farmId]
    );

    if (employee.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found' });
    }

    const assignedBuilding = employee.rows[0].metadata?.assignedBuilding || '';
    if (assignedBuilding && assignedBuilding.toLowerCase() !== buildingRecord.name.toLowerCase()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `${employee.rows[0].employeeName} is assigned to Building ${assignedBuilding}.` });
    }

    const compensation = await client.query(
      `SELECT handled_birds
       FROM employee_batch_compensations
       WHERE batch_id = $1
         AND employee_id = $2`,
      [batchId, employeeId]
    );
    const handledBirdsSnapshot = Number(handledBirds || compensation.rows[0]?.handled_birds || 0);
    const feedQuantity = Number(feed || 0);
    const mortalityQuantity = Number(mortality || 0);
    let selectedFeedItem = null;

    if (feedQuantity > 0) {
      if (feedItemId) {
        selectedFeedItem = await getInventoryItem(client, farmId, feedItemId);
      } else {
        selectedFeedItem = await getInventoryItemByName(client, farmId, 'Starter Feed');
      }

      if (!selectedFeedItem || selectedFeedItem.category !== 'Feed') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Select a valid feed inventory item for feed consumption.' });
      }
    }

    const result = await client.query(
      `INSERT INTO daily_logs
         (batch_id, date, building_id, employee_id, handled_birds_snapshot, feed_item_id, feed_consumed, mortality, average_weight_g, remarks, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING
         id,
         batch_id AS "batchId",
         date,
         feed_item_id AS "feedItemId",
         feed_consumed AS feed,
         mortality,
         handled_birds_snapshot AS "handledBirds",
         average_weight_g AS "averageWeightGrams",
         remarks`,
      [
        batchId,
        date,
        buildingRecord.id,
        employeeId,
        handledBirdsSnapshot,
        selectedFeedItem?.id || null,
        feedQuantity,
        mortalityQuantity,
        averageWeightGrams === '' || averageWeightGrams == null ? null : Number(averageWeightGrams),
        remarks || null,
        req.user.id,
      ]
    );
    const dailyLogId = result.rows[0].id;

    if (selectedFeedItem && feedQuantity > 0) {
      await insertInventoryMovement(client, req, {
        farmId,
        batchId,
        itemId: selectedFeedItem.id,
        movementDate: date,
        movementType: 'Stock Out',
        quantity: feedQuantity,
        building: buildingRecord.name,
        sourceType: 'daily_log_feed',
        sourceId: dailyLogId,
        remarks: `Feed consumed by ${employee.rows[0].employeeName}`,
      });
    }

    if (mortalityQuantity > 0) {
      const chicksItem = await getInventoryItemByName(client, farmId, 'DOC Chicks');

      if (chicksItem) {
        await insertInventoryMovement(client, req, {
          farmId,
          batchId,
          itemId: chicksItem.id,
          movementDate: date,
          movementType: 'Stock Out',
          quantity: mortalityQuantity,
          building: buildingRecord.name,
          sourceType: 'daily_log_mortality',
          sourceId: dailyLogId,
          remarks: `Mortality recorded for ${employee.rows[0].employeeName}`,
        });
      }
    }

    const dailyLog = {
      ...result.rows[0],
      date: toDateOnly(result.rows[0].date),
      building: buildingRecord.name,
      employeeId: Number(employeeId),
      employeeName: employee.rows[0].employeeName,
      feedItemName: selectedFeedItem?.name || '',
      feed: toNumber(result.rows[0].feed),
    };

    await auditLog(client, req, 'create', 'daily_log', result.rows[0].id, null, dailyLog, batchId);
    await client.query('COMMIT');

    res.status(201).json(mapDailyLog(dailyLog));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.patch('/:id', authenticate, requirePrimaryOwner, validate(dailyLogSchema), async (req, res, next) => {
  const {
    batchId,
    date,
    building,
    employeeId,
    handledBirds,
    feedItemId,
    feed,
    mortality,
    averageWeightGrams,
    remarks
  } = req.body;

  if (!date || !building || !employeeId) {
    return res.status(400).json({ error: 'date, building, and employee are required' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const before = await client.query(
      `SELECT
         dl.*,
         b.name AS building,
         COALESCE(s.display_name, s.name) AS employee_name
       FROM daily_logs dl
       JOIN batches ba ON ba.id = dl.batch_id
       LEFT JOIN buildings b ON b.id = dl.building_id
       LEFT JOIN stakeholders s ON s.id = dl.employee_id
       WHERE dl.id = $1
         AND ba.farm_id = $2
       FOR UPDATE OF dl`,
      [req.params.id, farmId]
    );

    if (before.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Log not found' });
    }

    const targetBatchId = batchId || before.rows[0].batch_id;
    const batch = await client.query(
      'SELECT id FROM batches WHERE id = $1 AND farm_id = $2',
      [targetBatchId, farmId]
    );

    if (batch.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Batch not found' });
    }

    const buildingRecord = await getBuilding(client, building);

    if (!buildingRecord) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Select a specific building for employee daily logs.' });
    }

    const employee = await client.query(
      `SELECT id, COALESCE(display_name, name) AS "employeeName", metadata
       FROM stakeholders
       WHERE id = $1
         AND farm_id = $2
         AND type = 'Employee'
         AND is_active = true`,
      [employeeId, farmId]
    );

    if (employee.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found' });
    }

    const assignedBuilding = employee.rows[0].metadata?.assignedBuilding || '';
    if (assignedBuilding && assignedBuilding.toLowerCase() !== buildingRecord.name.toLowerCase()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `${employee.rows[0].employeeName} is assigned to Building ${assignedBuilding}.` });
    }

    const compensation = await client.query(
      `SELECT handled_birds
       FROM employee_batch_compensations
       WHERE batch_id = $1
         AND employee_id = $2`,
      [targetBatchId, employeeId]
    );
    const handledBirdsSnapshot = Number(handledBirds || compensation.rows[0]?.handled_birds || before.rows[0].handled_birds_snapshot || 0);
    const feedQuantity = Number(feed || 0);
    const mortalityQuantity = Number(mortality || 0);
    let selectedFeedItem = null;

    if (feedQuantity > 0) {
      selectedFeedItem = feedItemId
        ? await getInventoryItem(client, farmId, feedItemId)
        : await getInventoryItemByName(client, farmId, 'Starter Feed');

      if (!selectedFeedItem || selectedFeedItem.category !== 'Feed') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Select a valid feed inventory item for feed consumption.' });
      }
    }

    const result = await client.query(
      `UPDATE daily_logs
       SET batch_id = $1,
           date = $2,
           building_id = $3,
           employee_id = $4,
           handled_birds_snapshot = $5,
           feed_item_id = $6,
           feed_consumed = $7,
           mortality = $8,
           average_weight_g = $9,
           remarks = $10,
           updated_at = now()
       WHERE id = $11
       RETURNING
         id,
         batch_id AS "batchId",
         date,
         feed_item_id AS "feedItemId",
         feed_consumed AS feed,
         mortality,
         handled_birds_snapshot AS "handledBirds",
         average_weight_g AS "averageWeightGrams",
         remarks`,
      [
        targetBatchId,
        date,
        buildingRecord.id,
        employeeId,
        handledBirdsSnapshot,
        selectedFeedItem?.id || null,
        feedQuantity,
        mortalityQuantity,
        averageWeightGrams === '' || averageWeightGrams == null ? null : Number(averageWeightGrams),
        remarks || null,
        req.params.id,
      ]
    );

    await client.query(
      `DELETE FROM inventory_movements
       WHERE source_type IN ('daily_log_feed', 'daily_log_mortality')
         AND source_id = $1`,
      [String(req.params.id)]
    );

    if (selectedFeedItem && feedQuantity > 0) {
      await insertInventoryMovement(client, req, {
        farmId,
        batchId: targetBatchId,
        itemId: selectedFeedItem.id,
        movementDate: date,
        movementType: 'Stock Out',
        quantity: feedQuantity,
        building: buildingRecord.name,
        sourceType: 'daily_log_feed',
        sourceId: req.params.id,
        remarks: `Feed consumed by ${employee.rows[0].employeeName}`,
      });
    }

    if (mortalityQuantity > 0) {
      const chicksItem = await getInventoryItemByName(client, farmId, 'DOC Chicks');

      if (chicksItem) {
        await insertInventoryMovement(client, req, {
          farmId,
          batchId: targetBatchId,
          itemId: chicksItem.id,
          movementDate: date,
          movementType: 'Stock Out',
          quantity: mortalityQuantity,
          building: buildingRecord.name,
          sourceType: 'daily_log_mortality',
          sourceId: req.params.id,
          remarks: `Mortality recorded for ${employee.rows[0].employeeName}`,
        });
      }
    }

    const dailyLog = {
      ...result.rows[0],
      date: toDateOnly(result.rows[0].date),
      building: buildingRecord.name,
      employeeId: Number(employeeId),
      employeeName: employee.rows[0].employeeName,
      feedItemName: selectedFeedItem?.name || '',
      feed: toNumber(result.rows[0].feed),
    };

    await auditLog(client, req, 'update', 'daily_log', req.params.id, before.rows[0], dailyLog, targetBatchId);
    await client.query('COMMIT');

    res.json(mapDailyLog(dailyLog));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id', authenticate, requirePrimaryOwner, async (req, res, next) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const before = await client.query(
      `SELECT
         dl.*,
         b.name AS building,
         COALESCE(s.display_name, s.name) AS employee_name
       FROM daily_logs dl
       JOIN batches ba ON ba.id = dl.batch_id
       LEFT JOIN buildings b ON b.id = dl.building_id
       LEFT JOIN stakeholders s ON s.id = dl.employee_id
       WHERE dl.id = $1
         AND ba.farm_id = $2
       FOR UPDATE OF dl`,
      [req.params.id, farmId]
    );

    if (before.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Log not found' });
    }

    await client.query(
      `DELETE FROM inventory_movements
       WHERE source_type IN ('daily_log_feed', 'daily_log_mortality')
         AND source_id = $1`,
      [String(req.params.id)]
    );
    await client.query('DELETE FROM daily_logs WHERE id = $1', [req.params.id]);
    await auditLog(client, req, 'delete', 'daily_log', req.params.id, before.rows[0], null, before.rows[0].batch_id);
    await client.query('COMMIT');

    res.json({ message: 'Log deleted' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
