const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { mockQuery, clearMocks } = require('./dbMock');

// Set JWT_SECRET before loading app
process.env.JWT_SECRET = 'test-jwt-secret-key-12345';
process.env.NODE_ENV = 'test';

const app = require('../app');
const { JWT_SIGNING_SECRET } = require('../middleware/auth');

test.describe('Transactions API', () => {
  let server;
  let port;
  let apiBase;
  let token;
  const mockUser = {
    id: 'user-uuid-123',
    farm_id: 'farm-uuid-abc',
    email: 'test@farm.com',
    username: 'testuser',
    role: 'OperationManager',
    is_active: true,
    is_primary_owner: true,
  };

  const mockBatch = {
    id: 'batch-2026-06',
    farm_id: 'farm-uuid-abc',
    status: 'ONGOING',
  };

  const mockTransactionRow = {
    id: '20260601-ALL-001',
    transaction_id: '20260601-ALL-001',
    batchId: 'batch-2026-06',
    batch_id: 'batch-2026-06',
    date: '2026-06-01',
    buildingScope: 'All',
    type: 'Expense',
    fundingNature: 'OPEX',
    category: 'Medicine',
    description: 'Bought vaccines',
    quantity: 1,
    unitCost: 1000,
    amount: 1000,
    reference: 'ref-123',
    remarks: 'Test remark',
    is_void: false,
    isVoid: false,
  };

  test.before(() => {
    server = app.listen(0);
    port = server.address().port;
    apiBase = `http://localhost:${port}`;
    token = jwt.sign({ userId: mockUser.id }, JWT_SIGNING_SECRET);
  });

  test.after(() => {
    server.close();
  });

  test.beforeEach(() => {
    clearMocks();
    mockQuery('FROM users', [mockUser]);
  });

  test.it('should fetch transactions list for a batch', async () => {
    mockQuery('FROM daily_transactions t', [mockTransactionRow]);

    const response = await fetch(`${apiBase}/api/batches/batch-2026-06/transactions`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].id, '20260601-ALL-001');
    assert.equal(body[0].category, 'Medicine');
  });

  test.it('should create a new transaction', async () => {
    // 1. Mock batch verification
    mockQuery('FROM batches WHERE id = $1 AND farm_id = $2', [mockBatch]);
    // 2. Mock generateTransactionCode sequence update
    mockQuery('INSERT INTO transaction_code_sequences', [{ last_sequence: 1 }]);
    // 3. Mock insert transaction
    mockQuery('INSERT INTO daily_transactions', [mockTransactionRow]);
    // 4. Mock select transaction after creation (getTransactionById)
    mockQuery('FROM daily_transactions t', [mockTransactionRow]);
    // 5. Mock audit log insert
    mockQuery('INSERT INTO audit_logs', { rowCount: 1 });

    const response = await fetch(`${apiBase}/api/batches/batch-2026-06/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        date: '2026-06-01',
        building: 'All',
        fundingNature: 'OPEX',
        category: 'Medicine',
        description: 'Bought vaccines',
        quantity: 1,
        unitCost: 1000,
        amount: 1000,
        paidBy: 'Rolly',
        paidTo: 'Supplier',
        reference: 'ref-123',
        remarks: 'Test remark',
        type: 'Expense'
      }),
    });

    const text = await response.text();
    assert.equal(response.status, 201);
    const body = JSON.parse(text);
    assert.equal(body.id, '20260601-ALL-001');
    assert.equal(body.amount, 1000);
  });

  test.it('should void an existing transaction', async () => {
    // Mock the check transaction query in voidTransaction
    mockQuery('FROM daily_transactions t', [mockTransactionRow]);

    // Mock update transaction query to void it
    mockQuery('UPDATE daily_transactions SET is_void = true', { rowCount: 1 });

    // Mock audit logs
    mockQuery('INSERT INTO audit_logs', { rowCount: 1 });

    const response = await fetch(`${apiBase}/api/batches/batch-2026-06/transactions/20260601-ALL-001/void`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    const text = await response.text();
    assert.equal(response.status, 200);
    const body = JSON.parse(text);
    assert.equal(body.message, 'Transaction voided');
  });

  test.it('should update a transaction details', async () => {
    // 1. Mock select query to verify transaction existence
    mockQuery('FROM daily_transactions t', [mockTransactionRow]);

    // 2. Mock update query
    mockQuery('UPDATE daily_transactions SET', [mockTransactionRow]);

    // 3. Mock audit logs
    mockQuery('INSERT INTO audit_logs', { rowCount: 1 });

    const response = await fetch(`${apiBase}/api/batches/batch-2026-06/transactions/20260601-ALL-001`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        date: '2026-06-01',
        building: 'All',
        fundingNature: 'OPEX',
        category: 'Medicine',
        description: 'Bought vaccines (Updated)',
        quantity: 1,
        unitCost: 1000,
        amount: 1000,
        paidBy: 'Rolly',
        paidTo: 'Supplier',
        reference: 'ref-123',
        remarks: 'Test remark',
        type: 'Expense'
      }),
    });

    const text = await response.text();
    assert.equal(response.status, 200);
    const body = JSON.parse(text);
    assert.equal(body.id, '20260601-ALL-001');
  });
});
