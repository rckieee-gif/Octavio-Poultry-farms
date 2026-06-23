const express = require('express');
const { pool, getDefaultFarmId } = require('../db');
const { authenticate, requirePrimaryOwner } = require('../middleware/auth');
const { requireMinimumRole } = require('../middleware/roles');
const { validate, employeeSchema, employeeCompensationSchema } = require('../middleware/validate');
const {
  mapEmployee,
  buildEmployeeMetadata,
  getEmployeeById,
  mapEmployeeCompensation,
  buildEmployeePaySummaryRows,
  normalizeHandledBirds,
  normalizeRatePerBird,
} = require('../services/payroll.service');
const { auditLog } = require('../services/transactions.service');

const router = express.Router();

// 1. Employee Profile Routes
router.get('/', authenticate, requireMinimumRole('OperationManager'), async (req, res, next) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const result = await pool.query(
      `SELECT
         id,
         name,
         COALESCE(display_name, name) AS "displayName",
         phone,
         email,
         address,
         metadata,
         is_active AS "isActive"
       FROM stakeholders
       WHERE farm_id = $1
         AND type = 'Employee'
         AND is_active = true
         AND lower(COALESCE(display_name, name)) NOT IN ('others', 'viewer', 'viewers')
         AND NOT EXISTS (
           SELECT 1
           FROM users u
           WHERE u.stakeholder_id = stakeholders.id
             AND u.role = 'Viewer'
         )
       ORDER BY COALESCE(display_name, name), name`,
      [farmId]
    );

    res.json(result.rows.map(mapEmployee));
  } catch (err) {
    next(err);
  }
});

router.post('/', authenticate, requireMinimumRole('OperationManager'), validate(employeeSchema), async (req, res, next) => {
  const {
    name,
    displayName,
    phone,
    email,
    address,
    position,
    hireDate,
    assignedBuilding,
    notes,
  } = req.body;

  if (!name?.trim()) {
    return res.status(400).json({ error: 'Employee name is required' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const existing = await client.query(
      `SELECT *
       FROM stakeholders
       WHERE farm_id = $1
         AND lower(name) = lower($2)
       LIMIT 1
       FOR UPDATE`,
      [farmId, name.trim()]
    );

    if (existing.rowCount > 0 && existing.rows[0].type !== 'Employee') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A non-employee stakeholder already uses this name.' });
    }

    const metadata = buildEmployeeMetadata({
      position,
      hireDate,
      assignedBuilding,
      notes,
    });

    let employeeId;
    let beforeData = null;

    if (existing.rowCount > 0) {
      beforeData = existing.rows[0];
      const updated = await client.query(
        `UPDATE stakeholders
         SET display_name = $1,
             phone = $2,
             email = $3,
             address = $4,
             metadata = $5,
             is_active = true
         WHERE id = $6
         RETURNING id`,
        [
          displayName || name.trim(),
          phone || null,
          email || null,
          address || null,
          JSON.stringify(metadata),
          existing.rows[0].id,
        ]
      );
      employeeId = updated.rows[0].id;
    } else {
      const inserted = await client.query(
        `INSERT INTO stakeholders
           (farm_id, name, display_name, type, phone, email, address, metadata)
         VALUES
           ($1, $2, $3, 'Employee', $4, $5, $6, $7)
         RETURNING id`,
        [
          farmId,
          name.trim(),
          displayName || name.trim(),
          phone || null,
          email || null,
          address || null,
          JSON.stringify(metadata),
        ]
      );
      employeeId = inserted.rows[0].id;
    }

    const saved = await getEmployeeById(employeeId, client);
    await auditLog(client, req, existing.rowCount > 0 ? 'update' : 'create', 'employee', employeeId, beforeData, saved);
    await client.query('COMMIT');

    res.status(existing.rowCount > 0 ? 200 : 201).json(saved);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.patch('/:id', authenticate, requirePrimaryOwner, validate(employeeSchema), async (req, res, next) => {
  const {
    name,
    displayName,
    phone,
    email,
    address,
    position,
    hireDate,
    assignedBuilding,
    notes,
  } = req.body;

  if (!name?.trim()) {
    return res.status(400).json({ error: 'Employee name is required' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const before = await client.query(
      `SELECT *
       FROM stakeholders
       WHERE id = $1
         AND farm_id = $2
         AND type = 'Employee'
       FOR UPDATE`,
      [req.params.id, farmId]
    );

    if (before.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found' });
    }

    const duplicate = await client.query(
      `SELECT id
       FROM stakeholders
       WHERE farm_id = $1
         AND lower(name) = lower($2)
         AND id <> $3
       LIMIT 1`,
      [farmId, name.trim(), req.params.id]
    );

    if (duplicate.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Another stakeholder already uses this name.' });
    }

    const metadata = buildEmployeeMetadata({
      position,
      hireDate,
      assignedBuilding,
      notes,
    });

    await client.query(
      `UPDATE stakeholders
       SET name = $1,
           display_name = $2,
           phone = $3,
           email = $4,
           address = $5,
           metadata = $6,
           is_active = true
       WHERE id = $7`,
      [
        name.trim(),
        displayName || name.trim(),
        phone || null,
        email || null,
        address || null,
        JSON.stringify(metadata),
        req.params.id,
      ]
    );

    const saved = await getEmployeeById(req.params.id, client);
    await auditLog(client, req, 'update', 'employee', req.params.id, before.rows[0], saved);
    await client.query('COMMIT');

    res.json(saved);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id', authenticate, requirePrimaryOwner, async (req, res, next) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const before = await client.query(
      `SELECT *
       FROM stakeholders
       WHERE id = $1
         AND farm_id = $2
         AND type = 'Employee'
       FOR UPDATE`,
      [req.params.id, farmId]
    );

    if (before.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found' });
    }

    await client.query(
      'UPDATE stakeholders SET is_active = false WHERE id = $1',
      [req.params.id]
    );
    await auditLog(client, req, 'delete', 'employee', req.params.id, before.rows[0], null);
    await client.query('COMMIT');

    res.json({ message: 'Employee archived' });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// 2. Employee Batch-Compensation and Payroll Routes
router.get('/batches/:batchId/employee-compensations', authenticate, requireMinimumRole('OperationManager'), async (req, res, next) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const batchCheck = await pool.query('SELECT id FROM batches WHERE id = $1 AND farm_id = $2', [req.params.batchId, farmId]);
    if (batchCheck.rowCount === 0) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    const result = await pool.query(
      `SELECT
         s.id AS "employeeId",
         COALESCE(s.display_name, s.name) AS "employeeName",
         s.metadata,
         ebc.batch_id AS "batchId",
         ebc.handled_birds AS "handledBirds",
         ebc.rate_per_bird AS "ratePerBird",
         ebc.corpo_group AS "corpoGroup",
         ebc.remarks
       FROM stakeholders s
       LEFT JOIN employee_batch_compensations ebc
         ON ebc.employee_id = s.id
        AND ebc.batch_id = $2
       WHERE s.farm_id = $1
         AND s.type = 'Employee'
         AND s.is_active = true
         AND lower(COALESCE(s.display_name, s.name)) NOT IN ('others', 'viewer', 'viewers')
         AND NOT EXISTS (
           SELECT 1
           FROM users u
           WHERE u.stakeholder_id = s.id
             AND u.role = 'Viewer'
         )
       ORDER BY COALESCE(s.display_name, s.name), s.name`,
      [farmId, req.params.batchId]
    );

    res.json(result.rows.map(mapEmployeeCompensation));
  } catch (err) {
    next(err);
  }
});

router.get('/batches/:batchId/employee-pay-summary', authenticate, requireMinimumRole('OperationManager'), async (req, res, next) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const batch = await pool.query(
      'SELECT id FROM batches WHERE id = $1 AND farm_id = $2',
      [req.params.batchId, farmId]
    );

    if (batch.rowCount === 0) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    const [compensations, transactions, dailyLogs, batchLoadings] = await Promise.all([
      pool.query(
        `SELECT
           s.id AS "employeeId",
           COALESCE(s.display_name, s.name) AS "employeeName",
           s.metadata,
           ebc.batch_id AS "batchId",
           ebc.handled_birds AS "handledBirds",
           ebc.rate_per_bird AS "ratePerBird",
           ebc.corpo_group AS "corpoGroup",
           ebc.remarks
         FROM stakeholders s
         LEFT JOIN employee_batch_compensations ebc
           ON ebc.employee_id = s.id
          AND ebc.batch_id = $2
         WHERE s.farm_id = $1
           AND s.type = 'Employee'
           AND s.is_active = true
           AND lower(COALESCE(s.display_name, s.name)) NOT IN ('others', 'viewer', 'viewers')
           AND NOT EXISTS (
             SELECT 1
             FROM users u
             WHERE u.stakeholder_id = s.id
               AND u.role = 'Viewer'
           )
         ORDER BY COALESCE(s.display_name, s.name), s.name`,
        [farmId, req.params.batchId]
      ),
      pool.query(
        `SELECT
           dt.type,
           dt.funding_nature AS "fundingNature",
           COALESCE(c.name, dt.category) AS category,
           dt.amount,
           paid_by.name AS "paidBy",
           COALESCE(paid_by.display_name, paid_by.name) AS "paidByDisplayName",
           paid_to.name AS "paidTo",
           COALESCE(paid_to.display_name, paid_to.name) AS "paidToDisplayName"
         FROM daily_transactions dt
         LEFT JOIN categories c ON c.id = dt.category_id
         LEFT JOIN stakeholders paid_by ON paid_by.id = dt.paid_by
         LEFT JOIN stakeholders paid_to ON paid_to.id = dt.paid_to
         WHERE dt.batch_id = $1
           AND dt.is_void = false`,
        [req.params.batchId]
      ),
      pool.query(
        `SELECT
           employee_id AS "employeeId",
           COALESCE(SUM(mortality), 0) AS mortality
         FROM daily_logs
         WHERE batch_id = $1
         GROUP BY employee_id`,
        [req.params.batchId]
      ),
      pool.query(
        `SELECT
           b.name AS building,
           CASE
             WHEN ba.actual_chicks_arrived > 0 THEN COALESCE(bbl.net_chicks_placed, 0)
             ELSE 0
           END AS "buildingChicksLoaded"
         FROM batch_building_loadings bbl
         JOIN batches ba ON ba.id = bbl.batch_id
         JOIN buildings b ON b.id = bbl.building_id
         WHERE bbl.batch_id = $1`,
        [req.params.batchId]
      ),
    ]);

    const rows = buildEmployeePaySummaryRows(compensations.rows, transactions.rows, dailyLogs.rows, batchLoadings.rows);
    const totals = rows.reduce((sum, row) => ({
      grossHandledBirds: sum.grossHandledBirds + row.grossHandledBirds,
      mortality: sum.mortality + row.mortality,
      netHandledBirds: sum.netHandledBirds + row.netHandledBirds,
      payableBirds: sum.payableBirds + row.payableBirds,
      cycleIncome: sum.cycleIncome + row.cycleIncome,
      laborPaid: sum.laborPaid + row.laborPaid,
      outstandingAdvance: sum.outstandingAdvance + row.outstandingAdvance,
      remainingCyclePay: sum.remainingCyclePay + row.remainingCyclePay,
      netPayable: sum.netPayable + row.netPayable,
    }), {
      grossHandledBirds: 0,
      mortality: 0,
      netHandledBirds: 0,
      payableBirds: 0,
      cycleIncome: 0,
      laborPaid: 0,
      outstandingAdvance: 0,
      remainingCyclePay: 0,
      netPayable: 0,
    });

    res.json({ batchId: req.params.batchId, totals, rows });
  } catch (err) {
    next(err);
  }
});

router.put('/batches/:batchId/employee-compensations/:employeeId', authenticate, requirePrimaryOwner, validate(employeeCompensationSchema), async (req, res, next) => {
  const client = await pool.connect();

  try {
    let handledBirds;
    let ratePerBird;
    try {
      handledBirds = normalizeHandledBirds(req.body.handledBirds);
      ratePerBird = normalizeRatePerBird(req.body.ratePerBird);
    } catch (validationErr) {
      client.release();
      return res.status(400).json({ error: validationErr.message });
    }
    const corpoGroup = req.body.corpoGroup?.trim() || null;
    const remarks = req.body.remarks || null;

    await client.query('BEGIN');

    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const batch = await client.query(
      'SELECT id FROM batches WHERE id = $1 AND farm_id = $2',
      [req.params.batchId, farmId]
    );

    if (batch.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Batch not found' });
    }

    const employee = await client.query(
      `SELECT id
       FROM stakeholders
       WHERE id = $1
         AND farm_id = $2
         AND type = 'Employee'
         AND is_active = true`,
      [req.params.employeeId, farmId]
    );

    if (employee.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found' });
    }

    const before = await client.query(
      `SELECT *
       FROM employee_batch_compensations
       WHERE batch_id = $1
         AND employee_id = $2
       FOR UPDATE`,
      [req.params.batchId, req.params.employeeId]
    );

    const result = await client.query(
      `INSERT INTO employee_batch_compensations
         (farm_id, batch_id, employee_id, handled_birds, rate_per_bird, corpo_group, remarks, created_by_user_id, updated_by_user_id)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       ON CONFLICT (batch_id, employee_id)
       DO UPDATE SET
         handled_birds = EXCLUDED.handled_birds,
         rate_per_bird = EXCLUDED.rate_per_bird,
         corpo_group = EXCLUDED.corpo_group,
         remarks = EXCLUDED.remarks,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = now()
       RETURNING *`,
      [
        farmId,
        req.params.batchId,
        req.params.employeeId,
        handledBirds,
        ratePerBird,
        corpoGroup,
        remarks,
        req.user.id,
      ]
    );

    await auditLog(
      client,
      req,
      before.rowCount > 0 ? 'update' : 'create',
      'employee_batch_compensation',
      `${req.params.batchId}:${req.params.employeeId}`,
      before.rows[0] || null,
      result.rows[0],
      req.params.batchId
    );
    await client.query('COMMIT');

    const saved = await pool.query(
      `SELECT
         s.id AS "employeeId",
         COALESCE(s.display_name, s.name) AS "employeeName",
         s.metadata,
         ebc.batch_id AS "batchId",
         ebc.handled_birds AS "handledBirds",
         ebc.rate_per_bird AS "ratePerBird",
         ebc.corpo_group AS "corpoGroup",
         ebc.remarks
       FROM employee_batch_compensations ebc
       JOIN stakeholders s ON s.id = ebc.employee_id
       WHERE ebc.batch_id = $1
         AND ebc.employee_id = $2`,
      [req.params.batchId, req.params.employeeId]
    );

    res.json(mapEmployeeCompensation(saved.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.get('/batches/:batchId/employee-assignments', authenticate, async (req, res, next) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const batchCheck = await pool.query('SELECT id FROM batches WHERE id = $1 AND farm_id = $2', [req.params.batchId, farmId]);
    if (batchCheck.rowCount === 0) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    const result = await pool.query(
      `SELECT
         s.id AS "employeeId",
         COALESCE(s.display_name, s.name) AS "employeeName",
         s.metadata,
         COALESCE(ebc.handled_birds, 0) AS "handledBirds",
         CASE
           WHEN ba.actual_chicks_arrived > 0 THEN COALESCE(bbl.net_chicks_placed, 0)
           ELSE 0
         END AS "buildingChicksLoaded",
         COALESCE(ebc.rate_per_bird, 1.5) AS "ratePerBird",
         ebc.corpo_group AS "corpoGroup",
         ebc.remarks
       FROM stakeholders s
       JOIN batches ba
         ON ba.id = $2
        AND ba.farm_id = $1
       LEFT JOIN employee_batch_compensations ebc
         ON ebc.employee_id = s.id
        AND ebc.batch_id = $2
       LEFT JOIN buildings b
         ON b.name = COALESCE(s.metadata->>'assignedBuilding', '')
       LEFT JOIN batch_building_loadings bbl
         ON bbl.batch_id = $2
        AND bbl.building_id = b.id
       WHERE s.farm_id = $1
         AND s.type = 'Employee'
         AND s.is_active = true
         AND lower(COALESCE(s.display_name, s.name)) NOT IN ('others', 'viewer', 'viewers')
         AND NOT EXISTS (
           SELECT 1
           FROM users u
           WHERE u.stakeholder_id = s.id
             AND u.role = 'Viewer'
         )
       ORDER BY COALESCE(s.display_name, s.name), s.name`,
      [farmId, req.params.batchId]
    );

    res.json(result.rows.map(mapEmployeeCompensation));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
