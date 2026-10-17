import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findOverlappingCards, filePathsIn, titlesOverlap } = require('./dispatch-overlap-check.js');
const os = require('os');
const path = require('path');
const fs = require('fs');
// Task #1896: the mirror-staleness race findOverlappingCards alone can't
// close — its input snapshot only shows a task as in_progress once the
// local task mirror already says so, and nothing writes that until the
// DISPATCHED session itself gets around to it, minutes later. The actual
// fix is scripts/lib/atomic-claim.js's atomic per-task claim, wired into
// bsc-next.js's fresh-dispatch path ahead of the overlap check this file
// tests. Required directly here (not re-exported from dispatch-overlap-
// check.js, which stays pure/no-I/O by convention) so the acceptance
// criteria's `node --test scripts/lib/dispatch-overlap-check.test.mjs`
// command exercises the real race-closing primitive, not just the guard.
const { acquireClaim, releaseClaim } = require('./atomic-claim.js');

test('findOverlappingCards flags an in_progress card sharing a scripts/ file path (#893/#902 class)', () => {
  const target = { id: '902', subject: 'Coverage Verdict S0: foundations', notes: 'Fix scripts/audit-show-review-gap.js self-clobber.' };
  const other = { id: '893', subject: 'Send-day gap-audit state is self-clobbering', notes: 'scripts/audit-show-review-gap.js overwrites its own state.' };
  const hits = findOverlappingCards(target, [other]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].card.id, '893');
  assert.equal(hits[0].reason, 'shared-file-path');
  assert.deepEqual(hits[0].sharedPaths, ['scripts/audit-show-review-gap.js']);
});

test('findOverlappingCards flags a byte-identical title as exact-title-match, not similar-title (task #1672: this is proof, not a hint)', () => {
  const target = { id: '911', subject: 'Extract pushCookieSecretWithMeta() helper so #850/#876 OTP-login outlets inherit cookie freshness fix', notes: '' };
  const other = { id: '897', subject: 'Extract pushCookieSecretWithMeta() helper so #850/#876 OTP-login outlets inherit cookie freshness fix', notes: '' };
  const hits = findOverlappingCards(target, [other]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].card.id, '897');
  assert.equal(hits[0].reason, 'exact-title-match');
});

test('findOverlappingCards flags a true prefix (non-identical) title overlap as similar-title (#897/#911-style near-miss)', () => {
  const target = { id: '911', subject: 'Extract pushCookieSecretWithMeta() helper so #850/#876 OTP-login outlets inherit cookie freshness fix', notes: '' };
  const other = { id: '897', subject: 'Extract pushCookieSecretWithMeta() helper so #850/#876 OTP-login outlets inherit cookie freshness', notes: '' };
  const hits = findOverlappingCards(target, [other]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].card.id, '897');
  assert.equal(hits[0].reason, 'similar-title');
});

test('findOverlappingCards ignores unrelated cards', () => {
  const target = { id: '1', subject: 'Fix homepage rage clicks', notes: 'scripts/audit-rage-clicks.js' };
  const other = { id: '2', subject: 'Send-day gap-audit state is self-clobbering', notes: 'scripts/audit-show-review-gap.js overwrites its own state.' };
  assert.deepEqual(findOverlappingCards(target, [other]), []);
});

test('findOverlappingCards excludes the target card itself even if it appears in the in_progress list', () => {
  const target = { id: '5', subject: 'Fix scripts/foo.js bug', notes: 'scripts/foo.js' };
  assert.deepEqual(findOverlappingCards(target, [target]), []);
});

test('findOverlappingCards returns ALL colliding cards, not just the first', () => {
  const target = { id: '1', subject: 'Fix scripts/foo.js bug', notes: 'scripts/foo.js' };
  const a = { id: '2', subject: 'Unrelated but touches scripts/foo.js too', notes: 'scripts/foo.js' };
  const b = { id: '3', subject: 'Fix scripts/foo.js bug', notes: '' }; // near-identical title
  const c = { id: '4', subject: 'Totally different long unrelated title text', notes: 'scripts/bar.js' };
  const hits = findOverlappingCards(target, [a, b, c]);
  assert.deepEqual(hits.map(h => h.card.id).sort(), ['2', '3']);
});

test('findOverlappingCards handles missing/malformed input without throwing', () => {
  assert.deepEqual(findOverlappingCards(null, [{ id: '1' }]), []);
  assert.deepEqual(findOverlappingCards({ id: '1', subject: 'x' }, null), []);
  assert.deepEqual(findOverlappingCards({ id: '1', subject: 'x' }, [null, undefined]), []);
});

test('filePathsIn extracts scripts/ paths and ignores non-scripts paths', () => {
  const text = 'Touches scripts/lib/foo.js and src/app/page.tsx and scripts/bar.sh, also scripts/baz.py (unsupported ext)';
  assert.deepEqual([...filePathsIn(text)].sort(), ['scripts/bar.sh', 'scripts/lib/foo.js']);
});

test('titlesOverlap requires both titles to clear the 20-char floor', () => {
  assert.equal(titlesOverlap('Fix: CI red', 'Fix: CI red today'), false); // too short
  assert.equal(titlesOverlap('Extract the shared helper function', 'Extract the shared helper function today'), true);
  assert.equal(titlesOverlap('Extract the shared helper function', 'Completely unrelated long title here'), false);
});

// ── Task #1896 race-simulation cases ────────────────────────────────────────
// The real incident: task #1893 was independently dispatched 4x within ~8
// minutes because findOverlappingCards' in_progress snapshot never reflected
// any of the in-flight attempts (nothing marks a task in_progress until the
// dispatched session itself gets around to it, minutes later). acquireClaim
// closes this by giving concurrent bsc-next.js processes a single, atomic
// per-task gate to race on BEFORE they ever reach the overlap check.

test('acquireClaim: race simulation — two dispatch attempts for the same stale-mirror task, only one may proceed (task #1896)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-claim-race-'));
  try {
    // Both "attempts" model bsc-next.js processes that loaded the identical
    // stale (not-yet-in_progress) mirror snapshot for task #1893 and, absent
    // this claim, would BOTH have passed findOverlappingCards and dispatched.
    const first = acquireClaim(dir, '1893');
    const second = acquireClaim(dir, '1893');
    assert.equal(first, true, 'first attempt claims the slot');
    assert.equal(second, false, 'second concurrent attempt on the same task must be refused, not also proceed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireClaim: does not block a DIFFERENT task id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-claim-race-'));
  try {
    assert.equal(acquireClaim(dir, '1893'), true);
    assert.equal(acquireClaim(dir, '1894'), true, 'an unrelated task id must never contend for #1893\'s claim');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireClaim: a stale claim (crashed or long-dead prior attempt) can be taken over', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-claim-race-'));
  try {
    assert.equal(acquireClaim(dir, '1893', { staleMs: 1000, now: 1000 }), true);
    assert.equal(acquireClaim(dir, '1893', { staleMs: 1000, now: 1500 }), false, 'still fresh at +500ms');
    assert.equal(acquireClaim(dir, '1893', { staleMs: 1000, now: 3000 }), true, 'stale at +2000ms — takeover allowed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseClaim allows an immediate reclaim — the legitimate same-session dead-launch retry path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-claim-race-'));
  try {
    // Mirrors the real incident's OWN legitimate retries (08:33 dead ->
    // 08:39 relaunch of the same task by the same session): those must never
    // be blocked by this claim, only genuinely concurrent OTHER attempts.
    assert.equal(acquireClaim(dir, '1893'), true);
    releaseClaim(dir, '1893');
    assert.equal(acquireClaim(dir, '1893'), true, 'a retry after releasing must not be refused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireClaim: unreadable/corrupt claim metadata fails closed, never guesses the slot is free', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-claim-race-'));
  try {
    fs.mkdirSync(path.join(dir, '1893.claim'));
    fs.writeFileSync(path.join(dir, '1893.claim', 'meta.json'), 'not valid json{{{');
    assert.equal(acquireClaim(dir, '1893'), 'error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Real CI catch (task #1896, live in the "Unit Tests" job): mkdirSync(p) and
// the meta.json write are two separate syscalls, not one atomic unit — a
// concurrent reader can win the EEXIST race against a winner that hasn't
// finished writing meta.json yet. That's "held, try again shortly", not
// corruption, and must NOT return 'error' (which reads as fail-closed/
// permanent to dispatchClaimGuard's caller) — distinct from the genuinely
// corrupt-JSON case above.
test('acquireClaim: a claim dir that exists but has no meta.json YET (winner mid-write) is treated as held, not corrupt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-claim-race-'));
  try {
    fs.mkdirSync(path.join(dir, '1893.claim')); // directory exists; meta.json not written yet
    assert.equal(acquireClaim(dir, '1893'), false, 'must read as "held, not stale", never as an error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
