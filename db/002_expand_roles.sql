ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (
    role IN (
      'Admin',
      'AdminOwner',
      'OpManager',
      'OperationManager',
      'DataEntry',
      'Viewer'
    )
  );

ALTER TABLE stakeholders DROP CONSTRAINT IF EXISTS stakeholders_type_check;

ALTER TABLE stakeholders
  ADD CONSTRAINT stakeholders_type_check
  CHECK (
    type IN (
      'Owner',
      'Employee',
      'Supplier',
      'Buyer',
      'Dressing Plant',
      'Other'
    )
  );
