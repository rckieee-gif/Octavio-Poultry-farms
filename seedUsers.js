require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function seedUsers() {
  const passwordHash = await bcrypt.hash('password123', 10);

  await pool.query(`
    INSERT INTO Users (email, password_hash, role)
    VALUES 
      ($1, $2, $3),
      ($4, $5, $6)
    ON CONFLICT (email) DO UPDATE
    SET password_hash = EXCLUDED.password_hash,
        role = EXCLUDED.role
  `, [
    'rolly@octavio.com',
    passwordHash,
    'Admin',

    'worker@octavio.com',
    passwordHash,
    'DataEntry'
  ]);

  console.log('Users seeded successfully.');
  await pool.end();
}

seedUsers().catch(err => {
  console.error(err);
  process.exit(1);
});