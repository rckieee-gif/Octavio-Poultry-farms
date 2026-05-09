ALTER TABLE users
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS is_primary_owner boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS users_unique_username
  ON users (lower(username))
  WHERE username IS NOT NULL;

WITH default_farm AS (
  SELECT id AS farm_id
  FROM farms
  WHERE code = 'octavio'
  LIMIT 1
),
owner_stakeholders AS (
  INSERT INTO stakeholders (farm_id, name, display_name, type, is_active)
  SELECT default_farm.farm_id, owner_name, owner_name, 'Owner', true
  FROM default_farm
  CROSS JOIN (VALUES ('Roland'), ('Rolly'), ('Rodney')) owners(owner_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM stakeholders s
    WHERE lower(s.name) = lower(owners.owner_name)
  )
  RETURNING id, name
),
all_owner_stakeholders AS (
  SELECT DISTINCT ON (lower(name)) id, name
  FROM (
    SELECT id, name
    FROM owner_stakeholders
    UNION ALL
    SELECT id, name
    FROM stakeholders
    WHERE lower(name) IN (lower('Roland'), lower('Rolly'), lower('Rodney'))
  ) owners
  ORDER BY lower(name), id
),
seed_users(email, username, password_hash, role, stakeholder_name, is_primary_owner) AS (
  VALUES
    (
      'admin.roland@octavio.local',
      'admin.roland',
      '$2b$10$XdRI53B0q4I9H.7WeYRjlOUkRYXDEsZXPwiKxL7qkNApTktGCBhSS',
      'AdminOwner',
      'Roland',
      true
    ),
    (
      'rolly@octavio.com',
      'rolly',
      '$2b$10$9BfI3yw0Qq/etD5v143i7eSvkME3bdYAHKjf.Xm3VES0wX5MeG.k6',
      'AdminOwner',
      'Rolly',
      false
    ),
    (
      'rodney@octavio.com',
      'rodney',
      '$2b$10$9BfI3yw0Qq/etD5v143i7eSvkME3bdYAHKjf.Xm3VES0wX5MeG.k6',
      'AdminOwner',
      'Rodney',
      false
    )
)
INSERT INTO users (farm_id, stakeholder_id, email, username, password_hash, role, is_active, is_primary_owner)
SELECT
  default_farm.farm_id,
  stakeholders.id,
  seed_users.email,
  seed_users.username,
  seed_users.password_hash,
  seed_users.role,
  true,
  seed_users.is_primary_owner
FROM seed_users
CROSS JOIN default_farm
LEFT JOIN all_owner_stakeholders stakeholders ON stakeholders.name = seed_users.stakeholder_name
ON CONFLICT (email)
DO UPDATE SET
  farm_id = EXCLUDED.farm_id,
  stakeholder_id = EXCLUDED.stakeholder_id,
  username = EXCLUDED.username,
  password_hash = EXCLUDED.password_hash,
  role = EXCLUDED.role,
  is_active = true,
  is_primary_owner = EXCLUDED.is_primary_owner,
  updated_at = now();

UPDATE users
SET username = 'worker'
WHERE lower(email) = lower('worker@octavio.com')
  AND username IS NULL;
