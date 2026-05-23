require('dotenv').config({ path: 'c:/Users/Admin/Documents/farm-manager/farm-backend/.env' });
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  const client = await pool.connect();
  try {
    const res = await client.query(`
      SELECT id, name, display_name, type, is_active 
      FROM stakeholders
      ORDER BY id ASC
    `);
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
