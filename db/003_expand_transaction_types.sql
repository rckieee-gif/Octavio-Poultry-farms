ALTER TABLE daily_transactions DROP CONSTRAINT IF EXISTS daily_transactions_type_check;

ALTER TABLE daily_transactions
  ADD CONSTRAINT daily_transactions_type_check
  CHECK (
    type IN (
      'Expense',
      'Income',
      'Adjustment',
      'Reimbursement',
      'Payment'
    )
  );
