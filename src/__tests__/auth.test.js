const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { mockQuery, clearMocks } = require('./dbMock');

// Set JWT_SECRET before loading app/middleware
process.env.JWT_SECRET = 'test-jwt-secret-key-12345';
process.env.NODE_ENV = 'test';

const app = require('../app');
const { JWT_SIGNING_SECRET } = require('../middleware/auth');
const authRouter = require('../routes/auth');

test.describe('Authentication API & Middleware', () => {
  let server;
  let port;
  let apiBase;
  const testPassword = 'password123';
  let testPasswordHash;

  test.before(() => {
    testPasswordHash = bcrypt.hashSync(testPassword, 8);
    // Listen on a random free port
    server = app.listen(0);
    port = server.address().port;
    apiBase = `http://localhost:${port}`;
  });

  test.after(() => {
    server.close();
  });

  test.beforeEach(() => {
    clearMocks();
  });

  test.it('should successfully log in and set cookie with correct credentials', async () => {
    const mockUser = {
      id: 'user-uuid-123',
      farm_id: 'farm-uuid-abc',
      stakeholder_id: null,
      email: 'test@farm.com',
      username: 'testuser',
      password_hash: testPasswordHash,
      role: 'OperationManager',
      is_active: true,
      is_primary_owner: false,
    };

    // Mock query from users table
    mockQuery('FROM users', [mockUser]);
    // Mock user update
    mockQuery('UPDATE users', { rowCount: 1 });

    const response = await fetch(`${apiBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'testuser', password: testPassword }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.message, 'Login successful');
    assert.equal(body.token, undefined);
    assert.equal(body.user.email, 'test@farm.com');

    // Verify token cookie is set
    const cookieHeader = response.headers.get('set-cookie');
    assert.ok(cookieHeader);
    assert.ok(cookieHeader.includes('token='));
    assert.ok(cookieHeader.includes('HttpOnly'));
  });

  test.it('should reject login with incorrect credentials', async () => {
    const mockUser = {
      id: 'user-uuid-123',
      password_hash: testPasswordHash,
      is_active: true,
    };

    mockQuery('FROM users', [mockUser]);

    const response = await fetch(`${apiBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'testuser', password: 'wrongpassword' }),
    });

    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error, 'Invalid email or password');
  });

  test.it('should use cross-site-compatible secure cookie attributes in production', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      assert.deepEqual(authRouter.getAuthCookieOptions(), {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
      });
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test.it('should return user info on GET /me with valid token header', async () => {
    const mockUser = {
      id: 'user-uuid-123',
      farm_id: 'farm-uuid-abc',
      email: 'test@farm.com',
      username: 'testuser',
      role: 'OperationManager',
      is_active: true,
      is_primary_owner: false,
    };

    mockQuery('FROM users', [mockUser]);

    const token = jwt.sign({ userId: mockUser.id }, JWT_SIGNING_SECRET);

    const response = await fetch(`${apiBase}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.user);
    assert.equal(body.token, undefined);
    assert.equal(body.user.username, 'testuser');
  });

  test.it('should return user info on GET /me with valid cookie token', async () => {
    const mockUser = {
      id: 'user-uuid-123',
      farm_id: 'farm-uuid-abc',
      email: 'test@farm.com',
      username: 'testuser',
      role: 'OperationManager',
      is_active: true,
      is_primary_owner: false,
    };

    mockQuery('FROM users', [mockUser]);

    const token = jwt.sign({ userId: mockUser.id }, JWT_SIGNING_SECRET);

    const response = await fetch(`${apiBase}/api/auth/me`, {
      headers: { 'Cookie': `token=${encodeURIComponent(token)}` },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.user);
    assert.equal(body.token, undefined);
    assert.equal(body.user.username, 'testuser');
  });

  test.it('should reject GET /me if authenticated user is inactive', async () => {
    const mockUser = {
      id: 'user-uuid-123',
      is_active: false, // inactive user
    };

    mockQuery('FROM users', [mockUser]);

    const token = jwt.sign({ userId: mockUser.id }, JWT_SIGNING_SECRET);

    const response = await fetch(`${apiBase}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    assert.equal(response.status, 401);
  });

  test.it('should clear token cookie on logout', async () => {
    const response = await fetch(`${apiBase}/api/auth/logout`, {
      method: 'POST',
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.message, 'Logout successful');

    // Verify cookie expires immediately
    const cookieHeader = response.headers.get('set-cookie');
    assert.ok(cookieHeader);
    assert.ok(cookieHeader.includes('Expires=Thu, 01 Jan 1970 00:00:00 GMT') || cookieHeader.includes('max-age=0'));
  });

  test.it('should successfully change password if current password is correct', async () => {
    const mockUser = {
      id: 'user-uuid-123',
      password_hash: testPasswordHash,
      is_active: true,
    };

    mockQuery('FROM users', [mockUser]);
    mockQuery('UPDATE users', { rowCount: 1 });

    const token = jwt.sign({ userId: mockUser.id }, JWT_SIGNING_SECRET);

    const response = await fetch(`${apiBase}/api/auth/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ currentPassword: testPassword, newPassword: 'newPassword123' }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.message, 'Password changed successfully.');
  });

  test.it('should reject password change if current password is wrong', async () => {
    const mockUser = {
      id: 'user-uuid-123',
      password_hash: testPasswordHash,
      is_active: true,
    };

    mockQuery('FROM users', [mockUser]);

    const token = jwt.sign({ userId: mockUser.id }, JWT_SIGNING_SECRET);

    const response = await fetch(`${apiBase}/api/auth/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ currentPassword: 'wrongcurrentpassword', newPassword: 'newPassword123' }),
    });

    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error, 'Current password is incorrect.');
  });
});
