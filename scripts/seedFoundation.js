require('dotenv').config();

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const categorySeeds = [
  ['OPEX', 'Feed'],
  ['OPEX', 'DOC'],
  ['OPEX', 'Medicine'],
  ['OPEX', 'Brooding Paper'],
  ['OPEX', 'Charcoal'],
  ['OPEX', 'Labor'],
  ['OPEX', 'Food Expense'],
  ['OPEX', 'Utilities'],
  ['OPEX', 'Supplies'],
  ['OPEX', 'Minor Repair'],
  ['OPEX', 'Transport'],
  ['OPEX', 'Cleaning & Janitorial'],
  ['OPEX', 'Dressing Plant Expense'],
  ['OPEX', 'Miscellaneous'],
  ['CAPEX', 'Building Repair'],
  ['CAPEX', 'Equipment'],
  ['CAPEX', 'Hardware'],
  ['CAPEX', 'Farm Improvement'],
  ['Receivable', 'Cash Advance'],
  ['Receivable', 'Reimbursement'],
  ['Payable', 'Supplier Credit'],
  ['Payable', 'Owner Paid Expense'],
  ['Payable', 'Reimbursement Due'],
  ['Payable', 'Previous Deficit'],
  ['Other Revenue', 'Net Meat Sale'],
  ['Other Revenue', 'Empty Sack Sale'],
  ['Other Revenue', 'Miscellaneous Income'],
  ['CAPEX-Recoverable', 'Recoverable Hardware'],
  ['CAPEX-Recoverable', 'Recoverable Equipment'],
];

const stakeholderSeeds = [
  ['Roland', 'Owner'],
  ['Rolly', 'Owner'],
  ['Rodney', 'Owner'],
  ['Others', 'Other'],
  ['Hardware Credit', 'Supplier'],
  ['Gomez', 'Supplier'],
  ['Octavio Poultry Farm', 'Owner'],
];

async function ensureFarm(client) {
  const result = await client.query(`
    INSERT INTO farms (code, name)
    VALUES ('octavio', 'Octavio Poultry Farm')
    ON CONFLICT (code)
    DO UPDATE SET name = EXCLUDED.name, updated_at = now()
    RETURNING id
  `);

  return result.rows[0].id;
}

async function ensureBuilding(client, farmId, name, share, sortOrder) {
  const existing = await client.query(
    'SELECT id FROM buildings WHERE lower(name) = lower($1) LIMIT 1',
    [name]
  );

  if (existing.rowCount > 0) {
    await client.query(
      `UPDATE buildings
       SET farm_id = $1,
           loading_share_percentage = $2,
           sort_order = $3,
           is_active = $4
       WHERE id = $5`,
      [farmId, share, sortOrder, name !== 'All', existing.rows[0].id]
    );
    return existing.rows[0].id;
  }

  const inserted = await client.query(
    `INSERT INTO buildings (name, loading_share_percentage, farm_id, sort_order, is_active)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [name, share, farmId, sortOrder, name !== 'All']
  );

  return inserted.rows[0].id;
}

async function ensureStakeholder(client, farmId, name, type) {
  const existing = await client.query(
    'SELECT id FROM stakeholders WHERE lower(name) = lower($1) LIMIT 1',
    [name]
  );

  if (existing.rowCount > 0) {
    await client.query(
      `UPDATE stakeholders
       SET farm_id = $1,
           type = $2,
           display_name = $3,
           is_active = true
       WHERE id = $4`,
      [farmId, type, name, existing.rows[0].id]
    );
    return existing.rows[0].id;
  }

  const inserted = await client.query(
    `INSERT INTO stakeholders (name, display_name, type, farm_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [name, name, type, farmId]
  );

  return inserted.rows[0].id;
}

async function ensureCategory(client, farmId, fundingNature, name, sortOrder) {
  await client.query(
    `INSERT INTO categories (farm_id, funding_nature, name, is_system, sort_order)
     VALUES ($1, $2, $3, true, $4)
     ON CONFLICT (farm_id, funding_nature, lower(name))
     DO UPDATE SET is_active = true, sort_order = EXCLUDED.sort_order`,
    [farmId, fundingNature, name, sortOrder]
  );
}

async function ensureUser(client, farmId, { email, username, passwordHash, role, stakeholderId, isPrimaryOwner = false }) {
  const existing = await client.query(
    'SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1',
    [email]
  );

  if (existing.rowCount > 0) {
    await client.query(
      `UPDATE users
       SET farm_id = $1,
           password_hash = $2,
           role = $3,
           stakeholder_id = $4,
           is_active = true,
           username = $5,
           is_primary_owner = $6,
           updated_at = now()
       WHERE id = $7`,
      [farmId, passwordHash, role, stakeholderId, username || null, isPrimaryOwner, existing.rows[0].id]
    );
    return;
  }

  await client.query(
    `INSERT INTO users (farm_id, email, username, password_hash, role, stakeholder_id, is_primary_owner)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [farmId, email, username || null, passwordHash, role, stakeholderId, isPrimaryOwner]
  );
}

async function seedBatchLoadings(client) {
  const batches = await client.query('SELECT id, start_date, total_chicks_loaded FROM batches');
  const buildings = await client.query(`
    SELECT id, loading_share_percentage
    FROM buildings
    WHERE name IN ('A', 'B', 'C')
    ORDER BY name
  `);

  for (const batch of batches.rows) {
    for (const building of buildings.rows) {
      const sharePct = Number(building.loading_share_percentage) * 100;
      const chicksLoaded = Math.round(Number(batch.total_chicks_loaded || 0) * Number(building.loading_share_percentage || 0));

      await client.query(
        `INSERT INTO batch_building_loadings
           (batch_id, building_id, loading_date, chicks_loaded, loading_share_pct)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (batch_id, building_id)
         DO UPDATE SET
           loading_date = EXCLUDED.loading_date,
           loading_share_pct = EXCLUDED.loading_share_pct`,
        [batch.id, building.id, batch.start_date, chicksLoaded, sharePct]
      );
    }
  }
}

async function backfillTransactionSequences(client) {
  await client.query(`
    INSERT INTO transaction_code_sequences (transaction_date, building_key, last_sequence)
    SELECT
      dt.date,
      COALESCE(NULLIF(b.name, ''), 'ALL') AS building_key,
      MAX(COALESCE(NULLIF(substring(dt.transaction_id from '([0-9]{3})$'), '')::integer, 0)) AS last_sequence
    FROM daily_transactions dt
    LEFT JOIN buildings b ON b.id = dt.building_id
    GROUP BY dt.date, COALESCE(NULLIF(b.name, ''), 'ALL')
    ON CONFLICT (transaction_date, building_key)
    DO UPDATE SET
      last_sequence = GREATEST(transaction_code_sequences.last_sequence, EXCLUDED.last_sequence),
      updated_at = now()
  `);
}

async function backfillCategoryIds(client, farmId) {
  await client.query(
    `UPDATE daily_transactions dt
     SET category_id = c.id
     FROM categories c
     WHERE c.farm_id = $1
       AND lower(c.name) = lower(dt.category)
       AND c.funding_nature = dt.funding_nature
       AND dt.category_id IS NULL`,
    [farmId]
  );
}

async function run() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const farmId = await ensureFarm(client);

    await client.query('UPDATE buildings SET farm_id = $1 WHERE farm_id IS NULL', [farmId]);
    await client.query('UPDATE stakeholders SET farm_id = $1 WHERE farm_id IS NULL', [farmId]);
    await client.query('UPDATE users SET farm_id = $1 WHERE farm_id IS NULL', [farmId]);
    await client.query('UPDATE batches SET farm_id = $1 WHERE farm_id IS NULL', [farmId]);

    await ensureBuilding(client, farmId, 'A', 0.4286, 1);
    await ensureBuilding(client, farmId, 'B', 0.2241, 2);
    await ensureBuilding(client, farmId, 'C', 0.3473, 3);
    await ensureBuilding(client, farmId, 'All', 1.0, 99);

    const stakeholders = new Map();
    for (const [name, type] of stakeholderSeeds) {
      stakeholders.set(name, await ensureStakeholder(client, farmId, name, type));
    }

    for (let i = 0; i < categorySeeds.length; i += 1) {
      const [fundingNature, name] = categorySeeds[i];
      await ensureCategory(client, farmId, fundingNature, name, i + 1);
    }

    await ensureUser(client, farmId, {
      email: 'admin.roland@octavio.local',
      username: 'admin.roland',
      passwordHash: await bcrypt.hash('121232', 10),
      role: 'AdminOwner',
      stakeholderId: stakeholders.get('Roland'),
      isPrimaryOwner: true,
    });
    await ensureUser(client, farmId, {
      email: 'rolly@octavio.com',
      username: 'rolly',
      passwordHash: await bcrypt.hash('123', 10),
      role: 'AdminOwner',
      stakeholderId: stakeholders.get('Rolly'),
    });
    await ensureUser(client, farmId, {
      email: 'rodney@octavio.com',
      username: 'rodney',
      passwordHash: await bcrypt.hash('123', 10),
      role: 'AdminOwner',
      stakeholderId: stakeholders.get('Rodney'),
    });
    await ensureUser(client, farmId, {
      email: 'worker@octavio.com',
      username: 'worker',
      passwordHash: await bcrypt.hash('password123', 10),
      role: 'DataEntry',
      stakeholderId: stakeholders.get('Others'),
    });

    await seedBatchLoadings(client);
    await backfillTransactionSequences(client);
    await backfillCategoryIds(client, farmId);

    await client.query('COMMIT');
    console.log('Foundation seed completed.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
