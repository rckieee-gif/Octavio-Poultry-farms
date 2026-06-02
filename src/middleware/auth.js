const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { normalizeRole } = require('./roles');

const JWT_SECRET = process.env.JWT_SECRET;
const isDevOrTest = !process.env.NODE_ENV || ['development', 'test'].includes(process.env.NODE_ENV);

if (!isDevOrTest && !JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in deployed environments.');
}

const JWT_SIGNING_SECRET = JWT_SECRET || 'dev-only-secret';

async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization || '';
  let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token && req.headers.cookie) {
    const cookies = {};
    req.headers.cookie.split(';').forEach(c => {
      const parts = c.split('=');
      if (parts.length >= 2) {
        cookies[parts[0].trim()] = parts.slice(1).join('=').trim();
      }
    });
    if (cookies.token) {
      try {
        token = decodeURIComponent(cookies.token);
      } catch {
        token = cookies.token;
      }
    }
  }

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

    req.token = token;
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
    return res.status(403).json({ error: 'Only the primary owner can perform this action.' });
  }
  next();
}

module.exports = {
  authenticate,
  requirePrimaryOwner,
  JWT_SIGNING_SECRET,
};
