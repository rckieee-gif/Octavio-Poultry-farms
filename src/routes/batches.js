const express = require('express');
const { pool, getDefaultFarmId } = require('../db');
const { authenticate, requirePrimaryOwner } = require('../middleware/auth');
const { requireMinimumRole } = require('../middleware/roles');
const { validate, batchSchema, batchLoadingsSchema, harvestReportSchema } = require('../middleware/validate');
const {
  insertHarvestLedgerTransaction,
  auditLog,
  normalizeFundingNatureForDb,
} = require('../services/transactions.service');
const { toDateOnly } = require('../utils/validation');
const { toFiniteNumber, toNullableFiniteNumber, roundMoney, toNumber } = require('../utils/money');

// --- Service imports ---
const {
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
  getLoadingsDoaTotal,
  getWeightedArrivalSampleWeight,
} = require('../services/batches.service');

const {
  mapHarvestEvent,
  mapHarvestChickenSale,
  mapHarvestByproduct,
  mapHarvestFinancingItem,
  getFinancingAmount,
  calculateHarvestSummary,
  getHarvestReport,
  getHarvestProductionSummary,
  getLatestHarvestDate,
  getOrdinalLabel,
} = require('../services/harvest.service');

const router = express.Router();

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
        actual_chicks_arrived AS "actualChicksArrived",
        doa_count AS "doaCount",
        net_chicks_placed AS "netChicksPlaced",
        arrival_sample_weight_g AS "arrivalSampleWeightGrams",
        planned_flock AS "plannedFlock",
        mortality_allowance AS "mortalityAllowance",
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
        actual_chicks_arrived AS "actualChicksArrived",
        doa_count AS "doaCount",
        net_chicks_placed AS "netChicksPlaced",
        arrival_sample_weight_g AS "arrivalSampleWeightGrams",
        planned_flock AS "plannedFlock",
        mortality_allowance AS "mortalityAllowance",
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
    actualChicksArrived,
    doaCount,
    netChicksPlaced,
    arrivalSampleWeightGrams,
    plannedFlock,
    mortalityAllowance,
    targetFeedKg,
    notes,
    status,
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
    const lockedDoaCount = lockedLoadings.length
      ? getLoadingsDoaTotal(lockedLoadings)
      : Math.round(Number(doaCount || 0));
    const lockedNetChicksPlaced = lockedLoadings.length
      ? Math.max(lockedTotalChicksLoaded - lockedDoaCount, 0)
      : Math.round(Number(netChicksPlaced || Math.max(lockedTotalChicksLoaded - lockedDoaCount, 0)));
    const lockedArrivalSampleWeightGrams = lockedLoadings.length
      ? getWeightedArrivalSampleWeight(lockedLoadings)
      : (arrivalSampleWeightGrams == null ? null : Number(arrivalSampleWeightGrams));
    const hasActualChicksArrivedInput = Object.prototype.hasOwnProperty.call(req.body, 'actualChicksArrived');
    const lockedActualChicksArrived = hasActualChicksArrivedInput
      ? Math.round(Number(actualChicksArrived || 0))
      : 0;

    const result = await client.query(
      `INSERT INTO batches
         (id, farm_id, start_date, target_harvest_date, status, total_chicks_loaded,
          actual_chicks_arrived, doa_count, net_chicks_placed, arrival_sample_weight_g,
          planned_flock, mortality_allowance, target_feed_kg, notes, created_by_user_id)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING
         id,
         start_date AS "startDate",
         target_harvest_date AS "targetHarvestDate",
         actual_harvest_end_date AS "actualHarvestEndDate",
         status,
         total_chicks_loaded AS "totalChicksLoaded",
         actual_chicks_arrived AS "actualChicksArrived",
         doa_count AS "doaCount",
         net_chicks_placed AS "netChicksPlaced",
         arrival_sample_weight_g AS "arrivalSampleWeightGrams",
         planned_flock AS "plannedFlock",
         mortality_allowance AS "mortalityAllowance",
         target_feed_kg AS "targetFeedKg",
         notes`,
      [
        batchId,
        farmId,
        startDate,
        targetHarvestDate || null,
        status || 'ON_THE_WAY',
        lockedTotalChicksLoaded,
        lockedActualChicksArrived,
        lockedDoaCount,
        lockedNetChicksPlaced,
        lockedArrivalSampleWeightGrams,
        Number(plannedFlock || 0),
        Math.round(Number(mortalityAllowance || 0)),
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
    actualChicksArrived,
    doaCount,
    netChicksPlaced,
    arrivalSampleWeightGrams,
    plannedFlock,
    mortalityAllowance,
    targetFeedKg,
    notes,
    status,
    loadings,
  } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const before = await client.query('SELECT * FROM batches WHERE id = $1 AND farm_id = $2', [id, farmId]);
    if (before.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Batch not found' });
    }

    const lockedLoadings = normalizeLoadingsWithLockedShares(loadings || []);
    const lockedTotalChicksLoaded = lockedLoadings.length
      ? getLoadingsTotal(lockedLoadings)
      : Number(totalChicksLoaded || 0);
    const lockedDoaCount = lockedLoadings.length
      ? getLoadingsDoaTotal(lockedLoadings)
      : Math.round(Number(doaCount || 0));
    const lockedNetChicksPlaced = lockedLoadings.length
      ? Math.max(lockedTotalChicksLoaded - lockedDoaCount, 0)
      : Math.round(Number(netChicksPlaced || Math.max(lockedTotalChicksLoaded - lockedDoaCount, 0)));
    const lockedArrivalSampleWeightGrams = lockedLoadings.length
      ? getWeightedArrivalSampleWeight(lockedLoadings)
      : (arrivalSampleWeightGrams == null ? null : Number(arrivalSampleWeightGrams));
    const hasActualChicksArrivedInput = Object.prototype.hasOwnProperty.call(req.body, 'actualChicksArrived');
    const existingActualChicksArrived = Number(before.rows[0]?.actual_chicks_arrived ?? before.rows[0]?.actualChicksArrived ?? 0);
    const lockedActualChicksArrived = hasActualChicksArrivedInput
      ? Math.round(Number(actualChicksArrived || 0))
      : existingActualChicksArrived;

    const result = await client.query(
      `UPDATE batches
       SET
         start_date = $1,
         target_harvest_date = $2,
         total_chicks_loaded = $3,
         actual_chicks_arrived = $4,
         doa_count = $5,
         net_chicks_placed = $6,
         arrival_sample_weight_g = $7,
         planned_flock = $8,
         mortality_allowance = $9,
         target_feed_kg = $10,
         notes = $11,
         status = $12,
         updated_at = now()
       WHERE id = $13
       RETURNING
         id,
         start_date AS "startDate",
         target_harvest_date AS "targetHarvestDate",
         actual_harvest_end_date AS "actualHarvestEndDate",
         status,
         total_chicks_loaded AS "totalChicksLoaded",
         actual_chicks_arrived AS "actualChicksArrived",
         doa_count AS "doaCount",
         net_chicks_placed AS "netChicksPlaced",
         arrival_sample_weight_g AS "arrivalSampleWeightGrams",
         planned_flock AS "plannedFlock",
         mortality_allowance AS "mortalityAllowance",
         target_feed_kg AS "targetFeedKg",
         notes`,
      [
        startDate,
        targetHarvestDate || null,
        lockedTotalChicksLoaded,
        lockedActualChicksArrived,
        lockedDoaCount,
        lockedNetChicksPlaced,
        lockedArrivalSampleWeightGrams,
        Number(plannedFlock || 0),
        Math.round(Number(mortalityAllowance || 0)),
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
    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const before = await client.query('SELECT * FROM batches WHERE id = $1 AND farm_id = $2', [id, farmId]);
    if (before.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Batch not found' });
    }
    await auditLog(client, req, 'delete', 'batch', id, before.rows[0] || null, null, id);
    await client.query('DELETE FROM batches WHERE id = $1 AND farm_id = $2', [id, farmId]);
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
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const result = await pool.query(
      `SELECT
         bbl.id,
         b.name AS building,
         bbl.loading_date AS "loadingDate",
         bbl.chicks_loaded AS "chicksLoaded",
         bbl.doa_count AS "doaCount",
         bbl.net_chicks_placed AS "netChicksPlaced",
         bbl.sample_weight_g AS "sampleWeightGrams",
         bbl.loading_share_pct AS "loadingSharePct",
         bbl.remarks
       FROM batch_building_loadings bbl
       JOIN buildings b ON b.id = bbl.building_id
       JOIN batches ba ON ba.id = bbl.batch_id
       WHERE bbl.batch_id = $1 AND ba.farm_id = $2
       ORDER BY b.sort_order, b.name`,
      [req.params.batchId, farmId]
    );

    res.json(result.rows.map(row => ({
      ...row,
      loadingDate: toDateOnly(row.loadingDate),
      chicksLoaded: Number(row.chicksLoaded || 0),
      doaCount: Number(row.doaCount || 0),
      netChicksPlaced: Number(row.netChicksPlaced || 0),
      sampleWeightGrams: row.sampleWeightGrams == null ? null : toNumber(row.sampleWeightGrams),
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
    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const batch = await client.query('SELECT start_date FROM batches WHERE id = $1 AND farm_id = $2', [req.params.batchId, farmId]);
    if (batch.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Batch not found' });
    }
    const lockedLoadings = normalizeLoadingsWithLockedShares(req.body.loadings || []);
    const lockedTotalChicksLoaded = getLoadingsTotal(lockedLoadings);
    const lockedDoaCount = getLoadingsDoaTotal(lockedLoadings);
    const lockedNetChicksPlaced = Math.max(lockedTotalChicksLoaded - lockedDoaCount, 0);
    const lockedArrivalSampleWeightGrams = getWeightedArrivalSampleWeight(lockedLoadings);
    const loadingDate = toDateOnly(batch.rows[0].start_date);

    await upsertLoadings(client, req.params.batchId, loadingDate, lockedLoadings);
    await client.query(
      `UPDATE batches
       SET total_chicks_loaded = $1,
           doa_count = $2,
           net_chicks_placed = $3,
           arrival_sample_weight_g = $4,
           updated_at = now()
       WHERE id = $5`,
      [
        lockedTotalChicksLoaded,
        lockedDoaCount,
        lockedNetChicksPlaced,
        lockedArrivalSampleWeightGrams,
        req.params.batchId
      ]
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

module.exports = {
  router,
  getCurrentBatchSnapshot,
};
