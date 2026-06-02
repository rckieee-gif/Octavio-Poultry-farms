const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { mockQuery, clearMocks } = require('./dbMock');

// Set JWT_SECRET before loading app
process.env.JWT_SECRET = 'test-jwt-secret-key-12345';
process.env.NODE_ENV = 'test';

const app = require('../app');
const { JWT_SIGNING_SECRET } = require('../middleware/auth');

test.describe('Farm Scoping & Data Isolation', () => {
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
    is_primary_owner: true, // Needs primary owner status to bypass batches write route checks
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
    // Default mock user check on authenticate middleware
    mockQuery('FROM users', [mockUser]);
  });

  test.it('should return empty list (200) for loadings if batch does not belong to user\'s farm', async () => {
    // Mock the loadings check query to return no rows when joined with batches
    // indicating that the batch does not belong to this user's farm.
    mockQuery('JOIN batches', []);

    const response = await fetch(`${apiBase}/api/batches/other-batch-id/loadings`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });

  test.it('should return 404 on PUT loadings if batch does not belong to user\'s farm', async () => {
    // Mock the batch verification query to return 0 rows (isolated/not found)
    mockQuery('FROM batches WHERE id = $1 AND farm_id = $2', []);

    const response = await fetch(`${apiBase}/api/batches/other-batch-id/loadings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ loadings: [{ building: 'Building 1', chicksLoaded: 4000 }] }),
    });

    assert.equal(response.status, 404);
    const body = await response.json();
    assert.ok(body.error);
  });

  test.it('should return 404 on PATCH batch if batch does not belong to user\'s farm', async () => {
    // Mock the batch verification query to return 0 rows (isolated/not found)
    mockQuery('FROM batches WHERE id = $1 AND farm_id = $2', []);

    const response = await fetch(`${apiBase}/api/batches/other-batch-id`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ startDate: '2026-06-02' }),
    });

    assert.equal(response.status, 404);
  });

  test.it('should return 404 on DELETE batch if batch does not belong to user\'s farm', async () => {
    mockQuery('FROM batches WHERE id = $1 AND farm_id = $2', []);

    const response = await fetch(`${apiBase}/api/batches/other-batch-id`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    assert.equal(response.status, 404);
  });

  test.it('should return 404 on GET employee-compensations if batch does not belong to user\'s farm', async () => {
    mockQuery('FROM batches WHERE id = $1 AND farm_id = $2', []);

    const response = await fetch(`${apiBase}/api/batches/other-batch-id/employee-compensations`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    assert.equal(response.status, 404);
  });

  test.it('should return 404 on GET employee-assignments if batch does not belong to user\'s farm', async () => {
    mockQuery('FROM batches WHERE id = $1 AND farm_id = $2', []);

    const response = await fetch(`${apiBase}/api/batches/other-batch-id/employee-assignments`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    assert.equal(response.status, 404);
  });
});
