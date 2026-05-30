const express = require('express');
const { pool, getDefaultFarmId } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.get('/buildings', authenticate, async (req, res, next) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const result = await pool.query(
      `SELECT
         id,
         name,
         loading_share_percentage AS "loadingSharePercentage",
         sort_order AS "sortOrder"
       FROM buildings
       WHERE farm_id = $1
         AND is_active = true
       ORDER BY sort_order, name`,
      [farmId]
    );

    res.json(result.rows.map((row) => ({
      ...row,
      loadingSharePercentage: Number(row.loadingSharePercentage || 0)
    })));
  } catch (err) {
    next(err);
  }
});

router.get('/categories', authenticate, async (req, res, next) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const result = await pool.query(
      `SELECT
         id,
         funding_nature AS "fundingNature",
         name,
         sort_order AS "sortOrder"
       FROM categories
       WHERE farm_id = $1
         AND is_active = true
       ORDER BY funding_nature, sort_order, name`,
      [farmId]
    );

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.get('/stakeholders', authenticate, async (req, res, next) => {
  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const result = await pool.query(
      `SELECT
         id,
         name,
         COALESCE(display_name, name) AS "displayName",
         type,
         phone,
         email,
         address
       FROM stakeholders
       WHERE farm_id = $1
         AND is_active = true
       ORDER BY type, COALESCE(display_name, name), name`,
      [farmId]
    );

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
