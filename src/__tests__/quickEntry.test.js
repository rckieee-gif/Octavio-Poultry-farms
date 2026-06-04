const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { parseQuickEntry } = require('../../lib/quickEntryParser');

// Set env variables
process.env.JWT_SECRET = 'test-jwt-secret-key-12345';
process.env.NODE_ENV = 'test';
process.env.AI_PARSER_DISABLED = 'true';

const app = require('../app');
const { JWT_SIGNING_SECRET } = require('../middleware/auth');
const { mockQuery, clearMocks } = require('./dbMock');

test.describe('Quick Entry Parser & Route', () => {
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
    is_primary_owner: false,
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

  test.describe('Rule-Based Parser Unit Tests', () => {
    const today = '2026-06-01';

    test.it('should parse feed opex in English/matching rule', () => {
      const parsed = parseQuickEntry('3 bags feeds at 1500 yesterday', { today });
      assert.equal(parsed.type, 'Expense');
      assert.equal(parsed.fundingNature, 'OPEX');
      assert.equal(parsed.category, 'Feed');
      assert.equal(parsed.amount, 4500);
      assert.equal(parsed.quantity, 3);
      assert.equal(parsed.unitPrice, 1500);
      assert.equal(parsed.date, '2026-05-31'); // yesterday
    });

    test.it('should parse cash advance in English/matching rule', () => {
      const parsed = parseQuickEntry('ca Jane 600', { today });
      assert.equal(parsed.type, 'Adjustment');
      assert.equal(parsed.fundingNature, 'Receivable');
      assert.equal(parsed.category, 'Cash Advance');
      assert.equal(parsed.amount, 600);
      assert.equal(parsed.paidTo, 'Jane');
    });

    test.it('should parse receivable customer payment in Bisaya', () => {
      const parsed = parseQuickEntry('bayad sa utang si Cardo 1500 gahapon', { today });
      assert.equal(parsed.type, 'Payment');
      assert.equal(parsed.fundingNature, 'Receivable');
      assert.equal(parsed.category, 'Reimbursement');
      assert.equal(parsed.amount, 1500);
      assert.equal(parsed.paidBy, 'Cardo');
      assert.equal(parsed.date, '2026-05-31');
    });

    test.it('should parse utility bills in English', () => {
      const parsed = parseQuickEntry('water bill 2500 php today', { today });
      assert.equal(parsed.type, 'Expense');
      assert.equal(parsed.fundingNature, 'OPEX');
      assert.equal(parsed.category, 'Utilities');
      assert.equal(parsed.amount, 2500);
      assert.equal(parsed.date, '2026-06-01');
    });
  });

  test.describe('Quick Entry API Endpoint Tests', () => {
    test.it('should return successfully parsed result when AI is disabled (fallback to rules)', async () => {
      const response = await fetch(`${apiBase}/api/transactions/quick-entry`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          text: 'ca Jane 600',
          today: '2026-06-01'
        })
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.parserMode, 'rules');
      assert.equal(body.parserModel, 'rules');
      assert.equal(body.parsed.type, 'Adjustment');
      assert.equal(body.parsed.amount, 600);
      assert.equal(body.parsed.paidTo, 'Jane');
    });

    test.it('should return 400 bad request if text is missing', async () => {
      const response = await fetch(`${apiBase}/api/transactions/quick-entry`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          today: '2026-06-01'
        })
      });

      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error, 'Transaction text is required.');
    });
  });
});
