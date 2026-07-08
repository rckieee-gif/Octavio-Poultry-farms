const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-key-12345';
delete process.env.CORS_ORIGINS;

const app = require('../app');

test.describe('Production CORS defaults', () => {
  let server;
  let apiBase;

  test.before(() => {
    server = app.listen(0);
    apiBase = `http://localhost:${server.address().port}`;
  });

  test.after(() => {
    server.close();
  });

  test.it('starts without CORS_ORIGINS and allows the production frontend origin', async () => {
    const origin = 'https://octavio-farms.vercel.app';
    const response = await fetch(`${apiBase}/health`, {
      headers: { Origin: origin },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
  });

  test.it('trusts the first proxy hop for Vercel and Render deployments', () => {
    assert.equal(app.get('trust proxy'), 1);
  });

  test.it('allows Vercel preview deployments for this project', async () => {
    const origin = 'https://octavio-farms-m9n7nq218-rckieee-1438s-projects.vercel.app';
    const response = await fetch(`${apiBase}/health`, {
      headers: { Origin: origin },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
  });

  test.it('rejects unknown browser origins', async () => {
    const response = await fetch(`${apiBase}/health`, {
      headers: { Origin: 'https://example.com' },
    });

    assert.equal(response.status, 403);
  });
});
