import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isInfraError, claudeHealthVerdict } = require('../../scripts/lib/commercial-claude-health.js');

test('timeouts, resets and API outages are infra errors', () => {
  for (const m of ['Claude API request timed out after 60s', 'Claude API request exceeded 120s deadline (timed out)', 'read ECONNRESET', 'socket hang up', 'Claude API error: Overloaded', 'Claude API error: rate limit exceeded', 'Claude API error: HTTP 529 overloaded', 'Claude API error: HTTP 404 {}', 'Claude API error: model: claude-x not_found_error']) {
    assert.equal(isInfraError(new Error(m)), true, m);
  }
});

test('parse failures and empty answers are not infra errors', () => {
  assert.equal(isInfraError(new Error('Failed to parse Claude response: Unexpected token')), false);
  assert.equal(isInfraError(new Error('Plausibility check failed')), false);
  assert.equal(isInfraError(null), false);
});

test('verdict trips only with 3+ attempts and at least half infra failures', () => {
  assert.equal(claudeHealthVerdict({ attempts: 2, infra: 2 }).systemic, false);
  assert.equal(claudeHealthVerdict({ attempts: 10, infra: 4 }).systemic, false);
  const v = claudeHealthVerdict({ attempts: 10, infra: 5 });
  assert.equal(v.systemic, true);
  assert.match(v.message, /5 of 10/);
  assert.equal(claudeHealthVerdict({ attempts: 0, infra: 0 }).systemic, false);
});
