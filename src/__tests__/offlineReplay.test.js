const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { mockQuery, clearMocks } = require('./dbMock');
const idempotencyMiddleware = require('../middleware/idempotency');

test.describe('Idempotency & Offline Replay Middleware', () => {
  let server;
  let port;
  let apiBase;

  test.before(() => {
    const app = express();
    app.use(express.json());

    // Mount the middleware on a test route
    app.post('/api/test-idempotency', idempotencyMiddleware, (req, res) => {
      res.status(200).json({ ok: true });
    });

    server = app.listen(0);
    port = server.address().port;
    apiBase = `http://localhost:${port}`;
  });

  test.after(() => {
    server.close();
  });

  test.beforeEach(() => {
    clearMocks();
  });

  test.it('should return cached response if key has already been successfully processed', async () => {
    const cachedResponse = {
      status_code: 201,
      response_body: JSON.stringify({ txnId: 'cached-txn-999', amount: 500 }),
      created_at: new Date().toISOString()
    };

    // Mock query selecting existing key
    mockQuery('FROM idempotency_keys', [cachedResponse]);

    const response = await fetch(`${apiBase}/api/test-idempotency`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sync-Queue-Id': 'existing-key-uuid'
      },
      body: JSON.stringify({ test: 'data' })
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.txnId, 'cached-txn-999');
    assert.equal(body.amount, 500);
  });

  test.it('should return 409 conflict if request is currently being processed', async () => {
    const activeProcessingKey = {
      status_code: 0,
      response_body: 'processing',
      created_at: new Date().toISOString()
    };

    mockQuery('FROM idempotency_keys', [activeProcessingKey]);

    const response = await fetch(`${apiBase}/api/test-idempotency`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sync-Queue-Id': 'processing-key-uuid'
      },
      body: JSON.stringify({ test: 'data' })
    });

    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, 'Request is already being processed.');
  });

  test.it('should proceed and save result for a new sync queue key', async () => {
    // 1. SELECT returns no row (new key)
    mockQuery('FROM idempotency_keys', []);
    // 2. INSERT reserves key in processing state
    mockQuery('INSERT INTO idempotency_keys', { rowCount: 1 });
    // 3. UPDATE saves final status and body on response
    let updateSql = null;
    let updateParams = [];
    mockQuery('UPDATE idempotency_keys', (sql, params) => {
      updateSql = sql;
      updateParams = params;
      return { rowCount: 1 };
    });

    const response = await fetch(`${apiBase}/api/test-idempotency`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sync-Queue-Id': 'new-key-uuid'
      },
      body: JSON.stringify({ test: 'data' })
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);

    // Verify update query parameters
    assert.ok(updateSql);
    assert.equal(updateParams[0], 200); // status_code
    assert.equal(updateParams[1], JSON.stringify({ ok: true })); // response_body
    assert.equal(updateParams[2], 'new-key-uuid'); // key
  });
});
