require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret';

const roleAliases = {
  Admin: 'AdminOwner',
  OpManager: 'OperationManager',
  admin: 'AdminOwner',
  adminowner: 'AdminOwner',
  dataentry: 'DataEntry',
  operationmanager: 'OperationManager',
  opmanager: 'OperationManager',
  viewer: 'Viewer',
};

const roleRank = {
  Viewer: 1,
  DataEntry: 2,
  OperationManager: 3,
  AdminOwner: 4,
};

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'octavio-farm-api' });
});

function normalizeRole(role) {
  if (!role) return role;
  const compactRole = String(role).replace(/[\s_-]/g, '').toLowerCase();
  return roleAliases[role] || roleAliases[compactRole] || role;
}

function hasMinimumRole(userRole, minimumRole) {
  return (roleRank[normalizeRole(userRole)] || 0) >= (roleRank[minimumRole] || 0);
}

function toNumber(value) {
  if (value === null || value === undefined) return value;
  const numberValue = Number(value);
  return Number.isNaN(numberValue) ? value : numberValue;
}

function toDateOnly(value) {
  if (!value) return value;
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

function normalizeFundingNatureForDb(fundingNature) {
  return fundingNature === 'Revenue' ? 'Other Revenue' : fundingNature;
}

function normalizeFundingNatureForClient(fundingNature) {
  return fundingNature === 'Other Revenue' ? 'Revenue' : fundingNature;
}

function deriveTransactionType(fundingNature, explicitType) {
  if (explicitType) return explicitType;
  return normalizeFundingNatureForDb(fundingNature) === 'Other Revenue' ? 'Income' : 'Expense';
}

function hasQuantityAndUnitCost(quantity, unitCost) {
  return quantity !== '' &&
    quantity !== undefined &&
    quantity !== null &&
    unitCost !== '' &&
    unitCost !== undefined &&
    unitCost !== null;
}

function calculateAmount({ quantity, unitCost, amount, manualAmount }) {
  const parsedQuantity = quantity === '' || quantity === undefined || quantity === null ? null : Number(quantity);
  const parsedUnitCost = unitCost === '' || unitCost === undefined || unitCost === null ? null : Number(unitCost);

  if (hasQuantityAndUnitCost(quantity, unitCost)) {
    return Number((parsedQuantity * parsedUnitCost).toFixed(2));
  }

  const inputAmount = amount ?? manualAmount;
  if (inputAmount === '' || inputAmount === undefined || inputAmount === null) {
    throw new Error('Amount is required when quantity and unit cost are not both provided.');
  }

  return Number(Number(inputAmount).toFixed(2));
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function sendCsv(res, filename, rows) {
  const headers = rows.length ? Object.keys(rows[0]) : ['message'];
  const bodyRows = rows.length ? rows : [{ message: 'No records found' }];
  const csv = [
    headers.map(csvEscape).join(','),
    ...bodyRows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

async function getDefaultFarmId(client = pool) {
  const result = await client.query(
    "SELECT id FROM farms WHERE code = 'octavio' LIMIT 1"
  );

  if (result.rowCount === 0) {
    throw new Error('Default farm is not seeded. Run npm run db:seed in farm-backend.');
  }

  return result.rows[0].id;
}

async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const result = await pool.query(
      `SELECT id, farm_id, stakeholder_id, email, username, role, is_active, is_primary_owner
       FROM users
       WHERE id = $1`,
      [payload.userId]
    );

    if (result.rowCount === 0 || !result.rows[0].is_active) {
      return res.status(401).json({ error: 'Invalid user' });
    }

    req.user = {
      ...result.rows[0],
      role: normalizeRole(result.rows[0].role),
      is_primary_owner: Boolean(result.rows[0].is_primary_owner),
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireMinimumRole(minimumRole) {
  return (req, res, next) => {
    if (!hasMinimumRole(req.user.role, minimumRole)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

function requirePrimaryOwner(req, res, next) {
  if (!req.user?.is_primary_owner) {
    return res.status(403).json({ error: 'Only the primary owner can manage user accounts.' });
  }
  next();
}

async function auditLog(client, req, action, entityType, entityId, beforeData, afterData, batchId = null) {
  await client.query(
    `INSERT INTO audit_logs
       (farm_id, batch_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      req.user?.farm_id || null,
      batchId,
      req.user?.id || null,
      action,
      entityType,
      entityId == null ? null : String(entityId),
      beforeData ? JSON.stringify(beforeData) : null,
      afterData ? JSON.stringify(afterData) : null,
      req.ip,
      req.headers['user-agent'] || null,
    ]
  );
}

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

function mapTransaction(row) {
  return {
    id: row.id,
    batchId: row.batchId,
    date: toDateOnly(row.date),
    building: row.building || 'All',
    buildingScope: row.buildingScope || 'Specific',
    type: row.type,
    fundingNature: normalizeFundingNatureForClient(row.fundingNature),
    category: row.category,
    description: row.description || '',
    quantity: toNumber(row.quantity),
    unitCost: toNumber(row.unitCost),
    amount: Number(row.amount || 0),
    paidBy: row.paidBy || '',
    paidTo: row.paidTo || '',
    reference: row.reference || '',
    remarks: row.remarks || '',
    feedItemId: row.feedItemId || row.feed_item_id || null,
    feedItemName: row.feedItemName || row.feed_item_name || '',
    isVoid: Boolean(row.isVoid),
    voidReason: row.voidReason || '',
  };
}

function mapAuditLog(row) {
  return {
    id: row.id,
    batchId: row.batchId,
    actorEmail: row.actorEmail || '',
    actorUsername: row.actorUsername || '',
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    beforeData: row.beforeData || null,
    afterData: row.afterData || null,
    createdAt: row.createdAt,
  };
}

function mapEmployee(row) {
  const metadata = row.metadata || {};

  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName || row.display_name || row.name,
    phone: row.phone || '',
    email: row.email || '',
    address: row.address || '',
    isActive: row.isActive ?? row.is_active ?? true,
    position: metadata.position || '',
    hireDate: metadata.hireDate || '',
    assignedBuilding: metadata.assignedBuilding || '',
    notes: metadata.notes || '',
  };
}

function mapEmployeeCompensation(row) {
  const metadata = row.metadata || {};

  return {
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    position: metadata.position || '',
    assignedBuilding: metadata.assignedBuilding || '',
    batchId: row.batchId || null,
    handledBirds: Number(row.handledBirds || 0),
    ratePerBird: Number(row.ratePerBird || 1.5),
    corpoGroup: row.corpoGroup || '',
    remarks: row.remarks || '',
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

function mapInventoryItem(row) {
  const currentStock = Number(row.currentStock ?? row.current_stock ?? 0);
  const targetQuantity = Number(row.targetQuantity ?? row.target_quantity ?? 0);
  const reorderLevel = Number(row.reorderLevel ?? row.reorder_level ?? 0);
  const needsWarning =
    (targetQuantity > 0 && currentStock < targetQuantity)
    || (reorderLevel > 0 && currentStock <= reorderLevel);

  return {
    id: row.id,
    name: row.name,
    category: row.category,
    unit: row.unit,
    targetQuantity,
    reorderLevel,
    currentStock,
    needsWarning,
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

async function generateBatchId(client, startDate) {
  const base = startDate.replace(/-/g, '');
  const result = await client.query(
    `SELECT id
     FROM batches
     WHERE id = $1 OR id LIKE $2
     ORDER BY id DESC`,
    [base, `${base}-%`]
  );

  if (result.rowCount === 0) return base;

  const exactExists = result.rows.some(row => row.id === base);
  if (!exactExists) return base;

  return `${base}-${String(result.rowCount + 1).padStart(2, '0')}`;
}

async function getBuilding(client, buildingName) {
  if (!buildingName || buildingName === 'All') return null;

  const result = await client.query(
    'SELECT id, name FROM buildings WHERE lower(name) = lower($1) LIMIT 1',
    [buildingName]
  );

  if (result.rowCount === 0) {
    throw new Error(`Unknown building: ${buildingName}`);
  }

  return result.rows[0];
}

async function ensureStakeholder(client, farmId, name, type = 'Supplier') {
  if (!name) return null;

  const existing = await client.query(
    'SELECT id FROM stakeholders WHERE lower(name) = lower($1) LIMIT 1',
    [name]
  );

  if (existing.rowCount > 0) return existing.rows[0].id;

  const inserted = await client.query(
    `INSERT INTO stakeholders (farm_id, name, display_name, type)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [farmId, name, name, type]
  );

  return inserted.rows[0].id;
}

async function ensureCategory(client, farmId, fundingNature, categoryName) {
  const dbFundingNature = normalizeFundingNatureForDb(fundingNature);

  const existing = await client.query(
    `SELECT id
     FROM categories
     WHERE farm_id = $1
       AND funding_nature = $2
       AND lower(name) = lower($3)
     LIMIT 1`,
    [farmId, dbFundingNature, categoryName]
  );

  if (existing.rowCount > 0) return existing.rows[0].id;

  const inserted = await client.query(
    `INSERT INTO categories (farm_id, funding_nature, name)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [farmId, dbFundingNature, categoryName]
  );

  return inserted.rows[0].id;
}

function buildEmployeeMetadata(employee) {
  return {
    position: employee.position || '',
    hireDate: employee.hireDate || '',
    assignedBuilding: employee.assignedBuilding || '',
    notes: employee.notes || '',
  };
}

async function getEmployeeById(employeeId, client = pool) {
  const result = await client.query(
    `SELECT
       id,
       name,
       COALESCE(display_name, name) AS "displayName",
       phone,
       email,
       address,
       metadata,
       is_active AS "isActive"
     FROM stakeholders
     WHERE id = $1
       AND type = 'Employee'
     LIMIT 1`,
    [employeeId]
  );

  return result.rows[0] ? mapEmployee(result.rows[0]) : null;
}

function normalizeRatePerBird(value) {
  const rate = value === '' || value === undefined || value === null ? 1.5 : Number(value);

  if (!Number.isFinite(rate) || rate < 1.5 || rate > 3) {
    throw new Error('Rate per bird must be between 1.50 and 3.00.');
  }

  return Number(rate.toFixed(2));
}

function normalizeHandledBirds(value) {
  const birds = value === '' || value === undefined || value === null ? 0 : Number(value);

  if (!Number.isFinite(birds) || birds < 0) {
    throw new Error('Handled birds must be zero or greater.');
  }

  return Math.round(birds);
}

async function generateTransactionCode(client, date, buildingKey) {
  const result = await client.query(
    `INSERT INTO transaction_code_sequences
       (transaction_date, building_key, last_sequence)
     VALUES ($1, $2, 1)
     ON CONFLICT (transaction_date, building_key)
     DO UPDATE SET
       last_sequence = transaction_code_sequences.last_sequence + 1,
       updated_at = now()
     RETURNING last_sequence`,
    [date, buildingKey]
  );

  const prefix = date.replace(/-/g, '');
  const sequence = String(result.rows[0].last_sequence).padStart(3, '0');
  return `${prefix}-${buildingKey}-${sequence}`;
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
         loading_share_pct = EXCLUDED.loading_share_pct`,
      [
        batchId,
        building.id,
        startDate,
        Math.round(Number(totalChicksLoaded || 0) * share),
        Number((share * 100).toFixed(4)),
      ]
    );
  }
}

function getLoadingChicks(loading) {
  const chicks = Number(loading?.chicksLoaded || 0);
  return Number.isFinite(chicks) && chicks >= 0 ? chicks : 0;
}

function getLoadingsTotal(loadings = []) {
  if (!Array.isArray(loadings)) return 0;
  return loadings.reduce((sum, loading) => sum + getLoadingChicks(loading), 0);
}

function getLockedLoadingSharePct(chicksLoaded, totalChicksLoaded) {
  const total = Number(totalChicksLoaded || 0);
  if (!total) return 0;
  return Number(((Number(chicksLoaded || 0) / total) * 100).toFixed(4));
}

function normalizeLoadingsWithLockedShares(loadings = []) {
  if (!Array.isArray(loadings)) return [];

  const total = getLoadingsTotal(loadings);

  return loadings.map((loading) => {
    const chicksLoaded = getLoadingChicks(loading);

    return {
      ...loading,
      chicksLoaded,
      loadingSharePct: getLockedLoadingSharePct(chicksLoaded, total),
    };
  });
}

async function upsertLoadings(client, batchId, startDate, loadings = []) {
  if (!Array.isArray(loadings) || loadings.length === 0) return;

  const lockedLoadings = normalizeLoadingsWithLockedShares(loadings);

  for (const loading of lockedLoadings) {
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
         remarks = EXCLUDED.remarks`,
      [
        batchId,
        building.id,
        loading.loadingDate || startDate,
        loading.chicksLoaded,
        loading.loadingSharePct,
        loading.remarks || null,
      ]
    );
  }
}

async function getTransactions(batchId = null) {
  const params = [];
  let where = 'WHERE t.is_void = false';

  if (batchId) {
    params.push(batchId);
    where += ` AND t.batch_id = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT
       t.transaction_id AS id,
       t.batch_id AS "batchId",
       t.date,
       COALESCE(b.name, 'All') AS building,
       t.building_scope AS "buildingScope",
       t.type,
       t.funding_nature AS "fundingNature",
       COALESCE(c.name, t.category) AS category,
       t.description,
       t.quantity,
       t.unit_cost AS "unitCost",
       t.amount,
       paid_by.name AS "paidBy",
       paid_to.name AS "paidTo",
       t.reference,
       t.remarks,
       feed_im.item_id AS "feedItemId",
       feed_item.name AS "feedItemName",
       t.is_void AS "isVoid",
       t.void_reason AS "voidReason"
     FROM daily_transactions t
     LEFT JOIN buildings b ON b.id = t.building_id
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN stakeholders paid_by ON paid_by.id = t.paid_by
     LEFT JOIN stakeholders paid_to ON paid_to.id = t.paid_to
     LEFT JOIN inventory_movements feed_im
       ON (
         (feed_im.source_type = 'ledger_feed_purchase' AND feed_im.source_id = t.transaction_id)
         OR (feed_im.source_type IS NULL AND feed_im.linked_transaction_id = t.transaction_id)
       )
     LEFT JOIN inventory_items feed_item ON feed_item.id = feed_im.item_id
     ${where}
     ORDER BY t.date DESC, t.transaction_id DESC`,
    params
  );

  return result.rows.map(mapTransaction);
}

async function getTransactionById(transactionId) {
  const result = await pool.query(
    `SELECT
       t.transaction_id AS id,
       t.batch_id AS "batchId",
       t.date,
       COALESCE(b.name, 'All') AS building,
       t.building_scope AS "buildingScope",
       t.type,
       t.funding_nature AS "fundingNature",
       COALESCE(c.name, t.category) AS category,
       t.description,
       t.quantity,
       t.unit_cost AS "unitCost",
       t.amount,
       paid_by.name AS "paidBy",
       paid_to.name AS "paidTo",
       t.reference,
       t.remarks,
       feed_im.item_id AS "feedItemId",
       feed_item.name AS "feedItemName",
       t.is_void AS "isVoid",
       t.void_reason AS "voidReason"
     FROM daily_transactions t
     LEFT JOIN buildings b ON b.id = t.building_id
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN stakeholders paid_by ON paid_by.id = t.paid_by
     LEFT JOIN stakeholders paid_to ON paid_to.id = t.paid_to
     LEFT JOIN inventory_movements feed_im
       ON (
         (feed_im.source_type = 'ledger_feed_purchase' AND feed_im.source_id = t.transaction_id)
         OR (feed_im.source_type IS NULL AND feed_im.linked_transaction_id = t.transaction_id)
       )
     LEFT JOIN inventory_items feed_item ON feed_item.id = feed_im.item_id
     WHERE t.transaction_id = $1
     LIMIT 1`,
    [transactionId]
  );

  return result.rows[0] ? mapTransaction(result.rows[0]) : null;
}

async function getAuditLogs({ farmId = null, batchId = null, entityType = null, entityId = null, limit = 100 }) {
  const params = [];
  const where = [];

  if (farmId) {
    params.push(farmId);
    where.push(`a.farm_id = $${params.length}`);
  }

  if (batchId) {
    params.push(batchId);
    where.push(`a.batch_id = $${params.length}`);
  }

  if (entityType) {
    params.push(entityType);
    where.push(`a.entity_type = $${params.length}`);
  }

  if (entityId) {
    params.push(String(entityId));
    where.push(`a.entity_id = $${params.length}`);
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 250);
  params.push(safeLimit);

  const result = await pool.query(
    `SELECT
       a.id,
       a.batch_id AS "batchId",
       u.email AS "actorEmail",
       u.username AS "actorUsername",
       a.action,
       a.entity_type AS "entityType",
       a.entity_id AS "entityId",
       a.before_data AS "beforeData",
       a.after_data AS "afterData",
       a.created_at AS "createdAt"
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.actor_user_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $${params.length}`,
    params
  );

  return result.rows.map(mapAuditLog);
}

async function getReceivablesSummary(batchId) {
  const result = await pool.query(
    `WITH scoped AS (
       SELECT
         dt.*,
         COALESCE(c.name, dt.category) AS category_name,
         CASE
           WHEN dt.type = 'Reimbursement'
             OR COALESCE(c.name, dt.category) ILIKE '%reimburse%'
           THEN dt.paid_by
           ELSE dt.paid_to
         END AS counterparty_id,
         CASE
           WHEN dt.type = 'Reimbursement'
             OR COALESCE(c.name, dt.category) ILIKE '%reimburse%'
           THEN true
           ELSE false
         END AS is_reimbursement
       FROM daily_transactions dt
       LEFT JOIN categories c ON c.id = dt.category_id
       WHERE dt.batch_id = $1
         AND dt.is_void = false
         AND dt.funding_nature = 'Receivable'
     )
     SELECT
       s.id AS "stakeholderId",
       s.name AS "stakeholderName",
       COALESCE(SUM(CASE WHEN scoped.is_reimbursement THEN 0 ELSE scoped.amount END), 0) AS "totalAdvance",
       COALESCE(SUM(CASE WHEN scoped.is_reimbursement THEN scoped.amount ELSE 0 END), 0) AS "totalReimbursement",
       COALESCE(SUM(CASE WHEN scoped.is_reimbursement THEN -scoped.amount ELSE scoped.amount END), 0) AS "outstandingAdvance",
       COUNT(scoped.transaction_id)::integer AS "transactionCount",
       MAX(scoped.date) AS "lastTransactionDate"
     FROM scoped
     JOIN stakeholders s ON s.id = scoped.counterparty_id
     GROUP BY s.id, s.name
     ORDER BY "outstandingAdvance" DESC, s.name`,
    [batchId]
  );

  return result.rows.map(row => ({
    ...row,
    totalAdvance: Number(row.totalAdvance || 0),
    totalReimbursement: Number(row.totalReimbursement || 0),
    outstandingAdvance: Number(row.outstandingAdvance || 0),
    lastTransactionDate: toDateOnly(row.lastTransactionDate),
  }));
}

async function getPayablesSummary(batchId) {
  const result = await pool.query(
    `WITH scoped AS (
       SELECT
         dt.*,
         COALESCE(c.name, dt.category) AS category_name,
         CASE
           WHEN dt.type = 'Payment'
             OR COALESCE(c.name, dt.category) ILIKE '%payment%'
             OR COALESCE(c.name, dt.category) ILIKE '%paid%'
           THEN dt.paid_to
           ELSE dt.paid_by
         END AS counterparty_id,
         CASE
           WHEN dt.type = 'Payment'
             OR COALESCE(c.name, dt.category) ILIKE '%payment%'
             OR COALESCE(c.name, dt.category) ILIKE '%paid%'
           THEN true
           ELSE false
         END AS is_payment,
         CASE
           WHEN dt.funding_nature = 'CAPEX-Recoverable' THEN 'CAPEX'
           ELSE dt.funding_nature
         END AS payable_bucket
       FROM daily_transactions dt
       LEFT JOIN categories c ON c.id = dt.category_id
       WHERE dt.batch_id = $1
         AND dt.is_void = false
         AND (
           dt.funding_nature = 'Payable'
           OR (
             dt.type = 'Expense'
             AND dt.funding_nature IN ('OPEX', 'CAPEX', 'CAPEX-Recoverable')
             AND dt.paid_by IS NOT NULL
           )
         )
     )
     SELECT
       s.id AS "stakeholderId",
       s.name AS "stakeholderName",
       COALESCE(SUM(CASE WHEN NOT scoped.is_payment AND scoped.payable_bucket = 'OPEX' THEN scoped.amount ELSE 0 END), 0) AS "opexPayable",
       COALESCE(SUM(CASE WHEN NOT scoped.is_payment AND scoped.payable_bucket = 'CAPEX' THEN scoped.amount ELSE 0 END), 0) AS "capexPayable",
       COALESCE(SUM(CASE WHEN NOT scoped.is_payment AND scoped.payable_bucket = 'Payable' THEN scoped.amount ELSE 0 END), 0) AS "otherPayable",
       COALESCE(SUM(CASE WHEN scoped.is_payment THEN scoped.amount ELSE 0 END), 0) AS "totalPayment",
       COALESCE(SUM(CASE WHEN scoped.is_payment THEN 0 ELSE scoped.amount END), 0) AS "totalPayable",
       COALESCE(SUM(CASE WHEN scoped.is_payment THEN -scoped.amount ELSE scoped.amount END), 0) AS "outstandingPayable",
       COUNT(scoped.transaction_id)::integer AS "transactionCount",
       MAX(scoped.date) AS "lastTransactionDate"
     FROM scoped
     JOIN stakeholders s ON s.id = scoped.counterparty_id
     GROUP BY s.id, s.name
     ORDER BY "outstandingPayable" DESC, s.name`,
    [batchId]
  );

  return result.rows.map(row => ({
    ...row,
    opexPayable: Number(row.opexPayable || 0),
    capexPayable: Number(row.capexPayable || 0),
    otherPayable: Number(row.otherPayable || 0),
    totalPayment: Number(row.totalPayment || 0),
    totalPayable: Number(row.totalPayable || 0),
    outstandingPayable: Number(row.outstandingPayable || 0),
    lastTransactionDate: toDateOnly(row.lastTransactionDate),
  }));
}

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

async function syncBatchChickInventory(client, req, {
  farmId,
  batchId,
  startDate,
  totalChicksLoaded,
}) {
  const chicksItem = await getInventoryItemByName(client, farmId, 'DOC Chicks');
  if (!chicksItem) return;

  const quantity = Number(totalChicksLoaded || 0);
  if (quantity <= 0) {
    await client.query(
      `DELETE FROM inventory_movements
       WHERE source_type = 'batch_loading_chicks'
         AND source_id = $1
         AND item_id = $2`,
      [String(batchId), chicksItem.id]
    );
    return;
  }

  await insertInventoryMovement(client, req, {
    farmId,
    batchId,
    itemId: chicksItem.id,
    movementDate: startDate,
    movementType: 'Stock In',
    quantity,
    building: 'All',
    sourceType: 'batch_loading_chicks',
    sourceId: batchId,
    remarks: `DOC chicks loaded for batch ${batchId}`,
  });
}

function isFeedPurchase({ fundingNature, category, type }) {
  const dbFundingNature = normalizeFundingNatureForDb(fundingNature);
  return String(category || '').toLowerCase() === 'feed'
    && ['OPEX', 'CAPEX', 'CAPEX-Recoverable'].includes(dbFundingNature)
    && deriveTransactionType(fundingNature, type) === 'Expense';
}

async function syncLedgerFeedInventory(client, req, {
  farmId,
  batchId,
  transactionId,
  date,
  building,
  fundingNature,
  category,
  type,
  feedItemId,
  quantity,
  unitCost,
  amount,
  description,
  remarks,
}) {
  await client.query(
    `DELETE FROM inventory_movements
     WHERE source_type = 'ledger_feed_purchase'
       AND source_id = $1`,
    [String(transactionId)]
  );
  await client.query(
    `DELETE FROM inventory_movements
     WHERE linked_transaction_id = $1
       AND source_type IS NULL`,
    [String(transactionId)]
  );

  if (!isFeedPurchase({ fundingNature, category, type })) return;

  const feedQuantity = Number(quantity || 0);
  if (!feedItemId || feedQuantity <= 0) {
    throw new Error('Feed ledger records need a feed inventory item and quantity.');
  }

  const feedItem = await getInventoryItem(client, farmId, feedItemId);
  if (!feedItem || feedItem.category !== 'Feed') {
    throw new Error('Select a valid feed inventory item.');
  }

  await insertInventoryMovement(client, req, {
    farmId,
    batchId,
    itemId: feedItem.id,
    movementDate: date,
    movementType: 'Stock In',
    quantity: feedQuantity,
    unitCost: unitCost === '' || unitCost === undefined || unitCost === null ? null : Number(unitCost),
    amount,
    building,
    sourceType: 'ledger_feed_purchase',
    sourceId: transactionId,
    linkedTransactionId: transactionId,
    remarks: remarks || `${feedItem.name} delivery from ledger${description ? `: ${description}` : ''}`,
  });
}

async function insertLinkedLedgerTransaction(client, req, {
  farmId,
  batchId,
  date,
  building = 'All',
  fundingNature,
  category,
  description,
  quantity,
  unitCost,
  amount,
  paidBy,
  paidTo,
  reference,
  remarks,
}) {
  const dbFundingNature = normalizeFundingNatureForDb(fundingNature);
  const buildingRecord = await getBuilding(client, building);
  const buildingScope = buildingRecord ? 'Specific' : 'All';
  const buildingKey = buildingRecord ? buildingRecord.name : 'ALL';
  const categoryId = await ensureCategory(client, farmId, dbFundingNature, category);
  const paidById = await ensureStakeholder(client, farmId, paidBy, 'Owner');
  const paidToId = await ensureStakeholder(client, farmId, paidTo, 'Supplier');
  const computedAmount = calculateAmount({ quantity, unitCost, amount });
  const transactionCode = await generateTransactionCode(client, date, buildingKey);

  await client.query(
    `INSERT INTO daily_transactions
       (transaction_id, batch_id, date, building_id, building_scope, type, funding_nature,
        category, category_id, description, quantity, unit_cost, manual_amount, amount,
        paid_by, paid_to, reference, remarks, created_by_user_id)
     VALUES
       ($1, $2, $3, $4, $5, 'Expense', $6,
        $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18)`,
    [
      transactionCode,
      batchId,
      date,
      buildingRecord?.id || null,
      buildingScope,
      dbFundingNature,
      category,
      categoryId,
      description,
      quantity === '' || quantity === undefined || quantity === null ? null : quantity,
      unitCost === '' || unitCost === undefined || unitCost === null ? null : unitCost,
      hasQuantityAndUnitCost(quantity, unitCost) ? null : computedAmount,
      computedAmount,
      paidById,
      paidToId,
      reference || null,
      remarks || null,
      req.user.id,
    ]
  );

  await auditLog(client, req, 'create', 'daily_transaction', transactionCode, null, { transactionCode, description, amount: computedAmount }, batchId);

  return transactionCode;
}

async function createTransaction(req, res, batchIdFromRoute = null) {
  const {
    date,
    building = 'All',
    fundingNature,
    category,
    description,
    quantity,
    unitCost,
    amount,
    paidBy,
    paidTo,
    reference,
    remarks,
    type,
    feedItemId,
  } = req.body;

  const batchId = batchIdFromRoute || req.body.batchId || req.query.batchId;

  if (!batchId) {
    return res.status(400).json({ error: 'batchId is required' });
  }

  if (!date || !fundingNature || !category || !description) {
    return res.status(400).json({ error: 'date, fundingNature, category, and description are required' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const dbFundingNature = normalizeFundingNatureForDb(fundingNature);
    const transactionType = deriveTransactionType(fundingNature, type);
    const buildingRecord = await getBuilding(client, building);
    const buildingScope = buildingRecord ? 'Specific' : 'All';
    const buildingKey = buildingRecord ? buildingRecord.name : 'ALL';
    const categoryId = await ensureCategory(client, farmId, dbFundingNature, category);
    const paidById = await ensureStakeholder(client, farmId, paidBy, 'Owner');
    const paidToId = await ensureStakeholder(client, farmId, paidTo, 'Supplier');
    const computedAmount = calculateAmount({ quantity, unitCost, amount });
    const transactionCode = await generateTransactionCode(client, date, buildingKey);

    const result = await client.query(
      `INSERT INTO daily_transactions
         (transaction_id, batch_id, date, building_id, building_scope, type, funding_nature,
          category, category_id, description, quantity, unit_cost, manual_amount, amount,
          paid_by, paid_to, reference, remarks, created_by_user_id)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19)
       RETURNING
         transaction_id AS id,
         batch_id AS "batchId",
         date,
         building_scope AS "buildingScope",
         type,
         funding_nature AS "fundingNature",
         category,
         description,
         quantity,
         unit_cost AS "unitCost",
         amount,
         reference,
         remarks`,
      [
        transactionCode,
        batchId,
        date,
        buildingRecord?.id || null,
        buildingScope,
        transactionType,
        dbFundingNature,
        category,
        categoryId,
        description,
        quantity === '' || quantity === undefined || quantity === null ? null : quantity,
        unitCost === '' || unitCost === undefined || unitCost === null ? null : unitCost,
        hasQuantityAndUnitCost(quantity, unitCost) ? null : computedAmount,
        computedAmount,
        paidById,
        paidToId,
        reference || null,
        remarks || null,
        req.user.id,
      ]
    );

    await syncLedgerFeedInventory(client, req, {
      farmId,
      batchId,
      transactionId: transactionCode,
      date,
      building,
      fundingNature,
      category,
      type: transactionType,
      feedItemId,
      quantity,
      unitCost,
      amount: computedAmount,
      description,
      remarks,
    });

    await auditLog(client, req, 'create', 'daily_transaction', transactionCode, null, result.rows[0], batchId);
    await client.query('COMMIT');

    const saved = await getTransactionById(transactionCode);
    res.status(201).json(saved);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to create transaction:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
}

async function updateTransaction(req, res, batchId, transactionId) {
  const {
    date,
    building = 'All',
    fundingNature,
    category,
    description,
    quantity,
    unitCost,
    amount,
    paidBy,
    paidTo,
    reference,
    remarks,
    type,
    feedItemId,
  } = req.body;

  if (!date || !fundingNature || !category || !description) {
    return res.status(400).json({ error: 'date, fundingNature, category, and description are required' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const before = await client.query(
      `SELECT *
       FROM daily_transactions
       WHERE transaction_id = $1
         AND batch_id = $2
       FOR UPDATE`,
      [transactionId, batchId]
    );

    if (before.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (before.rows[0].is_void) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Voided transactions cannot be edited.' });
    }

    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const dbFundingNature = normalizeFundingNatureForDb(fundingNature);
    const transactionType = deriveTransactionType(fundingNature, type);
    const buildingRecord = await getBuilding(client, building);
    const buildingScope = buildingRecord ? 'Specific' : 'All';
    const categoryId = await ensureCategory(client, farmId, dbFundingNature, category);
    const paidById = await ensureStakeholder(client, farmId, paidBy, 'Owner');
    const paidToId = await ensureStakeholder(client, farmId, paidTo, 'Supplier');
    const computedAmount = calculateAmount({ quantity, unitCost, amount });

    const result = await client.query(
      `UPDATE daily_transactions
       SET
         date = $1,
         building_id = $2,
         building_scope = $3,
         type = $4,
         funding_nature = $5,
         category = $6,
         category_id = $7,
         description = $8,
         quantity = $9,
         unit_cost = $10,
         manual_amount = $11,
         amount = $12,
         paid_by = $13,
         paid_to = $14,
         reference = $15,
         remarks = $16,
         updated_by_user_id = $17,
         updated_at = now()
       WHERE transaction_id = $18
         AND batch_id = $19
       RETURNING *`,
      [
        date,
        buildingRecord?.id || null,
        buildingScope,
        transactionType,
        dbFundingNature,
        category,
        categoryId,
        description,
        quantity === '' || quantity === undefined || quantity === null ? null : quantity,
        unitCost === '' || unitCost === undefined || unitCost === null ? null : unitCost,
        hasQuantityAndUnitCost(quantity, unitCost) ? null : computedAmount,
        computedAmount,
        paidById,
        paidToId,
        reference || null,
        remarks || null,
        req.user.id,
        transactionId,
        batchId,
      ]
    );

    await syncLedgerFeedInventory(client, req, {
      farmId,
      batchId,
      transactionId,
      date,
      building,
      fundingNature,
      category,
      type: transactionType,
      feedItemId,
      quantity,
      unitCost,
      amount: computedAmount,
      description,
      remarks,
    });

    await auditLog(client, req, 'update', 'daily_transaction', transactionId, before.rows[0], result.rows[0], batchId);
    await client.query('COMMIT');

    const saved = await getTransactionById(transactionId);
    res.json(saved);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to update transaction:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
}

async function voidTransaction(req, res, transactionId, batchId = null) {
  const reason = (req.body?.reason || 'Voided from ledger').trim();

  if (!reason) {
    return res.status(400).json({ error: 'Void reason is required' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const params = [transactionId];
    let batchClause = '';

    if (batchId) {
      params.push(batchId);
      batchClause = `AND batch_id = $${params.length}`;
    }

    const before = await client.query(
      `SELECT *
       FROM daily_transactions
       WHERE transaction_id = $1
         ${batchClause}
       FOR UPDATE`,
      params
    );

    if (before.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (before.rows[0].is_void) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Transaction is already voided' });
    }

    const updateParams = [transactionId, reason, req.user.id];
    let updateBatchClause = '';

    if (batchId) {
      updateParams.push(batchId);
      updateBatchClause = `AND batch_id = $${updateParams.length}`;
    }

    const result = await client.query(
      `UPDATE daily_transactions
       SET is_void = true,
           void_reason = $2,
           updated_by_user_id = $3,
           updated_at = now()
       WHERE transaction_id = $1
         ${updateBatchClause}
       RETURNING *`,
      updateParams
    );

    await client.query(
      `DELETE FROM inventory_movements
       WHERE source_type = 'ledger_feed_purchase'
         AND source_id = $1`,
      [String(transactionId)]
    );
    await client.query(
      `DELETE FROM inventory_movements
       WHERE linked_transaction_id = $1
         AND source_type IS NULL`,
      [String(transactionId)]
    );

    await auditLog(client, req, 'void', 'daily_transaction', transactionId, before.rows[0], result.rows[0], before.rows[0].batch_id);
    await client.query('COMMIT');

    res.json({ message: 'Transaction voided', transactionId, reason });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to void transaction:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
}

app.post('/api/auth/login', async (req, res) => {
  const login = (req.body.login || req.body.email || req.body.username || '').trim();
  const { password } = req.body;

  if (!login || !password) {
    return res.status(400).json({ error: 'Username/email and password are required' });
  }

  try {
    const userResult = await pool.query(
      `SELECT id, farm_id, stakeholder_id, email, username, password_hash, role, is_active, is_primary_owner
       FROM users
       WHERE lower(email) = lower($1)
          OR lower(username) = lower($1)
       LIMIT 1`,
      [login]
    );

    if (userResult.rowCount === 0 || !userResult.rows[0].is_active) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = userResult.rows[0];
    const isValidPassword = await bcrypt.compare(password, user.password_hash);

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

    const normalizedRole = normalizeRole(user.role);
    const token = jwt.sign(
      { userId: user.id, role: normalizedRole, email: user.email, username: user.username },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        email: user.email,
        username: user.username || '',
        role: normalizedRole,
        isPrimaryOwner: Boolean(user.is_primary_owner),
      },
    });
  } catch (err) {
    console.error('SERVER ERROR DURING LOGIN:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({
    user: {
      email: req.user.email,
      username: req.user.username || '',
      role: req.user.role,
      stakeholderId: req.user.stakeholder_id,
      isPrimaryOwner: Boolean(req.user.is_primary_owner),
    },
  });
});

app.post('/api/auth/change-password', authenticate, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required.' });
  }

  if (String(newPassword).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }

  try {
    const userResult = await pool.query(
      'SELECT id, password_hash FROM users WHERE id = $1 AND is_active = true LIMIT 1',
      [req.user.id]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const passwordMatches = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2',
      [newHash, req.user.id]
    );

    res.json({ message: 'Password changed successfully.' });
  } catch (err) {
    console.error('Failed to change password:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users', authenticate, requirePrimaryOwner, async (req, res) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const result = await pool.query(
      `SELECT
         u.id,
         u.email,
         u.username,
         u.role,
         u.is_active AS "isActive",
         u.is_primary_owner AS "isPrimaryOwner",
         u.last_login_at AS "lastLoginAt",
         u.created_at AS "createdAt",
         u.updated_at AS "updatedAt",
         u.stakeholder_id AS "stakeholderId",
         COALESCE(s.display_name, s.name) AS "stakeholderName",
         s.type AS "stakeholderType"
       FROM users u
       LEFT JOIN stakeholders s ON s.id = u.stakeholder_id
       WHERE u.farm_id = $1
       ORDER BY u.is_primary_owner DESC, u.is_active DESC, u.role, COALESCE(u.username, u.email)`,
      [farmId]
    );

    res.json(result.rows.map((row) => ({
      ...row,
      role: normalizeRole(row.role),
      isActive: Boolean(row.isActive),
      isPrimaryOwner: Boolean(row.isPrimaryOwner),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/audit-logs', authenticate, requirePrimaryOwner, async (req, res) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    res.json(await getAuditLogs({
      farmId,
      batchId: req.query.batchId || null,
      entityType: req.query.entityType || null,
      entityId: req.query.entityId || null,
      limit: req.query.limit || 150,
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users', authenticate, requirePrimaryOwner, async (req, res) => {
  const {
    email,
    username,
    password,
    role = 'DataEntry',
    stakeholderName,
    stakeholderType = 'Employee',
  } = req.body;

  if (!email?.trim() || !password || !role) {
    return res.status(400).json({ error: 'Email, password, and role are required.' });
  }

  if (!['AdminOwner', 'OperationManager', 'DataEntry', 'Viewer'].includes(normalizeRole(role))) {
    return res.status(400).json({ error: 'Invalid role.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const stakeholderId = stakeholderName?.trim()
      ? await ensureStakeholder(client, farmId, stakeholderName.trim(), stakeholderType || 'Employee')
      : null;
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await client.query(
      `INSERT INTO users
         (farm_id, stakeholder_id, email, username, password_hash, role, is_active, is_primary_owner)
       VALUES ($1, $2, $3, $4, $5, $6, true, false)
       RETURNING id, email, username, role, is_active AS "isActive", is_primary_owner AS "isPrimaryOwner", stakeholder_id AS "stakeholderId"`,
      [
        farmId,
        stakeholderId,
        email.trim(),
        username?.trim() || null,
        passwordHash,
        normalizeRole(role),
      ]
    );

    await auditLog(client, req, 'create', 'user', result.rows[0].id, null, {
      email: result.rows[0].email,
      username: result.rows[0].username,
      role: result.rows[0].role,
    });
    await client.query('COMMIT');

    res.status(201).json({
      ...result.rows[0],
      role: normalizeRole(result.rows[0].role),
      isActive: Boolean(result.rows[0].isActive),
      isPrimaryOwner: Boolean(result.rows[0].isPrimaryOwner),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email or username already exists.' });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.patch('/api/admin/users/:id', authenticate, requirePrimaryOwner, async (req, res) => {
  const {
    email,
    username,
    password,
    role,
    isActive,
    stakeholderName,
    stakeholderType = 'Employee',
  } = req.body;
  const userId = Number(req.params.id);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const before = await client.query(
      'SELECT * FROM users WHERE id = $1 AND farm_id = $2 FOR UPDATE',
      [userId, farmId]
    );

    if (before.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found.' });
    }

    if (before.rows[0].is_primary_owner && isActive === false) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The primary owner account cannot be disabled.' });
    }

    const stakeholderId = stakeholderName?.trim()
      ? await ensureStakeholder(client, farmId, stakeholderName.trim(), stakeholderType || 'Employee')
      : before.rows[0].stakeholder_id;
    const passwordHash = password ? await bcrypt.hash(password, 10) : before.rows[0].password_hash;
    const nextRole = role ? normalizeRole(role) : normalizeRole(before.rows[0].role);

    if (!['AdminOwner', 'OperationManager', 'DataEntry', 'Viewer'].includes(nextRole)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid role.' });
    }

    const result = await client.query(
      `UPDATE users
       SET email = $1,
           username = $2,
           password_hash = $3,
           role = $4,
           stakeholder_id = $5,
           is_active = $6,
           updated_at = now()
       WHERE id = $7
         AND farm_id = $8
       RETURNING id, email, username, role, is_active AS "isActive", is_primary_owner AS "isPrimaryOwner", stakeholder_id AS "stakeholderId"`,
      [
        email?.trim() || before.rows[0].email,
        username === undefined ? before.rows[0].username : (username?.trim() || null),
        passwordHash,
        nextRole,
        stakeholderId,
        isActive === undefined ? before.rows[0].is_active : Boolean(isActive),
        userId,
        farmId,
      ]
    );

    await auditLog(client, req, 'update', 'user', userId, before.rows[0], {
      email: result.rows[0].email,
      username: result.rows[0].username,
      role: result.rows[0].role,
      isActive: result.rows[0].isActive,
    });
    await client.query('COMMIT');

    res.json({
      ...result.rows[0],
      role: normalizeRole(result.rows[0].role),
      isActive: Boolean(result.rows[0].isActive),
      isPrimaryOwner: Boolean(result.rows[0].isPrimaryOwner),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email or username already exists.' });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/admin/users/:id', authenticate, requirePrimaryOwner, async (req, res) => {
  const userId = Number(req.params.id);

  if (userId === req.user.id) {
    return res.status(400).json({ error: 'You cannot remove your own account.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const before = await client.query(
      'SELECT * FROM users WHERE id = $1 AND farm_id = $2 FOR UPDATE',
      [userId, farmId]
    );

    if (before.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found.' });
    }

    if (before.rows[0].is_primary_owner) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The primary owner account cannot be removed.' });
    }

    await client.query(
      'UPDATE users SET is_active = false, updated_at = now() WHERE id = $1',
      [userId]
    );
    await auditLog(client, req, 'disable', 'user', userId, before.rows[0], { isActive: false });
    await client.query('COMMIT');

    res.json({ message: 'User account disabled.' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/settings/export', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
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
      const params = [farmId];
      const where = ['ba.farm_id = $1'];

      if (batchId) {
        params.push(batchId);
        where.push(`dl.batch_id = $${params.length}`);
      }

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
         ORDER BY dl.date DESC, dl.id DESC`,
        params
      );

      return sendCsv(res, `octavio-daily-logs${batchId ? `-${batchId}` : ''}.csv`, result.rows);
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
           planned_flock,
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
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings/archive', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/buildings', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, loading_share_percentage AS "loadingSharePercentage"
      FROM buildings
      WHERE is_active = true
        AND name <> 'All'
      ORDER BY sort_order, name
    `);
    res.json(result.rows.map(row => ({ ...row, loadingSharePercentage: Number(row.loadingSharePercentage) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/categories', authenticate, async (req, res) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const result = await pool.query(
      `SELECT id, funding_nature AS "fundingNature", name
       FROM categories
       WHERE farm_id = $1
         AND is_active = true
       ORDER BY funding_nature, sort_order, name`,
      [farmId]
    );
    res.json(result.rows.map(row => ({
      ...row,
      fundingNature: normalizeFundingNatureForClient(row.fundingNature),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stakeholders', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, COALESCE(display_name, name) AS name, type
      FROM stakeholders
      WHERE is_active = true
      ORDER BY name
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/employees', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const result = await pool.query(
      `SELECT
         id,
         name,
         COALESCE(display_name, name) AS "displayName",
         phone,
         email,
         address,
         metadata,
         is_active AS "isActive"
       FROM stakeholders
       WHERE farm_id = $1
         AND type = 'Employee'
         AND is_active = true
       ORDER BY COALESCE(display_name, name), name`,
      [farmId]
    );

    res.json(result.rows.map(mapEmployee));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/employees', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  const {
    name,
    displayName,
    phone,
    email,
    address,
    position,
    hireDate,
    assignedBuilding,
    notes,
  } = req.body;

  if (!name?.trim()) {
    return res.status(400).json({ error: 'Employee name is required' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const existing = await client.query(
      `SELECT *
       FROM stakeholders
       WHERE farm_id = $1
         AND lower(name) = lower($2)
       LIMIT 1
       FOR UPDATE`,
      [farmId, name.trim()]
    );

    if (existing.rowCount > 0 && existing.rows[0].type !== 'Employee') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A non-employee stakeholder already uses this name.' });
    }

    const metadata = buildEmployeeMetadata({
      position,
      hireDate,
      assignedBuilding,
      notes,
    });

    let employeeId;
    let beforeData = null;

    if (existing.rowCount > 0) {
      beforeData = existing.rows[0];
      const updated = await client.query(
        `UPDATE stakeholders
         SET display_name = $1,
             phone = $2,
             email = $3,
             address = $4,
             metadata = $5,
             is_active = true
         WHERE id = $6
         RETURNING id`,
        [
          displayName || name.trim(),
          phone || null,
          email || null,
          address || null,
          JSON.stringify(metadata),
          existing.rows[0].id,
        ]
      );
      employeeId = updated.rows[0].id;
    } else {
      const inserted = await client.query(
        `INSERT INTO stakeholders
           (farm_id, name, display_name, type, phone, email, address, metadata)
         VALUES
           ($1, $2, $3, 'Employee', $4, $5, $6, $7)
         RETURNING id`,
        [
          farmId,
          name.trim(),
          displayName || name.trim(),
          phone || null,
          email || null,
          address || null,
          JSON.stringify(metadata),
        ]
      );
      employeeId = inserted.rows[0].id;
    }

    const saved = await getEmployeeById(employeeId, client);
    await auditLog(client, req, existing.rowCount > 0 ? 'update' : 'create', 'employee', employeeId, beforeData, saved);
    await client.query('COMMIT');

    res.status(existing.rowCount > 0 ? 200 : 201).json(saved);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.patch('/api/employees/:id', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  const {
    name,
    displayName,
    phone,
    email,
    address,
    position,
    hireDate,
    assignedBuilding,
    notes,
  } = req.body;

  if (!name?.trim()) {
    return res.status(400).json({ error: 'Employee name is required' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const before = await client.query(
      `SELECT *
       FROM stakeholders
       WHERE id = $1
         AND farm_id = $2
         AND type = 'Employee'
       FOR UPDATE`,
      [req.params.id, farmId]
    );

    if (before.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found' });
    }

    const duplicate = await client.query(
      `SELECT id
       FROM stakeholders
       WHERE farm_id = $1
         AND lower(name) = lower($2)
         AND id <> $3
       LIMIT 1`,
      [farmId, name.trim(), req.params.id]
    );

    if (duplicate.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Another stakeholder already uses this name.' });
    }

    const metadata = buildEmployeeMetadata({
      position,
      hireDate,
      assignedBuilding,
      notes,
    });

    await client.query(
      `UPDATE stakeholders
       SET name = $1,
           display_name = $2,
           phone = $3,
           email = $4,
           address = $5,
           metadata = $6,
           is_active = true
       WHERE id = $7`,
      [
        name.trim(),
        displayName || name.trim(),
        phone || null,
        email || null,
        address || null,
        JSON.stringify(metadata),
        req.params.id,
      ]
    );

    const saved = await getEmployeeById(req.params.id, client);
    await auditLog(client, req, 'update', 'employee', req.params.id, before.rows[0], saved);
    await client.query('COMMIT');

    res.json(saved);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/employees/:id', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const before = await client.query(
      `SELECT *
       FROM stakeholders
       WHERE id = $1
         AND farm_id = $2
         AND type = 'Employee'
       FOR UPDATE`,
      [req.params.id, farmId]
    );

    if (before.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found' });
    }

    await client.query(
      'UPDATE stakeholders SET is_active = false WHERE id = $1',
      [req.params.id]
    );
    await auditLog(client, req, 'delete', 'employee', req.params.id, before.rows[0], null);
    await client.query('COMMIT');

    res.json({ message: 'Employee archived' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/batches/:batchId/employee-compensations', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const result = await pool.query(
      `SELECT
         s.id AS "employeeId",
         COALESCE(s.display_name, s.name) AS "employeeName",
         s.metadata,
         ebc.batch_id AS "batchId",
         ebc.handled_birds AS "handledBirds",
         ebc.rate_per_bird AS "ratePerBird",
         ebc.corpo_group AS "corpoGroup",
         ebc.remarks
       FROM stakeholders s
       LEFT JOIN employee_batch_compensations ebc
         ON ebc.employee_id = s.id
        AND ebc.batch_id = $2
       WHERE s.farm_id = $1
         AND s.type = 'Employee'
         AND s.is_active = true
       ORDER BY COALESCE(s.display_name, s.name), s.name`,
      [farmId, req.params.batchId]
    );

    res.json(result.rows.map(mapEmployeeCompensation));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/batches/:batchId/employee-compensations/:employeeId', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  const client = await pool.connect();

  try {
    const handledBirds = normalizeHandledBirds(req.body.handledBirds);
    const ratePerBird = normalizeRatePerBird(req.body.ratePerBird);
    const corpoGroup = req.body.corpoGroup?.trim() || null;
    const remarks = req.body.remarks || null;

    await client.query('BEGIN');

    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const batch = await client.query(
      'SELECT id FROM batches WHERE id = $1 AND farm_id = $2',
      [req.params.batchId, farmId]
    );

    if (batch.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Batch not found' });
    }

    const employee = await client.query(
      `SELECT id
       FROM stakeholders
       WHERE id = $1
         AND farm_id = $2
         AND type = 'Employee'
         AND is_active = true`,
      [req.params.employeeId, farmId]
    );

    if (employee.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found' });
    }

    const before = await client.query(
      `SELECT *
       FROM employee_batch_compensations
       WHERE batch_id = $1
         AND employee_id = $2
       FOR UPDATE`,
      [req.params.batchId, req.params.employeeId]
    );

    const result = await client.query(
      `INSERT INTO employee_batch_compensations
         (farm_id, batch_id, employee_id, handled_birds, rate_per_bird, corpo_group, remarks, created_by_user_id, updated_by_user_id)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       ON CONFLICT (batch_id, employee_id)
       DO UPDATE SET
         handled_birds = EXCLUDED.handled_birds,
         rate_per_bird = EXCLUDED.rate_per_bird,
         corpo_group = EXCLUDED.corpo_group,
         remarks = EXCLUDED.remarks,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = now()
       RETURNING *`,
      [
        farmId,
        req.params.batchId,
        req.params.employeeId,
        handledBirds,
        ratePerBird,
        corpoGroup,
        remarks,
        req.user.id,
      ]
    );

    await auditLog(
      client,
      req,
      before.rowCount > 0 ? 'update' : 'create',
      'employee_batch_compensation',
      `${req.params.batchId}:${req.params.employeeId}`,
      before.rows[0] || null,
      result.rows[0],
      req.params.batchId
    );
    await client.query('COMMIT');

    const saved = await pool.query(
      `SELECT
         s.id AS "employeeId",
         COALESCE(s.display_name, s.name) AS "employeeName",
         s.metadata,
         ebc.batch_id AS "batchId",
         ebc.handled_birds AS "handledBirds",
         ebc.rate_per_bird AS "ratePerBird",
         ebc.corpo_group AS "corpoGroup",
         ebc.remarks
       FROM employee_batch_compensations ebc
       JOIN stakeholders s ON s.id = ebc.employee_id
       WHERE ebc.batch_id = $1
         AND ebc.employee_id = $2`,
      [req.params.batchId, req.params.employeeId]
    );

    res.json(mapEmployeeCompensation(saved.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/batches/:batchId/employee-assignments', authenticate, async (req, res) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const result = await pool.query(
      `SELECT
         s.id AS "employeeId",
         COALESCE(s.display_name, s.name) AS "employeeName",
         s.metadata,
         COALESCE(ebc.handled_birds, 0) AS "handledBirds",
         COALESCE(bbl.chicks_loaded, 0) AS "buildingChicksLoaded"
       FROM stakeholders s
       LEFT JOIN employee_batch_compensations ebc
         ON ebc.employee_id = s.id
        AND ebc.batch_id = $2
       LEFT JOIN buildings b
         ON lower(b.name) = lower(s.metadata->>'assignedBuilding')
       LEFT JOIN batch_building_loadings bbl
         ON bbl.batch_id = $2
        AND bbl.building_id = b.id
       WHERE s.farm_id = $1
         AND s.type = 'Employee'
         AND s.is_active = true
       ORDER BY COALESCE(s.metadata->>'assignedBuilding', ''), COALESCE(s.display_name, s.name), s.name`,
      [farmId, req.params.batchId]
    );

    res.json(result.rows.map((row) => {
      const metadata = row.metadata || {};

      return {
        employeeId: row.employeeId,
        employeeName: row.employeeName,
        assignedBuilding: metadata.assignedBuilding || '',
        handledBirds: Number(row.handledBirds || 0),
        buildingChicksLoaded: Number(row.buildingChicksLoaded || 0),
      };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/batches', authenticate, async (req, res) => {
  try {
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
      ORDER BY start_date DESC
    `);

    res.json(result.rows.map(mapBatch));
  } catch (err) {
    console.error('Failed to fetch batches:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/batches/active', authenticate, async (req, res) => {
  try {
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
      ORDER BY start_date DESC
      LIMIT 1
    `);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'No active batch found' });
    }

    res.json(mapBatch(result.rows[0]));
  } catch (err) {
    console.error('Failed to fetch active batch:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/batches', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
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
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.patch('/api/batches/:id', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
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
    await client.query('COMMIT');

    res.json(mapBatch(result.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to update batch:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/batches/:id', authenticate, requireMinimumRole('AdminOwner'), async (req, res) => {
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
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/batches/:batchId/loadings', authenticate, async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/batches/:batchId/loadings', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
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
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/transactions', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  try {
    res.json(await getTransactions(req.query.batchId || null));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/batches/:batchId/transactions', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  try {
    res.json(await getTransactions(req.params.batchId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/transactions', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  await createTransaction(req, res);
});

app.post('/api/batches/:batchId/transactions', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  await createTransaction(req, res, req.params.batchId);
});

app.patch('/api/batches/:batchId/transactions/:id', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  await updateTransaction(req, res, req.params.batchId, req.params.id);
});

app.post('/api/batches/:batchId/transactions/:id/void', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  await voidTransaction(req, res, req.params.id, req.params.batchId);
});

app.delete('/api/transactions/:id', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  await voidTransaction(req, res, req.params.id);
});

app.get('/api/batches/:batchId/audit-logs', authenticate, requirePrimaryOwner, async (req, res) => {
  try {
    res.json(await getAuditLogs({
      farmId: req.user.farm_id || await getDefaultFarmId(),
      batchId: req.params.batchId,
      entityType: req.query.entityType || null,
      entityId: req.query.entityId || null,
      limit: req.query.limit || 100,
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/transactions/:id/audit-logs', authenticate, requirePrimaryOwner, async (req, res) => {
  try {
    res.json(await getAuditLogs({
      farmId: req.user.farm_id || await getDefaultFarmId(),
      entityType: 'daily_transaction',
      entityId: req.params.id,
      limit: req.query.limit || 100,
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/batches/:batchId/opex-summary', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT category, total_amount AS "totalAmount"
       FROM vw_batch_opex_summary
       WHERE batch_id = $1
       ORDER BY category`,
      [req.params.batchId]
    );
    res.json(result.rows.map(row => ({ ...row, totalAmount: Number(row.totalAmount || 0) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/batches/:batchId/capex-summary', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT category, total_amount AS "totalAmount"
       FROM vw_batch_capex_summary
       WHERE batch_id = $1
       ORDER BY category`,
      [req.params.batchId]
    );
    res.json(result.rows.map(row => ({ ...row, totalAmount: Number(row.totalAmount || 0) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/batches/:batchId/receivables-summary', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  try {
    res.json(await getReceivablesSummary(req.params.batchId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/batches/:batchId/payables-summary', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  try {
    res.json(await getPayablesSummary(req.params.batchId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/inventory/items', authenticate, async (req, res) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    res.json(await getInventoryItems(farmId, req.query.category || null));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/inventory/items', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
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

app.patch('/api/inventory/items/:id', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
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

app.get('/api/inventory/movements', authenticate, async (req, res) => {
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

app.post('/api/inventory/movements', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
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

app.get('/api/logs', authenticate, async (req, res) => {
  try {
    const params = [];
    const where = [];

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
       LEFT JOIN buildings b ON l.building_id = b.id
       LEFT JOIN stakeholders s ON s.id = l.employee_id
       LEFT JOIN inventory_items ii ON ii.id = l.feed_item_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY l.date DESC, l.id DESC`,
      params
    );

    res.json(result.rows.map(mapDailyLog));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logs', authenticate, requireMinimumRole('DataEntry'), async (req, res) => {
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
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/logs/:id', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const before = await client.query(
      `SELECT
         dl.*,
         b.name AS building,
         COALESCE(s.display_name, s.name) AS employee_name
       FROM daily_logs dl
       LEFT JOIN buildings b ON b.id = dl.building_id
       LEFT JOIN stakeholders s ON s.id = dl.employee_id
       WHERE dl.id = $1
       FOR UPDATE`,
      [req.params.id]
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
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

const keepAliveUrl = process.env.KEEP_ALIVE_URL;
const keepAliveIntervalMinutes = Number(process.env.KEEP_ALIVE_INTERVAL_MINUTES || 14);

if (keepAliveUrl && keepAliveIntervalMinutes > 0) {
  const keepAliveIntervalMs = keepAliveIntervalMinutes * 60 * 1000;

  setInterval(async () => {
    try {
      const response = await fetch(keepAliveUrl);
      console.log(`Keep-alive ping ${response.status} -> ${keepAliveUrl}`);
    } catch (err) {
      console.error(`Keep-alive ping failed: ${err.message}`);
    }
  }, keepAliveIntervalMs);

  console.log(`Keep-alive enabled every ${keepAliveIntervalMinutes} minutes.`);
}
