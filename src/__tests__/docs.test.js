const test = require('node:test');
const assert = require('node:assert/strict');

// Set JWT_SECRET before loading app/middleware
process.env.JWT_SECRET = 'test-jwt-secret-key-12345';
process.env.NODE_ENV = 'test';

const app = require('../app');

test.describe('API Documentation Routes', () => {
  let server;
  let port;
  let apiBase;

  test.before(() => {
    // Listen on a random free port
    server = app.listen(0);
    port = server.address().port;
    apiBase = `http://localhost:${port}`;
  });

  test.after(() => {
    server.close();
  });

  test.it('should return 200 and valid JSON on GET /api-docs/openapi.json', async () => {
    const response = await fetch(`${apiBase}/api-docs/openapi.json`);
    assert.equal(response.status, 200);

    const contentType = response.headers.get('content-type');
    assert.ok(contentType);
    assert.ok(contentType.includes('application/json'));

    const spec = await response.json();
    assert.equal(spec.openapi, '3.0.0');
    assert.equal(spec.info.title, 'Octavio Poultry Farm API Documentation');
    assert.ok(spec.paths);
    assert.ok(spec.components);
  });

  test.it('should return 200 and HTML on GET /api-docs', async () => {
    const response = await fetch(`${apiBase}/api-docs`);
    assert.equal(response.status, 200);

    const contentType = response.headers.get('content-type');
    assert.ok(contentType);
    assert.ok(contentType.includes('text/html'));

    const html = await response.text();
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('<title>Octavio Poultry Farm API Documentation</title>'));
    assert.ok(html.includes('id="swagger-ui"'));
    assert.ok(html.includes('unpkg.com/swagger-ui-dist'));
  });
});
