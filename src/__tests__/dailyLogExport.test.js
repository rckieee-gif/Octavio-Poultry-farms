const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { mockQuery, clearMocks } = require('./dbMock');
const {
  DAILY_LOG_EXPORT_HEADERS,
  buildDailyLogsCsv,
  formatUtcTimestamp,
  normalizeExportBuilding,
} = require('../services/dailyLogExport.service');

process.env.JWT_SECRET = 'test-jwt-secret-key-12345';
process.env.NODE_ENV = 'test';

const app = require('../app');
const { JWT_SIGNING_SECRET } = require('../middleware/auth');

const HEADER = 'id,batch_id,date,building,employee,handled_birds_snapshot,feed_item,feed_consumed,mortality,average_weight_g,estimated_weight_g,actual_fcr,estimated_fcr,remarks,created_at';

test.describe('Daily log CSV export formatting', () => {
  test.it('builds the exact daily log CSV shape with UTC dates and newest id first', () => {
    const csv = buildDailyLogsCsv([
      {
        id: 185,
        batch_id: '20260604-02',
        date: '2026-06-23',
        building: 'BLD C',
        employee: 'Enjay',
        handled_birds_snapshot: 6000,
        feed_item: 'Starter Feed',
        feed_consumed: 2,
        mortality: 17,
        average_weight_g: null,
        remarks: null,
        created_at: '2026-06-23T12:23:05.000Z',
      },
      {
        id: 186,
        batch_id: '20260604-02',
        date: '2026-06-23',
        building: 'Building A',
        employee: 'Ianrey',
        handled_birds_snapshot: 5000,
        feed_item: 'Starter Feed',
        feed_consumed: '2',
        mortality: 6,
        average_weight_g: undefined,
        remarks: '',
        created_at: '2026-07-02T17:44:29.000Z',
      },
    ]);

    const lines = csv.split('\r\n');

    assert.equal(lines[0], HEADER);
    assert.equal(
      lines[1],
      '186,20260604-02,Tue Jun 23 2026 00:00:00 GMT+0000 (Coordinated Universal Time),A,Ianrey,5000,Starter Feed,2.00,6,,,,,,Thu Jul 02 2026 17:44:29 GMT+0000 (Coordinated Universal Time)'
    );
    assert.equal(
      lines[2],
      '185,20260604-02,Tue Jun 23 2026 00:00:00 GMT+0000 (Coordinated Universal Time),C,Enjay,6000,Starter Feed,2.00,17,,,,,,Tue Jun 23 2026 12:23:05 GMT+0000 (Coordinated Universal Time)'
    );
  });

  test.it('uses created_at descending when ids are missing', () => {
    const rows = buildDailyLogsCsv([
      { batch_id: 'batch-1', created_at: '2026-06-23T10:00:00.000Z', employee: 'Older' },
      { batch_id: 'batch-1', created_at: '2026-06-23T12:00:00.000Z', employee: 'Newer' },
    ]).split('\r\n');

    assert.match(rows[1], /,Newer,/);
    assert.match(rows[2], /,Older,/);
  });

  test.it('escapes commas, quotes, and line breaks in CSV cells', () => {
    const csv = buildDailyLogsCsv([
      {
        id: 10,
        batch_id: 'batch-1',
        date: '2026-06-23',
        building: 'A-01',
        employee: 'Ian, "Boss"',
        handled_birds_snapshot: 5000,
        feed_item: 'Starter, Feed',
        feed_consumed: 1.5,
        mortality: 2,
        average_weight_g: 900,
        remarks: 'Line one\nLine "two"',
        created_at: '2026-06-23T12:23:05.000Z',
      },
    ]);

    assert.equal(
      csv,
      [
        HEADER,
        '10,batch-1,Tue Jun 23 2026 00:00:00 GMT+0000 (Coordinated Universal Time),A,"Ian, ""Boss""",5000,"Starter, Feed",1.50,2,900,,0.02,,"Line one\nLine ""two""",Tue Jun 23 2026 12:23:05 GMT+0000 (Coordinated Universal Time)',
      ].join('\r\n')
    );
  });

  test.it('normalizes common building labels to simple letters', () => {
    assert.equal(normalizeExportBuilding('Building A'), 'A');
    assert.equal(normalizeExportBuilding('BLD B'), 'B');
    assert.equal(normalizeExportBuilding('C-01'), 'C');
    assert.equal(normalizeExportBuilding('All'), 'All');
  });

  test.it('exposes the exact header order and UTC timestamp formatter', () => {
    assert.equal(DAILY_LOG_EXPORT_HEADERS.join(','), HEADER);
    assert.equal(
      formatUtcTimestamp('2026-06-24T01:23:05+08:00'),
      'Tue Jun 23 2026 17:23:05 GMT+0000 (Coordinated Universal Time)'
    );
    assert.equal(
      formatUtcTimestamp('2026-06-23', { forceMidnight: true }),
      'Tue Jun 23 2026 00:00:00 GMT+0000 (Coordinated Universal Time)'
    );
  });
});

test.describe('Daily log CSV export route', () => {
  let server;
  let apiBase;
  let token;

  const mockUser = {
    id: 'user-uuid-123',
    farm_id: 'farm-uuid-abc',
    email: 'manager@farm.com',
    username: 'manager',
    role: 'OperationManager',
    is_active: true,
    is_primary_owner: false,
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

  test.it('exports daily logs for the requested batch with the batch id in the filename', async () => {
    mockQuery(/FROM\s+daily_logs\s+dl/, (sql, params) => {
      assert.match(sql, /dl\.batch_id = \$2/);
      assert.match(sql, /ORDER BY dl\.id DESC, dl\.created_at DESC/);
      assert.deepEqual(params, ['farm-uuid-abc', '20260604-02']);

      return {
        rows: [
          {
            id: 185,
            batch_id: '20260604-02',
            date: '2026-06-23',
            building: 'Building C',
            employee: 'Enjay',
            handled_birds_snapshot: 6000,
            feed_item: 'Starter Feed',
            feed_consumed: 2,
            mortality: 17,
            average_weight_g: null,
            remarks: null,
            created_at: '2026-06-23T12:23:05.000Z',
          },
        ],
        rowCount: 1,
      };
    });

    const response = await fetch(`${apiBase}/api/settings/export?dataset=daily_logs&batchId=20260604-02`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.match(
      response.headers.get('content-disposition'),
      /filename="octavio-daily-logs-20260604-02\.csv"/
    );

    const text = await response.text();
    assert.equal(text.split('\r\n')[0], HEADER);
    assert.match(text, /^185,20260604-02,Tue Jun 23 2026 00:00:00 GMT\+0000 \(Coordinated Universal Time\),C,Enjay,6000,Starter Feed,2\.00,17,,,,,,Tue Jun 23 2026 12:23:05 GMT\+0000 \(Coordinated Universal Time\)$/m);
  });

  test.it('rejects daily log exports without a selected batch', async () => {
    const response = await fetch(`${apiBase}/api/settings/export?dataset=daily_logs`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 400);

    const body = await response.json();
    assert.equal(body.error, 'Daily log export requires a selected batch.');
  });
});
