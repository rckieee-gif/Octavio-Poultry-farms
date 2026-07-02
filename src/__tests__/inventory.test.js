const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { mockQuery, clearMocks } = require('./dbMock');

// Set JWT_SECRET before loading app
process.env.JWT_SECRET = 'test-jwt-secret-key-12345';
process.env.NODE_ENV = 'test';

const app = require('../app');
const { JWT_SIGNING_SECRET } = require('../middleware/auth');

test.describe('Inventory API', () => {
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

  const mockItemRow = {
    id: 1,
    name: 'Grower Feed',
    category: 'Feed',
    unit: 'bags',
    target_quantity: 100,
    targetQuantity: 100,
    reorder_level: 20,
    reorderLevel: 20,
    is_active: true,
    isActive: true,
    current_stock: 50,
    currentStock: 50,
  };

  const mockMovementRow = {
    id: 100,
    batchId: 'batch-2026-06',
    itemId: 1,
    movementDate: '2026-06-01',
    movementType: 'Stock In',
    quantity: 50,
    unitCost: 1500,
    amount: 75000,
    building: 'All',
    sourceType: 'manual',
    sourceId: '',
    linkedTransactionId: '',
    remarks: 'Manual stock adjustment',
    createdAt: '2026-06-01T08:00:00Z',
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

  test.it('should list all inventory items', async () => {
    mockQuery('FROM inventory_items ii', [mockItemRow]);

    const response = await fetch(`${apiBase}/api/inventory/items`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].name, 'Grower Feed');
    assert.equal(body[0].currentStock, 50);
  });

  test.it('should scope item stock to the requested batch', async () => {
    let capturedSql = '';
    let capturedParams = [];
    mockQuery('FROM inventory_items ii', (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [mockItemRow], rowCount: 1 };
    });

    const response = await fetch(`${apiBase}/api/inventory/items?batchId=batch-2026-06`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    assert.equal(response.status, 200);
    assert.match(capturedSql, /im\.batch_id = \$2/);
    assert.deepEqual(capturedParams, ['farm-uuid-abc', 'batch-2026-06']);
  });

  test.it('should create a new inventory item', async () => {
    mockQuery('INSERT INTO inventory_items', [mockItemRow]);

    const response = await fetch(`${apiBase}/api/inventory/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: 'Grower Feed',
        category: 'Feed',
        unit: 'bags',
        targetQuantity: 100,
        reorderLevel: 20
      }),
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.id, 1);
    assert.equal(body.name, 'Grower Feed');
  });

  test.it('should update an existing inventory item', async () => {
    mockQuery('UPDATE inventory_items', [mockItemRow]);
    mockQuery('FROM inventory_items ii', [mockItemRow]);

    const response = await fetch(`${apiBase}/api/inventory/items/1`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: 'Grower Feed (Updated)',
        category: 'Feed',
        unit: 'bags',
        targetQuantity: 120,
        reorderLevel: 30,
        isActive: true
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.id, 1);
  });

  test.it('should list inventory movements', async () => {
    mockQuery('FROM inventory_movements im', [mockMovementRow]);

    const response = await fetch(`${apiBase}/api/inventory/movements`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].movementType, 'Stock In');
    assert.equal(body[0].quantity, 50);
  });

  test.it('should create an inventory movement adjustment', async () => {
    // 1. Mock select query to verify inventory item exists
    mockQuery('FROM inventory_items', [mockItemRow]);
    // 2. Mock movement insert
    mockQuery('INSERT INTO inventory_movements', [{ id: 100 }]);
    // 3. Mock select movement after creation
    mockQuery('FROM inventory_movements im', [mockMovementRow]);
    // 4. Mock audit log insert
    mockQuery('INSERT INTO audit_logs', { rowCount: 1 });

    const response = await fetch(`${apiBase}/api/inventory/movements`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        batchId: 'batch-2026-06',
        itemId: 1,
        movementDate: '2026-06-01',
        movementType: 'Stock In',
        quantity: 50,
        unitCost: 1500,
        remarks: 'Manual stock adjustment'
      }),
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.id, 100);
    assert.equal(body.quantity, 50);
  });
});
