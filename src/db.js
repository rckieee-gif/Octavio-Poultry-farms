const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function getDefaultFarmId(client = pool) {
  const result = await client.query(
    "SELECT id FROM farms WHERE code = 'octavio' LIMIT 1"
  );

  if (result.rowCount === 0) {
    throw new Error('Default farm is not seeded. Run npm run db:seed in farm-backend.');
  }

  return result.rows[0].id;
}

async function ensureStakeholder(client, farmId, name, type = 'Supplier') {
  if (!name) return null;

  const existing = await client.query(
    'SELECT id FROM stakeholders WHERE lower(name) = lower($1) LIMIT 1',
    [name]
  );

  if (existing.rowCount > 0) return existing.rows[0].id;

  const inserted = await client.query(
    `INSERT INTO stakeholders (farm_id, name, display_name, type)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [farmId, name, name, type]
  );

  return inserted.rows[0].id;
}

async function ensureCategory(client, farmId, fundingNature, categoryName) {
  const dbFundingNature = fundingNature === 'Revenue' ? 'Other Revenue' : fundingNature;

  const existing = await client.query(
    `SELECT id
     FROM categories
     WHERE farm_id = $1
       AND funding_nature = $2
       AND lower(name) = lower($3)
     LIMIT 1`,
    [farmId, dbFundingNature, categoryName]
  );

  if (existing.rowCount > 0) return existing.rows[0].id;

  const inserted = await client.query(
    `INSERT INTO categories (farm_id, funding_nature, name)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [farmId, dbFundingNature, categoryName]
  );

  return inserted.rows[0].id;
}

async function getBuilding(client, buildingName) {
  if (!buildingName) return null;
  const result = await client.query(
    'SELECT id, name FROM buildings WHERE lower(name) = lower($1) LIMIT 1',
    [buildingName]
  );
  return result.rows[0] || null;
}

module.exports = {
  pool,
  getDefaultFarmId,
  ensureStakeholder,
  ensureCategory,
  getBuilding,
};
