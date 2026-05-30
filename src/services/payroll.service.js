const CORPO_GROUP_PREFIX = 'employees:';

function parseCorpoGroupIds(corpoGroup) {
  if (!corpoGroup?.startsWith(CORPO_GROUP_PREFIX)) return [];

  return corpoGroup
    .slice(CORPO_GROUP_PREFIX.length)
    .split(',')
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));
}

function isEmployeePaySheetName(name) {
  const normalized = String(name || '').trim().toLowerCase();
  return normalized && !['others', 'viewer', 'viewers'].includes(normalized);
}

function calculateMortalityBuffer(buildingChicksLoaded, employeeHandledBirds, totalBuildingHandledBirds) {
  const loaded = Number(buildingChicksLoaded || 0);
  const handled = Number(employeeHandledBirds || 0);
  const totalHandled = Number(totalBuildingHandledBirds || 0);
  if (!loaded || !handled || !totalHandled || loaded <= totalHandled) return 0;
  const employeeShare = handled / totalHandled;
  return Math.max(0, Math.floor(loaded * employeeShare) - handled);
}

function applyMortalityBuffer(mortality, buffer) {
  return Math.max(0, Number(mortality || 0) - Number(buffer || 0));
}

function mapEmployeeCompensation(row) {
  const metadata = row.metadata || {};

  return {
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    position: metadata.position || '',
    assignedBuilding: metadata.assignedBuilding || '',
    batchId: row.batchId || null,
    handledBirds: Number(row.handledBirds || 0),
    ratePerBird: Number(row.ratePerBird || 1.5),
    corpoGroup: row.corpoGroup || '',
    remarks: row.remarks || '',
  };
}

function buildEmployeePaySummaryRows(compensationRows, transactionRows, dailyLogRows, batchLoadingRows = []) {
  const parent = new Map();
  const mortalityByEmployee = new Map();

  dailyLogRows.forEach((row) => {
    const employeeId = Number(row.employeeId);
    if (!Number.isFinite(employeeId)) return;
    mortalityByEmployee.set(employeeId, Number(row.mortality || 0));
  });

  const rows = compensationRows
    .map(mapEmployeeCompensation)
    .filter((employee) => isEmployeePaySheetName(employee.employeeName));

  rows.forEach((row) => parent.set(row.employeeId, row.employeeId));

  // Build loading map and per-building handled totals for mortality buffer
  const loadingMap = new Map();
  batchLoadingRows.forEach((row) => {
    const key = String(row.building || '').toUpperCase();
    if (key) loadingMap.set(key, Number(row.chicksLoaded || row.chicks_loaded || 0));
  });

  const buildingHandledTotals = new Map();
  rows.forEach((row) => {
    const bldg = String(row.assignedBuilding || '').toUpperCase();
    if (bldg) {
      buildingHandledTotals.set(bldg, (buildingHandledTotals.get(bldg) || 0) + Number(row.handledBirds || 0));
    }
  });

  const find = (id) => {
    const current = parent.get(id) ?? id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };

  const union = (left, right) => {
    if (!parent.has(left) || !parent.has(right)) return;
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };

  rows.forEach((row) => {
    parseCorpoGroupIds(row.corpoGroup).forEach((otherId) => union(row.employeeId, otherId));
  });

  const groups = new Map();

  rows.forEach((row) => {
    const key = find(row.employeeId);
    const mortality = mortalityByEmployee.get(row.employeeId) || 0;
    const grossHandledBirds = Number(row.handledBirds || 0);
    const bldg = String(row.assignedBuilding || '').toUpperCase();
    const buffer = calculateMortalityBuffer(
      loadingMap.get(bldg),
      grossHandledBirds,
      buildingHandledTotals.get(bldg)
    );
    const effectiveMortality = applyMortalityBuffer(mortality, buffer);
    const netHandledBirds = Math.max(grossHandledBirds - effectiveMortality, 0);
    const group = groups.get(key) || { netHandledBirds: 0, members: [] };

    group.netHandledBirds += netHandledBirds;
    group.members.push(row.employeeId);
    groups.set(key, group);
  });

  const getNames = (row) => new Set(
    [row.employeeName, row.name, row.displayName]
      .filter(Boolean)
      .map((name) => String(name).trim())
  );

  const hasName = (names, ...values) => values.some((value) => names.has(String(value || '').trim()));

  return rows.map((row) => {
    const names = getNames(row);
    const summary = transactionRows.reduce((total, tx) => {
      const amount = Number(tx.amount || 0);

      if (tx.fundingNature === 'Receivable' && tx.category === 'Cash Advance' && hasName(names, tx.paidTo, tx.paidToDisplayName)) {
        total.cashAdvance += amount;
      }

      if (
        tx.fundingNature === 'Receivable'
        && (tx.type === 'Reimbursement' || tx.category === 'Reimbursement')
        && hasName(names, tx.paidBy, tx.paidByDisplayName)
      ) {
        total.reimbursement += amount;
      }

      if (tx.fundingNature === 'OPEX' && tx.category === 'Labor' && hasName(names, tx.paidTo, tx.paidToDisplayName)) {
        total.laborPaid += amount;
      }

      return total;
    }, {
      cashAdvance: 0,
      reimbursement: 0,
      laborPaid: 0,
    });

    const group = groups.get(find(row.employeeId));
    const mortality = mortalityByEmployee.get(row.employeeId) || 0;
    const grossHandledBirds = Number(row.handledBirds || 0);
    const empBldg = String(row.assignedBuilding || '').toUpperCase();
    const mortalityBuffer = calculateMortalityBuffer(
      loadingMap.get(empBldg),
      grossHandledBirds,
      buildingHandledTotals.get(empBldg)
    );
    const effectiveMortality = applyMortalityBuffer(mortality, mortalityBuffer);
    const netHandledBirds = Math.max(grossHandledBirds - effectiveMortality, 0);
    const memberCount = group?.members.length || 1;
    const poolBirds = memberCount > 1 ? group.netHandledBirds : netHandledBirds;
    const payableBirds = memberCount > 1 ? poolBirds / memberCount : netHandledBirds;
    const cycleIncome = payableBirds * Number(row.ratePerBird || 1.5);
    const outstandingAdvance = summary.cashAdvance - summary.reimbursement;
    const remainingCyclePay = cycleIncome - summary.laborPaid;
    const netPayable = remainingCyclePay - outstandingAdvance;

    return {
      ...row,
      grossHandledBirds,
      mortality,
      mortalityBuffer,
      effectiveMortality,
      netHandledBirds,
      poolBirds,
      payableBirds,
      memberCount,
      cycleIncome,
      cashAdvance: summary.cashAdvance,
      reimbursement: summary.reimbursement,
      laborPaid: summary.laborPaid,
      outstandingAdvance,
      remainingCyclePay,
      netPayable,
    };
  });
}

const { pool } = require('../db');

function mapEmployee(row) {
  const metadata = row.metadata || {};

  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName || row.display_name || row.name,
    phone: row.phone || '',
    email: row.email || '',
    address: row.address || '',
    isActive: row.isActive ?? row.is_active ?? true,
    position: metadata.position || '',
    assignedBuilding: metadata.assignedBuilding || '',
    notes: metadata.notes || '',
  };
}

function buildEmployeeMetadata(employee) {
  return {
    position: employee.position || '',
    hireDate: employee.hireDate || '',
    assignedBuilding: employee.assignedBuilding || '',
    notes: employee.notes || '',
  };
}

async function getEmployeeById(employeeId, client = pool) {
  const result = await client.query(
    `SELECT
       id,
       name,
       COALESCE(display_name, name) AS "displayName",
       phone,
       email,
       address,
       metadata,
       is_active AS "isActive"
     FROM stakeholders
     WHERE id = $1
       AND type = 'Employee'
     LIMIT 1`,
    [employeeId]
  );

  return result.rows[0] ? mapEmployee(result.rows[0]) : null;
}

function normalizeRatePerBird(value) {
  const rate = value === '' || value === undefined || value === null ? 1.5 : Number(value);

  if (!Number.isFinite(rate) || rate < 1.5 || rate > 3) {
    throw new Error('Rate per bird must be between 1.50 and 3.00.');
  }

  return Number(rate.toFixed(2));
}

function normalizeHandledBirds(value) {
  const birds = value === '' || value === undefined || value === null ? 0 : Number(value);

  if (!Number.isFinite(birds) || birds < 0) {
    throw new Error('Handled birds must be zero or greater.');
  }

  return Math.round(birds);
}

module.exports = {
  calculateMortalityBuffer,
  applyMortalityBuffer,
  isEmployeePaySheetName,
  mapEmployeeCompensation,
  buildEmployeePaySummaryRows,
  mapEmployee,
  buildEmployeeMetadata,
  getEmployeeById,
  normalizeRatePerBird,
  normalizeHandledBirds,
};
