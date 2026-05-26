require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { parseQuickEntryWithAi } = require('./lib/quickEntryAiParser');
const { createFlockOpsReply } = require('./lib/flockOpsAi');

const app = express();

app.use(cors());
app.use(express.json({ limit: '15mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET is required in production.');
}

if (!JWT_SECRET) {
  console.warn('JWT_SECRET is not set. Using development-only signing secret.');
}

const JWT_SIGNING_SECRET = JWT_SECRET || 'dev-only-secret';

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

app.get('/api/public/current-batch', async (req, res) => {
  try {
    const snapshot = await getCurrentBatchSnapshot();

    if (!snapshot) {
      return res.status(404).json({ error: 'No current batch found.' });
    }

    res.json(snapshot);
  } catch (err) {
    console.error('Failed to fetch public current batch snapshot:', err);
    res.status(500).json({ error: err.message });
  }
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
    const payload = jwt.verify(token, JWT_SIGNING_SECRET);
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
    return res.status(403).json({ error: 'Only admin.roland can perform this action.' });
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

const CORPO_GROUP_PREFIX = 'employees:';

function parseCorpoGroupIds(corpoGroup) {
  if (!corpoGroup?.startsWith(CORPO_GROUP_PREFIX)) return [];

  return corpoGroup
    .slice(CORPO_GROUP_PREFIX.length)
    .split(',')
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));
}

function isEmployeePaySheetName(name) {
  const normalized = String(name || '').trim().toLowerCase();
  return normalized && !['others', 'viewer', 'viewers'].includes(normalized);
}

function buildEmployeePaySummaryRows(compensationRows, transactionRows, dailyLogRows) {
  const parent = new Map();
  const mortalityByEmployee = new Map();

  dailyLogRows.forEach((row) => {
    const employeeId = Number(row.employeeId);
    if (!Number.isFinite(employeeId)) return;
    mortalityByEmployee.set(employeeId, Number(row.mortality || 0));
  });

  const rows = compensationRows
    .map(mapEmployeeCompensation)
    .filter((employee) => isEmployeePaySheetName(employee.employeeName));

  rows.forEach((row) => parent.set(row.employeeId, row.employeeId));

  const find = (id) => {
    const current = parent.get(id) ?? id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };

  const union = (left, right) => {
    if (!parent.has(left) || !parent.has(right)) return;
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };

  rows.forEach((row) => {
    parseCorpoGroupIds(row.corpoGroup).forEach((otherId) => union(row.employeeId, otherId));
  });

  const groups = new Map();

  rows.forEach((row) => {
    const key = find(row.employeeId);
    const mortality = mortalityByEmployee.get(row.employeeId) || 0;
    const grossHandledBirds = Number(row.handledBirds || 0);
    const netHandledBirds = Math.max(grossHandledBirds - mortality, 0);
    const group = groups.get(key) || { netHandledBirds: 0, members: [] };

    group.netHandledBirds += netHandledBirds;
    group.members.push(row.employeeId);
    groups.set(key, group);
  });

  const getNames = (row) => new Set(
    [row.employeeName, row.name, row.displayName]
      .filter(Boolean)
      .map((name) => String(name).trim())
  );

  const hasName = (names, ...values) => values.some((value) => names.has(String(value || '').trim()));

  return rows.map((row) => {
    const names = getNames(row);
    const summary = transactionRows.reduce((total, tx) => {
      const amount = Number(tx.amount || 0);

      if (tx.fundingNature === 'Receivable' && tx.category === 'Cash Advance' && hasName(names, tx.paidTo, tx.paidToDisplayName)) {
        total.cashAdvance += amount;
      }

      if (
        tx.fundingNature === 'Receivable'
        && (tx.type === 'Reimbursement' || tx.category === 'Reimbursement')
        && hasName(names, tx.paidBy, tx.paidByDisplayName)
      ) {
        total.reimbursement += amount;
      }

      if (tx.fundingNature === 'OPEX' && tx.category === 'Labor' && hasName(names, tx.paidTo, tx.paidToDisplayName)) {
        total.laborPaid += amount;
      }

      return total;
    }, {
      cashAdvance: 0,
      reimbursement: 0,
      laborPaid: 0,
    });

    const group = groups.get(find(row.employeeId));
    const mortality = mortalityByEmployee.get(row.employeeId) || 0;
    const grossHandledBirds = Number(row.handledBirds || 0);
    const netHandledBirds = Math.max(grossHandledBirds - mortality, 0);
    const memberCount = group?.members.length || 1;
    const poolBirds = memberCount > 1 ? group.netHandledBirds : netHandledBirds;
    const payableBirds = memberCount > 1 ? poolBirds / memberCount : netHandledBirds;
    const cycleIncome = payableBirds * Number(row.ratePerBird || 1.5);
    const outstandingAdvance = summary.cashAdvance - summary.reimbursement;
    const remainingCyclePay = cycleIncome - summary.laborPaid;
    const netPayable = remainingCyclePay - outstandingAdvance;

    return {
      ...row,
      grossHandledBirds,
      mortality,
      netHandledBirds,
      poolBirds,
      payableBirds,
      memberCount,
      cycleIncome,
      cashAdvance: summary.cashAdvance,
      reimbursement: summary.reimbursement,
      laborPaid: summary.laborPaid,
      outstandingAdvance,
      remainingCyclePay,
      netPayable,
    };
  });
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

const DEFAULT_CHICKEN_SALES_ROWS = [
  ['SQ', 132, 125],
  ['US', 140, 133],
  ['PS1', 148, 145],
  ['PS2', 148, 145],
  ['PS3', 148, 145],
  ['PS4', 148, 145],
  ['OS1', 144, 141],
  ['OS2', 144, 141],
  ['OS3', 142, 137],
  ['OS4', 142, 137],
  ['C1', 138, 135],
  ['C2', 138, 135],
].map(([item, basePricePerKg, finalRate], index) => ({
  item,
  basePricePerKg,
  harvest1Birds: 0,
  harvest1Kilos: 0,
  harvest2Birds: 0,
  harvest2Kilos: 0,
  harvest3Birds: 0,
  harvest3Kilos: 0,
  finalRate,
  notes: '',
  sortOrder: index + 1,
}));

const DEFAULT_BYPRODUCT_ROWS = [
  ['GZ(Gizzard)', 53, 116],
  ['LV(Liver)', 121, 121],
  ['FT(Feet)', 53, 53],
  ['HD(Head)', 28, 28],
  ['SI(Small Intestine)', 53, 53],
  ['LI(Large Intestine)', 121, 63],
  ['CRPs(Crops)', 53, 53],
  ['PV(Provent)', 63, 63],
  ['FA(Fats)', 43, 43],
  ['SP(Spleen)', 53, 53],
  ['RI(R. Intestine)', 58, 58],
  ['TRA(Tranchea)', 23, 23],
].map(([item, originalRate, finalRate], index) => ({
  item,
  originalRate,
  harvest1Qty: 0,
  harvest1Sales: 0,
  harvest2Qty: 0,
  harvest2Sales: 0,
  harvest3Qty: 0,
  harvest3Sales: 0,
  finalRate,
  notes: '',
  sortOrder: index + 1,
}));

const DEFAULT_FINANCING_ROWS = [
  ['Feeds Booster', 'Feed'],
  ['Feeds Starter', 'Feed'],
  ['Feeds Grower', 'Feed'],
  ['DOCs', 'DOC'],
  ['Medicines', 'Medicine'],
  ['Paper', 'Brooding Paper'],
].map(([item, category], index) => ({
  item,
  category,
  quantity: '',
  unitCost: '',
  amount: '',
  notes: '',
  sortOrder: index + 1,
}));

function toFiniteNumber(value, fallback = 0) {
  if (value === '' || value === undefined || value === null) return fallback;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function toNullableFiniteNumber(value) {
  if (value === '' || value === undefined || value === null) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function roundMoney(value) {
  return Number(toFiniteNumber(value).toFixed(2));
}

function addDays(dateText, days) {
  if (!dateText) return '';
  const date = new Date(`${dateText}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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

function getFinancingAmount(row) {
  const explicitAmount = toNullableFiniteNumber(row.amount);
  if (explicitAmount !== null) return explicitAmount;

  const quantity = toNullableFiniteNumber(row.quantity);
  const unitCost = toNullableFiniteNumber(row.unitCost);
  if (quantity !== null && unitCost !== null) return quantity * unitCost;

  return 0;
}

function calculateHarvestSummary(report) {
  const events = (report.harvestEvents || []).map(mapHarvestEvent).sort((a, b) => a.harvestOrder - b.harvestOrder);
  const chickenRows = (report.chickenSales || []).map(mapHarvestChickenSale);
  const byproductRows = (report.byproductSales || []).map(mapHarvestByproduct);
  const financingRows = (report.financingItems || []).map(mapHarvestFinancingItem);
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
  const financingTotal = financingRows.reduce((sum, row) => sum + getFinancingAmount(row), 0);
  const netProceeds = totals.netSales - financingTotal;

  return {
    perHarvest,
    totals: {
      ...totals,
      kilos: Number(totals.kilos.toFixed(3)),
      byproductQty: Number(totals.byproductQty.toFixed(3)),
      financingTotal: roundMoney(financingTotal),
      netProceeds: roundMoney(netProceeds),
      netProceedsPerBird: totals.birds > 0 ? Number((netProceeds / totals.birds).toFixed(4)) : 0,
    },
  };
}

function buildHarvestReportResponse(reportRow, batchRow, detailRows = {}) {
  const report = {
    id: reportRow?.id || null,
    batchId: reportRow?.batch_id || batchRow?.id || null,
    sourceFilename: reportRow?.source_filename || '',
    status: reportRow?.status || 'Draft',
    docAddOnRatePerBird: toFiniteNumber(reportRow?.doc_add_on_rate_per_bird, 3),
    truckingFeePerBird: toFiniteNumber(reportRow?.trucking_fee_per_bird, 2.7),
    notes: reportRow?.notes || '',
    ledgerTransactionIds: reportRow?.ledger_transaction_ids || [],
    postedAt: reportRow?.posted_at || null,
    harvestEvents: detailRows.harvestEvents || getDefaultHarvestEvents(batchRow),
    chickenSales: detailRows.chickenSales?.length ? detailRows.chickenSales : DEFAULT_CHICKEN_SALES_ROWS,
    byproductSales: detailRows.byproductSales?.length ? detailRows.byproductSales : DEFAULT_BYPRODUCT_ROWS,
    financingItems: detailRows.financingItems?.length ? detailRows.financingItems : DEFAULT_FINANCING_ROWS,
  };

  return {
    ...report,
    summary: calculateHarvestSummary(report),
  };
}

function buildHarvestProductionSummary(report) {
  if (!report) return null;

  const summary = report.summary || calculateHarvestSummary(report);
  const totals = summary.totals || {};
  const birds = Number(totals.birds || 0);
  const kilos = Number(totals.kilos || 0);
  const perHarvest = (summary.perHarvest || []).map((row) => {
    const harvestBirds = Number(row.birds || 0);
    const harvestKilos = Number(row.kilos || 0);

    return {
      harvestOrder: Number(row.harvestOrder || 0),
      harvestDate: toDateOnly(row.harvestDate) || '',
      birds: harvestBirds,
      kilos: harvestKilos,
      averageWeightKg: harvestBirds > 0 ? Number((harvestKilos / harvestBirds).toFixed(3)) : null,
    };
  });

  return {
    reportId: report.id,
    batchId: report.batchId,
    status: report.status || 'Draft',
    postedAt: report.postedAt || null,
    hasReport: Boolean(report.id),
    hasActualSales: birds > 0 || kilos > 0,
    lastHarvestDate: perHarvest.reduce((latest, row) => {
      if (!row.harvestDate) return latest;
      if (!latest || row.harvestDate > latest) return row.harvestDate;
      return latest;
    }, ''),
    totals: {
      birds,
      kilos,
      averageWeightKg: birds > 0 ? Number((kilos / birds).toFixed(3)) : null,
    },
    perHarvest,
  };
}

async function getHarvestProductionSummary(client, farmId, batchId) {
  const report = await getHarvestReport(client, farmId, batchId);
  return buildHarvestProductionSummary(report);
}

async function getHarvestReport(client, farmId, batchId) {
  const batch = await client.query(
    `SELECT
       id,
       start_date AS "startDate",
       target_harvest_date AS "targetHarvestDate",
       actual_harvest_end_date AS "actualHarvestEndDate"
     FROM batches
     WHERE id = $1
       AND farm_id = $2
     LIMIT 1`,
    [batchId, farmId]
  );

  if (batch.rowCount === 0) return null;

  const report = await client.query(
    `SELECT *
     FROM harvest_reports
     WHERE batch_id = $1
       AND farm_id = $2
     LIMIT 1`,
    [batchId, farmId]
  );

  if (report.rowCount === 0) {
    return buildHarvestReportResponse(null, batch.rows[0]);
  }

  const reportId = report.rows[0].id;
  const [events, chickenSales, byproductSales, financingItems] = await Promise.all([
    client.query(
      `SELECT id, harvest_order AS "harvestOrder", harvest_date AS "harvestDate", permit_shipping AS "permitShipping", tolling_fee AS "tollingFee", remarks
       FROM harvest_report_events
       WHERE report_id = $1
       ORDER BY harvest_order`,
      [reportId]
    ),
    client.query(
      `SELECT
         id,
         sort_order AS "sortOrder",
         item,
         base_price_per_kg AS "basePricePerKg",
         harvest1_birds AS "harvest1Birds",
         harvest1_kilos AS "harvest1Kilos",
         harvest2_birds AS "harvest2Birds",
         harvest2_kilos AS "harvest2Kilos",
         harvest3_birds AS "harvest3Birds",
         harvest3_kilos AS "harvest3Kilos",
         final_rate AS "finalRate",
         notes
       FROM harvest_chicken_sales
       WHERE report_id = $1
       ORDER BY sort_order, id`,
      [reportId]
    ),
    client.query(
      `SELECT
         id,
         sort_order AS "sortOrder",
         item,
         original_rate AS "originalRate",
         harvest1_qty AS "harvest1Qty",
         harvest1_sales AS "harvest1Sales",
         harvest2_qty AS "harvest2Qty",
         harvest2_sales AS "harvest2Sales",
         harvest3_qty AS "harvest3Qty",
         harvest3_sales AS "harvest3Sales",
         final_rate AS "finalRate",
         notes
       FROM harvest_byproduct_sales
       WHERE report_id = $1
       ORDER BY sort_order, id`,
      [reportId]
    ),
    client.query(
      `SELECT
         id,
         sort_order AS "sortOrder",
         item,
         category,
         quantity,
         unit_cost AS "unitCost",
         amount,
         notes
       FROM harvest_financing_items
       WHERE report_id = $1
       ORDER BY sort_order, id`,
      [reportId]
    ),
  ]);

  return buildHarvestReportResponse(report.rows[0], batch.rows[0], {
    harvestEvents: events.rows.map(mapHarvestEvent),
    chickenSales: chickenSales.rows.map(mapHarvestChickenSale),
    byproductSales: byproductSales.rows.map(mapHarvestByproduct),
    financingItems: financingItems.rows.map(mapHarvestFinancingItem),
  });
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

async function getTransactions(batchId = null, farmId = null) {
  const params = [];
  const where = ['t.is_void = false'];

  if (farmId) {
    params.push(farmId);
    where.push(`ba.farm_id = $${params.length}`);
  }

  if (batchId) {
    params.push(batchId);
    where.push(`t.batch_id = $${params.length}`);
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
      JOIN batches ba ON ba.id = t.batch_id
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
      WHERE ${where.join(' AND ')}
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

async function getReceivablesSummary(batchId, farmId) {
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
        JOIN batches b ON b.id = dt.batch_id
        LEFT JOIN categories c ON c.id = dt.category_id
        WHERE dt.batch_id = $1
          AND b.farm_id = $2
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
      WHERE s.farm_id = $2
      GROUP BY s.id, s.name
      ORDER BY "outstandingAdvance" DESC, s.name`,
    [batchId, farmId]
  );

  return result.rows.map(row => ({
    ...row,
    totalAdvance: Number(row.totalAdvance || 0),
    totalReimbursement: Number(row.totalReimbursement || 0),
    outstandingAdvance: Number(row.outstandingAdvance || 0),
    lastTransactionDate: toDateOnly(row.lastTransactionDate),
  }));
}

async function getPayablesSummary(batchId, farmId) {
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
        JOIN batches b ON b.id = dt.batch_id
        LEFT JOIN categories c ON c.id = dt.category_id
        WHERE dt.batch_id = $1
          AND b.farm_id = $2
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
      WHERE s.farm_id = $2
      GROUP BY s.id, s.name
      ORDER BY "outstandingPayable" DESC, s.name`,
    [batchId, farmId]
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
  const paidToRole = (category === 'Cash Advance' || category === 'Labor') ? 'Employee' : 'Supplier';
  const paidByRole = (category === 'Reimbursement' && (fundingNature === 'Receivable' || dbFundingNature === 'Receivable')) ? 'Employee' : 'Owner';
  const paidById = await ensureStakeholder(client, farmId, paidBy, paidByRole);
  const paidToId = await ensureStakeholder(client, farmId, paidTo, paidToRole);
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

async function insertHarvestLedgerTransaction(client, req, {
  farmId,
  batchId,
  date,
  type,
  fundingNature,
  category,
  description,
  quantity = null,
  unitCost = null,
  amount,
  reference,
  remarks,
}) {
  const dbFundingNature = normalizeFundingNatureForDb(fundingNature);
  const categoryId = await ensureCategory(client, farmId, dbFundingNature, category);
  const computedAmount = calculateAmount({ quantity, unitCost, amount });
  const transactionCode = await generateTransactionCode(client, date, 'HRV');

  await client.query(
    `INSERT INTO daily_transactions
       (transaction_id, batch_id, date, building_id, building_scope, type, funding_nature,
        category, category_id, description, quantity, unit_cost, manual_amount, amount,
        paid_by, paid_to, reference, remarks, created_by_user_id)
     VALUES
       ($1, $2, $3, NULL, 'All', $4, $5,
        $6, $7, $8, $9, $10, $11, $12,
        NULL, NULL, $13, $14, $15)`,
    [
      transactionCode,
      batchId,
      date,
      type,
      dbFundingNature,
      category,
      categoryId,
      description,
      quantity === '' || quantity === undefined || quantity === null ? null : quantity,
      unitCost === '' || unitCost === undefined || unitCost === null ? null : unitCost,
      hasQuantityAndUnitCost(quantity, unitCost) ? null : computedAmount,
      computedAmount,
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
    const paidToRole = (category === 'Cash Advance' || category === 'Labor') ? 'Employee' : 'Supplier';
    const paidByRole = (category === 'Reimbursement' && (fundingNature === 'Receivable' || dbFundingNature === 'Receivable')) ? 'Employee' : 'Owner';
    const paidById = await ensureStakeholder(client, farmId, paidBy, paidByRole);
    const paidToId = await ensureStakeholder(client, farmId, paidTo, paidToRole);
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
    const paidToRole = (category === 'Cash Advance' || category === 'Labor') ? 'Employee' : 'Supplier';
    const paidByRole = (category === 'Reimbursement' && (fundingNature === 'Receivable' || dbFundingNature === 'Receivable')) ? 'Employee' : 'Owner';
    const paidById = await ensureStakeholder(client, farmId, paidBy, paidByRole);
    const paidToId = await ensureStakeholder(client, farmId, paidTo, paidToRole);
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
      JWT_SIGNING_SECRET,
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

  const normalizedRole = normalizeRole(role);

  if (!['AdminOwner', 'OperationManager', 'DataEntry', 'Viewer'].includes(normalizedRole)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const effectiveStakeholderType = normalizedRole === 'Viewer' ? 'Other' : (stakeholderType || 'Employee');
    const stakeholderId = stakeholderName?.trim()
      ? await ensureStakeholder(client, farmId, stakeholderName.trim(), effectiveStakeholderType)
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
        normalizedRole,
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

    const passwordHash = password ? await bcrypt.hash(password, 10) : before.rows[0].password_hash;
    const nextRole = role ? normalizeRole(role) : normalizeRole(before.rows[0].role);

    if (!['AdminOwner', 'OperationManager', 'DataEntry', 'Viewer'].includes(nextRole)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid role.' });
    }

    const effectiveStakeholderType = nextRole === 'Viewer' ? 'Other' : (stakeholderType || 'Employee');
    const stakeholderId = stakeholderName?.trim()
      ? await ensureStakeholder(client, farmId, stakeholderName.trim(), effectiveStakeholderType)
      : before.rows[0].stakeholder_id;

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

  const before = await client.query('SELECT id FROM batches WHERE id = $1', [batchId]);

  await client.query(
    `INSERT INTO batches
       (id, farm_id, start_date, target_harvest_date, actual_harvest_end_date, status,
        total_chicks_loaded, planned_flock, target_feed_kg, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id)
     DO UPDATE SET
       farm_id = EXCLUDED.farm_id,
       start_date = EXCLUDED.start_date,
       target_harvest_date = EXCLUDED.target_harvest_date,
       actual_harvest_end_date = EXCLUDED.actual_harvest_end_date,
       status = EXCLUDED.status,
       total_chicks_loaded = EXCLUDED.total_chicks_loaded,
       planned_flock = EXCLUDED.planned_flock,
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
      Math.round(getImportNumber(row, 'planned_flock', 'plannedFlock') || 0),
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
  const before = await client.query(
    'SELECT id FROM batch_building_loadings WHERE batch_id = $1 AND building_id = $2',
    [batchId, building.id]
  );

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
      getImportDate(row, 'loading_date', 'loadingDate') || new Date().toISOString().slice(0, 10),
      Math.round(getImportNumber(row, 'chicks_loaded', 'chicksLoaded') || 0),
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
      'SELECT id FROM stakeholders WHERE lower(name) = lower($1) LIMIT 1',
      [name]
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
    const originalEmployeeId = getImportNumber(row, 'employee_id');
    const employeeId = originalEmployeeId && employeeIdMap.has(Number(originalEmployeeId))
      ? employeeIdMap.get(Number(originalEmployeeId))
      : await ensureStakeholder(client, farmId, getImportText(row, 'employee', 'employee_name'), 'Employee');
    const originalFeedItemId = getImportNumber(row, 'feed_item_id');
    let feedItemId = originalFeedItemId && itemIdMap.has(Number(originalFeedItemId))
      ? itemIdMap.get(Number(originalFeedItemId))
      : null;

    if (!feedItemId && getImportText(row, 'feed_item')) {
      feedItemId = await upsertImportedInventoryItem(client, farmId, {
        name: getImportText(row, 'feed_item'),
        category: 'Feed',
        unit: 'sacks',
      }, createImportStats('feed item'), itemIdMap);
    }

    if (!employeeId) {
      stats.skipped += 1;
      addImportWarning(stats, 'Skipped daily log row without an employee.');
      continue;
    }

    const originalId = getImportNumber(row, 'id');
    const existing = originalId
      ? await client.query('SELECT id FROM daily_logs WHERE id = $1', [originalId])
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
             updated_at = now()
         WHERE id = $12`,
        [...values, originalId]
      );
      stats.updated += 1;
      continue;
    }

    if (originalId) {
      await client.query(
        `INSERT INTO daily_logs
           (id, batch_id, date, building_id, employee_id, handled_birds_snapshot,
            feed_item_id, feed_consumed, mortality, average_weight_g, remarks, created_by_user_id)
         VALUES ($12, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [...values, originalId]
      );
    } else {
      await client.query(
        `INSERT INTO daily_logs
           (batch_id, date, building_id, employee_id, handled_birds_snapshot,
            feed_item_id, feed_consumed, mortality, average_weight_g, remarks, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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

app.post('/api/settings/import', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  const { importType, content, filename } = req.body || {};

  if (!importType || !content) {
    return res.status(400).json({ error: 'Import type and file content are required.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const itemIdMap = new Map();
    const employeeIdMap = new Map();
    let summary;

    if (importType === 'batch_archive') {
      summary = await importBatchArchive(client, req, farmId, JSON.parse(content));
    } else {
      const rows = parseCsvRows(content);
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

    await auditLog(client, req, 'import', 'settings_file', filename || importType, null, { importType, summary });
    await client.query('COMMIT');
    res.json({ message: 'Import complete.', importType, filename: filename || '', summary });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Failed to import settings data:', err);
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
         AND lower(COALESCE(display_name, name)) NOT IN ('others', 'viewer', 'viewers')
         AND NOT EXISTS (
           SELECT 1
           FROM users u
           WHERE u.stakeholder_id = stakeholders.id
             AND u.role = 'Viewer'
         )
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

app.patch('/api/employees/:id', authenticate, requirePrimaryOwner, async (req, res) => {
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

app.delete('/api/employees/:id', authenticate, requirePrimaryOwner, async (req, res) => {
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
         AND lower(COALESCE(s.display_name, s.name)) NOT IN ('others', 'viewer', 'viewers')
         AND NOT EXISTS (
           SELECT 1
           FROM users u
           WHERE u.stakeholder_id = s.id
             AND u.role = 'Viewer'
         )
       ORDER BY COALESCE(s.display_name, s.name), s.name`,
      [farmId, req.params.batchId]
    );

    res.json(result.rows.map(mapEmployeeCompensation));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/batches/:batchId/employee-pay-summary', authenticate, async (req, res) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const batch = await pool.query(
      'SELECT id FROM batches WHERE id = $1 AND farm_id = $2',
      [req.params.batchId, farmId]
    );

    if (batch.rowCount === 0) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    const [compensations, transactions, dailyLogs] = await Promise.all([
      pool.query(
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
           AND lower(COALESCE(s.display_name, s.name)) NOT IN ('others', 'viewer', 'viewers')
           AND NOT EXISTS (
             SELECT 1
             FROM users u
             WHERE u.stakeholder_id = s.id
               AND u.role = 'Viewer'
           )
         ORDER BY COALESCE(s.display_name, s.name), s.name`,
        [farmId, req.params.batchId]
      ),
      pool.query(
        `SELECT
           dt.type,
           dt.funding_nature AS "fundingNature",
           COALESCE(c.name, dt.category) AS category,
           dt.amount,
           paid_by.name AS "paidBy",
           COALESCE(paid_by.display_name, paid_by.name) AS "paidByDisplayName",
           paid_to.name AS "paidTo",
           COALESCE(paid_to.display_name, paid_to.name) AS "paidToDisplayName"
         FROM daily_transactions dt
         LEFT JOIN categories c ON c.id = dt.category_id
         LEFT JOIN stakeholders paid_by ON paid_by.id = dt.paid_by
         LEFT JOIN stakeholders paid_to ON paid_to.id = dt.paid_to
         WHERE dt.batch_id = $1
           AND dt.is_void = false`,
        [req.params.batchId]
      ),
      pool.query(
        `SELECT
           employee_id AS "employeeId",
           COALESCE(SUM(mortality), 0) AS mortality
         FROM daily_logs
         WHERE batch_id = $1
         GROUP BY employee_id`,
        [req.params.batchId]
      ),
    ]);

    const rows = buildEmployeePaySummaryRows(compensations.rows, transactions.rows, dailyLogs.rows);
    const totals = rows.reduce((sum, row) => ({
      grossHandledBirds: sum.grossHandledBirds + row.grossHandledBirds,
      mortality: sum.mortality + row.mortality,
      netHandledBirds: sum.netHandledBirds + row.netHandledBirds,
      payableBirds: sum.payableBirds + row.payableBirds,
      cycleIncome: sum.cycleIncome + row.cycleIncome,
      laborPaid: sum.laborPaid + row.laborPaid,
      outstandingAdvance: sum.outstandingAdvance + row.outstandingAdvance,
      remainingCyclePay: sum.remainingCyclePay + row.remainingCyclePay,
      netPayable: sum.netPayable + row.netPayable,
    }), {
      grossHandledBirds: 0,
      mortality: 0,
      netHandledBirds: 0,
      payableBirds: 0,
      cycleIncome: 0,
      laborPaid: 0,
      outstandingAdvance: 0,
      remainingCyclePay: 0,
      netPayable: 0,
    });

    res.json({ batchId: req.params.batchId, totals, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/batches/:batchId/employee-compensations/:employeeId', authenticate, requirePrimaryOwner, async (req, res) => {
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
         AND lower(COALESCE(s.display_name, s.name)) NOT IN ('others', 'viewer', 'viewers')
         AND NOT EXISTS (
           SELECT 1
           FROM users u
           WHERE u.stakeholder_id = s.id
             AND u.role = 'Viewer'
         )
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
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/batches/active', authenticate, async (req, res) => {
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

app.patch('/api/batches/:id', authenticate, requirePrimaryOwner, async (req, res) => {
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

app.delete('/api/batches/:id', authenticate, requirePrimaryOwner, async (req, res) => {
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

app.get('/api/batches/:batchId/harvest-production-summary', authenticate, async (req, res) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const summary = await getHarvestProductionSummary(pool, farmId, req.params.batchId);

    if (!summary) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/batches/:batchId/loadings', authenticate, requirePrimaryOwner, async (req, res) => {
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

app.get('/api/batches/:batchId/harvest-report', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const report = await getHarvestReport(pool, farmId, req.params.batchId);

    if (!report) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/batches/:batchId/harvest-report', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
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
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/batches/:batchId/harvest-report/post-ledger', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
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
        description: `${row.harvestOrder}${row.harvestOrder === 1 ? 'st' : row.harvestOrder === 2 ? 'nd' : 'rd'} Harvest Net Meat Sale`,
        amount: row.netSales,
        reference,
        remarks: `Harvest report ${report.id}. Birds: ${row.birds}; kilos: ${row.kilos}; gross sales: ${row.grossSales}; harvest expenses: ${row.totalExpenses}.`,
      });
      ledgerTransactionIds.push(transactionId);
    }

    const lastHarvestDate = datedHarvests[datedHarvests.length - 1]?.harvestDate;
    for (const item of report.financingItems) {
      const amount = roundMoney(getFinancingAmount(item));
      if (amount <= 0) continue;

      const transactionId = await insertHarvestLedgerTransaction(client, req, {
        farmId,
        batchId: req.params.batchId,
        date: lastHarvestDate,
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
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/transactions', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  try {
    res.json(await getTransactions(req.query.batchId || null, req.user.farm_id || await getDefaultFarmId()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/batches/:batchId/transactions', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  try {
    res.json(await getTransactions(req.params.batchId, req.user.farm_id || await getDefaultFarmId()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/quick-entry', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  const { text, today, building, paidBy } = req.body;

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Transaction text is required.' });
  }

  try {
    console.info('[quick-entry] request', {
      userId: req.user.id,
      role: req.user.role,
      textLength: text.length,
    });

    const result = await parseQuickEntryWithAi(text, {
      today,
      building,
      paidBy,
    });

    console.info('[quick-entry] parser', {
      userId: req.user.id,
      mode: result.parserMode,
      model: result.parserModel,
      warning: result.parserWarning || null,
    });

    res.json({
      parsed: result.parsed,
      needsReview: result.parsed.confidence < 0.75 || result.parsed.amount == null,
      parserMode: result.parserMode,
      parserModel: result.parserModel,
      parserWarning: result.parserWarning,
    });
  } catch (err) {
    console.error('[quick-entry] error', {
      userId: req.user.id,
      message: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/flockops-chat', authenticate, async (req, res) => {
  const { message, context = {} } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required.' });
  }

  const canEnterDaily = hasMinimumRole(req.user.role, 'DataEntry');
  const canManageOperations = hasMinimumRole(req.user.role, 'OperationManager');
  const allowedScreens = [
    'today',
    'dashboard',
    'batches',
    'dailyLog',
    'paySummary',
    'inventory',
    'analytics',
    'settings',
    ...(canManageOperations ? ['employees', 'ledger', 'harvest', 'statement'] : []),
  ];

  try {
    console.info('[flockops-chat] request', {
      userId: req.user.id,
      role: req.user.role,
      messageLength: message.length,
      activeBatchId: context?.activeBatch?.id || null,
    });

    const result = await createFlockOpsReply({
      message,
      context,
      user: req.user,
      permissions: {
        allowedScreens,
        canEnterDaily,
        canManageOperations,
        canViewFinancial: canManageOperations,
      },
    });

    console.info('[flockops-chat] response', {
      userId: req.user.id,
      provider: result.provider,
      model: result.model,
    });

    res.json(result);
  } catch (err) {
    console.error('[flockops-chat] error', {
      userId: req.user.id,
      message: err.message,
    });
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.post('/api/transactions', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  await createTransaction(req, res);
});

app.post('/api/batches/:batchId/transactions', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  await createTransaction(req, res, req.params.batchId);
});

app.patch('/api/batches/:batchId/transactions/:id', authenticate, requirePrimaryOwner, async (req, res) => {
  await updateTransaction(req, res, req.params.batchId, req.params.id);
});

app.post('/api/batches/:batchId/transactions/:id/void', authenticate, requirePrimaryOwner, async (req, res) => {
  await voidTransaction(req, res, req.params.id, req.params.batchId);
});

app.delete('/api/transactions/:id', authenticate, requirePrimaryOwner, async (req, res) => {
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
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const result = await pool.query(
      `SELECT v.category, v.total_amount AS "totalAmount"
       FROM vw_batch_opex_summary v
       JOIN batches b ON b.id = v.batch_id
       WHERE v.batch_id = $1
         AND b.farm_id = $2
       ORDER BY category`,
      [req.params.batchId, farmId]
    );
    res.json(result.rows.map(row => ({ ...row, totalAmount: Number(row.totalAmount || 0) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/batches/:batchId/capex-summary', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const result = await pool.query(
      `SELECT v.category, v.total_amount AS "totalAmount"
       FROM vw_batch_capex_summary v
       JOIN batches b ON b.id = v.batch_id
       WHERE v.batch_id = $1
         AND b.farm_id = $2
       ORDER BY category`,
      [req.params.batchId, farmId]
    );
    res.json(result.rows.map(row => ({ ...row, totalAmount: Number(row.totalAmount || 0) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/batches/:batchId/receivables-summary', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  try {
    res.json(await getReceivablesSummary(req.params.batchId, req.user.farm_id || await getDefaultFarmId()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/batches/:batchId/payables-summary', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  try {
    res.json(await getPayablesSummary(req.params.batchId, req.user.farm_id || await getDefaultFarmId()));
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

app.patch('/api/inventory/items/:id', authenticate, requirePrimaryOwner, async (req, res) => {
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

app.patch('/api/logs/:id', authenticate, requirePrimaryOwner, async (req, res) => {
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
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/logs/:id', authenticate, requirePrimaryOwner, async (req, res) => {
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
       FOR UPDATE OF dl`,
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
