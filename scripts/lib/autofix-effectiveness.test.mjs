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
// Default 4h, not 1h (BRO-3321): a dispatch only counts toward dispatched/
// silent once it is older than ORPHAN_TIMEOUT_H (3h), because reconciliation
// declares nothing before then — so a 1h-old launch is not evidence of
// silence, it is evidence of nothing yet. These fixtures mean "launches that
// have had their chance and said nothing", which is what 4h expresses. The
// grace itself is pinned separately below ('a dispatch younger than the
// orphan timeout is not evidence of silence').
const launch = (h = 4) => ({ event: 'auto-dispatch', ts: at(h) });
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

// BRO-3868: digest-autofix-ledger.jsonl is now merge=union — a sync's union
// recovery can leave the SAME row twice. assessAutofixEffectiveness has no
// dedupe of its own, so readLedgerRows must collapse an exact duplicate line
// before it reaches the daily bucketing, or a resurrected dispatch/outcome
// row would be double-counted.
test('readLedgerRows: collapses byte-identical duplicate lines to one row', () => {
  const tmp = path.join(os.tmpdir(), `ledger-dup-${process.pid}.jsonl`);
  const line = JSON.stringify({ event: 'auto-dispatch', ts: '2026-09-16T11:37:07.007Z' });
  fs.writeFileSync(tmp, `${line}\n${line}\n`);
  try {
    const rows = readLedgerRows(tmp);
    assert.equal(rows.length, 1, 'a union-resurrected exact duplicate must count once, not twice');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('readLedgerRows -> assessAutofixEffectiveness: real dead-fleet ledger on disk reproduces the DEAD verdict', () => {
  const tmp = path.join(os.tmpdir(), `ledger-dead-${process.pid}.jsonl`);
  const rows = [];
  // Offset past ORPHAN_TIMEOUT_H (BRO-3321) — same reason the `launch` helper
  // defaults to 4h. These 5 launches are meant to have had their chance and
  // reported nothing; inside the grace they would mean "not yet", not "dead".
  for (let i = 0; i < 5; i++) rows.push({ event: 'auto-dispatch', taskId: `t${i}`, ts: new Date(NOW - (i + 4) * 3600_000).toISOString() });
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

// ── BRO-3321: the 2026-09-14 false "Auto-fix loop is DEAD" banner ────────────
// The digest reconciled three dispatches from 2026-08-14 — 31 days stale,
// because the digest itself had not run in between — stamped all three
// card-fails with the RECONCILIATION time, then read them back as three fresh
// failures. It emailed the owner that the loop was dead while, in the same
// pass, three new dispatches (BRO-352/471/472) spawned and reached job-done
// inside the hour.

const AUG_DISPATCH = '2026-08-14T11:30:46.270Z';
const SEP_RECONCILE = '2026-09-14T11:37:13.131Z';
const DIGEST_MOMENT = Date.parse('2026-09-14T11:37:20Z');

// The exact 9 rows that were on disk, in order.
function realIncidentLedger({ stamped }) {
  const fail = (cardId) => ({
    ts: SEP_RECONCILE, event: 'card-fail', cardId, contentHash: 'h-' + cardId,
    ...(stamped ? { judgedDispatchTs: AUG_DISPATCH } : {}),
  });
  return [
    { ts: AUG_DISPATCH, event: 'auto-dispatch', taskId: '1386', contentHash: 'h-1386' },
    { ts: AUG_DISPATCH, event: 'auto-dispatch', taskId: '1166', contentHash: 'h-1166' },
    { ts: AUG_DISPATCH, event: 'auto-dispatch', taskId: 'BRO-303', contentHash: 'h-BRO-303' },
    fail('1386'), fail('1166'), fail('BRO-303'),
    { ts: '2026-09-14T11:37:13.134Z', event: 'auto-dispatch', taskId: 'BRO-352', contentHash: 'h352' },
    { ts: '2026-09-14T11:37:13.135Z', event: 'auto-dispatch', taskId: 'BRO-471', contentHash: 'h471' },
    { ts: '2026-09-14T11:37:13.136Z', event: 'auto-dispatch', taskId: 'BRO-472', contentHash: 'h472' },
  ];
}

test('regression: month-old failures reconciled today no longer read as a dead loop', () => {
  const before = assessAutofixEffectiveness(realIncidentLedger({ stamped: false }), { now: DIGEST_MOMENT });
  assert.equal(before.status, 'error', 'control: the unstamped shape is what emailed the owner');
  assert.match(before.message, /DEAD/);

  const after = assessAutofixEffectiveness(realIncidentLedger({ stamped: true }), { now: DIGEST_MOMENT });
  assert.notEqual(after.status, 'error', 'must not call a live loop dead; got ' + JSON.stringify(after));
  assert.doesNotMatch(after.message, /DEAD/, 'the banner this whole fix exists to remove');
  assert.equal(after.attempts, 0, 'the 31-day-old failures must age out of a 7d window');
});

test('a dispatch younger than the orphan timeout is not evidence of silence', () => {
  // The half that ageing alone does NOT fix. With the card-fails aged out
  // correctly the ledger still reads dispatched=3, attempts=0, silent=3 —
  // which satisfies the silent-dispatch DEAD branch. The digest dispatches and
  // then immediately measures itself, so without a grace period every run that
  // dispatched its full cap would declare the loop dead.
  const justNow = Date.parse('2026-09-14T11:37:13Z');
  const rows = [0, 1, 2].map((i) => ({
    ts: new Date(justNow + i).toISOString(), event: 'auto-dispatch', taskId: 't' + i, contentHash: 'h' + i,
  }));
  const r = assessAutofixEffectiveness(rows, { now: justNow + 60000 });
  assert.notEqual(r.status, 'error', 'a dispatch made 1 minute ago cannot have reported back; got ' + JSON.stringify(r));
  assert.equal(r.tooYoung, 3);
  assert.match(r.message, /too recent to have reported back/);
});

test('the grace period expires — dispatches that never report back DO still read as dead', () => {
  // The grace must delay the alarm by one cycle, not disable it.
  const t0 = Date.parse('2026-09-10T11:00:00Z');
  const rows = [0, 1, 2].map((i) => ({
    ts: new Date(t0 + i).toISOString(), event: 'auto-dispatch', taskId: 't' + i, contentHash: 'h' + i,
  }));
  const r = assessAutofixEffectiveness(rows, { now: t0 + 12 * 60 * 60 * 1000 });
  assert.equal(r.status, 'error', '12h later with nothing heard back IS the dead shape; got ' + JSON.stringify(r));
  assert.equal(r.tooYoung, 0);
  assert.equal(r.dispatched, 3);
});

test('outcome rows written before judgedDispatchTs existed still age by ts (back-compat)', () => {
  const now = Date.parse('2026-09-14T12:00:00Z');
  const recent = new Date(now - 2 * 24 * 3600 * 1000).toISOString();
  const rows = [
    { ts: recent, event: 'card-fail', cardId: 'a', contentHash: 'h' },
    { ts: recent, event: 'card-fail', cardId: 'b', contentHash: 'h' },
    { ts: recent, event: 'card-fail', cardId: 'c', contentHash: 'h' },
  ];
  const r = assessAutofixEffectiveness(rows, { now });
  assert.equal(r.attempts, 3, 'unstamped rows must still be counted, not silently dropped');
  assert.equal(r.status, 'error', 'three real in-window failures with no passes is genuinely dead');
});

test('the 400-char card bound holds on a DEAD message carrying BOTH diagnostic notes', () => {
  // The existing length test never set tooYoung, so when BRO-3321 appended
  // youngNote to the DEAD messages the worst case silently grew to 436 chars —
  // past digest-autofix.js:187's slice(0, 400) — while the test that exists to
  // guard exactly this still passed. Construct the actual worst case: a DEAD
  // verdict with a too-young dispatch AND an undated row, so both notes render.
  const now = Date.parse('2026-09-14T12:00:00Z');
  const old = new Date(now - 5 * 24 * 3600 * 1000).toISOString();
  const rows = [
    ...[0, 1, 2].map((i) => ({ event: 'auto-dispatch', ts: old, taskId: 't' + i })),
    ...[0, 1, 2].map((i) => ({ event: 'card-fail', ts: old, cardId: 't' + i, judgedDispatchTs: old })),
    { event: 'auto-dispatch', ts: new Date(now - 60000).toISOString(), taskId: 'young' },
    { event: 'card-fail', ts: 'not-a-date', cardId: 'z' },
  ];
  const r = assessAutofixEffectiveness(rows, { now });
  assert.equal(r.status, 'error', 'fixture precondition: must be the DEAD branch');
  assert.ok(r.tooYoung > 0 && r.undated > 0, 'fixture precondition: both notes must render');
  assert.ok(
    r.message.length <= 400,
    `DEAD message is ${r.message.length} chars — digest-autofix.js truncates at 400, and the remediation clause must survive: ${r.message}`
  );
  assert.match(r.message, /ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/, 'the instructions are the part that must not be truncated away');
});

test('the 400-char card bound holds on BOTH DEAD branches at extreme counts', () => {
  // The first version of this test pinned only the passes===0 branch and only
  // at small counts. Review found the OTHER DEAD branch (silent-dispatch) runs
  // longer — 392 chars, eight from the limit — which is the same "passes for
  // the inputs it happens to pick" failure the test was added to close.
  // Both branches, both notes rendering, counts inflated to widen every
  // interpolated number.
  const now = Date.parse('2026-09-14T12:00:00Z');
  const old = new Date(now - 5 * 24 * 3600 * 1000).toISOString();
  const mk = (nDispatch, nFail) => [
    ...Array.from({ length: nDispatch }, (_, i) => ({ event: 'auto-dispatch', ts: old, taskId: 't' + i })),
    ...Array.from({ length: nFail }, (_, i) => ({ event: 'card-fail', ts: old, cardId: 't' + i, judgedDispatchTs: old })),
    { event: 'auto-dispatch', ts: new Date(now - 60000).toISOString(), taskId: 'young' },
    { event: 'card-fail', ts: 'not-a-date', cardId: 'z' },
  ];

  // Pin that these are genuinely TWO branches. Asserting only status==='error'
  // on both would keep passing if they ever collapsed into one, and the whole
  // point of this test is that the two have different lengths. (The earlier
  // "392 chars, eight from the limit" note above described the message BEFORE
  // undatedNote was trimmed; the trimmed worst case measures 362.)
  const seen = new Set();
  for (const [label, rows] of [['silent-dispatch', mk(9999, 0)], ['passes===0', mk(3, 9999)]]) {
    const r = assessAutofixEffectiveness(rows, { now });
    assert.equal(r.status, 'error', `${label}: fixture precondition — must be a DEAD branch`);
    assert.ok(r.tooYoung > 0 && r.undated > 0, `${label}: fixture precondition — both notes must render`);
    assert.ok(
      r.message.length <= 400,
      `${label}: message is ${r.message.length} chars, over digest-autofix.js's slice(0, 400): ${r.message}`
    );
    assert.match(
      r.message,
      /ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/,
      `${label}: the remediation instructions are the part that must survive truncation`
    );
    seen.add(label);
    // Assert the SHAPE of each branch, not merely that two strings differ.
    // `seen.size === 2` on the raw messages proved nothing: the fixtures carry
    // different counts (9999 vs 3), so a single collapsed template would still
    // interpolate two distinct strings and pass. These two phrasings come from
    // genuinely different branches.
    if (label === 'silent-dispatch') {
      assert.match(r.message, /job\(s\) launched .* reported back/, 'silent-dispatch branch must report launches with no reply');
      assert.doesNotMatch(r.message, /0 of \d+ job\(s\) succeeded/, 'must not be the passes===0 branch');
    } else {
      assert.match(r.message, /0 of \d+ job\(s\) succeeded/, 'passes===0 branch must report outcomes that all failed');
      // NOT /reported back/ — youngNote ("too recent to have reported back")
      // contains that phrase and renders on both branches. The discriminator
      // has to be the branch's own clause.
      assert.doesNotMatch(r.message, /job\(s\) launched in the last/, 'must not be the silent-dispatch branch');
    }
  }
  assert.equal(seen.size, 2, 'both branches must actually have been exercised');
});
