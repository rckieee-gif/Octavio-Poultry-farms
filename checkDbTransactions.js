require('dotenv').config({ path: 'c:/Users/Admin/Documents/farm-manager/farm-backend/.env' });
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  const client = await pool.connect();
  try {
    const res = await client.query(`
      SELECT 
        t.transaction_id, 
        t.batch_id, 
        t.date, 
        t.type, 
        t.funding_nature, 
        t.category, 
        t.description, 
        t.amount, 
        s1.name as paid_by_name, 
        s2.name as paid_to_name
      FROM daily_transactions t
      LEFT JOIN stakeholders s1 ON t.paid_by = s1.id
      LEFT JOIN stakeholders s2 ON t.paid_to = s2.id
      WHERE t.category IN ('Cash Advance', 'Reimbursement')
      ORDER BY t.date DESC
      LIMIT 10
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
