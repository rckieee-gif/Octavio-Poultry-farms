const express = require('express');
const { pool, getDefaultFarmId, getBuilding } = require('../db');
const { authenticate, requirePrimaryOwner } = require('../middleware/auth');
const { requireMinimumRole } = require('../middleware/roles');
const { validate, batchSchema, batchLoadingsSchema, harvestReportSchema } = require('../middleware/validate');
const {
  insertHarvestLedgerTransaction,
  auditLog,
  normalizeFundingNatureForDb,
} = require('../services/transactions.service');
const {
  getInventoryItemByName,
  insertInventoryMovement,
  getInventoryItems,
  mapInventoryMovement,
} = require('../services/inventory.service');
const { toDateOnly } = require('../utils/validation');
const { toNumber, toFiniteNumber, toNullableFiniteNumber, roundMoney } = require('../utils/money');

const router = express.Router();

// --- Map Helpers ---
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
    targetFeedKg: toNumber(row.targetFeedKg ?? row.target_feed_kg ?? 0),
    notes: row.notes || '',
  };
}

function mapHarvestEvent(row) {
  return {
    id: row.id || null,
    harvestOrder: Number(row.harvestOrder || row.harvest_order || 0),
    harvestDate: toDateOnly(row.harvestDate || row.harvest_date) || '',
    permitShipping: toFiniteNumber(row.permitShipping ?? row.permit_shipping),
    tollingFee: toFiniteNumber(row.tollingFee ?? row.tolling_fee),
    remarks: row.remarks || '',
  };
}

function mapHarvestChickenSale(row) {
  return {
    id: row.id || null,
    item: row.item || '',
    basePricePerKg: row.basePricePerKg ?? row.base_price_per_kg ?? '',
    harvest1Birds: Number(row.harvest1Birds ?? row.harvest1_birds ?? 0),
    harvest1Kilos: toFiniteNumber(row.harvest1Kilos ?? row.harvest1_kilos),
    harvest2Birds: Number(row.harvest2Birds ?? row.harvest2_birds ?? 0),
    harvest2Kilos: toFiniteNumber(row.harvest2Kilos ?? row.harvest2_kilos),
    harvest3Birds: Number(row.harvest3Birds ?? row.harvest3_birds ?? 0),
    harvest3Kilos: toFiniteNumber(row.harvest3Kilos ?? row.harvest3_kilos),
    finalRate: row.finalRate ?? row.final_rate ?? '',
    notes: row.notes || '',
    sortOrder: Number(row.sortOrder ?? row.sort_order ?? 0),
  };
}

function mapHarvestByproduct(row) {
  return {
    id: row.id || null,
    item: row.item || '',
    originalRate: row.originalRate ?? row.original_rate ?? '',
    harvest1Qty: toFiniteNumber(row.harvest1Qty ?? row.harvest1_qty),
    harvest1Sales: toFiniteNumber(row.harvest1Sales ?? row.harvest1_sales),
    harvest2Qty: toFiniteNumber(row.harvest2Qty ?? row.harvest2_qty),
    harvest2Sales: toFiniteNumber(row.harvest2Sales ?? row.harvest2_sales),
    harvest3Qty: toFiniteNumber(row.harvest3Qty ?? row.harvest3_qty),
    harvest3Sales: toFiniteNumber(row.harvest3Sales ?? row.harvest3_sales),
    finalRate: row.finalRate ?? row.final_rate ?? '',
    notes: row.notes || '',
    sortOrder: Number(row.sortOrder ?? row.sort_order ?? 0),
  };
}

function mapHarvestFinancingItem(row) {
  return {
    id: row.id || null,
    item: row.item || '',
    category: row.category || 'Miscellaneous',
    quantity: row.quantity ?? '',
    unitCost: row.unitCost ?? row.unit_cost ?? '',
    amount: row.amount ?? '',
    notes: row.notes || '',
    sortOrder: Number(row.sortOrder ?? row.sort_order ?? 0),
  };
}

// --- Loadings & Zero Out Helpers ---
function getLoadingsTotal(loadings = []) {
  return loadings.reduce((sum, item) => sum + toNumber(item.loadingSharePct ?? item.loading_share_pct ?? 0), 0);
}

function normalizeLoadingsWithLockedShares(loadings = []) {
  const total = getLoadingsTotal(loadings);
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

// --- Harvest Core Summary Calculators ---
function getFinancingAmount(row) {
  const explicitAmount = toNullableFiniteNumber(row.amount);
  if (explicitAmount !== null) return explicitAmount;

  const quantity = toNullableFiniteNumber(row.quantity);
  const unitCost = toNullableFiniteNumber(row.unitCost);
  if (quantity !== null && unitCost !== null) return quantity * unitCost;

  return 0;
}

function getDefaultHarvestEvents(batch) {
  const firstHarvestDate = toDateOnly(batch?.targetHarvestDate || batch?.target_harvest_date || batch?.actualHarvestEndDate || batch?.actual_harvest_end_date);

  return [0, 1, 2].map((_, index) => ({
    harvestOrder: index + 1,
    harvestDate: index === 0 ? firstHarvestDate || '' : '',
    permitShipping: 0,
    tollingFee: 0,
    remarks: '',
  }));
}

function calculateHarvestSummary(report) {
  const events = (report.harvestEvents || []).map(mapHarvestEvent).sort((a, b) => a.harvestOrder - b.harvestOrder);
  const chickenRows = (report.chickenSales || []).map(mapHarvestChickenSale);
  const byproductRows = (report.byproductSales || []).map(mapHarvestByproduct);
  const docRate = toFiniteNumber(report.docAddOnRatePerBird ?? report.doc_add_on_rate_per_bird, 3);
  const truckingRate = toFiniteNumber(report.truckingFeePerBird ?? report.trucking_fee_per_bird, 2.7);

  const perHarvest = [1, 2, 3].map((harvestOrder) => {
    const event = events.find((item) => Number(item.harvestOrder) === harvestOrder) || { harvestOrder };
    const birdsKey = `harvest${harvestOrder}Birds`;
    const kilosKey = `harvest${harvestOrder}Kilos`;
    const qtyKey = `harvest${harvestOrder}Qty`;
    const salesKey = `harvest${harvestOrder}Sales`;
    const birds = chickenRows.reduce((sum, row) => sum + Math.round(toFiniteNumber(row[birdsKey])), 0);
    const kilos = chickenRows.reduce((sum, row) => sum + toFiniteNumber(row[kilosKey]), 0);
    const chickenSales = chickenRows.reduce((sum, row) => {
      const rate = toFiniteNumber(row.finalRate, toFiniteNumber(row.basePricePerKg));
      return sum + (toFiniteNumber(row[kilosKey]) * rate);
    }, 0);
    const byproductSales = byproductRows.reduce((sum, row) => sum + toFiniteNumber(row[salesKey]), 0);
    const byproductQty = byproductRows.reduce((sum, row) => sum + toFiniteNumber(row[qtyKey]), 0);
    const grossSales = chickenSales + byproductSales;
    const docAddOn = birds * docRate;
    const truckingFee = birds * truckingRate;
    const permitShipping = toFiniteNumber(event.permitShipping);
    const tollingFee = toFiniteNumber(event.tollingFee);
    const totalExpenses = permitShipping + tollingFee + docAddOn + truckingFee;
    const netSales = grossSales - totalExpenses;

    return {
      harvestOrder,
      harvestDate: event.harvestDate || '',
      birds,
      kilos: Number(kilos.toFixed(3)),
      chickenSales: roundMoney(chickenSales),
      byproductQty: Number(byproductQty.toFixed(3)),
      byproductSales: roundMoney(byproductSales),
      grossSales: roundMoney(grossSales),
      permitShipping: roundMoney(permitShipping),
      tollingFee: roundMoney(tollingFee),
      docAddOn: roundMoney(docAddOn),
      truckingFee: roundMoney(truckingFee),
      totalExpenses: roundMoney(totalExpenses),
      netSales: roundMoney(netSales),
    };
  });

  const totals = perHarvest.reduce((sum, row) => ({
    birds: sum.birds + row.birds,
    kilos: sum.kilos + row.kilos,
    chickenSales: sum.chickenSales + row.chickenSales,
    byproductQty: sum.byproductQty + row.byproductQty,
    byproductSales: sum.byproductSales + row.byproductSales,
    grossSales: sum.grossSales + row.grossSales,
    permitShipping: sum.permitShipping + row.permitShipping,
    tollingFee: sum.tollingFee + row.tollingFee,
    docAddOn: sum.docAddOn + row.docAddOn,
    truckingFee: sum.truckingFee + row.truckingFee,
    totalExpenses: sum.totalExpenses + row.totalExpenses,
    netSales: sum.netSales + row.netSales,
  }), {
    birds: 0,
    kilos: 0,
    chickenSales: 0,
    byproductQty: 0,
    byproductSales: 0,
    grossSales: 0,
    permitShipping: 0,
    tollingFee: 0,
    docAddOn: 0,
    truckingFee: 0,
    totalExpenses: 0,
    netSales: 0,
  });

  totals.kilos = Number(totals.kilos.toFixed(3));
  totals.byproductQty = Number(totals.byproductQty.toFixed(3));

  return { perHarvest, totals };
}

async function getHarvestReport(client, farmId, batchId) {
  const batch = await client.query(
    'SELECT id, status, target_harvest_date, actual_harvest_end_date FROM batches WHERE id = $1 AND farm_id = $2 LIMIT 1',
    [batchId, farmId]
  );

  if (batch.rowCount === 0) return null;

  const reportResult = await client.query(
    'SELECT * FROM harvest_reports WHERE batch_id = $1 AND farm_id = $2 LIMIT 1',
    [batchId, farmId]
  );

  if (reportResult.rowCount === 0) {
    const defaultEvents = getDefaultHarvestEvents(mapBatch(batch.rows[0]));
    return {
      docAddOnRatePerBird: 3,
      truckingFeePerBird: 2.7,
      notes: '',
      status: 'Draft',
      harvestEvents: defaultEvents,
      chickenSales: [],
      byproductSales: [],
      financingItems: [],
      summary: calculateHarvestSummary({
        docAddOnRatePerBird: 3,
        truckingFeePerBird: 2.7,
        harvestEvents: defaultEvents,
      }),
    };
  }

  const report = reportResult.rows[0];
  const [events, chickenSales, byproductSales, financingItems] = await Promise.all([
    client.query('SELECT * FROM harvest_report_events WHERE report_id = $1 ORDER BY harvest_order', [report.id]),
    client.query('SELECT * FROM harvest_chicken_sales WHERE report_id = $1 ORDER BY sort_order', [report.id]),
    client.query('SELECT * FROM harvest_byproduct_sales WHERE report_id = $1 ORDER BY sort_order', [report.id]),
    client.query('SELECT * FROM harvest_financing_items WHERE report_id = $1 ORDER BY sort_order', [report.id]),
  ]);

  const output = {
    id: report.id,
    sourceFilename: report.source_filename || '',
    docAddOnRatePerBird: toNumber(report.doc_add_on_rate_per_bird),
    truckingFeePerBird: toNumber(report.trucking_fee_per_bird),
    notes: report.notes || '',
    status: report.status || 'Draft',
    harvestEvents: events.rows.map(mapHarvestEvent),
    chickenSales: chickenSales.rows.map(mapHarvestChickenSale),
    byproductSales: byproductSales.rows.map(mapHarvestByproduct),
    financingItems: financingItems.rows.map(mapHarvestFinancingItem),
  };

  output.summary = calculateHarvestSummary(output);
  return output;
}

async function getHarvestProductionSummary(client, farmId, batchId) {
  const report = await getHarvestReport(client, farmId, batchId);
  return report ? report.summary : null;
}

function getLatestHarvestDate(harvestRows) {
  const dates = harvestRows.map((r) => r.harvestDate).filter(Boolean);
  if (dates.length === 0) return '';
  return dates.reduce((max, d) => (d > max ? d : max), dates[0]);
}

function getOrdinalLabel(value) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = Number(value) || 0;
  const lastDigit = v % 10;
  const lastTwoDigits = v % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 13) return `${v}th`;
  return `${v}${suffixes[lastDigit] || 'th'}`;
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

// --- Routes ---
router.get('/', authenticate, async (req, res, next) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const result = await pool.query(`
      SELECT
        id,
        start_date AS "startDate",
        target_harvest_date AS "targetHarvestDate",
        actual_harvest_end_date AS "actualHarvestEndDate",
        status,
        total_chicks_loaded AS "totalChicksLoaded",
        planned_flock AS "plannedFlock",
        target_feed_kg AS "targetFeedKg",
        notes
      FROM batches
      WHERE farm_id = $1
      ORDER BY start_date DESC
    `, [farmId]);

    res.json(result.rows.map(mapBatch));
  } catch (err) {
    console.error('Failed to fetch batches:', err);
    next(err);
  }
});

router.get('/active', authenticate, async (req, res, next) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const result = await pool.query(`
      SELECT
        id,
        start_date AS "startDate",
        target_harvest_date AS "targetHarvestDate",
        actual_harvest_end_date AS "actualHarvestEndDate",
        status,
        total_chicks_loaded AS "totalChicksLoaded",
        planned_flock AS "plannedFlock",
        target_feed_kg AS "targetFeedKg",
        notes
      FROM batches
      WHERE status = 'ONGOING'
        AND farm_id = $1
      ORDER BY start_date DESC
      LIMIT 1
    `, [farmId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'No active batch found' });
    }

    res.json(mapBatch(result.rows[0]));
  } catch (err) {
    console.error('Failed to fetch active batch:', err);
    next(err);
  }
});

router.post('/', authenticate, requireMinimumRole('OperationManager'), validate(batchSchema), async (req, res, next) => {
  const {
    startDate,
    targetHarvestDate,
    totalChicksLoaded,
    plannedFlock,
    targetFeedKg,
    notes,
    loadings,
  } = req.body;

  if (!startDate) {
    return res.status(400).json({ error: 'Start date is required' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const batchId = await generateBatchId(client, startDate);
    const lockedLoadings = normalizeLoadingsWithLockedShares(loadings || []);
    const lockedTotalChicksLoaded = lockedLoadings.length
      ? getLoadingsTotal(lockedLoadings)
      : Number(totalChicksLoaded || 0);

    const result = await client.query(
      `INSERT INTO batches
         (id, farm_id, start_date, target_harvest_date, status, total_chicks_loaded,
          planned_flock, target_feed_kg, notes, created_by_user_id)
       VALUES
         ($1, $2, $3, $4, 'ONGOING', $5, $6, $7, $8, $9)
       RETURNING
         id,
         start_date AS "startDate",
         target_harvest_date AS "targetHarvestDate",
         actual_harvest_end_date AS "actualHarvestEndDate",
         status,
         total_chicks_loaded AS "totalChicksLoaded",
         planned_flock AS "plannedFlock",
         target_feed_kg AS "targetFeedKg",
         notes`,
      [
        batchId,
        farmId,
        startDate,
        targetHarvestDate || null,
        lockedTotalChicksLoaded,
        Number(plannedFlock || 0),
        Number(targetFeedKg || 0),
        notes || '',
        req.user.id,
      ]
    );

    if (lockedLoadings.length) {
      await upsertLoadings(client, batchId, startDate, lockedLoadings);
    } else {
      await createDefaultLoadings(client, batchId, startDate, lockedTotalChicksLoaded);
    }
    await syncBatchChickInventory(client, req, {
      farmId,
      batchId,
      startDate,
      totalChicksLoaded: lockedTotalChicksLoaded,
    });

    await auditLog(client, req, 'create', 'batch', batchId, null, result.rows[0], batchId);
    await client.query('COMMIT');

    res.status(201).json(mapBatch(result.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to create batch:', err);
    next(err);
  } finally {
    client.release();
  }
});

router.patch('/:id', authenticate, requirePrimaryOwner, validate(batchSchema), async (req, res, next) => {
  const { id } = req.params;
  const {
    startDate,
    targetHarvestDate,
    totalChicksLoaded,
    plannedFlock,
    targetFeedKg,
    notes,
    status,
    loadings,
  } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const before = await client.query('SELECT * FROM batches WHERE id = $1', [id]);
    if (before.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Batch not found' });
    }

    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const lockedLoadings = normalizeLoadingsWithLockedShares(loadings || []);
    const lockedTotalChicksLoaded = lockedLoadings.length
      ? getLoadingsTotal(lockedLoadings)
      : Number(totalChicksLoaded || 0);

    const result = await client.query(
      `UPDATE batches
       SET
         start_date = $1,
         target_harvest_date = $2,
         total_chicks_loaded = $3,
         planned_flock = $4,
         target_feed_kg = $5,
         notes = $6,
         status = $7,
         updated_at = now()
       WHERE id = $8
       RETURNING
         id,
         start_date AS "startDate",
         target_harvest_date AS "targetHarvestDate",
         actual_harvest_end_date AS "actualHarvestEndDate",
         status,
         total_chicks_loaded AS "totalChicksLoaded",
         planned_flock AS "plannedFlock",
         target_feed_kg AS "targetFeedKg",
         notes`,
      [
        startDate,
        targetHarvestDate || null,
        lockedTotalChicksLoaded,
        Number(plannedFlock || 0),
        Number(targetFeedKg || 0),
        notes || '',
        status || 'ONGOING',
        id,
      ]
    );

    if (lockedLoadings.length) {
      await upsertLoadings(client, id, startDate, lockedLoadings);
    }
    await syncBatchChickInventory(client, req, {
      farmId,
      batchId: id,
      startDate,
      totalChicksLoaded: lockedTotalChicksLoaded,
    });

    await auditLog(client, req, 'update', 'batch', id, before.rows[0], result.rows[0], id);

    const oldStatus = before.rows[0]?.status;
    const newStatus = status || 'ONGOING';
    if (oldStatus !== 'HARVESTED' && oldStatus !== 'CLOSED' && (newStatus === 'HARVESTED' || newStatus === 'CLOSED')) {
      const harvestDate = req.body.actualHarvestEndDate || targetHarvestDate || startDate || toDateOnly(new Date());
      await zeroOutFeedInventory(client, req, farmId, id, harvestDate);
    }

    await client.query('COMMIT');

    res.json(mapBatch(result.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to update batch:', err);
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id', authenticate, requirePrimaryOwner, async (req, res, next) => {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const before = await client.query('SELECT * FROM batches WHERE id = $1', [id]);
    await auditLog(client, req, 'delete', 'batch', id, before.rows[0] || null, null, id);
    await client.query('DELETE FROM batches WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ message: 'Batch deleted' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to delete batch:', err);
    next(err);
  } finally {
    client.release();
  }
});

router.get('/:batchId/loadings', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
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
      [req.params.batchId]
    );

    res.json(result.rows.map(row => ({
      ...row,
      loadingDate: toDateOnly(row.loadingDate),
      chicksLoaded: Number(row.chicksLoaded || 0),
      loadingSharePct: toNumber(row.loadingSharePct),
    })));
  } catch (err) {
    next(err);
  }
});

router.get('/:batchId/harvest-production-summary', authenticate, async (req, res, next) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const summary = await getHarvestProductionSummary(pool, farmId, req.params.batchId);

    if (!summary) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    res.json(summary);
  } catch (err) {
    next(err);
  }
});

router.put('/:batchId/loadings', authenticate, requirePrimaryOwner, validate(batchLoadingsSchema), async (req, res, next) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const batch = await client.query('SELECT start_date FROM batches WHERE id = $1', [req.params.batchId]);
    if (batch.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Batch not found' });
    }

    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const lockedLoadings = normalizeLoadingsWithLockedShares(req.body.loadings || []);
    const lockedTotalChicksLoaded = getLoadingsTotal(lockedLoadings);
    const loadingDate = toDateOnly(batch.rows[0].start_date);

    await upsertLoadings(client, req.params.batchId, loadingDate, lockedLoadings);
    await client.query(
      'UPDATE batches SET total_chicks_loaded = $1, updated_at = now() WHERE id = $2',
      [lockedTotalChicksLoaded, req.params.batchId]
    );
    await syncBatchChickInventory(client, req, {
      farmId,
      batchId: req.params.batchId,
      startDate: loadingDate,
      totalChicksLoaded: lockedTotalChicksLoaded,
    });
    await auditLog(client, req, 'update', 'batch_building_loadings', req.params.batchId, null, req.body, req.params.batchId);
    await client.query('COMMIT');
    res.json({ message: 'Loadings updated' });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.get('/:batchId/harvest-report', authenticate, requireMinimumRole('OperationManager'), async (req, res, next) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const report = await getHarvestReport(pool, farmId, req.params.batchId);

    if (!report) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    res.json(report);
  } catch (err) {
    next(err);
  }
});

router.put('/:batchId/harvest-report', authenticate, requireMinimumRole('OperationManager'), validate(harvestReportSchema), async (req, res, next) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const batch = await client.query(
      'SELECT id FROM batches WHERE id = $1 AND farm_id = $2 LIMIT 1',
      [req.params.batchId, farmId]
    );

    if (batch.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Batch not found' });
    }

    const before = await client.query(
      `SELECT *
       FROM harvest_reports
       WHERE batch_id = $1
         AND farm_id = $2
       FOR UPDATE`,
      [req.params.batchId, farmId]
    );

    if (before.rows[0]?.status === 'Posted') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Posted harvest reports cannot be edited.' });
    }

    const saved = await client.query(
      `INSERT INTO harvest_reports
         (farm_id, batch_id, source_filename, doc_add_on_rate_per_bird, trucking_fee_per_bird,
          notes, created_by_user_id, updated_by_user_id)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (batch_id)
       DO UPDATE SET
         source_filename = EXCLUDED.source_filename,
         doc_add_on_rate_per_bird = EXCLUDED.doc_add_on_rate_per_bird,
         trucking_fee_per_bird = EXCLUDED.trucking_fee_per_bird,
         notes = EXCLUDED.notes,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = now()
       RETURNING *`,
      [
        farmId,
        req.params.batchId,
        req.body.sourceFilename || null,
        toFiniteNumber(req.body.docAddOnRatePerBird, 3),
        toFiniteNumber(req.body.truckingFeePerBird, 2.7),
        req.body.notes || null,
        req.user.id,
      ]
    );

    const reportId = saved.rows[0].id;
    await client.query('DELETE FROM harvest_report_events WHERE report_id = $1', [reportId]);
    await client.query('DELETE FROM harvest_chicken_sales WHERE report_id = $1', [reportId]);
    await client.query('DELETE FROM harvest_byproduct_sales WHERE report_id = $1', [reportId]);
    await client.query('DELETE FROM harvest_financing_items WHERE report_id = $1', [reportId]);

    const harvestEvents = (req.body.harvestEvents || []).map(mapHarvestEvent);
    for (let index = 0; index < Math.max(harvestEvents.length, 3); index += 1) {
      const event = harvestEvents[index] || { harvestOrder: index + 1 };
      await client.query(
        `INSERT INTO harvest_report_events
           (report_id, harvest_order, harvest_date, permit_shipping, tolling_fee, remarks)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          reportId,
          event.harvestOrder || index + 1,
          event.harvestDate || null,
          toFiniteNumber(event.permitShipping),
          toFiniteNumber(event.tollingFee),
          event.remarks || null,
        ]
      );
    }

    for (const [index, rawRow] of (req.body.chickenSales || []).entries()) {
      const row = mapHarvestChickenSale({ ...rawRow, sortOrder: rawRow.sortOrder || index + 1 });
      if (!row.item.trim()) continue;

      await client.query(
        `INSERT INTO harvest_chicken_sales
           (report_id, sort_order, item, base_price_per_kg,
            harvest1_birds, harvest1_kilos, harvest2_birds, harvest2_kilos,
            harvest3_birds, harvest3_kilos, final_rate, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          reportId,
          row.sortOrder || index + 1,
          row.item.trim(),
          toNullableFiniteNumber(row.basePricePerKg),
          Math.round(toFiniteNumber(row.harvest1Birds)),
          toFiniteNumber(row.harvest1Kilos),
          Math.round(toFiniteNumber(row.harvest2Birds)),
          toFiniteNumber(row.harvest2Kilos),
          Math.round(toFiniteNumber(row.harvest3Birds)),
          toFiniteNumber(row.harvest3Kilos),
          toNullableFiniteNumber(row.finalRate),
          row.notes || null,
        ]
      );
    }

    for (const [index, rawRow] of (req.body.byproductSales || []).entries()) {
      const row = mapHarvestByproduct({ ...rawRow, sortOrder: rawRow.sortOrder || index + 1 });
      if (!row.item.trim()) continue;

      await client.query(
        `INSERT INTO harvest_byproduct_sales
           (report_id, sort_order, item, original_rate,
            harvest1_qty, harvest1_sales, harvest2_qty, harvest2_sales,
            harvest3_qty, harvest3_sales, final_rate, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          reportId,
          row.sortOrder || index + 1,
          row.item.trim(),
          toNullableFiniteNumber(row.originalRate),
          toFiniteNumber(row.harvest1Qty),
          toFiniteNumber(row.harvest1Sales),
          toFiniteNumber(row.harvest2Qty),
          toFiniteNumber(row.harvest2Sales),
          toFiniteNumber(row.harvest3Qty),
          toFiniteNumber(row.harvest3Sales),
          toNullableFiniteNumber(row.finalRate),
          row.notes || null,
        ]
      );
    }

    for (const [index, rawRow] of (req.body.financingItems || []).entries()) {
      const row = mapHarvestFinancingItem({ ...rawRow, sortOrder: rawRow.sortOrder || index + 1 });
      if (!row.item.trim()) continue;

      await client.query(
        `INSERT INTO harvest_financing_items
           (report_id, sort_order, item, category, quantity, unit_cost, amount, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          reportId,
          row.sortOrder || index + 1,
          row.item.trim(),
          row.category || 'Miscellaneous',
          toNullableFiniteNumber(row.quantity),
          toNullableFiniteNumber(row.unitCost),
          toNullableFiniteNumber(row.amount),
          row.notes || null,
        ]
      );
    }

    const report = await getHarvestReport(client, farmId, req.params.batchId);
    await auditLog(client, req, before.rowCount ? 'update' : 'create', 'harvest_report', reportId, before.rows[0] || null, report, req.params.batchId);
    await client.query('COMMIT');

    res.json(report);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.post('/:batchId/harvest-report/post-ledger', authenticate, requireMinimumRole('OperationManager'), async (req, res, next) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const reportLock = await client.query(
      `SELECT *
       FROM harvest_reports
       WHERE batch_id = $1
         AND farm_id = $2
       FOR UPDATE`,
      [req.params.batchId, farmId]
    );

    if (reportLock.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Save the harvest report before posting it to the ledger.' });
    }

    if (reportLock.rows[0].status === 'Posted') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This harvest report was already posted to the ledger.' });
    }

    const report = await getHarvestReport(client, farmId, req.params.batchId);
    const datedHarvests = report.summary.perHarvest.filter((row) => row.harvestDate);
    const latestHarvestDate = getLatestHarvestDate(datedHarvests);

    if (datedHarvests.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Add at least one harvest date before posting.' });
    }

    const reference = report.sourceFilename || `Harvest Report ${report.id}`;
    const ledgerTransactionIds = [];

    for (const row of datedHarvests) {
      if (row.netSales === 0) continue;

      const transactionId = await insertHarvestLedgerTransaction(client, req, {
        farmId,
        batchId: req.params.batchId,
        date: row.harvestDate,
        type: 'Income',
        fundingNature: 'Revenue',
        category: 'Net Meat Sale',
        description: `${getOrdinalLabel(row.harvestOrder)} Harvest net sale after harvest expenses`,
        amount: row.netSales,
        reference,
        remarks: `Harvest report ${report.id}. Birds: ${row.birds}; kilos: ${row.kilos}; gross sales: ${row.grossSales}; harvest expenses: ${row.totalExpenses}.`,
      });
      ledgerTransactionIds.push(transactionId);
    }

    for (const item of report.financingItems) {
      const amount = roundMoney(getFinancingAmount(item));
      if (amount <= 0) continue;

      const transactionId = await insertHarvestLedgerTransaction(client, req, {
        farmId,
        batchId: req.params.batchId,
        date: latestHarvestDate,
        type: 'Expense',
        fundingNature: 'OPEX',
        category: item.category || 'Miscellaneous',
        description: item.item,
        quantity: item.quantity,
        unitCost: item.unitCost,
        amount,
        reference,
        remarks: item.notes || `Harvest report ${report.id} financing item.`,
      });
      ledgerTransactionIds.push(transactionId);
    }

    await client.query(
      `UPDATE batches
       SET status = 'HARVESTED',
           actual_harvest_end_date = $1,
           updated_at = now()
       WHERE id = $2
         AND farm_id = $3`,
      [latestHarvestDate, req.params.batchId, farmId]
    );

    await zeroOutFeedInventory(client, req, farmId, req.params.batchId, latestHarvestDate);

    await client.query(
      `UPDATE harvest_reports
       SET status = 'Posted',
           posted_at = now(),
           posted_by_user_id = $1,
           ledger_transaction_ids = $2,
           updated_by_user_id = $1,
           updated_at = now()
       WHERE id = $3`,
      [req.user.id, JSON.stringify(ledgerTransactionIds), report.id]
    );

    await auditLog(client, req, 'post', 'harvest_report', report.id, reportLock.rows[0], { ledgerTransactionIds }, req.params.batchId);
    const postedReport = await getHarvestReport(client, farmId, req.params.batchId);
    await client.query('COMMIT');

    res.json(postedReport);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

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
  router,
  getCurrentBatchSnapshot,
};
