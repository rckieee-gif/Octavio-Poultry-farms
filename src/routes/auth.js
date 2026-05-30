const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { authenticate, JWT_SIGNING_SECRET } = require('../middleware/auth');
const { normalizeRole } = require('../middleware/roles');

const router = express.Router();

router.post('/login', async (req, res, next) => {
  const login = (req.body.login || req.body.email || req.body.username || '').trim();
  const { password } = req.body;

  if (!login || !password) {
    return res.status(400).json({ error: 'Username/email and password are required' });
  }

  try {
    const userResult = await pool.query(
      `SELECT id, farm_id, stakeholder_id, email, username, password_hash, role, is_active, is_primary_owner
       FROM users
       WHERE lower(email) = lower($1)
          OR lower(username) = lower($1)
       LIMIT 1`,
      [login]
    );

    if (userResult.rowCount === 0 || !userResult.rows[0].is_active) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = userResult.rows[0];
    const isValidPassword = await bcrypt.compare(password, user.password_hash);

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

    const normalizedRole = normalizeRole(user.role);
    const token = jwt.sign(
      { userId: user.id, role: normalizedRole, email: user.email, username: user.username },
      JWT_SIGNING_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        email: user.email,
        username: user.username || '',
        role: normalizedRole,
        isPrimaryOwner: Boolean(user.is_primary_owner),
      },
    });
  } catch (err) {
    console.error('SERVER ERROR DURING LOGIN:', err);
    next(err);
  }
});

router.get('/me', authenticate, (req, res) => {
  res.json({
    user: {
      email: req.user.email,
      username: req.user.username || '',
      role: req.user.role,
      stakeholderId: req.user.stakeholder_id,
      isPrimaryOwner: Boolean(req.user.is_primary_owner),
    },
  });
});

router.post('/change-password', authenticate, async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required.' });
  }

  if (String(newPassword).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }

  try {
    const userResult = await pool.query(
      'SELECT id, password_hash FROM users WHERE id = $1 AND is_active = true LIMIT 1',
      [req.user.id]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const passwordMatches = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2',
      [newHash, req.user.id]
    );

    res.json({ message: 'Password changed successfully.' });
  } catch (err) {
    console.error('Failed to change password:', err);
    next(err);
  }
});

module.exports = router;
