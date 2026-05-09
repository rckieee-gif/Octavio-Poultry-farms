UPDATE stakeholders
SET
  name = 'Others',
  display_name = 'Others'
WHERE lower(name) = lower('Yanyan')
   OR lower(display_name) = lower('Yanyan');
