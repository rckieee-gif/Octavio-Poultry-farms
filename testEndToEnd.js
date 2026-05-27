const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '.env'), quiet: true });

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
    // Ignore, API is not reachable/healthy
  }
  return false;
}

const config = {
  apiBase: trimTrailingSlash(
    process.env.REGRESSION_API_BASE ||
    process.env.BACKEND_BASE_URL ||
    process.env.API_BASE ||
    `http://localhost:${process.env.PORT || 5000}`
  ),
  login: process.env.REGRESSION_LOGIN || process.env.TEST_LOGIN || 'admin.roland',
  password: process.env.REGRESSION_PASSWORD || process.env.TEST_PASSWORD || '121232',
  batchId: process.env.REGRESSION_BATCH_ID || '',
  employeeName: process.env.REGRESSION_EMPLOYEE_NAME || 'Jane',
  paidBy: process.env.REGRESSION_PAID_BY || 'Rolly',
  today: process.env.REGRESSION_TODAY || new Date().toISOString().split('T')[0],
  advanceAmount: readNumberEnv('REGRESSION_ADVANCE_AMOUNT', 600),
  reimbursementAmount: readNumberEnv('REGRESSION_REIMBURSEMENT_AMOUNT', 200),
};

function readNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }

  return value;
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function sameName(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function amountOf(row, key) {
  return Number(row?.[key] || 0);
}

function findSummaryRow(summary, employeeName) {
  return (summary.rows || []).find((row) => sameName(row.employeeName, employeeName)) || null;
}

function assertClose(actual, expected, label) {
  const roundedActual = Number(actual.toFixed(2));
  const roundedExpected = Number(expected.toFixed(2));

  assert.ok(
    Math.abs(roundedActual - roundedExpected) < 0.01,
    `${label}: expected ${roundedExpected}, received ${roundedActual}`
  );
}

function assertSummaryDelta(beforeSummary, afterSummary, employeeName, field, expectedDelta, label) {
  const beforeRow = findSummaryRow(beforeSummary, employeeName);
  const afterRow = findSummaryRow(afterSummary, employeeName);

  assert.ok(afterRow, `${label}: expected employee "${employeeName}" in pay summary.`);
  assertClose(amountOf(afterRow, field) - amountOf(beforeRow, field), expectedDelta, label);
}

function assertEmployeeExists(summary, employeeName) {
  assert.ok(
    findSummaryRow(summary, employeeName),
    `Regression employee "${employeeName}" was not found in the pay summary. Use REGRESSION_EMPLOYEE_NAME for an existing employee so the test does not create a permanent fixture.`
  );
}

function transactionPayloadFromParsed(parsed, overrides = {}) {
  return {
    date: parsed.date,
    building: parsed.building || 'All',
    fundingNature: parsed.fundingNature,
    category: parsed.category,
    description: parsed.description,
    quantity: parsed.quantity ?? undefined,
    unitCost: parsed.unitPrice ?? undefined,
    amount: parsed.amount,
    paidBy: parsed.paidBy,
    paidTo: parsed.paidTo,
    reference: parsed.reference || '',
    remarks: parsed.remarks || `Regression quick entry: ${parsed.originalText || parsed.description}`,
    type: parsed.type || parsed.transactionType,
    ...overrides,
  };
}

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
  const payload = text ? tryParseJson(text) : null;

  if (!response.ok) {
    const message = payload?.error || text || response.statusText;
    const error = new Error(`${method} ${pathname} failed with ${response.status}: ${message}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function login() {
  const result = await apiRequest('/api/auth/login', {
    method: 'POST',
    body: {
      login: config.login,
      email: config.login,
      password: config.password,
    },
  });

  assert.ok(result.token, 'Login did not return a token.');
  assert.equal(
    result.user?.isPrimaryOwner,
    true,
    'Regression login must be a primary owner so created transactions can be voided during cleanup.'
  );

  return result.token;
}

async function resolveBatch(token) {
  if (config.batchId) {
    return { id: config.batchId, source: 'REGRESSION_BATCH_ID' };
  }

  try {
    const activeBatch = await apiRequest('/api/batches/active', { token });
    if (activeBatch?.id) {
      return { ...activeBatch, source: '/api/batches/active' };
    }
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  const batches = await apiRequest('/api/batches', { token });
  assert.ok(Array.isArray(batches) && batches.length > 0, 'No batch is available for regression testing.');

  return {
    ...(batches.find((batch) => String(batch.status).toUpperCase() === 'ACTIVE') || batches[0]),
    source: '/api/batches fallback',
  };
}

async function parseQuickEntry(token, text) {
  const result = await apiRequest('/api/quick-entry', {
    method: 'POST',
    token,
    body: {
      text,
      today: config.today,
      building: 'All',
      paidBy: config.paidBy,
    },
  });

  assert.ok(result.parsed, `Quick entry did not return parsed data for "${text}".`);
  return result.parsed;
}

async function saveTransaction(token, batchId, parsed, createdTransactionIds) {
  const saved = await apiRequest(`/api/batches/${encodeURIComponent(batchId)}/transactions`, {
    method: 'POST',
    token,
    body: transactionPayloadFromParsed(parsed),
  });

  assert.ok(saved.id, 'Saved transaction did not return an id.');
  createdTransactionIds.push(saved.id);
  return saved;
}

async function getPaySummary(token, batchId) {
  const summary = await apiRequest(`/api/batches/${encodeURIComponent(batchId)}/employee-pay-summary`, { token });

  assert.ok(Array.isArray(summary.rows), 'Employee pay summary did not return rows.');
  return summary;
}

async function cleanupTransactions(token, batchId, transactionIds) {
  const cleanupErrors = [];

  for (const transactionId of [...transactionIds].reverse()) {
    try {
      await apiRequest(
        `/api/batches/${encodeURIComponent(batchId)}/transactions/${encodeURIComponent(transactionId)}/void`,
        {
          method: 'POST',
          token,
          body: { reason: 'Automated regression cleanup' },
        }
      );
      transactionIds.splice(transactionIds.indexOf(transactionId), 1);
      console.log(`ok cleanup voided ${transactionId}`);
    } catch (error) {
      if (error.status === 409) {
        transactionIds.splice(transactionIds.indexOf(transactionId), 1);
        continue;
      }

      cleanupErrors.push(error);
    }
  }

  if (cleanupErrors.length > 0) {
    throw new Error(cleanupErrors.map((error) => error.message).join('\n'));
  }
}

function assertCashAdvanceParse(parsed) {
  assert.equal(parsed.type, 'Adjustment', 'Cash advance should parse as an Adjustment.');
  assert.equal(parsed.fundingNature, 'Receivable', 'Cash advance should use Receivable funding.');
  assert.equal(parsed.category, 'Cash Advance', 'Cash advance should use the Cash Advance category.');
  assert.equal(Number(parsed.amount), config.advanceAmount, 'Cash advance amount did not match.');
  assert.ok(sameName(parsed.paidBy, config.paidBy), 'Cash advance paidBy did not match the configured payer.');
  assert.ok(sameName(parsed.paidTo, config.employeeName), 'Cash advance paidTo did not match the employee.');
}

function assertReimbursementParse(parsed) {
  assert.ok(
    ['Payment', 'Reimbursement'].includes(parsed.type),
    'Reimbursement should parse as a Payment or Reimbursement transaction.'
  );
  assert.equal(parsed.fundingNature, 'Receivable', 'Reimbursement should use Receivable funding.');
  assert.equal(parsed.category, 'Reimbursement', 'Reimbursement should use the Reimbursement category.');
  assert.equal(Number(parsed.amount), config.reimbursementAmount, 'Reimbursement amount did not match.');
  assert.ok(sameName(parsed.paidBy, config.employeeName), 'Reimbursement paidBy did not match the employee.');
}

async function runRegression(context) {
  const token = await login();
  context.token = token;

  const batch = await resolveBatch(token);
  context.batchId = batch.id;

  console.log(`Using API: ${config.apiBase}`);
  console.log(`Using batch: ${batch.id} (${batch.source})`);
  console.log(`Using employee: ${config.employeeName}`);

  const summaryBefore = await getPaySummary(token, batch.id);
  assertEmployeeExists(summaryBefore, config.employeeName);

  const cashAdvanceText = `${config.employeeName} cash advance ${config.advanceAmount}`;
  const reimbursementText = `${config.employeeName} paid balance ${config.reimbursementAmount}`;

  const cashAdvanceParsed = await parseQuickEntry(token, cashAdvanceText);
  assertCashAdvanceParse(cashAdvanceParsed);
  console.log('ok quick-entry parsed cash advance');

  const cashAdvance = await saveTransaction(token, batch.id, cashAdvanceParsed, context.createdTransactionIds);
  assert.equal(cashAdvance.category, 'Cash Advance', 'Saved cash advance category did not match.');
  assert.ok(sameName(cashAdvance.paidTo, config.employeeName), 'Saved cash advance paidTo did not match.');
  console.log(`ok saved cash advance ${cashAdvance.id}`);

  const summaryAfterAdvance = await getPaySummary(token, batch.id);
  assertSummaryDelta(
    summaryBefore,
    summaryAfterAdvance,
    config.employeeName,
    'cashAdvance',
    config.advanceAmount,
    'Cash advance summary delta'
  );
  assertSummaryDelta(
    summaryBefore,
    summaryAfterAdvance,
    config.employeeName,
    'outstandingAdvance',
    config.advanceAmount,
    'Outstanding advance after cash advance'
  );
  console.log('ok employee pay summary reflected cash advance');

  const reimbursementParsed = await parseQuickEntry(token, reimbursementText);
  assertReimbursementParse(reimbursementParsed);
  console.log('ok quick-entry parsed reimbursement');

  const reimbursement = await saveTransaction(token, batch.id, reimbursementParsed, context.createdTransactionIds);
  assert.equal(reimbursement.category, 'Reimbursement', 'Saved reimbursement category did not match.');
  assert.ok(sameName(reimbursement.paidBy, config.employeeName), 'Saved reimbursement paidBy did not match.');
  console.log(`ok saved reimbursement ${reimbursement.id}`);

  const summaryAfterReimbursement = await getPaySummary(token, batch.id);
  assertSummaryDelta(
    summaryBefore,
    summaryAfterReimbursement,
    config.employeeName,
    'cashAdvance',
    config.advanceAmount,
    'Cash advance summary delta after reimbursement'
  );
  assertSummaryDelta(
    summaryBefore,
    summaryAfterReimbursement,
    config.employeeName,
    'reimbursement',
    config.reimbursementAmount,
    'Reimbursement summary delta'
  );
  assertSummaryDelta(
    summaryBefore,
    summaryAfterReimbursement,
    config.employeeName,
    'outstandingAdvance',
    config.advanceAmount - config.reimbursementAmount,
    'Outstanding advance after reimbursement'
  );
  console.log('ok employee pay summary reflected reimbursement');

  await cleanupTransactions(token, batch.id, context.createdTransactionIds);

  const summaryAfterCleanup = await getPaySummary(token, batch.id);
  assertSummaryDelta(
    summaryBefore,
    summaryAfterCleanup,
    config.employeeName,
    'cashAdvance',
    0,
    'Cash advance summary cleanup delta'
  );
  assertSummaryDelta(
    summaryBefore,
    summaryAfterCleanup,
    config.employeeName,
    'reimbursement',
    0,
    'Reimbursement summary cleanup delta'
  );
  assertSummaryDelta(
    summaryBefore,
    summaryAfterCleanup,
    config.employeeName,
    'outstandingAdvance',
    0,
    'Outstanding advance cleanup delta'
  );
  console.log('ok cleanup restored employee pay summary totals');
}

async function main() {
  const context = {
    token: '',
    batchId: '',
    createdTransactionIds: [],
  };
  let runError = null;
  let cleanupError = null;
  let serverProcess = null;

  try {
    const isHealthy = await checkApiHealth(config.apiBase);
    if (!isHealthy) {
      console.log(`API at ${config.apiBase} is not running. Starting API server...`);
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
        throw new Error(`Failed to start API server at ${config.apiBase} within 5 seconds.`);
      }
      console.log('API server started and healthy.');
    } else {
      console.log(`API at ${config.apiBase} is already running.`);
    }

    await runRegression(context);
  } catch (error) {
    runError = error;
  } finally {
    if (context.token && context.batchId && context.createdTransactionIds.length > 0) {
      try {
        await cleanupTransactions(context.token, context.batchId, context.createdTransactionIds);
      } catch (error) {
        cleanupError = error;
      }
    }

    if (serverProcess) {
      console.log('Stopping spawned API server...');
      serverProcess.kill();
    }
  }

  if (cleanupError) {
    console.error('Cleanup failed:');
    console.error(cleanupError.message);
  }

  if (runError) {
    throw runError;
  }

  if (cleanupError) {
    process.exitCode = 1;
    return;
  }

  console.log('cash advance/reimbursement regression passed');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
