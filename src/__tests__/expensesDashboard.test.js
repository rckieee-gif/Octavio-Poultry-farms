const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { mockQuery, clearMocks } = require('./dbMock');

process.env.JWT_SECRET = 'test-jwt-secret-key-12345';
process.env.NODE_ENV = 'test';

const app = require('../app');
const { JWT_SIGNING_SECRET } = require('../middleware/auth');

test.describe('Expenses and dashboard summary API', () => {
  let server;
  let apiBase;
  let token;

  const mockUser = {
    id: 'user-uuid-123',
    farm_id: 'farm-uuid-abc',
    email: 'owner@farm.com',
    username: 'owner',
    role: 'OperationManager',
    is_active: true,
    is_primary_owner: true,
  };

  const expenseRow = {
    id: '20260627-ALL-001',
    transaction_id: '20260627-ALL-001',
    batchId: 'batch-1',
    batch_id: 'batch-1',
    date: '2026-06-27',
    building: 'All',
    buildingScope: 'All',
    type: 'Expense',
    fundingNature: 'OPEX',
    category: 'Fuel',
    description: 'Diesel refill',
    amount: 180,
    paidTo: 'TotalEnergies',
    remarks: 'Receipt 88',
    isVoid: false,
    createdAt: '2026-06-27T00:00:00.000Z',
    updatedAt: '2026-06-27T00:00:00.000Z',
  };

  const saleRow = {
    ...expenseRow,
    id: '20260628-ALL-001',
    transaction_id: '20260628-ALL-001',
    type: 'Income',
    fundingNature: 'Other Revenue',
    category: 'Net Meat Sale',
    description: 'Harvest sale',
    amount: 500,
    paidTo: 'Buyer',
  };

  test.before(() => {
    server = app.listen(0);
    apiBase = `http://localhost:${server.address().port}`;
    token = jwt.sign({ userId: mockUser.id }, JWT_SIGNING_SECRET);
  });

  test.after(() => {
    server.close();
  });

  test.beforeEach(() => {
    clearMocks();
    mockQuery('FROM users', [mockUser]);
  });

  test.it('maps transaction rows to /api/expenses without exposing sales as expenses', async () => {
    mockQuery('FROM daily_transactions t', [expenseRow, saleRow]);

    const response = await fetch(`${apiBase}/api/expenses`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].id, '20260627-ALL-001');
    assert.equal(body[0].vendor, 'TotalEnergies');
    assert.equal(body[0].notes, 'Receipt 88');
    assert.equal(body[0].created_at, '2026-06-27T00:00:00.000Z');
  });

  test.it('creates an expense through the existing transaction persistence path', async () => {
    mockQuery(/FROM batches\s+WHERE farm_id/, [{ id: 'batch-1' }]);
    mockQuery('FROM batches WHERE id = $1 AND farm_id = $2', [{ id: 'batch-1' }]);
    mockQuery('INSERT INTO transaction_code_sequences', [{ last_sequence: 1 }]);
    mockQuery('INSERT INTO daily_transactions', [expenseRow]);
    mockQuery('FROM daily_transactions t', [expenseRow]);
    mockQuery('INSERT INTO audit_logs', { rowCount: 1 });

    const response = await fetch(`${apiBase}/api/expenses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        description: 'Diesel refill',
        category: 'Fuel',
        vendor: 'TotalEnergies',
        date: '2026-06-27',
        amount: 180,
        notes: 'Receipt 88',
      }),
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.description, 'Diesel refill');
    assert.equal(body.vendor, 'TotalEnergies');
    assert.equal(body.amount, 180);
  });

  test.it('derives dashboard totals from transactions and low stock from inventory', async () => {
    mockQuery('FROM daily_transactions t', [expenseRow, saleRow]);
    mockQuery('FROM inventory_items ii', [
      {
        id: 1,
        name: 'Corn Seed',
        category: 'Seeds',
        unit: 'kg',
        targetQuantity: 20,
        reorderLevel: 10,
        currentStock: 8,
        isActive: true,
      },
      {
        id: 2,
        name: 'NPK Fertilizer',
        category: 'Supplies',
        unit: 'kg',
        targetQuantity: 50,
        reorderLevel: 10,
        currentStock: 40,
        isActive: true,
      },
    ]);
    mockQuery(/FROM batches\s+WHERE farm_id/, [
      { id: 'batch-1', targetHarvestDate: '2026-07-10' },
    ]);

    const response = await fetch(`${apiBase}/api/dashboard/summary`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.totalSales, 500);
    assert.equal(body.totalExpenses, 180);
    assert.equal(body.estimatedProfit, 320);
    assert.equal(body.lowStockItems, 1);
    assert.equal(body.harvestCalendar.length, 1);
    assert.equal(body.recentSales[0].description, 'Harvest sale');
  });
});
