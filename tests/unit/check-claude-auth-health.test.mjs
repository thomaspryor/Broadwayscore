// Task #1076: nothing detected a revoked local Claude OAuth token until
// something tried to launch. `claude auth status` reported {loggedIn: true}
// for the entire 2026-08-05 outage — it only reads the on-disk token's
// presence, never its server-side validity. These tests prove the decision
// layer (scripts/lib/claude-auth-health.js) never lets that status field
// override a failed real API call — the exact combination that made the
// real-world incident invisible. Requires the REAL module (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateAuthHealth, buildAlertPayload, buildBillingFallbackAlertPayload, REPAIR_STEPS } = require('../../scripts/lib/claude-auth-health.js');

test('revoked-token shape: preflight fails while auth status still says loggedIn:true → treated as FAILURE', () => {
  // This is the exact real-world bug: authPing's live call gets a 401 (spawn
  // exits nonzero / no "pong" in the envelope) while the separate, on-disk
  // `claude auth status` call still reports a stale loggedIn:true.
  const preflight = { ok: false, mode: 'fail', detail: 'OAuth access token has been revoked' };
  const authStatus = { loggedIn: true, authMethod: 'oauth_token' };

  const health = evaluateAuthHealth({ preflight, authStatus });

  assert.equal(health.ok, false, 'a failed live call must be FAILURE regardless of what auth status claims');
  assert.equal(health.authStatusLoggedIn, true, 'the lying status is carried through for reporting, not swallowed');
  assert.match(health.reason, /revoked/);
});

test('healthy oauth: preflight succeeds via stored login', () => {
  const preflight = { ok: true, mode: 'oauth' };
  const authStatus = { loggedIn: true, authMethod: 'oauth_token' };

  const health = evaluateAuthHealth({ preflight, authStatus });

  assert.equal(health.ok, true);
  assert.equal(health.mode, 'oauth');
});

test('api-key fallback: preflight succeeds but via pay-per-token, not the subscription', () => {
  const preflight = { ok: true, mode: 'api-key', storedDetail: 'OAuth access token has been revoked' };
  const health = evaluateAuthHealth({ preflight, authStatus: { loggedIn: false } });

  assert.equal(health.ok, true, 'a launch would still succeed via the API key');
  assert.equal(health.mode, 'api-key');
  assert.match(health.reason, /ANTHROPIC_API_KEY fallback/);
  assert.match(health.reason, /revoked/, 'the underlying oauth failure detail is preserved for diagnosis');
});

test('missing/malformed authStatus never crashes the decision (best-effort only)', () => {
  const preflight = { ok: false, mode: 'fail', detail: 'network error' };
  const health = evaluateAuthHealth({ preflight, authStatus: null });

  assert.equal(health.ok, false);
  assert.equal(health.authStatusLoggedIn, null);
});

test('evaluateAuthHealth throws on a missing/malformed preflight result (programmer error, not a health state)', () => {
  assert.throws(() => evaluateAuthHealth({ preflight: null }));
  assert.throws(() => evaluateAuthHealth({ preflight: {} }));
});

test('buildAlertPayload: page-worthy conditionKey, includes the repair command and the auth-status-lies warning', () => {
  const health = evaluateAuthHealth({
    preflight: { ok: false, mode: 'fail', detail: 'OAuth access token has been revoked' },
    authStatus: { loggedIn: true },
  });
  const payload = buildAlertPayload(health);

  assert.equal(payload.conditionKey, 'claude-auth:revoked');
  assert.equal(payload.disposition, 'human');
  assert.ok(payload.description.includes(REPAIR_STEPS));
  assert.match(payload.description, /loggedIn:true/, 'alert body must explain why auth status cannot be trusted');
});

test('buildAlertPayload: omits the auth-status-lies warning when status agrees (loggedIn:false)', () => {
  const health = evaluateAuthHealth({
    preflight: { ok: false, mode: 'fail', detail: 'network error' },
    authStatus: { loggedIn: false },
  });
  const payload = buildAlertPayload(health);

  assert.doesNotMatch(payload.description, /loggedIn:true/);
});

test('buildBillingFallbackAlertPayload: digest-tier (not page-worthy), distinct conditionKey from the revoked-token page', () => {
  const health = evaluateAuthHealth({
    preflight: { ok: true, mode: 'api-key', storedDetail: 'OAuth access token has been revoked' },
    authStatus: { loggedIn: false },
  });
  const payload = buildBillingFallbackAlertPayload(health);

  assert.equal(payload.conditionKey, 'claude-auth:api-key-fallback');
  assert.notEqual(payload.conditionKey, 'claude-auth:revoked', 'must not collide with the real-failure page and reuse its cooldown');
  assert.equal(payload.disposition, 'digest');
  const { isPageWorthy } = require('../../scripts/lib/page-worthy-alerts.js');
  assert.equal(isPageWorthy(payload.conditionKey), false, 'billing-fallback is a real gap but not launch-blocking — digest, not a page');
});

test('scripts/lib/page-worthy-alerts.js has claude-auth:revoked on the page-worthy allowlist', () => {
  const { isPageWorthy } = require('../../scripts/lib/page-worthy-alerts.js');
  assert.equal(isPageWorthy('claude-auth:revoked'), true);
});
