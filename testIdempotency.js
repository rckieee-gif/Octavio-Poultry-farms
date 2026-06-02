const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '.env'), quiet: true });

const config = {
  apiBase: process.env.REGRESSION_API_BASE || `http://localhost:${process.env.PORT || 5000}`,
  login: process.env.REGRESSION_LOGIN || 'admin.roland',
  password: process.env.REGRESSION_PASSWORD || '121232',
};

async function apiRequest(pathname, { method = 'GET', sessionCookie = '', headers = {}, body = undefined } = {}) {
  const finalHeaders = { ...headers };

  if (sessionCookie) {
    finalHeaders.Cookie = sessionCookie;
  }

  if (body !== undefined) {
    finalHeaders['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${config.apiBase}${pathname}`, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }

  return { status: response.status, payload, headers: response.headers };
}

async function checkApiHealth(apiBase) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1000);
    const response = await fetch(`${apiBase}/health`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (response.ok) {
      const data = await response.json();
      return data.service === 'octavio-farm-api';
    }
  } catch {
    // ignore
  }
  return false;
}

async function main() {
  let serverProcess = null;

  try {
    const isHealthy = await checkApiHealth(config.apiBase);
    if (!isHealthy) {
      console.log(`Starting API server...`);
      serverProcess = spawn('node', [path.resolve(__dirname, 'server.js')], {
        cwd: __dirname,
        stdio: 'ignore',
        env: { ...process.env },
      });

      let healthy = false;
      for (let i = 0; i < 50; i++) {
        healthy = await checkApiHealth(config.apiBase);
        if (healthy) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (!healthy) {
        throw new Error(`Failed to start API server.`);
      }
    }

    // 1. Login
    const loginRes = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: { login: config.login, email: config.login, password: config.password },
    });
    assert.equal(loginRes.status, 200);
    const sessionCookie = loginRes.headers.get('set-cookie')?.split(';')[0] || '';
    assert.ok(sessionCookie);

    // 2. Get active batch
    const activeBatchRes = await apiRequest('/api/batches/active', { sessionCookie });
    assert.equal(activeBatchRes.status, 200);
    const batchId = activeBatchRes.payload.id;
    assert.ok(batchId);

    // 3. Prepare payload & unique queue ID
    const queueId = `test-idempotency-${crypto.randomUUID()}`;
    const payload = {
      date: new Date().toISOString().split('T')[0],
      building: 'All',
      fundingNature: 'OPEX',
      category: 'Medicines',
      description: 'Idempotency test drug purchase',
      amount: 150.00,
      type: 'Expense',
      paidBy: 'Rolly',
      paidTo: 'Supplier',
      reference: `ref-${Date.now()}`
    };

    console.log(`Sending first request with X-Sync-Queue-Id: ${queueId}`);

    // 4. Send first request (should create record)
    const res1 = await apiRequest(`/api/batches/${encodeURIComponent(batchId)}/transactions`, {
      method: 'POST',
      sessionCookie,
      headers: { 'X-Sync-Queue-Id': queueId },
      body: payload
    });

    assert.ok([200, 201].includes(res1.status), `First request failed with status: ${res1.status}`);
    const txnId1 = res1.payload.id;
    assert.ok(txnId1);
    console.log(`First request succeeded. Transaction ID: ${txnId1}`);

    // 5. Send second request (should match idempotency and return cached)
    console.log(`Sending second request with same X-Sync-Queue-Id...`);
    const res2 = await apiRequest(`/api/batches/${encodeURIComponent(batchId)}/transactions`, {
      method: 'POST',
      sessionCookie,
      headers: { 'X-Sync-Queue-Id': queueId },
      body: payload
    });

    assert.equal(res2.status, res1.status);
    assert.equal(res2.payload.id, txnId1);
    console.log('Second request returned same cached transaction ID successfully.');

    // 6. Verify only one transaction was created in DB
    const listRes = await apiRequest(`/api/batches/${encodeURIComponent(batchId)}/transactions`, { sessionCookie });
    assert.equal(listRes.status, 200);

    const matchingTxns = listRes.payload.filter(t => t.reference === payload.reference);
    assert.equal(matchingTxns.length, 1, `Expected exactly 1 transaction in DB, found ${matchingTxns.length}`);
    console.log('Verified database has no duplicate transaction.');

    // Cleanup: void the transaction
    console.log(`Cleaning up: voiding transaction ${txnId1}`);
    const voidRes = await apiRequest(`/api/batches/${encodeURIComponent(batchId)}/transactions/${encodeURIComponent(txnId1)}/void`, {
      method: 'POST',
      sessionCookie,
      body: { reason: 'Idempotency test cleanup' }
    });
    assert.equal(voidRes.status, 200);
    console.log('Cleanup successful.');

    console.log('All idempotency tests passed successfully!');
  } finally {
    if (serverProcess) {
      serverProcess.kill();
    }
  }
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
