const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dotenv = require('dotenv');
const { Pool } = require('pg');

dotenv.config({ path: path.resolve(__dirname, '.env'), quiet: true });

const config = {
  apiBase: process.env.REGRESSION_API_BASE || `http://localhost:${process.env.PORT || 5000}`,
  login: process.env.REGRESSION_LOGIN || 'admin.roland',
  password: process.env.REGRESSION_PASSWORD || '121232',
};

async function apiRequest(pathname, { method = 'GET', token = '', body = undefined } = {}) {
  const headers = {};

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${config.apiBase}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }

  return { status: response.status, payload };
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
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  let serverProcess = null;

  try {
    // 1. Set up dummy second farm and batch directly in the database
    console.log('Seeding other farm and batch into DB...');
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO farms (id, code, name) 
       VALUES ('e2fa729d-0c23-4d1b-a51e-bae345257857', 'otherfarm', 'Other Farm')
       ON CONFLICT (id) DO NOTHING`
    );
    await client.query(
      `INSERT INTO batches (id, farm_id, start_date, status) 
       VALUES ('other-batch-id', 'e2fa729d-0c23-4d1b-a51e-bae345257857', '2026-06-01', 'ONGOING')
       ON CONFLICT (id) DO NOTHING`
    );
    await client.query(
      `INSERT INTO batch_building_loadings (batch_id, building_id, loading_date, chicks_loaded)
       VALUES ('other-batch-id', 1, '2026-06-01', 5000)
       ON CONFLICT (batch_id, building_id) DO NOTHING`
    );
    await client.query('COMMIT');

    // 2. Start/Ensure server is running
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

    // 3. Log in as user (associated with default 'octavio' farm)
    const loginRes = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: { login: config.login, email: config.login, password: config.password },
    });
    assert.equal(loginRes.status, 200);
    const token = loginRes.payload.token;
    assert.ok(token);

    console.log('Testing data isolation endpoints...');

    // 4. Test GET loadings (should return empty array, not showing other farm's loadings)
    const loadingsGetRes = await apiRequest('/api/batches/other-batch-id/loadings', { token });
    assert.equal(loadingsGetRes.status, 200);
    assert.equal(loadingsGetRes.payload.length, 0);
    console.log('✔ GET loadings returned 0 records (isolated).');

    // 5. Test PUT loadings (should return 404)
    const loadingsPutRes = await apiRequest('/api/batches/other-batch-id/loadings', {
      method: 'PUT',
      token,
      body: { loadings: [{ building: 'Building 1', chicksLoaded: 4000 }] }
    });
    assert.equal(loadingsPutRes.status, 404);
    console.log('✔ PUT loadings returned 404 (isolated).');

    // 6. Test PATCH batch (should return 404)
    const batchPatchRes = await apiRequest('/api/batches/other-batch-id', {
      method: 'PATCH',
      token,
      body: { startDate: '2026-06-02' }
    });
    assert.equal(batchPatchRes.status, 404);
    console.log('✔ PATCH batch returned 404 (isolated).');

    // 7. Test DELETE batch (should return 404)
    const batchDeleteRes = await apiRequest('/api/batches/other-batch-id', {
      method: 'DELETE',
      token
    });
    assert.equal(batchDeleteRes.status, 404);
    console.log('✔ DELETE batch returned 404 (isolated).');

    // 8. Test GET employee-compensations (should return 404)
    const compensationsRes = await apiRequest('/api/batches/other-batch-id/employee-compensations', { token });
    assert.equal(compensationsRes.status, 404);
    console.log('✔ GET employee-compensations returned 404 (isolated).');

    // 9. Test GET employee-assignments (should return 404)
    const assignmentsRes = await apiRequest('/api/batches/other-batch-id/employee-assignments', { token });
    assert.equal(assignmentsRes.status, 404);
    console.log('✔ GET employee-assignments returned 404 (isolated).');

    console.log('All data isolation tests passed successfully!');
  } finally {
    // Cleanup database
    console.log('Cleaning up other farm/batch records from database...');
    await client.query('BEGIN');
    await client.query("DELETE FROM batch_building_loadings WHERE batch_id = 'other-batch-id'");
    await client.query("DELETE FROM batches WHERE id = 'other-batch-id'");
    await client.query("DELETE FROM farms WHERE id = 'e2fa729d-0c23-4d1b-a51e-bae345257857'");
    await client.query('COMMIT');
    client.release();
    await pool.end();

    if (serverProcess) {
      serverProcess.kill();
    }
  }
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
