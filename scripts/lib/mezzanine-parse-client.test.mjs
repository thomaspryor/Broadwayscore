import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyParseResponse } = require('./mezzanine-parse-client.js');

test('classifyParseResponse (BRO-5098): Parse error bodies are errors, never empty results', () => {
  const invalid = classifyParseResponse(400, JSON.stringify({ code: 209, error: 'Invalid session token' }));
  assert.ok(invalid.error, 'HTTP 400 + code 209 is an error');
  assert.equal(invalid.error.authFailed, true, 'code 209 means the token is dead');
  assert.match(invalid.error.message, /209.*Invalid session token/);

  const missing = classifyParseResponse(400, JSON.stringify({ code: 206, error: 'Session missing' }));
  assert.equal(missing.error.authFailed, true);

  const other = classifyParseResponse(400, JSON.stringify({ code: 102, error: 'Invalid query' }));
  assert.equal(other.error.authFailed, false, 'a bad query is not a token problem');
  assert.equal(other.error.parseCode, 102);

  assert.equal(classifyParseResponse(401, '').error.authFailed, true);
  assert.equal(classifyParseResponse(403, '{}').error.authFailed, true);
  assert.equal(classifyParseResponse(429, '').error.rateLimited, true);
  assert.match(classifyParseResponse(502, '<html>Bad gateway</html>').error.message, /502.*non-JSON/);
  assert.match(classifyParseResponse(500, '{"message":"boom"}').error.message, /HTTP 500/);
});

test('classifyParseResponse passes real results through, including a genuinely empty page', () => {
  assert.deepEqual(classifyParseResponse(200, '{"results":[{"objectId":"a"}]}').json, { results: [{ objectId: 'a' }] });
  assert.deepEqual(classifyParseResponse(200, '{"results":[]}').json, { results: [] });
});
