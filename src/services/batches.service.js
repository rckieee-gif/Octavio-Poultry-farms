const { pool, getDefaultFarmId, getBuilding } = require('../db');
const { toDateOnly } = require('../utils/validation');
const { toNumber } = require('../utils/money');
const {
  getInventoryItemByName,
  insertInventoryMovement,
  getInventoryItems,
  mapInventoryMovement,
} = require('./inventory.service');
const { getHarvestProductionSummary } = require('./harvest.service');

function mapBatch(row) {
  return {
    id: row.id,
    batchCode: row.id,
    startDate: toDateOnly(row.startDate || row.start_date),
    targetHarvestDate: toDateOnly(row.targetHarvestDate || row.target_harvest_date),
    actualHarvestEndDate: toDateOnly(row.actualHarvestEndDate || row.actual_harvest_end_date),
    status: row.status,
    totalChicksLoaded: Number(row.totalChicksLoaded ?? row.total_chicks_loaded ?? 0),
    plannedFlock: Number(row.plannedFlock ?? row.planned_flock ?? 0),
    mortalityAllowance: Number(row.mortalityAllowance ?? row.mortality_allowance ?? 0),
    targetFeedKg: toNumber(row.targetFeedKg ?? row.target_feed_kg ?? 0),
    notes: row.notes || '',
  };
}

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

function getLoadingsTotal(loadings = []) {
  return loadings.reduce((sum, item) => sum + Math.round(Number(item.chicksLoaded || item.chicks_loaded || 0)), 0);
}

function getLoadingShareTotal(loadings = []) {
  return loadings.reduce((sum, item) => sum + toNumber(item.loadingSharePct ?? item.loading_share_pct ?? 0), 0);
}

function normalizeLoadingsWithLockedShares(loadings = []) {
  const total = getLoadingShareTotal(loadings);
  if (total === 100) return loadings;
  const standardShares = { A: 40, B: 30, C: 30 };
  return loadings.map(item => ({
    ...item,
    loadingSharePct: standardShares[String(item.building || item.buildingName).toUpperCase()] || 0,
  }));
}

async function upsertLoadings(client, batchId, startDate, loadings = []) {
  for (const loading of loadings) {
    const building = await getBuilding(client, loading.building || loading.buildingName);
    if (!building) continue;
    await client.query(
      `INSERT INTO batch_building_loadings
         (batch_id, building_id, loading_date, chicks_loaded, loading_share_pct, remarks)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (batch_id, building_id)
       DO UPDATE SET
         loading_date = EXCLUDED.loading_date,
         chicks_loaded = EXCLUDED.chicks_loaded,
         loading_share_pct = EXCLUDED.loading_share_pct,
         remarks = EXCLUDED.remarks,
         updated_at = now()`,
      [
        batchId,
        building.id,
        startDate,
        Math.round(Number(loading.chicksLoaded || loading.chicks_loaded || 0)),
        toNumber(loading.loadingSharePct ?? loading.loading_share_pct ?? 0),
        loading.remarks || null,
      ]
    );
  }
}

async function createDefaultLoadings(client, batchId, startDate, totalChicksLoaded) {
  const buildings = await client.query(`
    SELECT id, loading_share_percentage
    FROM buildings
    WHERE name IN ('A', 'B', 'C')
    ORDER BY name
  `);

  for (const building of buildings.rows) {
    const share = Number(building.loading_share_percentage || 0);
    await client.query(
      `INSERT INTO batch_building_loadings
         (batch_id, building_id, loading_date, chicks_loaded, loading_share_pct)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (batch_id, building_id)
       DO UPDATE SET
         loading_date = EXCLUDED.loading_date,
         chicks_loaded = EXCLUDED.chicks_loaded,
         loading_share_pct = EXCLUDED.loading_share_pct,
         updated_at = now()`,
      [
        batchId,
        building.id,
        startDate,
        Math.round(totalChicksLoaded * (share / 100)),
        share,
      ]
    );
  }
}

async function syncBatchChickInventory(client, req, {
  farmId,
  batchId,
  startDate,
  totalChicksLoaded,
}) {
  const chicksItem = await getInventoryItemByName(client, farmId, 'DOC Chicks');
  if (!chicksItem) return;

  await insertInventoryMovement(client, req, {
    farmId,
    batchId,
    itemId: chicksItem.id,
    movementDate: startDate,
    movementType: 'Stock In',
    quantity: totalChicksLoaded,
    building: 'All',
    sourceType: 'batch_loading',
    sourceId: batchId,
    remarks: `Initial chicks loaded for batch ${batchId}`,
  });
}

async function zeroOutFeedInventory(client, req, farmId, batchId, date) {
  const result = await client.query(
    `SELECT
       ii.id AS item_id,
       COALESCE(SUM(
         CASE
           WHEN im.movement_type = 'Stock In' THEN im.quantity
           WHEN im.movement_type = 'Stock Out' THEN -im.quantity
           WHEN im.movement_type = 'Adjustment' THEN im.quantity
           ELSE 0
         END
       ), 0) AS balance
     FROM inventory_items ii
     LEFT JOIN inventory_movements im ON im.item_id = ii.id AND im.farm_id = ii.farm_id
     WHERE ii.farm_id = $1
       AND ii.category = 'Feed'
       AND ii.is_active = true
     GROUP BY ii.id`,
    [farmId]
  );

  for (const item of result.rows) {
    const balance = Number(item.balance || 0);
    if (balance > 0) {
      await insertInventoryMovement(client, req, {
        farmId,
        batchId,
        itemId: item.item_id,
        movementDate: date,
        movementType: 'Stock Out',
        quantity: balance,
        building: 'All',
        sourceType: 'batch_zero_out',
        sourceId: batchId,
        remarks: `Zero-out remaining feed balance on batch completion.`,
      });
    }
  }
}

async function generateBatchId(client, startDate) {
  const yearMonth = startDate.replace(/-/g, '').slice(0, 6);
  const result = await client.query(
    `SELECT count(*)::integer AS count
     FROM batches
     WHERE id LIKE $1`,
    [`${yearMonth}%`]
  );
  const sequence = String(result.rows[0].count + 1).padStart(2, '0');
  return `${yearMonth}-${sequence}`;
}

async function getCurrentBatchSnapshot() {
  const farmId = await getDefaultFarmId();
  const batchResult = await pool.query(
    `SELECT
       id,
       start_date AS "startDate",
       target_harvest_date AS "targetHarvestDate",
       actual_harvest_end_date AS "actualHarvestEndDate",
       status,
       total_chicks_loaded AS "totalChicksLoaded",
       planned_flock AS "plannedFlock",
       mortality_allowance AS "mortalityAllowance",
       target_feed_kg AS "targetFeedKg",
       notes
     FROM batches
     WHERE farm_id = $1
     ORDER BY
       CASE
         WHEN status = 'ONGOING' THEN 0
         WHEN actual_harvest_end_date IS NULL THEN 1
         ELSE 2
       END,
       start_date DESC
     LIMIT 1`,
    [farmId]
  );

  if (batchResult.rowCount === 0) {
    return null;
  }

  const batch = mapBatch(batchResult.rows[0]);
  const [
    buildingResult,
    loadingResult,
    assignmentResult,
    logResult,
    inventoryItems,
    movementResult,
    harvestProductionSummary,
  ] = await Promise.all([
    pool.query(
      `SELECT id, name, loading_share_percentage AS "loadingSharePercentage"
       FROM buildings
       WHERE is_active = true
         AND name <> 'All'
       ORDER BY sort_order, name`
    ),
    pool.query(
      `SELECT
         bbl.id,
         b.name AS building,
         bbl.loading_date AS "loadingDate",
         bbl.chicks_loaded AS "chicksLoaded",
         bbl.loading_share_pct AS "loadingSharePct",
         bbl.remarks
       FROM batch_building_loadings bbl
       JOIN buildings b ON b.id = bbl.building_id
       WHERE bbl.batch_id = $1
       ORDER BY b.sort_order, b.name`,
      [batch.id]
    ),
    pool.query(
      `SELECT
         s.id AS "employeeId",
         COALESCE(s.display_name, s.name) AS "employeeName",
         COALESCE(s.metadata->>'assignedBuilding', '') AS "assignedBuilding",
         COALESCE(ebc.handled_birds, 0) AS "handledBirds",
         COALESCE(bbl.chicks_loaded, 0) AS "buildingChicksLoaded"
       FROM stakeholders s
       LEFT JOIN employee_batch_compensations ebc
         ON ebc.employee_id = s.id
        AND ebc.batch_id = $2
       LEFT JOIN buildings b
         ON b.name = COALESCE(s.metadata->>'assignedBuilding', '')
       LEFT JOIN batch_building_loadings bbl
         ON bbl.batch_id = $2
        AND bbl.building_id = b.id
       WHERE s.farm_id = $1
         AND s.type = 'Employee'
         AND s.is_active = true
         AND lower(COALESCE(s.display_name, s.name)) NOT IN ('others', 'viewer', 'viewers')
         AND NOT EXISTS (
           SELECT 1
           FROM users u
           WHERE u.stakeholder_id = s.id
             AND u.role = 'Viewer'
         )
       ORDER BY COALESCE(s.metadata->>'assignedBuilding', ''), COALESCE(s.display_name, s.name)`,
      [farmId, batch.id]
    ),
    pool.query(
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
       LEFT JOIN buildings b ON l.building_id = b.id
       LEFT JOIN stakeholders s ON s.id = l.employee_id
       LEFT JOIN inventory_items ii ON ii.id = l.feed_item_id
       WHERE l.batch_id = $1
       ORDER BY l.date DESC, l.id DESC`,
      [batch.id]
    ),
    getInventoryItems(farmId),
    pool.query(
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
         NULL::numeric AS "unitCost",
         NULL::numeric AS amount,
         COALESCE(b.name, 'All') AS building,
         im.source_type AS "sourceType",
         im.source_id AS "sourceId",
         im.linked_transaction_id AS "linkedTransactionId",
         im.remarks,
         im.created_at AS "createdAt"
       FROM inventory_movements im
       JOIN inventory_items ii ON ii.id = im.item_id
       LEFT JOIN buildings b ON b.id = im.building_id
       WHERE im.farm_id = $1
         AND (im.batch_id = $2 OR im.batch_id IS NULL)
       ORDER BY im.movement_date DESC, im.id DESC
       LIMIT 200`,
      [farmId, batch.id]
    ),
    getHarvestProductionSummary(pool, farmId, batch.id),
  ]);

  return {
    batch,
    batches: [batch],
    buildings: buildingResult.rows.map((row) => ({
      ...row,
      loadingSharePercentage: Number(row.loadingSharePercentage || 0),
    })),
    loadings: loadingResult.rows.map((row) => ({
      ...row,
      loadingDate: toDateOnly(row.loadingDate),
      chicksLoaded: Number(row.chicksLoaded || 0),
      loadingSharePct: toNumber(row.loadingSharePct),
    })),
    assignments: assignmentResult.rows.map((row) => ({
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      assignedBuilding: row.assignedBuilding || '',
      handledBirds: Number(row.handledBirds || 0),
      buildingChicksLoaded: Number(row.buildingChicksLoaded || 0),
    })),
    logs: logResult.rows.map(mapDailyLog),
    feedItems: inventoryItems.filter((item) => item.category === 'Feed'),
    inventoryItems,
    inventoryMovements: movementResult.rows.map(mapInventoryMovement),
    harvestProductionSummary,
    stakeholders: [],
  };
}

module.exports = {
  mapBatch,
  mapDailyLog,
  getLoadingsTotal,
  normalizeLoadingsWithLockedShares,
  upsertLoadings,
  createDefaultLoadings,
  syncBatchChickInventory,
  zeroOutFeedInventory,
  generateBatchId,
  getCurrentBatchSnapshot,
};
