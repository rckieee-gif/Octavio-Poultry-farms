const express = require('express');
const { pool, getDefaultFarmId } = require('../db');
const { authenticate, requirePrimaryOwner } = require('../middleware/auth');
const { requireMinimumRole } = require('../middleware/roles');
const { parseQuickEntryWithAi } = require('../../lib/quickEntryAiParser');
const {
  getTransactions,
  createTransaction,
  updateTransaction,
  voidTransaction,
  getAuditLogs,
  getReceivablesSummary,
  getPayablesSummary,
} = require('../services/transactions.service');

const router = express.Router();

// 1. Transaction Retrieval routes
router.get('/', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  try {
    res.json(await getTransactions(req.query.batchId || null, req.user.farm_id || await getDefaultFarmId()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/batches/:batchId/transactions', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  try {
    res.json(await getTransactions(req.params.batchId, req.user.farm_id || await getDefaultFarmId()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Transaction Mutation routes
router.post('/', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  await createTransaction(req, res);
});

router.post('/batches/:batchId/transactions', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  await createTransaction(req, res, req.params.batchId);
});

router.patch('/batches/:batchId/transactions/:id', authenticate, requirePrimaryOwner, async (req, res) => {
  await updateTransaction(req, res, req.params.batchId, req.params.id);
});

// 3. Voiding / Deleting routes
router.post('/batches/:batchId/transactions/:id/void', authenticate, requirePrimaryOwner, async (req, res) => {
  await voidTransaction(req, res, req.params.id, req.params.batchId);
});

router.post('/:id/void', authenticate, requirePrimaryOwner, async (req, res) => {
  await voidTransaction(req, res, req.params.id);
});

router.delete('/:id', authenticate, requirePrimaryOwner, async (req, res) => {
  await voidTransaction(req, res, req.params.id);
});

// 4. Audit Log routes
router.get('/batches/:batchId/audit-logs', authenticate, requirePrimaryOwner, async (req, res) => {
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

router.get('/:id/audit-logs', authenticate, requirePrimaryOwner, async (req, res) => {
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

// 5. Financial Summaries
router.get('/batches/:batchId/opex-summary', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
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

router.get('/batches/:batchId/capex-summary', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
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

router.get('/batches/:batchId/receivables-summary', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  try {
    res.json(await getReceivablesSummary(req.params.batchId, req.user.farm_id || await getDefaultFarmId()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/batches/:batchId/payables-summary', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
  try {
    res.json(await getPayablesSummary(req.params.batchId, req.user.farm_id || await getDefaultFarmId()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Quick Entry AI route
router.post('/quick-entry', authenticate, requireMinimumRole('OperationManager'), async (req, res) => {
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

module.exports = router;
