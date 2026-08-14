/**
 * Pins the detector that would have caught the 2026-08-10 incident on day 2: the
 * local claude CLI was logged out, every headless auto-fix job produced zero
 * output and timed out, and the owner got a near-identical digest for 13 days
 * while "Alert Router: dispatch deadman" read 42/42 green (it counts launches).
 *
 * Also pins the corrections from code review of d8d11372ffc, where the first
 * version of this detector would itself have gone permanently red in CI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  assessAutofixEffectiveness,
  readLedgerRows,
  MIN_OUTCOMES_TO_JUDGE,
} = require('./autofix-effectiveness.js');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NOW = Date.parse('2026-08-10T12:00:00.000Z');
const at = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const pass = (h = 1) => ({ event: 'card-pass', ts: at(h) });
const fail = (h = 1) => ({ event: 'card-fail', ts: at(h) });
const launch = (h = 1) => ({ event: 'auto-dispatch', ts: at(h) });
const many = (n, f) => Array.from({ length: n }, () => f());

test('all outcomes failing is an ERROR', () => {
  const r = assessAutofixEffectiveness([...many(3, launch), fail(), fail(), fail()], { now: NOW });
  assert.equal(r.status, 'error');
  assert.equal(r.passes, 0);
  assert.match(r.message, /DEAD/);
});

test('the error points at the job logs and .env, NOT at the CLI login', () => {
  // 2026-08-11: the original wording told the reader to run `claude -p` and look
  // for "Not logged in". That is the wrong check — the fleet does not use the
  // CLI's stored login at all; claude-cli.js injects ANTHROPIC_API_KEY /
  // CLAUDE_CODE_OAUTH_TOKEN from .env into every spawned job. A bare probe from
  // an interactive shell reports "Not logged in" even while the fleet is healthy,
  // and that false reading was escalated to the owner as a total outage twice in
  // one session. The remediation must name what is actually diagnostic.
  const r = assessAutofixEffectiveness([...many(3, launch), fail(), fail(), fail()], { now: NOW });
  assert.match(r.message, /bsc-jobs/);
  assert.match(r.message, /ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/);
  assert.ok(!/Not logged in/.test(r.message),
    'must not send the reader to the CLI login, which the fleet does not use');
  assert.ok(!/claude -p/.test(r.message),
    'a bare `claude -p` probe reports logged-out even on a healthy fleet');
});

test('REGRESSION: jobs launched that never report back is an ERROR, not "not enough to judge"', () => {
  // Code review finding 3 on d8d11372ffc: the strict `attempts === 0` guard let
  // 100 launches with 2 stragglers (both failures, zero passes) read as `pass` —
  // precisely the dead-fleet shape the row exists to catch.
  const r = assessAutofixEffectiveness([...many(100, launch), fail(), fail()], { now: NOW });
  assert.equal(r.status, 'error');
  assert.equal(r.dispatched, 100);
  assert.equal(r.attempts, 2);
  assert.match(r.message, /100 job\(s\) launched .* 2 reported back, 0 succeeded/);
});

test('REGRESSION: an empty ledger is never an error on its own', () => {
  // Finding 1: the first version cross-referenced alert-router-attempts.jsonl,
  // which is git-TRACKED and re-committed by CI every run, while this ledger is
  // UNTRACKED. In CI that pairing was permanently "absent + ~100 attempts" =>
  // hard ERROR every day forever, even at 100% health, burning a daily
  // auto-dispatch slot on a card no CI session could fix.
  const r = assessAutofixEffectiveness([], { now: NOW });
  assert.notEqual(r.status, 'error');
  assert.equal(r.dispatched, 0);
  assert.equal(r.attempts, 0);
});

test('REGRESSION: only this ledger is consulted — no alert-router coupling', () => {
  // Finding 2: alert-router-attempts.jsonl logs Notion ALERT-CARD creations
  // (live entries are `e2e-canary:*`), an unrelated population. Rows of other
  // shapes must not move any counter here.
  const r = assessAutofixEffectiveness(
    [{ conditionKey: 'e2e-canary:main', ok: true, ts: at(1) },
     { conditionKey: 'e2e-canary:dedup', ok: true, ts: at(1) },
     ...many(3, launch), pass(), pass(), pass()],
    { now: NOW },
  );
  assert.equal(r.dispatched, 3);
  assert.equal(r.passes, 3);
  assert.equal(r.status, 'pass');
});

test('a majority-failing loop warns', () => {
  const r = assessAutofixEffectiveness([...many(3, launch), pass(), fail(), fail()], { now: NOW });
  assert.equal(r.status, 'warn');
  assert.match(r.message, /re-report tomorrow/);
});

test('a healthy loop passes', () => {
  const r = assessAutofixEffectiveness([...many(4, launch), pass(), pass(), pass(), fail()], { now: NOW });
  assert.equal(r.status, 'pass');
  assert.equal(r.passes, 3);
});

test('reproduces the real ledger shape from the incident', () => {
  const r = assessAutofixEffectiveness(
    [...many(18, launch), ...many(4, pass), ...many(10, fail)],
    { now: NOW },
  );
  assert.equal(r.status, 'warn');
  assert.equal(r.passes, 4);
  assert.equal(r.fails, 10);
});

test('too few outcomes with too few launches stays quiet', () => {
  const r = assessAutofixEffectiveness([launch(), launch(), fail()], { now: NOW });
  assert.equal(r.status, 'pass');
  assert.ok(r.attempts < MIN_OUTCOMES_TO_JUDGE);
});

test('outcomes outside the window are excluded', () => {
  const r = assessAutofixEffectiveness(many(3, () => fail(24 * 30)), { now: NOW });
  assert.equal(r.attempts, 0);
  assert.equal(r.status, 'pass');
});

test('undated rows are surfaced, not counted as outcomes and not silently dropped', () => {
  // Finding 4: the ledger is append-only with no retention pass, so counting
  // unparseable-ts rows as normal outcomes made them permanent — 3 phantom fails
  // would hold a fully healthy loop at WARN forever. They are reported instead.
  const r = assessAutofixEffectiveness(
    [{ event: 'card-fail' }, { event: 'card-fail', ts: 'garbage' },
     ...many(4, launch), ...many(3, pass), pass()],
    { now: NOW },
  );
  assert.equal(r.undated, 2);
  assert.equal(r.status, 'pass', 'phantom rows must not condemn a healthy loop');
  assert.match(r.message, /unreadable timestamps/);
});

test('messages stay under the 400-char card truncation limit', () => {
  // Finding 6: digest-autofix.js slices message to 400 chars before filing the
  // card, which cut off the remediation clause in the original wording.
  const cases = [
    assessAutofixEffectiveness([...many(100, launch), fail(), fail()], { now: NOW }),
    assessAutofixEffectiveness([...many(3, launch), fail(), fail(), fail()], { now: NOW }),
    assessAutofixEffectiveness([...many(3, launch), pass(), fail(), fail()], { now: NOW }),
  ];
  for (const r of cases) {
    assert.ok(r.message.length <= 400, `message ${r.message.length} chars: ${r.message}`);
  }
});

test('survives junk input without throwing', () => {
  for (const bad of [null, undefined, 'nope', 42, [null, undefined, {}]]) {
    const r = assessAutofixEffectiveness(bad, { now: NOW });
    assert.equal(r.status, 'pass');
    assert.equal(r.attempts, 0);
  }
});

// readLedgerRows (task #1220/BRO-230): the standalone read+parse helper a
// caller on the SAME machine as the ledger (send-morning-digest.js) uses to
// bypass health-check.js's CI-only view of this data.
test('readLedgerRows: returns null (not []) when the file is absent — "unknown" must never read as "empty and healthy"', () => {
  const missing = path.join(os.tmpdir(), `no-such-ledger-${process.pid}-${Date.now()}.jsonl`);
  assert.equal(readLedgerRows(missing), null);
});

test('readLedgerRows: parses real JSONL, skipping unparseable lines', () => {
  const tmp = path.join(os.tmpdir(), `ledger-test-${process.pid}.jsonl`);
  fs.writeFileSync(tmp, [
    JSON.stringify({ event: 'auto-dispatch', ts: '2026-08-14T10:00:00Z' }),
    'not json',
    JSON.stringify({ event: 'card-fail', ts: '2026-08-14T10:05:00Z' }),
    '',
  ].join('\n'));
  try {
    const rows = readLedgerRows(tmp);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].event, 'auto-dispatch');
    assert.equal(rows[1].event, 'card-fail');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('readLedgerRows -> assessAutofixEffectiveness: real dead-fleet ledger on disk reproduces the DEAD verdict', () => {
  const tmp = path.join(os.tmpdir(), `ledger-dead-${process.pid}.jsonl`);
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push({ event: 'auto-dispatch', taskId: `t${i}`, ts: new Date(NOW - i * 3600_000).toISOString() });
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n'));
  try {
    const parsed = readLedgerRows(tmp);
    const r = assessAutofixEffectiveness(parsed, { now: NOW });
    assert.equal(r.status, 'error');
    assert.match(r.message, /DEAD/);
  } finally {
    fs.unlinkSync(tmp);
  }
});
