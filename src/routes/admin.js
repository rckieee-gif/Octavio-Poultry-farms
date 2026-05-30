const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, getDefaultFarmId, ensureStakeholder } = require('../db');
const { authenticate, requirePrimaryOwner } = require('../middleware/auth');
const { normalizeRole } = require('../middleware/roles');
const { auditLog, getAuditLogs } = require('../services/transactions.service');

const router = express.Router();

router.get('/users', authenticate, requirePrimaryOwner, async (req, res, next) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const result = await pool.query(
      `SELECT
         u.id,
         u.email,
         u.username,
         u.role,
         u.is_active AS "isActive",
         u.is_primary_owner AS "isPrimaryOwner",
         u.last_login_at AS "lastLoginAt",
         u.created_at AS "createdAt",
         u.updated_at AS "updatedAt",
         u.stakeholder_id AS "stakeholderId",
         COALESCE(s.display_name, s.name) AS "stakeholderName",
         s.type AS "stakeholderType"
       FROM users u
       LEFT JOIN stakeholders s ON s.id = u.stakeholder_id
       WHERE u.farm_id = $1
       ORDER BY u.is_primary_owner DESC, u.is_active DESC, u.role, COALESCE(u.username, u.email)`,
      [farmId]
    );

    res.json(result.rows.map((row) => ({
      ...row,
      role: normalizeRole(row.role),
      isActive: Boolean(row.isActive),
      isPrimaryOwner: Boolean(row.isPrimaryOwner),
    })));
  } catch (err) {
    next(err);
  }
});

router.get('/audit-logs', authenticate, requirePrimaryOwner, async (req, res, next) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    res.json(await getAuditLogs({
      farmId,
      batchId: req.query.batchId || null,
      entityType: req.query.entityType || null,
      entityId: req.query.entityId || null,
      limit: req.query.limit || 150,
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/users', authenticate, requirePrimaryOwner, async (req, res, next) => {
  const {
    email,
    username,
    password,
    role = 'DataEntry',
    stakeholderName,
    stakeholderType = 'Employee',
  } = req.body;

  if (!email?.trim() || !password || !role) {
    return res.status(400).json({ error: 'Email, password, and role are required.' });
  }

  const normalizedRole = normalizeRole(role);

  if (!['AdminOwner', 'OperationManager', 'DataEntry', 'Viewer'].includes(normalizedRole)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const effectiveStakeholderType = normalizedRole === 'Viewer' ? 'Other' : (stakeholderType || 'Employee');
    const stakeholderId = stakeholderName?.trim()
      ? await ensureStakeholder(client, farmId, stakeholderName.trim(), effectiveStakeholderType)
      : null;
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await client.query(
      `INSERT INTO users
         (farm_id, stakeholder_id, email, username, password_hash, role, is_active, is_primary_owner)
       VALUES ($1, $2, $3, $4, $5, $6, true, false)
       RETURNING id, email, username, role, is_active AS "isActive", is_primary_owner AS "isPrimaryOwner", stakeholder_id AS "stakeholderId"`,
      [
        farmId,
        stakeholderId,
        email.trim(),
        username?.trim() || null,
        passwordHash,
        normalizedRole,
      ]
    );

    await auditLog(client, req, 'create', 'user', result.rows[0].id, null, {
      email: result.rows[0].email,
      username: result.rows[0].username,
      role: result.rows[0].role,
    });
    await client.query('COMMIT');

    res.status(201).json({
      ...result.rows[0],
      role: normalizeRole(result.rows[0].role),
      isActive: Boolean(result.rows[0].isActive),
      isPrimaryOwner: Boolean(result.rows[0].isPrimaryOwner),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email or username already exists.' });
    }
    next(err);
  } finally {
    client.release();
  }
});

router.patch('/users/:id', authenticate, requirePrimaryOwner, async (req, res, next) => {
  const {
    email,
    username,
    password,
    role,
    isActive,
    stakeholderName,
    stakeholderType = 'Employee',
  } = req.body;
  const userId = Number(req.params.id);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const before = await client.query(
      'SELECT * FROM users WHERE id = $1 AND farm_id = $2 FOR UPDATE',
      [userId, farmId]
    );

    if (before.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found.' });
    }

    if (before.rows[0].is_primary_owner && isActive === false) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The primary owner account cannot be disabled.' });
    }

    const passwordHash = password ? await bcrypt.hash(password, 10) : before.rows[0].password_hash;
    const nextRole = role ? normalizeRole(role) : normalizeRole(before.rows[0].role);

    if (!['AdminOwner', 'OperationManager', 'DataEntry', 'Viewer'].includes(nextRole)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid role.' });
    }

    const effectiveStakeholderType = nextRole === 'Viewer' ? 'Other' : (stakeholderType || 'Employee');
    const stakeholderId = stakeholderName?.trim()
      ? await ensureStakeholder(client, farmId, stakeholderName.trim(), effectiveStakeholderType)
      : before.rows[0].stakeholder_id;

    const result = await client.query(
      `UPDATE users
       SET email = $1,
           username = $2,
           password_hash = $3,
           role = $4,
           stakeholder_id = $5,
           is_active = $6,
           updated_at = now()
       WHERE id = $7
         AND farm_id = $8
       RETURNING id, email, username, role, is_active AS "isActive", is_primary_owner AS "isPrimaryOwner", stakeholder_id AS "stakeholderId"`,
      [
        email?.trim() || before.rows[0].email,
        username === undefined ? before.rows[0].username : (username?.trim() || null),
        passwordHash,
        nextRole,
        stakeholderId,
        isActive === undefined ? before.rows[0].is_active : Boolean(isActive),
        userId,
        farmId,
      ]
    );

    await auditLog(client, req, 'update', 'user', userId, before.rows[0], {
      email: result.rows[0].email,
      username: result.rows[0].username,
      role: result.rows[0].role,
      isActive: result.rows[0].isActive,
    });
    await client.query('COMMIT');

    res.json({
      ...result.rows[0],
      role: normalizeRole(result.rows[0].role),
      isActive: Boolean(result.rows[0].isActive),
      isPrimaryOwner: Boolean(result.rows[0].isPrimaryOwner),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email or username already exists.' });
    }
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/users/:id', authenticate, requirePrimaryOwner, async (req, res, next) => {
  const userId = Number(req.params.id);

  if (userId === req.user.id) {
    return res.status(400).json({ error: 'You cannot remove your own account.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const farmId = req.user.farm_id || await getDefaultFarmId(client);
    const before = await client.query(
      'SELECT * FROM users WHERE id = $1 AND farm_id = $2 FOR UPDATE',
      [userId, farmId]
    );

    if (before.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found.' });
    }

    if (before.rows[0].is_primary_owner) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The primary owner account cannot be removed.' });
    }

    await client.query(
      'UPDATE users SET is_active = false, updated_at = now() WHERE id = $1',
      [userId]
    );
    await auditLog(client, req, 'disable', 'user', userId, before.rows[0], { isActive: false });
    await client.query('COMMIT');

    res.json({ message: 'User account disabled.' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
