require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function run() {
  const dbDir = path.join(__dirname, '..', 'db');
  const files = (await fs.readdir(dbDir))
    .filter(file => file.endsWith('.sql'))
    .sort();

  const client = await pool.connect();

  try {
    await ensureMigrationTable(client);

    for (const file of files) {
      const migrationId = file.replace(/\.sql$/, '');
      const existing = await client.query(
        'SELECT id FROM schema_migrations WHERE id = $1',
        [migrationId]
      );

      if (existing.rowCount > 0) {
        console.log(`Skipping ${file}`);
        continue;
      }

      const sql = await fs.readFile(path.join(dbDir, file), 'utf8');

      console.log(`Applying ${file}`);
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (id) VALUES ($1)',
        [migrationId]
      );
      await client.query('COMMIT');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
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
