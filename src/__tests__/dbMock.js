const db = require('../db');

// Registry of patterns to match queries
const mockQueries = new Map();

function mockQuery(pattern, result) {
  mockQueries.set(pattern, result);
}

function clearMocks() {
  mockQueries.clear();
}

db.pool.query = async (sql, params) => {
  for (const [pattern, result] of mockQueries.entries()) {
    const isMatch = typeof pattern === 'string' 
      ? sql.includes(pattern)
      : pattern.test(sql);
      
    if (isMatch) {
      return executeMockResult(result, sql, params);
    }
  }
  // Return empty result instead of throwing to keep tests robust
  return { rows: [], rowCount: 0 };
};

db.pool.connect = async () => {
  return {
    query: db.pool.query,
    release: () => {}
  };
};

function executeMockResult(result, sql, params) {
  if (typeof result === 'function') {
    return result(sql, params);
  }
  if (result instanceof Error) {
    throw result;
  }
  if (Array.isArray(result)) {
    return { rows: result, rowCount: result.length };
  }
  if (result && typeof result === 'object' && ('rows' in result)) {
    return result;
  }
  return { rows: result ? [result] : [], rowCount: result ? 1 : 0 };
}

// Override helpers to prevent database hits
const originalGetDefaultFarmId = db.getDefaultFarmId;
const originalEnsureStakeholder = db.ensureStakeholder;
const originalEnsureCategory = db.ensureCategory;
const originalGetBuilding = db.getBuilding;

db.getDefaultFarmId = async () => 'default-farm-uuid';
db.ensureStakeholder = async () => 'mock-stakeholder-uuid';
db.ensureCategory = async () => 'mock-category-uuid';
db.getBuilding = async (client, name) => ({ id: 1, name: name || 'Building 1' });

module.exports = {
  mockQuery,
  clearMocks,
  originalGetDefaultFarmId,
  originalEnsureStakeholder,
  originalEnsureCategory,
  originalGetBuilding,
};
