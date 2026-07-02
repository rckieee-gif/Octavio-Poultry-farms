const express = require('express');
const { pool, getDefaultFarmId, ensureStakeholder, ensureCategory, getBuilding } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireMinimumRole } = require('../middleware/roles');
const {
  auditLog,
  generateTransactionCode,
  normalizeFundingNatureForDb,
  deriveTransactionType,
} = require('../services/transactions.service');
const {
  buildEmployeeMetadata,
  normalizeHandledBirds,
  normalizeRatePerBird,
} = require('../services/payroll.service');
const { sendDailyLogsCsv } = require('../services/dailyLogExport.service');
const { parseDailyLogXlsx } = require('../services/dailyLogXlsxImport.service');
const { toDateOnly, sendCsv } = require('../utils/validation');
const { calculateAmount } = require('../utils/money');

const router = express.Router();

function normalizeImportKey(key) {
  return String(key || '')
    .trim()
    .replace(/^\uFEFF/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function parseCsvRows(text) {
  const input = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        value += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(value);
      value = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
      continue;
    }

    value += char;
  }

  row.push(value);
  rows.push(row);

  const nonEmptyRows = rows.filter((entry) => entry.some((cell) => String(cell || '').trim() !== ''));
  if (nonEmptyRows.length === 0) return [];

  const headers = nonEmptyRows[0].map(normalizeImportKey);

  return nonEmptyRows.slice(1).map((entry) => headers.reduce((record, header, index) => {
    if (header) record[header] = entry[index] === undefined ? '' : entry[index];
    return record;
  }, {}));
}

function isXlsxFilename(filename) {
  return /\.xlsx$/i.test(String(filename || ''));
}

function decodeBase64Content(contentBase64) {
  const text = String(contentBase64 || '').trim();
  if (!text) return null;
  return Buffer.from(text, 'base64');
}

function createImportError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function getActiveBatchId(client, farmId) {
  const result = await client.query(
    `SELECT id
       FROM batches
      WHERE farm_id = $1
        AND status = 'ONGOING'
      ORDER BY start_date DESC
      LIMIT 1`,
    [farmId]
  );

  return result.rows[0]?.id || null;
}

async function parseImportRows({ client, farmId, importType, content, contentBase64, filename, options }) {
  if (importType === 'daily_logs' && contentBase64 && isXlsxFilename(filename)) {
    const activeBatchId = await getActiveBatchId(client, farmId);

    if (!activeBatchId) {
      throw createImportError('Daily log workbook import requires an active batch. Create or activate a batch, then import again.');
    }

    return parseDailyLogXlsx(decodeBase64Content(contentBase64), {
      batchId: activeBatchId,
      defaultFeedItem: options?.defaultFeedItem,
    });
  }

  if (contentBase64) {
    throw createImportError('Excel workbook import is only supported for Daily Logs.');
  }

  return parseCsvRows(content);
}

function createImportStats(label) {
  return { label, rowsRead: 0, created: 0, updated: 0, skipped: 0, warnings: [] };
}

function addImportWarning(stats, message) {
  if (stats.warnings.length < 10) stats.warnings.push(message);
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function getImportValue(row, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key) && !isBlank(row[key])) return row[key];
    const normalizedKey = normalizeImportKey(key);
    if (Object.prototype.hasOwnProperty.call(row, normalizedKey) && !isBlank(row[normalizedKey])) return row[normalizedKey];
  }

  return null;
}

function getImportText(row, ...keys) {
  const value = getImportValue(row, ...keys);
  return value === null ? '' : String(value).trim();
}

function getImportNumber(row, ...keys) {
  const value = getImportValue(row, ...keys);
  if (value === null) return null;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function getImportBoolean(row, ...keys) {
  const value = getImportValue(row, ...keys);
  if (value === null) return false;
  return ['true', '1', 'yes', 'y'].includes(String(value).trim().toLowerCase());
}

function getImportDate(row, ...keys) {
  const value = getImportValue(row, ...keys);
  return value ? toDateOnly(value) : null;
}

async function resetImportSequence(client, tableName, columnName = 'id') {
  const allowedTables = new Set([
    'daily_logs',
    'employee_batch_compensations',
    'inventory_items',
    'inventory_movements',
    'stakeholders',
  ]);

  if (!allowedTables.has(tableName)) return;
  if (columnName !== 'id') return;

  await client.query(
    `SELECT setval(
       pg_get_serial_sequence('public.${tableName}', '${columnName}'),
       GREATEST(COALESCE((SELECT MAX(${columnName}) FROM ${tableName}), 1), 1),
       true
     )`
  );
}

async function batchExists(client, farmId, batchId) {
  if (!batchId) return false;
  const result = await client.query(
    'SELECT id FROM batches WHERE id = $1 AND farm_id = $2 LIMIT 1',
    [batchId, farmId]
  );
  return result.rowCount > 0;
}

async function upsertImportedBatch(client, req, farmId, row, stats) {
  const batchId = getImportText(row, 'id', 'batch_id');
  const startDate = getImportDate(row, 'start_date', 'startDate');

  if (!batchId || !startDate) {
    stats.skipped += 1;
    addImportWarning(stats, 'Skipped batch row without id or start date.');
    return null;
  }

  const before = await client.query('SELECT id, farm_id FROM batches WHERE id = $1', [batchId]);
  if (before.rowCount > 0 && before.rows[0].farm_id !== farmId) {
    stats.skipped += 1;
    addImportWarning(stats, `Skipped batch ${batchId}: ID is already taken by another farm.`);
    return null;
  }

  await client.query(
    `INSERT INTO batches
       (id, farm_id, start_date, target_harvest_date, actual_harvest_end_date, status,
        total_chicks_loaded, actual_chicks_arrived, doa_count, net_chicks_placed, arrival_sample_weight_g,
        planned_flock, mortality_allowance, target_feed_kg, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (id)
     DO UPDATE SET
       farm_id = EXCLUDED.farm_id,
       start_date = EXCLUDED.start_date,
       target_harvest_date = EXCLUDED.target_harvest_date,
       actual_harvest_end_date = EXCLUDED.actual_harvest_end_date,
       status = EXCLUDED.status,
       total_chicks_loaded = EXCLUDED.total_chicks_loaded,
       actual_chicks_arrived = EXCLUDED.actual_chicks_arrived,
       doa_count = EXCLUDED.doa_count,
       net_chicks_placed = EXCLUDED.net_chicks_placed,
       arrival_sample_weight_g = EXCLUDED.arrival_sample_weight_g,
       planned_flock = EXCLUDED.planned_flock,
       mortality_allowance = EXCLUDED.mortality_allowance,
       target_feed_kg = EXCLUDED.target_feed_kg,
       notes = EXCLUDED.notes,
       updated_at = now()`,
    [
      batchId,
      farmId,
      startDate,
      getImportDate(row, 'target_harvest_date', 'targetHarvestDate'),
      getImportDate(row, 'actual_harvest_end_date', 'actualHarvestEndDate'),
      getImportText(row, 'status') || 'ONGOING',
      Math.round(getImportNumber(row, 'total_chicks_loaded', 'totalChicksLoaded') || 0),
      Math.round(getImportNumber(row, 'actual_chicks_arrived', 'actualChicksArrived', 'arrivedDocCount') || 0),
      Math.round(getImportNumber(row, 'doa_count', 'doaCount') || 0),
      Math.round(getImportNumber(row, 'net_chicks_placed', 'netChicksPlaced') || 0),
      getImportNumber(row, 'arrival_sample_weight_g', 'arrivalSampleWeightGrams'),
      Math.round(getImportNumber(row, 'planned_flock', 'plannedFlock') || 0),
      Math.round(getImportNumber(row, 'mortality_allowance', 'mortalityAllowance') || 0),
      getImportNumber(row, 'target_feed_kg', 'targetFeedKg') || 0,
      getImportText(row, 'notes'),
      req.user.id,
    ]
  );

  stats[before.rowCount ? 'updated' : 'created'] += 1;
  return batchId;
}

async function upsertImportedLoading(client, row, batchId, stats) {
  const buildingName = getImportText(row, 'building', 'building_name');
  if (!batchId || !buildingName) {
    stats.skipped += 1;
    return;
  }

  const building = await getBuilding(client, buildingName);
  if (!building) {
    stats.skipped += 1;
    addImportWarning(stats, `Skipped loading row: building "${buildingName}" not found.`);
    return;
  }
  const before = await client.query(
    'SELECT id FROM batch_building_loadings WHERE batch_id = $1 AND building_id = $2',
    [batchId, building.id]
  );

  await client.query(
    `INSERT INTO batch_building_loadings
       (batch_id, building_id, loading_date, chicks_loaded, doa_count, net_chicks_placed, sample_weight_g, loading_share_pct, remarks)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (batch_id, building_id)
     DO UPDATE SET
       loading_date = EXCLUDED.loading_date,
       chicks_loaded = EXCLUDED.chicks_loaded,
       doa_count = EXCLUDED.doa_count,
       net_chicks_placed = EXCLUDED.net_chicks_placed,
       sample_weight_g = EXCLUDED.sample_weight_g,
       loading_share_pct = EXCLUDED.loading_share_pct,
       remarks = EXCLUDED.remarks`,
    [
      batchId,
      building.id,
      getImportDate(row, 'loading_date', 'loadingDate') || new Date().toISOString().slice(0, 10),
      Math.round(getImportNumber(row, 'chicks_loaded', 'chicksLoaded') || 0),
      Math.round(getImportNumber(row, 'doa_count', 'doaCount') || 0),
      Math.round(getImportNumber(row, 'net_chicks_placed', 'netChicksPlaced') || 0),
      getImportNumber(row, 'sample_weight_g', 'sampleWeightGrams', 'arrivalSampleWeightGrams'),
      getImportNumber(row, 'loading_share_pct', 'loadingSharePct'),
      getImportText(row, 'remarks'),
    ]
  );

  stats[before.rowCount ? 'updated' : 'created'] += 1;
}

async function upsertImportedInventoryItem(client, farmId, row, stats, itemIdMap = new Map()) {
  const originalId = getImportNumber(row, 'id', 'item_id');
  const name = getImportText(row, 'name', 'item', 'item_name', 'feed_item');

  if (!name) {
    stats.skipped += 1;
    addImportWarning(stats, 'Skipped inventory item without a name.');
    return null;
  }

  const category = getImportText(row, 'category') || (normalizeImportKey(name).includes('feed') ? 'Feed' : 'Supplies');
  const unit = getImportText(row, 'unit') || (category === 'Feed' ? 'sacks' : 'pcs');
  const targetQuantity = getImportNumber(row, 'target_quantity', 'targetQuantity') || 0;
  const reorderLevel = getImportNumber(row, 'reorder_level', 'reorderLevel') || 0;
  let existing = null;

  if (originalId) {
    existing = await client.query(
      'SELECT id FROM inventory_items WHERE id = $1 AND farm_id = $2 LIMIT 1',
      [originalId, farmId]
    );
  }

  if (!existing?.rowCount) {
    existing = await client.query(
      'SELECT id FROM inventory_items WHERE farm_id = $1 AND lower(name) = lower($2) LIMIT 1',
      [farmId, name]
    );
  }

  if (existing.rowCount > 0) {
    const itemId = existing.rows[0].id;
    await client.query(
      `UPDATE inventory_items
       SET name = $1,
           category = $2,
           unit = $3,
           target_quantity = $4,
           reorder_level = $5,
           is_active = true,
           updated_at = now()
       WHERE id = $6`,
      [name, category, unit, targetQuantity, reorderLevel, itemId]
    );
    if (originalId) itemIdMap.set(Number(originalId), itemId);
    stats.updated += 1;
    return itemId;
  }

  let inserted;
  if (originalId) {
    const idTaken = await client.query('SELECT id FROM inventory_items WHERE id = $1 LIMIT 1', [originalId]);
    if (idTaken.rowCount === 0) {
      inserted = await client.query(
        `INSERT INTO inventory_items
           (id, farm_id, name, category, unit, target_quantity, reorder_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [originalId, farmId, name, category, unit, targetQuantity, reorderLevel]
      );
    }
  }

  if (!inserted) {
    inserted = await client.query(
      `INSERT INTO inventory_items
         (farm_id, name, category, unit, target_quantity, reorder_level)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [farmId, name, category, unit, targetQuantity, reorderLevel]
    );
  }

  const itemId = inserted.rows[0].id;
  if (originalId) itemIdMap.set(Number(originalId), itemId);
  stats.created += 1;
  return itemId;
}

async function upsertImportedEmployee(client, req, farmId, row, stats, employeeIdMap = new Map()) {
  const originalId = getImportNumber(row, 'id', 'employee_id');
  const name = getImportText(row, 'name', 'employee', 'employee_name', 'display_name');

  if (!name) {
    stats.skipped += 1;
    addImportWarning(stats, 'Skipped employee row without a name.');
    return null;
  }

  const metadata = row.metadata && typeof row.metadata === 'object'
    ? row.metadata
    : buildEmployeeMetadata({
        position: getImportText(row, 'position'),
        hireDate: getImportDate(row, 'hire_date', 'hireDate') || '',
        assignedBuilding: getImportText(row, 'assigned_building', 'assignedBuilding'),
        notes: getImportText(row, 'notes'),
      });

  let existing = null;
  if (originalId) {
    existing = await client.query(
      'SELECT id FROM stakeholders WHERE id = $1 AND farm_id = $2 LIMIT 1',
      [originalId, farmId]
    );
  }

  if (!existing?.rowCount) {
    existing = await client.query(
      'SELECT id FROM stakeholders WHERE lower(name) = lower($1) AND farm_id = $2 LIMIT 1',
      [name, farmId]
    );
  }

  if (existing.rowCount > 0) {
    const employeeId = existing.rows[0].id;
    await client.query(
      `UPDATE stakeholders
       SET name = $1,
           display_name = $2,
           type = 'Employee',
           phone = $3,
           email = $4,
           address = $5,
           metadata = $6,
           is_active = true
       WHERE id = $7`,
      [
        name,
        getImportText(row, 'display_name', 'displayName') || name,
        getImportText(row, 'phone') || null,
        getImportText(row, 'email') || null,
        getImportText(row, 'address') || null,
        JSON.stringify(metadata),
        employeeId,
      ]
    );
    if (originalId) employeeIdMap.set(Number(originalId), employeeId);
    stats.updated += 1;
    return employeeId;
  }

  let inserted;
  if (originalId) {
    const idTaken = await client.query('SELECT id FROM stakeholders WHERE id = $1 LIMIT 1', [originalId]);
    if (idTaken.rowCount === 0) {
      inserted = await client.query(
        `INSERT INTO stakeholders
           (id, farm_id, name, display_name, type, phone, email, address, metadata)
         VALUES ($1, $2, $3, $4, 'Employee', $5, $6, $7, $8)
         RETURNING id`,
        [
          originalId,
          farmId,
          name,
          getImportText(row, 'display_name', 'displayName') || name,
          getImportText(row, 'phone') || null,
          getImportText(row, 'email') || null,
          getImportText(row, 'address') || null,
          JSON.stringify(metadata),
        ]
      );
    }
  }

  if (!inserted) {
    inserted = await client.query(
      `INSERT INTO stakeholders
         (farm_id, name, display_name, type, phone, email, address, metadata)
       VALUES ($1, $2, $3, 'Employee', $4, $5, $6, $7)
       RETURNING id`,
      [
        farmId,
        name,
        getImportText(row, 'display_name', 'displayName') || name,
        getImportText(row, 'phone') || null,
        getImportText(row, 'email') || null,
        getImportText(row, 'address') || null,
        JSON.stringify(metadata),
      ]
    );
  }

  const employeeId = inserted.rows[0].id;
  if (originalId) employeeIdMap.set(Number(originalId), employeeId);
  await auditLog(client, req, 'import', 'employee', employeeId, null, { name }, null);
  stats.created += 1;
  return employeeId;
}

async function upsertImportedEmployeeCompensation(client, req, farmId, row, employeeId, stats) {
  const batchId = getImportText(row, 'batch_id', 'batchId');
  if (!batchId || !employeeId || getImportValue(row, 'handled_birds', 'handledBirds') === null) return;

  if (!(await batchExists(client, farmId, batchId))) {
    stats.skipped += 1;
    addImportWarning(stats, `Skipped compensation for missing batch ${batchId}.`);
    return;
  }

  const before = await client.query(
    'SELECT id FROM employee_batch_compensations WHERE batch_id = $1 AND employee_id = $2',
    [batchId, employeeId]
  );

  await client.query(
    `INSERT INTO employee_batch_compensations
       (farm_id, batch_id, employee_id, handled_birds, rate_per_bird, corpo_group, remarks, created_by_user_id, updated_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     ON CONFLICT (batch_id, employee_id)
     DO UPDATE SET
       handled_birds = EXCLUDED.handled_birds,
       rate_per_bird = EXCLUDED.rate_per_bird,
       corpo_group = EXCLUDED.corpo_group,
       remarks = EXCLUDED.remarks,
       updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_at = now()`,
    [
      farmId,
      batchId,
      employeeId,
      normalizeHandledBirds(getImportNumber(row, 'handled_birds', 'handledBirds') || 0),
      normalizeRatePerBird(getImportNumber(row, 'rate_per_bird', 'ratePerBird') || 1.5),
      getImportText(row, 'corpo_group', 'corpoGroup') || null,
      getImportText(row, 'remarks', 'compensation_remarks') || null,
      req.user.id,
    ]
  );

  stats[before.rowCount ? 'updated' : 'created'] += 1;
}

async function getImportedStakeholderId(client, farmId, row, idKey, nameKey, type, employeeIdMap = new Map()) {
  const originalId = getImportNumber(row, idKey);
  if (originalId && employeeIdMap.has(Number(originalId))) return employeeIdMap.get(Number(originalId));

  const name = getImportText(row, `${nameKey}_name`, nameKey);
  if (name) return ensureStakeholder(client, farmId, name, type);

  if (originalId) {
    const existing = await client.query(
      'SELECT id FROM stakeholders WHERE id = $1 AND farm_id = $2 LIMIT 1',
      [originalId, farmId]
    );
    if (existing.rowCount > 0) return existing.rows[0].id;
  }

  return null;
}

async function importTransactions(client, req, farmId, rows, stats, employeeIdMap = new Map()) {
  for (const row of rows) {
    stats.rowsRead += 1;
    const batchId = getImportText(row, 'batch_id', 'batchId');
    const date = getImportDate(row, 'date');
    const fundingNature = getImportText(row, 'funding_nature', 'fundingNature');
    const category = getImportText(row, 'category', 'category_name');
    const description = getImportText(row, 'description');

    if (!batchId || !date || !fundingNature || !category) {
      stats.skipped += 1;
      addImportWarning(stats, 'Skipped transaction row missing batch, date, funding, or category.');
      continue;
    }

    if (!(await batchExists(client, farmId, batchId))) {
      stats.skipped += 1;
      addImportWarning(stats, `Skipped transaction for missing batch ${batchId}.`);
      continue;
    }

    const transactionId = getImportText(row, 'transaction_id', 'id') || await generateTransactionCode(client, date, 'IMP');
    const exists = await client.query('SELECT transaction_id FROM daily_transactions WHERE transaction_id = $1', [transactionId]);
    const dbFundingNature = normalizeFundingNatureForDb(fundingNature);
    const transactionType = getImportText(row, 'type') || deriveTransactionType(fundingNature);
    const buildingName = getImportText(row, 'building') || 'All';
    const buildingRecord = await getBuilding(client, buildingName);
    const buildingScope = buildingRecord ? 'Specific' : 'All';
    const categoryId = await ensureCategory(client, farmId, dbFundingNature, category);
    const paidById = await getImportedStakeholderId(client, farmId, row, 'paid_by', 'paid_by', 'Owner', employeeIdMap);
    const paidToId = await getImportedStakeholderId(client, farmId, row, 'paid_to', 'paid_to', 'Supplier', employeeIdMap);
    const quantity = getImportNumber(row, 'quantity');
    const unitCost = getImportNumber(row, 'unit_cost', 'unitCost');
    const amount = getImportNumber(row, 'amount') ?? calculateAmount({ quantity, unitCost, amount: getImportValue(row, 'manual_amount', 'manualAmount') || 0 });

    await client.query(
      `INSERT INTO daily_transactions
         (transaction_id, batch_id, date, building_id, building_scope, type, funding_nature,
          category, category_id, description, quantity, unit_cost, manual_amount, amount,
          paid_by, paid_to, reference, remarks, is_void, void_reason, created_by_user_id, updated_by_user_id)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19, $20, $21, $21)
       ON CONFLICT (transaction_id)
       DO UPDATE SET
         batch_id = EXCLUDED.batch_id,
         date = EXCLUDED.date,
         building_id = EXCLUDED.building_id,
         building_scope = EXCLUDED.building_scope,
         type = EXCLUDED.type,
         funding_nature = EXCLUDED.funding_nature,
         category = EXCLUDED.category,
         category_id = EXCLUDED.category_id,
         description = EXCLUDED.description,
         quantity = EXCLUDED.quantity,
         unit_cost = EXCLUDED.unit_cost,
         manual_amount = EXCLUDED.manual_amount,
         amount = EXCLUDED.amount,
         paid_by = EXCLUDED.paid_by,
         paid_to = EXCLUDED.paid_to,
         reference = EXCLUDED.reference,
         remarks = EXCLUDED.remarks,
         is_void = EXCLUDED.is_void,
         void_reason = EXCLUDED.void_reason,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = now()`,
      [
        transactionId,
        batchId,
        date,
        buildingRecord?.id || null,
        buildingScope,
        transactionType,
        dbFundingNature,
        category,
        categoryId,
        description || category,
        quantity,
        unitCost,
        quantity !== null && unitCost !== null ? null : amount,
        amount,
        paidById,
        paidToId,
        getImportText(row, 'reference') || null,
        getImportText(row, 'remarks') || null,
        getImportBoolean(row, 'is_void', 'isVoid'),
        getImportText(row, 'void_reason', 'voidReason') || null,
        req.user.id,
      ]
    );

    stats[exists.rowCount ? 'updated' : 'created'] += 1;
  }
}

async function importEmployees(client, req, farmId, rows, stats, employeeIdMap = new Map()) {
  for (const row of rows) {
    stats.rowsRead += 1;
    const employeeId = await upsertImportedEmployee(client, req, farmId, row, stats, employeeIdMap);
    await upsertImportedEmployeeCompensation(client, req, farmId, row, employeeId, stats);
  }

  await resetImportSequence(client, 'stakeholders');
  await resetImportSequence(client, 'employee_batch_compensations');
}

async function importDailyLogs(client, req, farmId, rows, stats, employeeIdMap = new Map(), itemIdMap = new Map()) {
  const feedItemNameMap = new Map();

  for (const row of rows) {
    stats.rowsRead += 1;
    const batchId = getImportText(row, 'batch_id', 'batchId');
    const date = getImportDate(row, 'date');
    const buildingName = getImportText(row, 'building');

    if (!batchId || !date || !buildingName) {
      stats.skipped += 1;
      addImportWarning(stats, 'Skipped daily log row missing batch, date, or building.');
      continue;
    }

    if (!(await batchExists(client, farmId, batchId))) {
      stats.skipped += 1;
      addImportWarning(stats, `Skipped daily log for missing batch ${batchId}.`);
      continue;
    }

    const building = await getBuilding(client, buildingName);
    if (!building) {
      stats.skipped += 1;
      addImportWarning(stats, `Skipped daily log row: building "${buildingName}" not found.`);
      continue;
    }
    const originalEmployeeId = getImportNumber(row, 'employee_id');
    const employeeId = originalEmployeeId && employeeIdMap.has(Number(originalEmployeeId))
      ? employeeIdMap.get(Number(originalEmployeeId))
      : await ensureStakeholder(client, farmId, getImportText(row, 'employee', 'employee_name'), 'Employee');
    const originalFeedItemId = getImportNumber(row, 'feed_item_id');
    let feedItemId = originalFeedItemId && itemIdMap.has(Number(originalFeedItemId))
      ? itemIdMap.get(Number(originalFeedItemId))
      : null;
    const feedItemName = getImportText(row, 'feed_item');

    if (!feedItemId && feedItemName) {
      const feedItemKey = feedItemName.toLowerCase();
      if (feedItemNameMap.has(feedItemKey)) {
        feedItemId = feedItemNameMap.get(feedItemKey);
      } else {
        feedItemId = await upsertImportedInventoryItem(client, farmId, {
          name: feedItemName,
          category: 'Feed',
          unit: 'sacks',
        }, createImportStats('feed item'), itemIdMap);
        feedItemNameMap.set(feedItemKey, feedItemId);
      }
    }

    if (!employeeId) {
      stats.skipped += 1;
      addImportWarning(stats, 'Skipped daily log row without an employee.');
      continue;
    }

    const originalId = getImportNumber(row, 'id');
    const importSourceKey = getImportText(row, 'import_source_key', 'source_key');
    const existing = originalId
      ? await client.query('SELECT id FROM daily_logs WHERE id = $1', [originalId])
      : importSourceKey
        ? await client.query(
          'SELECT id FROM daily_logs WHERE batch_id = $1 AND import_source_key = $2',
          [batchId, importSourceKey]
        )
        : { rowCount: 0 };
    const values = [
      batchId,
      date,
      building.id,
      employeeId,
      Math.round(getImportNumber(row, 'handled_birds_snapshot', 'handledBirds') || 0),
      feedItemId,
      getImportNumber(row, 'feed_consumed', 'feed') || 0,
      Math.round(getImportNumber(row, 'mortality') || 0),
      getImportNumber(row, 'average_weight_g', 'averageWeightGrams'),
      getImportText(row, 'remarks') || null,
      importSourceKey || null,
      req.user.id,
    ];

    if (existing.rowCount > 0) {
      await client.query(
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
             import_source_key = $11,
             updated_at = now()
         WHERE id = $13`,
        [...values, existing.rows[0].id]
      );
      stats.updated += 1;
      continue;
    }

    if (originalId) {
      await client.query(
        `INSERT INTO daily_logs
           (id, batch_id, date, building_id, employee_id, handled_birds_snapshot,
            feed_item_id, feed_consumed, mortality, average_weight_g, remarks, import_source_key, created_by_user_id)
         VALUES ($13, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [...values, originalId]
      );
    } else {
      await client.query(
        `INSERT INTO daily_logs
           (batch_id, date, building_id, employee_id, handled_birds_snapshot,
            feed_item_id, feed_consumed, mortality, average_weight_g, remarks, import_source_key, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        values
      );
    }

    stats.created += 1;
  }

  await resetImportSequence(client, 'daily_logs');
}

async function importInventoryMovements(client, req, farmId, rows, stats, itemIdMap = new Map()) {
  for (const row of rows) {
    stats.rowsRead += 1;
    const batchId = getImportText(row, 'batch_id', 'batchId') || null;
    const movementDate = getImportDate(row, 'movement_date', 'movementDate');
    const movementType = getImportText(row, 'movement_type', 'movementType');
    const quantity = getImportNumber(row, 'quantity');

    if (!movementDate || !movementType || quantity === null) {
      stats.skipped += 1;
      addImportWarning(stats, 'Skipped inventory movement without date, type, or quantity.');
      continue;
    }

    if (batchId && !(await batchExists(client, farmId, batchId))) {
      stats.skipped += 1;
      addImportWarning(stats, `Skipped inventory movement for missing batch ${batchId}.`);
      continue;
    }

    const originalItemId = getImportNumber(row, 'item_id');
    const itemId = originalItemId && itemIdMap.has(Number(originalItemId))
      ? itemIdMap.get(Number(originalItemId))
      : await upsertImportedInventoryItem(client, farmId, row, createImportStats('inventory item'), itemIdMap);

    if (!itemId) {
      stats.skipped += 1;
      continue;
    }

    const building = await getBuilding(client, getImportText(row, 'building') || 'All');
    const sourceType = getImportText(row, 'source_type', 'sourceType') || null;
    const sourceId = getImportText(row, 'source_id', 'sourceId') || null;
    const linkedTransactionId = getImportText(row, 'linked_transaction_id', 'linkedTransactionId') || null;
    const linkedExists = linkedTransactionId
      ? await client.query('SELECT transaction_id FROM daily_transactions WHERE transaction_id = $1 LIMIT 1', [linkedTransactionId])
      : { rowCount: 0 };
    const originalId = getImportNumber(row, 'id');
    let existing = { rowCount: 0 };

    if (sourceType && sourceId) {
      existing = await client.query(
        `SELECT id
         FROM inventory_movements
         WHERE source_type = $1
           AND source_id = $2
           AND item_id = $3
         LIMIT 1`,
        [sourceType, sourceId, itemId]
      );
    }

    if (!existing.rowCount && originalId) {
      existing = await client.query('SELECT id FROM inventory_movements WHERE id = $1 LIMIT 1', [originalId]);
    }

    const values = [
      farmId,
      batchId,
      itemId,
      movementDate,
      movementType,
      quantity,
      getImportNumber(row, 'unit_cost', 'unitCost'),
      getImportNumber(row, 'amount'),
      building?.id || null,
      sourceType,
      sourceId,
      linkedExists.rowCount ? linkedTransactionId : null,
      getImportText(row, 'remarks') || null,
      req.user.id,
    ];

    if (existing.rowCount > 0) {
      await client.query(
        `UPDATE inventory_movements
         SET farm_id = $1,
             batch_id = $2,
             item_id = $3,
             movement_date = $4,
             movement_type = $5,
             quantity = $6,
             unit_cost = $7,
             amount = $8,
             building_id = $9,
             source_type = $10,
             source_id = $11,
             linked_transaction_id = $12,
             remarks = $13
         WHERE id = $15`,
        [...values, existing.rows[0].id]
      );
      stats.updated += 1;
      continue;
    }

    if (originalId) {
      await client.query(
        `INSERT INTO inventory_movements
           (id, farm_id, batch_id, item_id, movement_date, movement_type, quantity,
            unit_cost, amount, building_id, source_type, source_id, linked_transaction_id,
            remarks, created_by_user_id)
         VALUES ($15, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [...values, originalId]
      );
    } else {
      await client.query(
        `INSERT INTO inventory_movements
           (farm_id, batch_id, item_id, movement_date, movement_type, quantity,
            unit_cost, amount, building_id, source_type, source_id, linked_transaction_id,
            remarks, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        values
      );
    }

    stats.created += 1;
  }

  await resetImportSequence(client, 'inventory_items');
  await resetImportSequence(client, 'inventory_movements');
}

async function importBatchArchive(client, req, farmId, archive) {
  const summary = {
    batches: createImportStats('Batch'),
    loadings: createImportStats('Loadings'),
    employees: createImportStats('Employees'),
    inventoryItems: createImportStats('Inventory Items'),
    transactions: createImportStats('Ledger Transactions'),
    dailyLogs: createImportStats('Daily Logs'),
    inventoryMovements: createImportStats('Inventory Movements'),
  };
  const batches = Array.isArray(archive?.batches) ? archive.batches : [];

  if (batches.length !== 1) {
    throw new Error('Single batch import requires an archive JSON with exactly one batch.');
  }

  const itemIdMap = new Map();
  const employeeIdMap = new Map();
  const batchId = await upsertImportedBatch(client, req, farmId, batches[0], summary.batches);

  for (const row of archive.inventoryItems || []) {
    summary.inventoryItems.rowsRead += 1;
    await upsertImportedInventoryItem(client, farmId, row, summary.inventoryItems, itemIdMap);
  }

  for (const row of archive.loadings || []) {
    summary.loadings.rowsRead += 1;
    await upsertImportedLoading(client, row, getImportText(row, 'batch_id') || batchId, summary.loadings);
  }

  await importEmployees(client, req, farmId, archive.employees || [], summary.employees, employeeIdMap);
  await importTransactions(client, req, farmId, archive.transactions || [], summary.transactions, employeeIdMap);
  await importDailyLogs(client, req, farmId, archive.dailyLogs || archive.daily_logs || [], summary.dailyLogs, employeeIdMap, itemIdMap);
  await importInventoryMovements(client, req, farmId, archive.inventoryMovements || archive.inventory_movements || [], summary.inventoryMovements, itemIdMap);

  return summary;
}

router.post('/import', authenticate, requireMinimumRole('OperationManager'), async (req, res, next) => {
  const { importType, content, contentBase64, filename, dryRun, options } = req.body || {};

  if (!importType || (!content && !contentBase64)) {
    return res.status(400).json({ error: 'Import type and file content are required.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const itemIdMap = new Map();
    const employeeIdMap = new Map();
    let summary;
    let previewRows = [];

    if (importType === 'batch_archive') {
      summary = await importBatchArchive(client, req, farmId, JSON.parse(content));
    } else {
      const rows = await parseImportRows({ client, farmId, importType, content, contentBase64, filename, options });
      previewRows = rows.slice(0, 10);
      summary = { [importType]: createImportStats(importType) };

      if (importType === 'transactions') {
        await importTransactions(client, req, farmId, rows, summary[importType], employeeIdMap);
      } else if (importType === 'daily_logs') {
        await importDailyLogs(client, req, farmId, rows, summary[importType], employeeIdMap, itemIdMap);
      } else if (importType === 'inventory') {
        await importInventoryMovements(client, req, farmId, rows, summary[importType], itemIdMap);
      } else if (importType === 'employees') {
        await importEmployees(client, req, farmId, rows, summary[importType], employeeIdMap);
      } else {
        throw new Error('Unknown import type.');
      }
    }

    if (dryRun) {
      await client.query('ROLLBACK').catch(() => {});
      return res.json({
        message: 'Dry-run complete.',
        importType,
        filename: filename || '',
        summary,
        previewRows,
        isDryRun: true
      });
    }

    await auditLog(client, req, 'import', 'settings_file', filename || importType, null, { importType, summary });
    await client.query('COMMIT');
    res.json({ message: 'Import complete.', importType, filename: filename || '', summary });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Failed to import settings data:', err);
    next(err);
  } finally {
    client.release();
  }
});

router.get('/export', authenticate, requireMinimumRole('OperationManager'), async (req, res, next) => {
  const dataset = req.query.dataset || 'transactions';
  const batchId = req.query.batchId || null;

  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();

    if (dataset === 'transactions') {
      const params = [farmId];
      const where = ['ba.farm_id = $1'];

      if (batchId) {
        params.push(batchId);
        where.push(`t.batch_id = $${params.length}`);
      }

      const result = await pool.query(
        `SELECT
           t.transaction_id,
           t.batch_id,
           t.date,
           COALESCE(b.name, 'All') AS building,
           t.type,
           CASE WHEN t.funding_nature = 'Other Revenue' THEN 'Revenue' ELSE t.funding_nature END AS funding_nature,
           COALESCE(c.name, t.category) AS category,
           t.description,
           t.quantity,
           t.unit_cost,
           t.amount,
           paid_by.name AS paid_by,
           paid_to.name AS paid_to,
           t.reference,
           t.remarks,
           t.is_void,
           t.void_reason,
           t.created_at
         FROM daily_transactions t
         JOIN batches ba ON ba.id = t.batch_id
         LEFT JOIN buildings b ON b.id = t.building_id
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN stakeholders paid_by ON paid_by.id = t.paid_by
         LEFT JOIN stakeholders paid_to ON paid_to.id = t.paid_to
         WHERE ${where.join(' AND ')}
         ORDER BY t.date DESC, t.transaction_id DESC`,
        params
      );

      return sendCsv(res, `octavio-transactions${batchId ? `-${batchId}` : ''}.csv`, result.rows);
    }

    if (dataset === 'daily_logs') {
      if (!batchId) {
        return res.status(400).json({ error: 'Daily log export requires a selected batch.' });
      }

      const params = [farmId];
      const where = ['ba.farm_id = $1'];

      params.push(batchId);
      where.push(`dl.batch_id = $${params.length}`);

      const result = await pool.query(
        `SELECT
           dl.id,
           dl.batch_id,
           dl.date,
           COALESCE(b.name, 'All') AS building,
           COALESCE(s.display_name, s.name) AS employee,
           dl.handled_birds_snapshot,
           ii.name AS feed_item,
           dl.feed_consumed,
           dl.mortality,
           dl.average_weight_g,
           dl.remarks,
           dl.created_at
         FROM daily_logs dl
         JOIN batches ba ON ba.id = dl.batch_id
         LEFT JOIN buildings b ON b.id = dl.building_id
         LEFT JOIN stakeholders s ON s.id = dl.employee_id
         LEFT JOIN inventory_items ii ON ii.id = dl.feed_item_id
         WHERE ${where.join(' AND ')}
         ORDER BY dl.id DESC, dl.created_at DESC`,
        params
      );

      return sendDailyLogsCsv(res, `octavio-daily-logs-${batchId}.csv`, result.rows);
    }

    if (dataset === 'inventory') {
      const result = await pool.query(
        `SELECT
           im.id,
           im.batch_id,
           im.movement_date,
           ii.name AS item,
           ii.category,
           ii.unit,
           im.movement_type,
           im.quantity,
           im.unit_cost,
           im.amount,
           COALESCE(b.name, 'All') AS building,
           im.source_type,
           im.source_id,
           im.linked_transaction_id,
           im.remarks,
           im.created_at
         FROM inventory_movements im
         JOIN inventory_items ii ON ii.id = im.item_id
         LEFT JOIN buildings b ON b.id = im.building_id
         WHERE im.farm_id = $1
           AND ($2::varchar IS NULL OR im.batch_id = $2)
         ORDER BY im.movement_date DESC, im.id DESC`,
        [farmId, batchId]
      );

      return sendCsv(res, `octavio-inventory${batchId ? `-${batchId}` : ''}.csv`, result.rows);
    }

    if (dataset === 'employees') {
      const result = await pool.query(
        `SELECT
           s.id,
           s.name,
           COALESCE(s.display_name, s.name) AS display_name,
           s.phone,
           s.email,
           s.metadata->>'position' AS position,
           s.metadata->>'assignedBuilding' AS assigned_building,
           ebc.batch_id,
           ebc.handled_birds,
           ebc.rate_per_bird,
           ebc.corpo_group,
           ebc.remarks
         FROM stakeholders s
         LEFT JOIN employee_batch_compensations ebc ON ebc.employee_id = s.id
         WHERE s.farm_id = $1
           AND s.type = 'Employee'
           AND ($2::varchar IS NULL OR ebc.batch_id = $2)
         ORDER BY COALESCE(s.display_name, s.name), ebc.batch_id DESC NULLS LAST`,
        [farmId, batchId]
      );

      return sendCsv(res, `octavio-employees${batchId ? `-${batchId}` : ''}.csv`, result.rows);
    }

    if (dataset === 'batches') {
      const result = await pool.query(
        `SELECT
           id,
           start_date,
           target_harvest_date,
           actual_harvest_end_date,
           status,
           total_chicks_loaded,
           actual_chicks_arrived,
           doa_count,
           net_chicks_placed,
           arrival_sample_weight_g,
           planned_flock,
           mortality_allowance,
           target_feed_kg,
           notes,
           created_at,
           updated_at
         FROM batches
         WHERE farm_id = $1
         ORDER BY start_date DESC`,
        [farmId]
      );

      return sendCsv(res, 'octavio-batches.csv', result.rows);
    }

    return res.status(400).json({ error: 'Unknown export dataset.' });
  } catch (err) {
    console.error('Failed to export settings data:', err);
    next(err);
  }
});

router.get('/archive', authenticate, requireMinimumRole('OperationManager'), async (req, res, next) => {
  const batchId = req.query.batchId || null;

  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const batchParams = [farmId];
    const batchWhere = ['farm_id = $1'];

    if (batchId) {
      batchParams.push(batchId);
      batchWhere.push(`id = $${batchParams.length}`);
    }

    const [
      farm,
      batches,
      loadings,
      transactions,
      dailyLogs,
      inventoryItems,
      inventoryMovements,
      employees,
    ] = await Promise.all([
      pool.query(
        `SELECT code, name, legal_name, timezone, currency, settings, created_at, updated_at
         FROM farms
         WHERE id = $1`,
        [farmId]
      ),
      pool.query(
        `SELECT *
         FROM batches
         WHERE ${batchWhere.join(' AND ')}
         ORDER BY start_date DESC`,
        batchParams
      ),
      pool.query(
        `SELECT bbl.*, b.name AS building
         FROM batch_building_loadings bbl
         JOIN batches ba ON ba.id = bbl.batch_id
         JOIN buildings b ON b.id = bbl.building_id
         WHERE ba.farm_id = $1
           AND ($2::varchar IS NULL OR bbl.batch_id = $2)
         ORDER BY bbl.batch_id, b.sort_order, b.name`,
        [farmId, batchId]
      ),
      pool.query(
        `SELECT t.*, b.name AS building, c.name AS category_name, paid_by.name AS paid_by_name, paid_to.name AS paid_to_name
         FROM daily_transactions t
         JOIN batches ba ON ba.id = t.batch_id
         LEFT JOIN buildings b ON b.id = t.building_id
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN stakeholders paid_by ON paid_by.id = t.paid_by
         LEFT JOIN stakeholders paid_to ON paid_to.id = t.paid_to
         WHERE ba.farm_id = $1
           AND ($2::varchar IS NULL OR t.batch_id = $2)
         ORDER BY t.date DESC, t.transaction_id DESC`,
        [farmId, batchId]
      ),
      pool.query(
        `SELECT dl.*, b.name AS building, COALESCE(s.display_name, s.name) AS employee_name, ii.name AS feed_item
         FROM daily_logs dl
         JOIN batches ba ON ba.id = dl.batch_id
         LEFT JOIN buildings b ON b.id = dl.building_id
         LEFT JOIN stakeholders s ON s.id = dl.employee_id
         LEFT JOIN inventory_items ii ON ii.id = dl.feed_item_id
         WHERE ba.farm_id = $1
           AND ($2::varchar IS NULL OR dl.batch_id = $2)
         ORDER BY dl.date DESC, dl.id DESC`,
        [farmId, batchId]
      ),
      pool.query(
        `SELECT *
         FROM inventory_items
         WHERE farm_id = $1
         ORDER BY category, name`,
        [farmId]
      ),
      pool.query(
        `SELECT im.*, ii.name AS item_name, ii.category, ii.unit, b.name AS building
         FROM inventory_movements im
         JOIN inventory_items ii ON ii.id = im.item_id
         LEFT JOIN buildings b ON b.id = im.building_id
         WHERE im.farm_id = $1
           AND ($2::varchar IS NULL OR im.batch_id = $2)
         ORDER BY im.movement_date DESC, im.id DESC`,
        [farmId, batchId]
      ),
      pool.query(
        `SELECT s.*, ebc.batch_id, ebc.handled_birds, ebc.rate_per_bird, ebc.corpo_group, ebc.remarks AS compensation_remarks
         FROM stakeholders s
         LEFT JOIN employee_batch_compensations ebc ON ebc.employee_id = s.id
         WHERE s.farm_id = $1
           AND s.type = 'Employee'
           AND ($2::varchar IS NULL OR ebc.batch_id = $2)
         ORDER BY COALESCE(s.display_name, s.name), ebc.batch_id DESC NULLS LAST`,
        [farmId, batchId]
      ),
    ]);

    res.setHeader('Content-Disposition', `attachment; filename="octavio-archive${batchId ? `-${batchId}` : ''}.json"`);
    res.json({
      generatedAt: new Date().toISOString(),
      scope: batchId ? { batchId } : { farm: 'all_batches' },
      farm: farm.rows[0] || null,
      batches: batches.rows,
      loadings: loadings.rows,
      transactions: transactions.rows,
      dailyLogs: dailyLogs.rows,
      inventoryItems: inventoryItems.rows,
      inventoryMovements: inventoryMovements.rows,
      employees: employees.rows,
    });
  } catch (err) {
    console.error('Failed to create archive:', err);
    next(err);
  }
});

module.exports = router;
