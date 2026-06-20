const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { mockQuery, clearMocks } = require('./dbMock');

process.env.JWT_SECRET = 'test-jwt-secret-key-12345';
process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = 'test-key';

const app = require('../app');
const { JWT_SIGNING_SECRET } = require('../middleware/auth');

function readPromptContext(requestBody) {
  const prompt = requestBody.systemInstruction.parts[0].text;
  const marker = 'Current farm context:\n';
  const markerIndex = prompt.indexOf(marker);

  assert.notEqual(markerIndex, -1);
  return JSON.parse(prompt.slice(markerIndex + marker.length));
}

test('/api/flockops-chat preserves explicit arrival state without treating planned DOC as actual', async (t) => {
  const server = app.listen(0);
  const apiBase = `http://localhost:${server.address().port}`;
  const nativeFetch = global.fetch;
  const capturedBodies = [];
  const mockUser = {
    id: 'user-uuid-123',
    farm_id: 'farm-uuid-abc',
    email: 'manager@farm.test',
    username: 'manager',
    role: 'OperationManager',
    is_active: true,
    is_primary_owner: false,
  };
  const token = jwt.sign({ userId: mockUser.id }, JWT_SIGNING_SECRET);

  clearMocks();
  mockQuery('FROM users', [mockUser]);

  global.fetch = async (url, options) => {
    if (String(url).startsWith(apiBase)) {
      return nativeFetch(url, options);
    }

    assert.match(String(url), /generativelanguage\.googleapis\.com/);
    capturedBodies.push(JSON.parse(options.body));

    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Context received.' }] } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  t.after(() => {
    global.fetch = nativeFetch;
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const postChat = (activeBatch, loaded) => global.fetch(`${apiBase}/api/flockops-chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      message: 'What is the flock status?',
      context: {
        activeBatch,
        metrics: { loaded },
      },
    }),
  });

  const preArrivalResponse = await postChat({
    id: 'PRE-ARRIVAL',
    status: 'ONGOING',
    plannedFlock: 45000,
    totalChicksLoaded: 45000,
    actualChicksArrived: null,
    doaCount: null,
    netChicksPlaced: null,
    hasConfirmedArrival: false,
  }, 0);

  const confirmedResponse = await postChat({
    id: 'CONFIRMED',
    status: 'ONGOING',
    plannedFlock: 45000,
    totalChicksLoaded: 44850,
    actualChicksArrived: 44850,
    doaCount: 73,
    netChicksPlaced: 44777,
    hasConfirmedArrival: true,
  }, 44777);

  assert.equal(preArrivalResponse.status, 200);
  assert.equal(confirmedResponse.status, 200);
  assert.equal(capturedBodies.length, 2);

  const preArrivalBatch = readPromptContext(capturedBodies[0]).activeBatch;
  assert.equal(preArrivalBatch.plannedFlock, 45000);
  assert.equal(preArrivalBatch.hasConfirmedArrival, false);
  assert.equal(Object.hasOwn(preArrivalBatch, 'totalChicksLoaded'), false);
  assert.equal(Object.hasOwn(preArrivalBatch, 'actualChicksArrived'), false);
  assert.equal(Object.hasOwn(preArrivalBatch, 'doaCount'), false);
  assert.equal(Object.hasOwn(preArrivalBatch, 'netChicksPlaced'), false);

  const confirmedBatch = readPromptContext(capturedBodies[1]).activeBatch;
  assert.equal(confirmedBatch.hasConfirmedArrival, true);
  assert.equal(confirmedBatch.totalChicksLoaded, 44850);
  assert.equal(confirmedBatch.actualChicksArrived, 44850);
  assert.equal(confirmedBatch.doaCount, 73);
  assert.equal(confirmedBatch.netChicksPlaced, 44777);
});
