require('dotenv').config({ path: 'c:/Users/Admin/Documents/farm-manager/farm-backend/.env' });

async function main() {
  const loginRes = await fetch('http://localhost:5000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'rolly@octavio.com', password: 'password123' })
  });

  const loginText = await loginRes.text();
  if (!loginRes.ok) {
    console.error("Login failed:", loginRes.status, loginText);
    return;
  }

  const loginData = JSON.parse(loginText);
  const token = loginData.token;
  console.log("Logged in successfully. Token length:", token.length);

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  // 1. Get batches
  const batchesRes = await fetch('http://localhost:5000/api/batches', { headers });
  const batchesText = await batchesRes.text();
  if (!batchesRes.ok) {
    console.error("Failed to fetch batches:", batchesRes.status, batchesText);
    return;
  }
  const batches = JSON.parse(batchesText);
  if (batches.length === 0) {
    console.error("No batches found.");
    return;
  }
  const activeBatch = batches[0];
  console.log(`Using active batch ID: ${activeBatch.id}`);

  // 2. Query employee pay summary BEFORE cash advance
  const summaryBeforeRes = await fetch(`http://localhost:5000/api/batches/${activeBatch.id}/employee-pay-summary`, { headers });
  const summaryBefore = await summaryBeforeRes.json();
  const janeBefore = summaryBefore.rows.find(r => r.employeeName === 'Jane');
  console.log("Jane pay summary BEFORE cash advance:", {
    outstandingAdvance: janeBefore ? janeBefore.outstandingAdvance : 0,
    cashAdvance: janeBefore ? janeBefore.cashAdvance : 0,
    reimbursement: janeBefore ? janeBefore.reimbursement : 0,
    netPayable: janeBefore ? janeBefore.netPayable : 0
  });

  // 3. Parse quick entry "Jane cash advance 600"
  console.log("Parsing: 'Jane cash advance 600'...");
  const quickEntryRes = await fetch('http://localhost:5000/api/quick-entry', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      text: 'Jane cash advance 600',
      today: new Date().toISOString().split('T')[0],
      building: 'All',
      paidBy: 'Rolly'
    })
  });
  const quickEntryText = await quickEntryRes.text();
  if (!quickEntryRes.ok) {
    console.error("Quick entry parse failed:", quickEntryRes.status, quickEntryText);
    return;
  }
  const quickEntryData = JSON.parse(quickEntryText);
  console.log("Parsed result:", JSON.stringify(quickEntryData.parsed, null, 2));

  // 4. Save transaction to ledger
  console.log("Saving parsed transaction to ledger...");
  const parsed = quickEntryData.parsed;
  const saveRes = await fetch(`http://localhost:5000/api/batches/${activeBatch.id}/transactions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      date: parsed.date,
      building: parsed.building,
      fundingNature: parsed.fundingNature,
      category: parsed.category,
      description: parsed.description,
      quantity: parsed.quantity,
      unitCost: parsed.unitPrice,
      amount: parsed.amount,
      paidBy: parsed.paidBy,
      paidTo: parsed.paidTo,
      reference: parsed.reference,
      remarks: parsed.remarks,
      type: parsed.type
    })
  });
  const saveText = await saveRes.text();
  if (!saveRes.ok) {
    console.error("Save transaction failed:", saveRes.status, saveText);
    return;
  }
  const saveData = JSON.parse(saveText);
  console.log("Saved transaction:", saveData);
  const transactionId = saveData.id;

  // 5. Query employee pay summary AFTER cash advance
  const summaryAfterRes = await fetch(`http://localhost:5000/api/batches/${activeBatch.id}/employee-pay-summary`, { headers });
  const summaryAfter = await summaryAfterRes.json();
  const janeAfter = summaryAfter.rows.find(r => r.employeeName === 'Jane');
  console.log("Jane pay summary AFTER cash advance:", {
    outstandingAdvance: janeAfter ? janeAfter.outstandingAdvance : 0,
    cashAdvance: janeAfter ? janeAfter.cashAdvance : 0,
    reimbursement: janeAfter ? janeAfter.reimbursement : 0,
    netPayable: janeAfter ? janeAfter.netPayable : 0
  });

  // 6. Test a reimbursement/repayment "Jane paid balance 200"
  console.log("Parsing repayment: 'Jane paid balance 200'...");
  const repayParseRes = await fetch('http://localhost:5000/api/quick-entry', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      text: 'Jane paid balance 200',
      today: new Date().toISOString().split('T')[0],
      building: 'All',
      paidBy: 'Rolly'
    })
  });
  const repayParseText = await repayParseRes.text();
  if (!repayParseRes.ok) {
    console.error("Repayment parse failed:", repayParseRes.status, repayParseText);
    return;
  }
  const repayParseData = JSON.parse(repayParseText);
  console.log("Parsed repayment result:", JSON.stringify(repayParseData.parsed, null, 2));

  // 7. Save repayment transaction
  console.log("Saving repayment transaction...");
  const repParsed = repayParseData.parsed;
  const saveRepRes = await fetch(`http://localhost:5000/api/batches/${activeBatch.id}/transactions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      date: repParsed.date,
      building: repParsed.building,
      fundingNature: repParsed.fundingNature,
      category: repParsed.category,
      description: repParsed.description,
      quantity: repParsed.quantity,
      unitCost: repParsed.unitPrice,
      amount: repParsed.amount,
      paidBy: repParsed.paidBy,
      paidTo: repParsed.paidTo,
      reference: repParsed.reference,
      remarks: repParsed.remarks,
      type: repParsed.type
    })
  });
  const saveRepText = await saveRepRes.text();
  if (!saveRepRes.ok) {
    console.error("Save repayment failed:", saveRepRes.status, saveRepText);
    return;
  }
  const saveRepData = JSON.parse(saveRepText);
  console.log("Saved repayment transaction:", saveRepData);
  const repTransactionId = saveRepData.id;

  // 8. Query employee pay summary AFTER repayment
  const summaryFinalRes = await fetch(`http://localhost:5000/api/batches/${activeBatch.id}/employee-pay-summary`, { headers });
  const summaryFinal = await summaryFinalRes.json();
  const janeFinal = summaryFinal.rows.find(r => r.employeeName === 'Jane');
  console.log("Jane pay summary AFTER repayment:", {
    outstandingAdvance: janeFinal ? janeFinal.outstandingAdvance : 0,
    cashAdvance: janeFinal ? janeFinal.cashAdvance : 0,
    reimbursement: janeFinal ? janeFinal.reimbursement : 0,
    netPayable: janeFinal ? janeFinal.netPayable : 0
  });

  // 9. Clean up test transactions so we don't pollute database
  console.log("Cleaning up test transactions...");
  await fetch(`http://localhost:5000/api/batches/${activeBatch.id}/transactions/${transactionId}/void`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reason: 'E2E Test Cleanup' })
  });
  await fetch(`http://localhost:5000/api/batches/${activeBatch.id}/transactions/${repTransactionId}/void`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reason: 'E2E Test Cleanup' })
  });
  console.log("Cleanup finished.");
}

main().catch(err => console.error(err));
