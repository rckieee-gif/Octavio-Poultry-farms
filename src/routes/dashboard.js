const express = require('express');
const { pool, getDefaultFarmId } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireMinimumRole } = require('../middleware/roles');
const { getTransactions } = require('../services/transactions.service');
const { getInventoryItems } = require('../services/inventory.service');
const { toDateOnly } = require('../utils/validation');

const router = express.Router();

function isRevenue(tx) {
  return tx?.fundingNature === 'Revenue' || tx?.fundingNature === 'Other Revenue' || tx?.type === 'Income';
}

function mapLowStockAlert(item) {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    currentStock: item.currentStock,
    reorderLevel: item.reorderLevel,
    unit: item.unit,
  };
}

function mapSale(tx) {
  return {
    id: tx.id,
    description: tx.description,
    vendor: tx.paidTo || tx.paidBy || '',
    date: tx.date,
    amount: Number(tx.amount || 0),
  };
}

router.get('/summary', authenticate, requireMinimumRole('OperationManager'), async (req, res, next) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const [transactions, inventoryItems, harvestResult] = await Promise.all([
      getTransactions(null, farmId),
      getInventoryItems(farmId),
      pool.query(
        `SELECT id, target_harvest_date AS "targetHarvestDate"
         FROM batches
         WHERE farm_id = $1
           AND target_harvest_date IS NOT NULL
           AND target_harvest_date >= CURRENT_DATE
           AND target_harvest_date <= CURRENT_DATE + INTERVAL '30 days'
         ORDER BY target_harvest_date ASC, id ASC
         LIMIT 10`,
        [farmId]
      )
    ]);

    const sales = transactions.filter(isRevenue);
    const expenses = transactions.filter((tx) => !isRevenue(tx));
    const totalSales = sales.reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
    const totalExpenses = expenses.reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
    const lowStockAlerts = inventoryItems
      .filter((item) => item.warningType === 'low-stock')
      .map(mapLowStockAlert);
    const harvestCalendar = harvestResult.rows.map((row) => ({
      batch: row.id,
      building: 'All buildings',
      employee: 'Assigned team',
      date: toDateOnly(row.targetHarvestDate || row.target_harvest_date),
    }));

    res.json({
      pendingTasks: 0,
      overdueTasks: 0,
      lowStockItems: lowStockAlerts.length,
      upcomingHarvests: harvestCalendar.length,
      totalSales,
      totalExpenses,
      estimatedProfit: totalSales - totalExpenses,
      recentSales: sales.slice(0, 5).map(mapSale),
      harvestCalendar,
      lowStockAlerts,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
