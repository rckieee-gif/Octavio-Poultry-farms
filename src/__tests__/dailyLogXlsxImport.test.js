const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const { mockQuery, clearMocks } = require('./dbMock');
const { parseDailyLogXlsx } = require('../services/dailyLogXlsxImport.service');

process.env.JWT_SECRET = 'test-jwt-secret-key-12345';
process.env.NODE_ENV = 'test';

const app = require('../app');
const { JWT_SIGNING_SECRET } = require('../middleware/auth');

async function buildDailyLogWorkbookBuffer() {
  const workbook = new ExcelJS.Workbook();
  const setup = workbook.addWorksheet('Setup');
  const dailyLog = workbook.addWorksheet('Daily Log');

  setup.getCell('B3').value = 'BATCH_20260620';

  dailyLog.getCell('A3').value = 'Date';
  dailyLog.getCell('B3').value = 'Age (days)';
  dailyLog.getCell('C3').value = 'Flockman';
  dailyLog.getCell('D3').value = 'Cage ID';
  dailyLog.getCell('E3').value = 'Building ID';
  dailyLog.getCell('F3').value = 'Birds Start';
  dailyLog.getCell('G3').value = 'Deaths';
  dailyLog.getCell('H3').value = 'Transfer/Out';
  dailyLog.getCell('I3').value = 'Birds End';
  dailyLog.getCell('J3').value = 'Feed Given (Sacks)';
  dailyLog.getCell('Q3').value = 'Weather Condition';
  dailyLog.getCell('R3').value = 'Observed Issue / Condition';
  dailyLog.getCell('S3').value = 'Remarks / Explanation';

  dailyLog.getCell('A4').value = 46193;
  dailyLog.getCell('B4').value = 0;
  dailyLog.getCell('C4').value = 'Ianrey';
  dailyLog.getCell('D4').value = 'A-01';
  dailyLog.getCell('E4').value = 'BLD A';
  dailyLog.getCell('F4').value = 5100;
  dailyLog.getCell('G4').value = 3;
  dailyLog.getCell('I4').value = 5097;
  dailyLog.getCell('J4').value = 1.5;
  dailyLog.getCell('Q4').value = 'Normal';

  dailyLog.getCell('A5').value = 46194;
  dailyLog.getCell('B5').value = 1;
  dailyLog.getCell('C5').value = 'Paul';
  dailyLog.getCell('D5').value = 'A-02';
  dailyLog.getCell('E5').value = 'BLD A';
  dailyLog.getCell('F5').value = 5097;
  dailyLog.getCell('G5').value = 6;
  dailyLog.getCell('H5').value = 1;
  dailyLog.getCell('I5').value = 5090;
  dailyLog.getCell('J5').value = 2;
  dailyLog.getCell('R5').value = 'Wet litter';
  dailyLog.getCell('S5').value = 'Changed bedding';

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

test.describe('daily log XLSX import parser', () => {
  test.it('maps the poultry monitoring workbook to daily log import rows', async () => {
    const rows = await parseDailyLogXlsx(await buildDailyLogWorkbookBuffer(), {
      batchId: 'BATCH_ACTIVE',
      defaultFeedItem: 'Grower Feed',
    });

    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      batch_id: 'BATCH_ACTIVE',
      date: '2026-06-20',
      building: 'A',
      employee: 'Ianrey',
      handled_birds_snapshot: 5100,
      feed_item: 'Grower Feed',
      feed_consumed: 1.5,
      mortality: 3,
      average_weight_g: '',
      remarks: 'Cage A-01 | Weather: Normal',
      import_source_key: 'poultry-daily-log:2026-06-20:A-01',
    });
    assert.equal(rows[1].remarks, 'Cage A-02 | Transfer/out: 1 | Issue: Wet litter | Note: Changed bedding');
  });

  test.it('ships the import source key migration', () => {
    const migration = fs.readFileSync(
      path.join(__dirname, '../../db/019_daily_log_import_source_key.sql'),
      'utf8'
    );

    assert.match(migration, /ADD COLUMN IF NOT EXISTS import_source_key text/i);
    assert.match(migration, /daily_logs_batch_import_source_key/i);
  });
});

test.describe('daily log XLSX import route', () => {
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

  test.it('dry-runs daily log XLSX uploads through the settings importer', async () => {
    mockQuery("status = 'ONGOING'", [{ id: 'BATCH_ACTIVE' }]);
    mockQuery('SELECT id FROM batches WHERE id = $1 AND farm_id = $2 LIMIT 1', [{ id: 'BATCH_ACTIVE' }]);
    mockQuery('INSERT INTO inventory_items', [{ id: 9 }]);
    mockQuery('INSERT INTO daily_logs', (() => {
      let nextId = 101;
      return () => ({ rows: [{ id: nextId++ }], rowCount: 1 });
    })());
    mockQuery('INSERT INTO inventory_movements', [{ id: 501 }]);

    const workbookBuffer = await buildDailyLogWorkbookBuffer();
    const response = await fetch(`${apiBase}/api/settings/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        importType: 'daily_logs',
        filename: 'Poultry_Performance_Monitoring_System_BATCH_20260620.xlsx',
        contentBase64: workbookBuffer.toString('base64'),
        options: { defaultFeedItem: 'Grower Feed' },
        dryRun: true,
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.isDryRun, true);
    assert.equal(body.summary.daily_logs.rowsRead, 2);
    assert.equal(body.summary.daily_logs.created, 2);
    assert.equal(body.summary.daily_logs.warnings.length, 0);
    assert.equal(body.previewRows[0].batch_id, 'BATCH_ACTIVE');
    assert.equal(body.previewRows[0].import_source_key, 'poultry-daily-log:2026-06-20:A-01');
    assert.equal(body.previewRows[0].feed_item, 'Grower Feed');
  });

  test.it('creates linked stock-out movements when committing daily log imports', async () => {
    const insertedMovements = [];

    mockQuery("status = 'ONGOING'", [{ id: 'BATCH_ACTIVE' }]);
    mockQuery('SELECT id FROM batches WHERE id = $1 AND farm_id = $2 LIMIT 1', [{ id: 'BATCH_ACTIVE' }]);
    mockQuery(/inventory_items[\s\S]*lower\(name\)\s*=\s*lower\(\$2\)/i, (sql, params) => {
      const name = params[1];
      if (name === 'DOC Chicks') {
        return { rows: [{ id: 10, name: 'DOC Chicks', category: 'Chicks', unit: 'heads' }], rowCount: 1 };
      }
      return { rows: [{ id: 9, name, category: 'Feed', unit: 'sacks' }], rowCount: 1 };
    });
    mockQuery('UPDATE inventory_items', []);
    mockQuery('INSERT INTO inventory_items', [{ id: 9 }]);
    mockQuery('INSERT INTO daily_logs', (() => {
      let nextId = 201;
      return () => ({ rows: [{ id: nextId++ }], rowCount: 1 });
    })());
    mockQuery('INSERT INTO inventory_movements', (sql, params) => {
      insertedMovements.push({
        batchId: params[1],
        itemId: params[2],
        movementDate: params[3],
        movementType: params[4],
        quantity: Number(params[5]),
        sourceType: params[9],
        sourceId: params[10],
        remarks: params[12],
      });
      return { rows: [{ id: 700 + insertedMovements.length }], rowCount: 1 };
    });

    const workbookBuffer = await buildDailyLogWorkbookBuffer();
    const response = await fetch(`${apiBase}/api/settings/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        importType: 'daily_logs',
        filename: 'Poultry_Performance_Monitoring_System_BATCH_20260620.xlsx',
        contentBase64: workbookBuffer.toString('base64'),
        options: { defaultFeedItem: 'Starter Feed' },
        dryRun: false,
      }),
    });

    assert.equal(response.status, 200);
    const feedMovements = insertedMovements.filter((movement) => movement.sourceType === 'daily_log_feed');
    const mortalityMovements = insertedMovements.filter((movement) => movement.sourceType === 'daily_log_mortality');

    assert.equal(feedMovements.length, 2);
    assert.equal(mortalityMovements.length, 2);
    assert.deepEqual(feedMovements.map((movement) => movement.quantity), [1.5, 2]);
    assert.equal(feedMovements[0].itemId, 9);
    assert.equal(feedMovements[0].movementType, 'Stock Out');
    assert.equal(feedMovements[0].sourceId, '201');
    assert.equal(mortalityMovements[0].itemId, 10);
  });
});
