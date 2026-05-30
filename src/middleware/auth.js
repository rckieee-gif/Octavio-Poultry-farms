const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { normalizeRole } = require('./roles');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_SIGNING_SECRET = JWT_SECRET || 'dev-only-secret';

async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, JWT_SIGNING_SECRET);
    const result = await pool.query(
      `SELECT id, farm_id, stakeholder_id, email, username, role, is_active, is_primary_owner
       FROM users
       WHERE id = $1`,
      [payload.userId]
    );

    if (result.rowCount === 0 || !result.rows[0].is_active) {
      return res.status(401).json({ error: 'Invalid user' });
    }

    req.user = {
      ...result.rows[0],
      role: normalizeRole(result.rows[0].role),
      is_primary_owner: Boolean(result.rows[0].is_primary_owner),
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requirePrimaryOwner(req, res, next) {
  if (!req.user?.is_primary_owner) {
    return res.status(403).json({ error: 'Only admin.roland can perform this action.' });
  }
  next();
}

module.exports = {
  authenticate,
  requirePrimaryOwner,
  JWT_SIGNING_SECRET,
};
