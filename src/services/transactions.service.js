const { pool, getDefaultFarmId, getBuilding, ensureCategory, ensureStakeholder } = require('../db');
const { toDateOnly } = require('../utils/validation');
const { toNumber, calculateAmount, hasQuantityAndUnitCost } = require('../utils/money');
const { getInventoryItem, insertInventoryMovement } = require('./inventory.service');

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
    createdAt: row.createdAt || row.created_at,
    updatedAt: row.updatedAt || row.updated_at,
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

async function voidTransaction(req, res, next, transactionId, batchId = null) {
  const reason = (req.body?.reason || 'Voided from ledger').trim();

  if (!reason) {
    return res.status(400).json({ error: 'Void reason is required' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const queryParams = [transactionId, farmId];
    let batchClause = '';

    if (batchId) {
      queryParams.push(batchId);
      batchClause = `AND t.batch_id = $3`;
    }

    const before = await client.query(
      `SELECT t.*
       FROM daily_transactions t
       JOIN batches b ON b.id = t.batch_id
       WHERE t.transaction_id = $1
         AND b.farm_id = $2
         ${batchClause}
       FOR UPDATE OF t`,
      queryParams
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
    next(err);
  } finally {
    client.release();
  }
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
       COALESCE(paid_by.display_name, paid_by.name) AS "paidBy",
       COALESCE(paid_to.display_name, paid_to.name) AS "paidTo",
       t.reference,
       t.remarks,
       feed_im.item_id AS "feedItemId",
       feed_item.name AS "feedItemName",
       t.is_void AS "isVoid",
       t.void_reason AS "voidReason",
       t.created_at AS "createdAt",
       t.updated_at AS "updatedAt"
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
       COALESCE(paid_by.display_name, paid_by.name) AS "paidBy",
       COALESCE(paid_to.display_name, paid_to.name) AS "paidTo",
       t.reference,
       t.remarks,
       feed_im.item_id AS "feedItemId",
       feed_item.name AS "feedItemName",
       t.is_void AS "isVoid",
       t.void_reason AS "voidReason",
       t.created_at AS "createdAt",
       t.updated_at AS "updatedAt"
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

function isFeedPurchase({ fundingNature, category, type }) {
  const dbFundingNature = normalizeFundingNatureForDb(fundingNature);
  const transactionType = deriveTransactionType(fundingNature, type);
  return (
    dbFundingNature === 'OPEX' &&
    category === 'Feed' &&
    transactionType === 'Expense'
  );
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

async function createTransaction(req, res, next, batchIdFromRoute = null) {
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

    const batchCheck = await client.query(
      'SELECT id FROM batches WHERE id = $1 AND farm_id = $2 LIMIT 1',
      [batchId, farmId]
    );
    if (batchCheck.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Batch not found' });
    }

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
    next(err);
  } finally {
    client.release();
  }
}

async function updateTransaction(req, res, next, batchId, transactionId) {
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

    const farmId = req.user.farm_id || await getDefaultFarmId(client);

    const before = await client.query(
      `SELECT t.*
       FROM daily_transactions t
       JOIN batches b ON b.id = t.batch_id
       WHERE t.transaction_id = $1
         AND t.batch_id = $2
         AND b.farm_id = $3
       FOR UPDATE OF t`,
      [transactionId, batchId, farmId]
    );

    if (before.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (before.rows[0].is_void) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Voided transactions cannot be edited.' });
    }
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
    next(err);
  } finally {
    client.release();
  }
}

module.exports = {
  normalizeFundingNatureForDb,
  normalizeFundingNatureForClient,
  deriveTransactionType,
  mapTransaction,
  mapAuditLog,
  auditLog,
  voidTransaction,
  getAuditLogs,
  generateTransactionCode,
  insertLinkedLedgerTransaction,
  insertHarvestLedgerTransaction,
  getTransactions,
  getTransactionById,
  getReceivablesSummary,
  getPayablesSummary,
  createTransaction,
  updateTransaction,
};
