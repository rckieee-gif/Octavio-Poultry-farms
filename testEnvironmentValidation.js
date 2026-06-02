const assert = require('node:assert/strict');
const path = require('node:path');

// We want to test src/middleware/auth.js behavior under different environments.
// We must clear the require cache for auth.js because Node.js caches loaded modules.
const authMiddlewarePath = path.resolve(__dirname, 'src/middleware/auth.js');

function clearRequireCache() {
  delete require.cache[authMiddlewarePath];
}

function runTest(nodeEnv, jwtSecret, shouldThrow, expectedErrorMessage) {
  clearRequireCache();

  // Set environment variables
  if (nodeEnv !== undefined) {
    process.env.NODE_ENV = nodeEnv;
  } else {
    delete process.env.NODE_ENV;
  }

  if (jwtSecret !== undefined) {
    process.env.JWT_SECRET = jwtSecret;
  } else {
    delete process.env.JWT_SECRET;
  }

  let errorThrown = null;
  try {
    require(authMiddlewarePath);
  } catch (err) {
    errorThrown = err;
  }

  if (shouldThrow) {
    assert.ok(errorThrown, `Expected error to be thrown for NODE_ENV=${nodeEnv}, JWT_SECRET=${jwtSecret}`);
    assert.equal(errorThrown.message, expectedErrorMessage);
  } else {
    assert.equal(errorThrown, null, `Expected no error to be thrown for NODE_ENV=${nodeEnv}, JWT_SECRET=${jwtSecret}, but got: ${errorThrown?.message}`);
  }
}

function main() {
  console.log('Starting backend JWT secret environment validation tests...');

  // Save initial env to restore later
  const originalNodeEnv = process.env.NODE_ENV;
  const originalJwtSecret = process.env.JWT_SECRET;

  try {
    // 1. Deployed environments missing JWT_SECRET should throw
    runTest('production', undefined, true, 'JWT_SECRET must be set in deployed environments.');
    runTest('staging', undefined, true, 'JWT_SECRET must be set in deployed environments.');
    runTest('preview', undefined, true, 'JWT_SECRET must be set in deployed environments.');

    // 2. Deployed environments with JWT_SECRET should NOT throw
    runTest('production', 'my-production-secret-value', false);
    runTest('staging', 'my-staging-secret-value', false);

    // 3. Local development and test environments without JWT_SECRET should NOT throw
    runTest('development', undefined, false);
    runTest('test', undefined, false);
    runTest(undefined, undefined, false); // empty/missing NODE_ENV

    // 4. Local development and test environments with JWT_SECRET should NOT throw
    runTest('development', 'dev-secret', false);
    runTest('test', 'test-secret', false);

    console.log('✔ All environment validation tests passed successfully!');
  } finally {
    // Restore environment
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
    if (originalJwtSecret !== undefined) {
      process.env.JWT_SECRET = originalJwtSecret;
    } else {
      delete process.env.JWT_SECRET;
    }
  }
}

main();
