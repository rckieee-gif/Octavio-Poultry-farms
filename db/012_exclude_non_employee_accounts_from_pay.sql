UPDATE stakeholders s
SET type = 'Other'
WHERE s.type = 'Employee'
  AND (
    lower(COALESCE(s.display_name, s.name)) IN ('others', 'viewer', 'viewers')
    OR EXISTS (
      SELECT 1
      FROM users u
      WHERE u.stakeholder_id = s.id
        AND u.role = 'Viewer'
    )
  );
