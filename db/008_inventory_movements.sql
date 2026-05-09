CREATE TABLE IF NOT EXISTS inventory_items (
  id serial PRIMARY KEY,
  farm_id uuid REFERENCES farms(id),
  name text NOT NULL,
  category text NOT NULL,
  unit text NOT NULL,
  target_quantity numeric(14,3) NOT NULL DEFAULT 0,
  reorder_level numeric(14,3) NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_unique_name
  ON inventory_items (farm_id, lower(name));

ALTER TABLE daily_logs
  ADD COLUMN IF NOT EXISTS feed_item_id integer REFERENCES inventory_items(id);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id serial PRIMARY KEY,
  farm_id uuid REFERENCES farms(id),
  batch_id varchar(50) REFERENCES batches(id) ON DELETE SET NULL,
  item_id integer NOT NULL REFERENCES inventory_items(id),
  movement_date date NOT NULL,
  movement_type varchar(20) NOT NULL,
  quantity numeric(14,3) NOT NULL,
  unit_cost numeric(14,4),
  amount numeric(14,2),
  building_id integer REFERENCES buildings(id),
  source_type text,
  source_id text,
  linked_transaction_id varchar(50) REFERENCES daily_transactions(transaction_id) ON DELETE SET NULL,
  remarks text,
  created_by_user_id integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (movement_type IN ('Stock In', 'Stock Out', 'Adjustment', 'Transfer')),
  CHECK (
    (movement_type = 'Adjustment' AND quantity <> 0)
    OR (movement_type <> 'Adjustment' AND quantity > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_unique_source
  ON inventory_movements (source_type, source_id, item_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_movements_item_date
  ON inventory_movements (item_id, movement_date DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_batch
  ON inventory_movements (batch_id);

WITH seed_items(name, category, unit, target_quantity, reorder_level) AS (
  VALUES
    ('DOC Chicks', 'Chicks', 'heads', 0, 0),
    ('Starter Feed', 'Feed', 'sacks', 0, 20),
    ('Grower Feed', 'Feed', 'sacks', 0, 20),
    ('Finisher Feed', 'Feed', 'sacks', 0, 20),
    ('Lights', 'Equipment', 'pcs', 0, 5),
    ('Feeder Small', 'Equipment', 'pcs', 0, 5),
    ('Feeder Medium', 'Equipment', 'pcs', 0, 5),
    ('Feeder Large', 'Equipment', 'pcs', 0, 5),
    ('Waterer Small', 'Equipment', 'pcs', 0, 5),
    ('Waterer Medium', 'Equipment', 'pcs', 0, 5),
    ('Waterer Large', 'Equipment', 'pcs', 0, 5),
    ('Waterer Gallon', 'Equipment', 'gallon', 0, 5),
    ('Bell Drinker', 'Equipment', 'pcs', 0, 0)
)
INSERT INTO inventory_items (farm_id, name, category, unit, target_quantity, reorder_level)
SELECT f.id, s.name, s.category, s.unit, s.target_quantity, s.reorder_level
FROM farms f
CROSS JOIN seed_items s
WHERE NOT EXISTS (
  SELECT 1
  FROM inventory_items ii
  WHERE ii.farm_id = f.id
    AND lower(ii.name) = lower(s.name)
);
