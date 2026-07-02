const express = require('express');
const { pool, getDefaultFarmId } = require('../db');
const { authenticate, requirePrimaryOwner } = require('../middleware/auth');
const { requireMinimumRole } = require('../middleware/roles');
const { validate, expenseSchema } = require('../middleware/validate');
const {
  createTransaction,
  getTransactions,
  updateTransaction,
  voidTransaction,
} = require('../services/transactions.service');

const router = express.Router();

function isRevenue(tx) {
  return tx?.fundingNature === 'Revenue' || tx?.fundingNature === 'Other Revenue' || tx?.type === 'Income';
}

function toExpense(tx) {
  return {
    id: tx.id,
    description: tx.description || '',
    category: tx.category || '',
    vendor: tx.paidTo || '',
    date: tx.date,
    amount: Number(tx.amount || 0),
    notes: tx.remarks || '',
    batchId: tx.batchId,
    created_at: tx.createdAt || null,
    updated_at: tx.updatedAt || null,
  };
}

function expenseBodyToTransactionBody(body, batchId) {
  return {
    batchId,
    date: body.date,
    building: 'All',
    fundingNature: 'OPEX',
    category: body.category,
    description: body.description,
    quantity: undefined,
    unitCost: undefined,
    amount: body.amount,
    paidBy: '',
    paidTo: body.vendor || '',
    reference: '',
    remarks: body.notes || '',
    type: 'Expense',
    feedItemId: null,
  };
}

function captureExpenseResponse(res, mapper) {
  let statusCode = 200;
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      if (statusCode >= 400 || payload?.error) {
        return res.status(statusCode).json(payload);
      }
      return res.status(statusCode).json(mapper(payload));
    },
  };
}

async function resolveExpenseBatchId(req, farmId) {
  if (req.body?.batchId) return String(req.body.batchId);
  if (req.query?.batchId) return String(req.query.batchId);

  const result = await pool.query(
    `SELECT id
     FROM batches
     WHERE farm_id = $1
       AND COALESCE(status_override, status) IN ('ONGOING', 'ON_THE_WAY')
     ORDER BY start_date DESC, id DESC
     LIMIT 1`,
    [farmId]
  );

  if (result.rowCount > 0) return String(result.rows[0].id);

  const err = new Error('Select a batch before saving an expense.');
  err.status = 400;
  throw err;
}

async function resolveTransactionBatchId(transactionId, farmId) {
  const result = await pool.query(
    `SELECT t.batch_id AS "batchId"
     FROM daily_transactions t
     JOIN batches b ON b.id = t.batch_id
     WHERE t.transaction_id = $1
       AND b.farm_id = $2
     LIMIT 1`,
    [transactionId, farmId]
  );

  if (result.rowCount > 0) return String(result.rows[0].batchId);

  const err = new Error('Expense not found');
  err.status = 404;
  throw err;
}

router.get('/', authenticate, requireMinimumRole('OperationManager'), async (req, res, next) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const transactions = await getTransactions(req.query.batchId || null, farmId);
    res.json(transactions.filter((tx) => !isRevenue(tx)).map(toExpense));
  } catch (err) {
    next(err);
  }
});

router.post('/', authenticate, requireMinimumRole('OperationManager'), validate(expenseSchema), async (req, res, next) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const batchId = await resolveExpenseBatchId(req, farmId);
    req.body = expenseBodyToTransactionBody(req.body, batchId);
    await createTransaction(req, captureExpenseResponse(res, toExpense), next, batchId);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', authenticate, requirePrimaryOwner, validate(expenseSchema), async (req, res, next) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const batchId = req.body.batchId || req.query.batchId || await resolveTransactionBatchId(req.params.id, farmId);
    req.body = expenseBodyToTransactionBody(req.body, batchId);
    await updateTransaction(req, captureExpenseResponse(res, toExpense), next, batchId, req.params.id);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', authenticate, requirePrimaryOwner, async (req, res, next) => {
  await voidTransaction(req, res, next, req.params.id);
});

module.exports = router;
