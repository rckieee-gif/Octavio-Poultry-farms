INSERT INTO categories (farm_id, funding_nature, name, is_system, sort_order)
SELECT id, 'Payable', 'Previous Deficit', true, 34
FROM farms
WHERE code = 'octavio'
ON CONFLICT (farm_id, funding_nature, lower(name))
DO UPDATE SET is_active = true, is_system = true;
