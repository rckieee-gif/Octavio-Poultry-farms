const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { mockQuery, clearMocks } = require('./dbMock');

// Set JWT_SECRET before loading app
process.env.JWT_SECRET = 'test-jwt-secret-key-12345';
process.env.NODE_ENV = 'test';

const app = require('../app');
const { JWT_SIGNING_SECRET } = require('../middleware/auth');

test.describe('Batches API', () => {
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
    start_date: '2026-06-01',
    target_harvest_date: '2026-07-15',
    actual_harvest_end_date: null,
    status: 'ONGOING',
    total_chicks_loaded: 5000,
    planned_flock: 5000,
    target_feed_kg: 7500,
    notes: 'Test batch details',
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

  test.it('should return the active batch (200) if one exists', async () => {
    mockQuery("status = 'ONGOING'", [mockBatch]);

    const response = await fetch(`${apiBase}/api/batches/active`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.id, 'batch-2026-06');
    assert.equal(body.status, 'ONGOING');
    assert.equal(body.totalChicksLoaded, 5000);
  });

  test.it('should return 404 from active batch endpoint if no batch is active', async () => {
    mockQuery("status = 'ONGOING'", []);

    const response = await fetch(`${apiBase}/api/batches/active`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    assert.equal(response.status, 404);
  });

  test.it('should fetch loadings list for a batch', async () => {
    const mockLoadings = [
      {
        id: 10,
        building: 'Building 1',
        loadingDate: '2026-06-01',
        chicksLoaded: 3000,
        loadingSharePct: 60.00,
        remarks: ''
      },
      {
        id: 11,
        building: 'Building 2',
        loadingDate: '2026-06-01',
        chicksLoaded: 2000,
        loadingSharePct: 40.00,
        remarks: ''
      }
    ];

    mockQuery('FROM batch_building_loadings bbl', mockLoadings);

    const response = await fetch(`${apiBase}/api/batches/batch-2026-06/loadings`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.length, 2);
    assert.equal(body[0].building, 'Building 1');
    assert.equal(body[0].chicksLoaded, 3000);
  });

  test.it('should update loadings list for a batch', async () => {
    // Mock the exists query
    mockQuery('FROM batches WHERE id = $1 AND farm_id = $2', [mockBatch]);

    // Mock update queries
    mockQuery('DELETE FROM batch_building_loadings', { rowCount: 2 });
    mockQuery('INSERT INTO batch_building_loadings', { rowCount: 1 });
    mockQuery('INSERT INTO audit_logs', { rowCount: 1 });

    const response = await fetch(`${apiBase}/api/batches/batch-2026-06/loadings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        loadings: [
          { building: 'Building 1', chicksLoaded: 3000 },
          { building: 'Building 2', chicksLoaded: 2000 }
        ]
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.message, 'Loadings updated');
  });

  test.it('should create a new batch', async () => {
    // Mock generateBatchId count query
    mockQuery('count(*)::integer', [{ count: 0 }]);
    // Mock batch inserts
    mockQuery('INSERT INTO batches', [mockBatch]);
    mockQuery('INSERT INTO batch_building_loadings', { rowCount: 1 });
    mockQuery('INSERT INTO audit_logs', { rowCount: 1 });

    const response = await fetch(`${apiBase}/api/batches`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        startDate: '2026-06-01',
        plannedFlock: 5000,
        loadings: [
          { building: 'Building 1', chicksLoaded: 5000 }
        ],
        notes: 'Test new batch notes'
      }),
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    // API returns the created batch matching mapped format
    assert.equal(body.id, 'batch-2026-06');
  });
});
