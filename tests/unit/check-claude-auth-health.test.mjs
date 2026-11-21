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
const { probeWithConfirm, evaluateAuthHealth, buildAlertPayload, buildBillingFallbackAlertPayload, REPAIR_STEPS } = require('../../scripts/lib/claude-auth-health.js');

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

// ---------------------------------------------------------------------------
// BRO-2971: a spawn that never reached the auth handshake (spawnSync
// ETIMEDOUT/ENOMEM, an OS/jetsam signal kill, or a missing binary) used to
// page with the SAME 'claude-auth:revoked' framing as an actual revoked
// credential, telling on-call to re-run `claude auth login` for a problem
// that fix cannot touch. preflightAuth() (scripts/lib/claude-cli.js) now
// carries a `reason` field through; these tests prove evaluateAuthHealth and
// buildAlertPayload route it to distinct conditionKeys/remediations.
// ---------------------------------------------------------------------------

test('evaluateAuthHealth: a spawn-starved preflight failure routes to mode "spawn-starved", not "fail"', () => {
  const preflight = { ok: false, mode: 'fail', reason: 'spawn-starved', detail: 'spawnSync claude ETIMEDOUT' };
  const health = evaluateAuthHealth({ preflight, authStatus: null });

  assert.equal(health.ok, false);
  assert.equal(health.mode, 'spawn-starved');
});

test('evaluateAuthHealth: a spawn-error preflight failure (e.g. missing binary) routes to mode "spawn-error"', () => {
  const preflight = { ok: false, mode: 'fail', reason: 'spawn-error', detail: 'spawnSync claude ENOENT' };
  const health = evaluateAuthHealth({ preflight, authStatus: null });

  assert.equal(health.ok, false);
  assert.equal(health.mode, 'spawn-error');
});

test('evaluateAuthHealth: an actual auth rejection (no reason, or reason:"auth-rejected") still routes to mode "fail"', () => {
  const health = evaluateAuthHealth({
    preflight: { ok: false, mode: 'fail', detail: 'OAuth access token has been revoked' },
    authStatus: null,
  });
  assert.equal(health.mode, 'fail');
});

test('buildAlertPayload: spawn-starved gets its OWN conditionKey, no auth-login repair command, and warns against re-login', () => {
  const health = evaluateAuthHealth({
    preflight: { ok: false, mode: 'fail', reason: 'spawn-starved', detail: 'spawnSync claude ETIMEDOUT' },
    authStatus: null,
  });
  const payload = buildAlertPayload(health);

  assert.equal(payload.conditionKey, 'claude-spawn-starved');
  assert.notEqual(payload.conditionKey, 'claude-auth:revoked');
  assert.equal(payload.disposition, 'human', 'still launch-blocking, so still page-worthy');
  assert.doesNotMatch(payload.description, new RegExp(REPAIR_STEPS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'must not print the auth REPAIR_STEPS for a resource-starvation failure');
  assert.match(payload.description, /do NOT re-run `claude auth login`/);
  const { isPageWorthy } = require('../../scripts/lib/page-worthy-alerts.js');
  // BRO-4141: an overloaded Mac is not something the owner can act on; the
  // router downgrades it to the morning digest. Only claude-auth:revoked pages.
  assert.equal(isPageWorthy(payload.conditionKey), false);
});

test('buildAlertPayload: spawn-error gets its OWN conditionKey, distinct from both spawn-starved and revoked', () => {
  const health = evaluateAuthHealth({
    preflight: { ok: false, mode: 'fail', reason: 'spawn-error', detail: 'spawnSync claude ENOENT' },
    authStatus: null,
  });
  const payload = buildAlertPayload(health);

  assert.equal(payload.conditionKey, 'claude-spawn-error');
  assert.notEqual(payload.conditionKey, 'claude-spawn-starved');
  assert.notEqual(payload.conditionKey, 'claude-auth:revoked');
  assert.match(payload.description, /do NOT re-run `claude auth login`/);
  const { isPageWorthy } = require('../../scripts/lib/page-worthy-alerts.js');
  // BRO-4141: an overloaded Mac is not something the owner can act on; the
  // router downgrades it to the morning digest. Only claude-auth:revoked pages.
  assert.equal(isPageWorthy(payload.conditionKey), false);
});

test('buildBillingFallbackAlertPayload: a spawn-starved stored-probe blip is NOT reported as a confirmed revoked credential', () => {
  // The stored-login probe itself never reached the handshake (ETIMEDOUT) —
  // adversarial-review finding: without storedReason threading through, this
  // read identically to an actually-revoked stored login and told on-call to
  // re-login for a hiccup that needed no action.
  const health = evaluateAuthHealth({
    preflight: { ok: true, mode: 'api-key', storedDetail: 'spawnSync claude ETIMEDOUT', storedReason: 'spawn-starved' },
    authStatus: { loggedIn: false },
  });
  const payload = buildBillingFallbackAlertPayload(health);

  assert.doesNotMatch(health.reason, /stored OAuth login failed/, 'must not assert a confirmed failure for an unreached probe');
  assert.match(health.reason, /NOT a confirmed revoked credential/);
  assert.equal(payload.conditionKey, 'claude-auth:api-key-fallback');
});

const { pingFailureDetail } = require('../../scripts/lib/claude-cli.js');

test('probeWithConfirm: a single transient failure that recovers on re-probe is healthy (2026-10-21 false alarm)', () => {
  const results = [{ ok: false, mode: 'fail', reason: 'auth-rejected', detail: 'empty envelope' }, { ok: true, mode: 'oauth' }];
  const sleeps = [];
  const { preflight, attemptsUsed } = probeWithConfirm({ probe: () => results.shift(), sleep: ms => sleeps.push(ms), delayMs: 1000 });
  assert.equal(preflight.ok, true);
  assert.equal(attemptsUsed, 2);
  assert.deepEqual(sleeps, [1000], 'waits between attempts');
});

test('probeWithConfirm: failing every attempt still reports failure (a real revocation must page), with the LAST detail', () => {
  const results = [{ ok: false, reason: 'auth-rejected', detail: 'first' }, { ok: false, reason: 'auth-rejected', detail: 'second' }];
  const { preflight, attemptsUsed } = probeWithConfirm({ probe: () => results.shift(), sleep: () => {}, delayMs: 1 });
  assert.equal(preflight.ok, false);
  assert.equal(preflight.detail, 'second');
  assert.equal(attemptsUsed, 2);
});

test('probeWithConfirm: a NaN/negative delay (typo in an env var) falls back to the default instead of hanging Atomics.wait', () => {
  for (const bad of [NaN, -5, Infinity]) {
    const sleeps = [];
    probeWithConfirm({ probe: () => ({ ok: false }), sleep: ms => sleeps.push(ms), delayMs: bad });
    assert.deepEqual(sleeps, [45000], `delayMs=${bad} must be replaced by the finite default`);
  }
});

test('probeWithConfirm: a healthy first probe never sleeps or re-probes', () => {
  let calls = 0;
  const { attemptsUsed } = probeWithConfirm({ probe: () => { calls++; return { ok: true, mode: 'oauth' }; }, sleep: () => { throw new Error('must not sleep'); } });
  assert.equal(calls, 1);
  assert.equal(attemptsUsed, 1);
});

test('pingFailureDetail: surfaces the envelope result text instead of the leading zeroed usage fields', () => {
  const stdout = JSON.stringify({ duration_api_ms: 0, usage: { input_tokens: 0 }, is_error: true, result: 'Invalid API key · Please run /login' });
  assert.match(pingFailureDetail({ status: 1, stdout, stderr: '' }), /Please run \/login/);
  assert.match(pingFailureDetail({ status: 1, stdout: 'plain text', stderr: '' }), /plain text/);
  assert.match(pingFailureDetail({ status: 1, stdout: '', stderr: 'boom' }), /boom/);
});

test('pingFailureDetail: an envelope with an EMPTY result names subtype/is_error/api_error_status instead of zeroed usage', () => {
  const stdout = JSON.stringify({ duration_api_ms: 0, stop_reason: 'stop_sequence', is_error: true, api_error_status: 529, result: '', usage: { input_tokens: 0 } });
  const d = pingFailureDetail({ status: 1, stdout, stderr: '' });
  assert.match(d, /empty result/);
  assert.match(d, /api_error_status=529/);
  assert.doesNotMatch(d, /input_tokens/);
});

test('check-claude-auth-health.js wires probeWithConfirm around preflightAuth (not a bare single probe)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../scripts/check-claude-auth-health.js', import.meta.url), 'utf8');
  assert.match(src, /probeWithConfirm\(\{[\s\S]*probe: \(\) => preflightAuth\(/);
  assert.doesNotMatch(src, /const preflight = preflightAuth\(/);
});

test('buildBillingFallbackAlertPayload: an actual revoked stored login (auth-rejected reason) keeps the confirmed-failure wording', () => {
  const health = evaluateAuthHealth({
    preflight: { ok: true, mode: 'api-key', storedDetail: 'OAuth access token has been revoked', storedReason: 'auth-rejected' },
    authStatus: { loggedIn: false },
  });

  assert.match(health.reason, /stored OAuth login failed/);
});

// BRO-5846: 2026-10-21 the plan's monthly spend cap made a valid token fail the
// probe and the owner was told to log in again.
test('usage cap: real CLI cap envelope classifies as usage-cap, not auth-rejected, and never says to re-login', () => {
  const { classifyAuthPingFailure, isUsageCapMessage, worseAuthPingReason } = require('../../scripts/lib/claude-cli.js');
  const msg = "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message";
  assert.equal(isUsageCapMessage(msg), true);
  assert.equal(isUsageCapMessage('Invalid API key · Please run /login'), false);
  assert.equal(classifyAuthPingFailure({ status: 1, stdout: JSON.stringify({ is_error: true, result: msg }), stderr: '' }), 'usage-cap');
  assert.equal(classifyAuthPingFailure({ status: 1, stdout: '', stderr: 'Not logged in' }), 'auth-rejected');
  assert.equal(worseAuthPingReason('usage-cap', 'auth-rejected'), 'usage-cap');
  // A capped API key must not mask a rejected stored login.
  assert.equal(worseAuthPingReason('auth-rejected', 'usage-cap'), 'auth-rejected');
  // Process-level kills win over cap text in the output.
  assert.equal(classifyAuthPingFailure({ status: 137, signal: null, stdout: '', stderr: 'spend limit' }), 'spawn-starved');
  assert.equal(worseAuthPingReason('usage-cap', 'spawn-starved'), 'spawn-starved');

  const health = evaluateAuthHealth({ preflight: { ok: false, mode: 'fail', reason: 'usage-cap', detail: msg }, authStatus: { loggedIn: true } });
  assert.equal(health.mode, 'usage-cap');
  const payload = buildAlertPayload(health);
  assert.equal(payload.conditionKey, 'claude-usage-cap');
  assert.equal(payload.disposition, 'digest');
  assert.match(payload.description, /do NOT re-run `claude auth login`/);
  assert.doesNotMatch(payload.hint, /auth login/);
  const { isPageWorthy } = require('../../scripts/lib/page-worthy-alerts.js');
  assert.equal(isPageWorthy(payload.conditionKey), false);
});

test('usage cap: stored login capped but API-key fallback works -> digest billing alert with no re-login advice', () => {
  const { buildBillingFallbackAlertPayload } = require('../../scripts/lib/claude-auth-health.js');
  const health = evaluateAuthHealth({ preflight: { ok: true, mode: 'api-key', storedReason: 'usage-cap', storedDetail: 'hit your monthly spend limit' }, authStatus: null });
  assert.match(health.reason, /usage cap/);
  const p = buildBillingFallbackAlertPayload(health);
  assert.equal(p.disposition, 'digest');
  assert.doesNotMatch(p.description + p.hint, /auth logout/);
  assert.doesNotMatch(p.hint, /auth login/);
  assert.match(p.description, /Do NOT re-run/);
});

test('usage cap: opening-night monitor routing digests a cap instead of paging auth', () => {
  const { authFailureRouting } = require('../../scripts/opening-night-monitor-launch.js');
  if (typeof authFailureRouting !== 'function') return;
  assert.equal(authFailureRouting({ reason: 'usage-cap', consecutiveStarved: 1 }).page, false);
  assert.equal(authFailureRouting({ reason: 'auth-rejected', consecutiveStarved: 1 }).page, true);
});
