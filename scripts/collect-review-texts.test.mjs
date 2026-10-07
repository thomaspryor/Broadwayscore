// BRO-2381: scripts/audit-workflow-secret-gaps.js (task #1855) found that
// several workflows invoke collect-review-texts.js in a step whose env never
// provides REVIEW_TEXTS_TOKEN. pushReviewTextsCheckpoint() gated on that
// token (and GITHUB_ACTIONS) with a bare `return` and no logging, so the
// mid-run private-repo checkpoint silently no-op'd for the whole run with
// nothing in the job log to show it — see scripts/lib/review-texts-
// checkpoint-gate.js for the extracted decision function this requires
// (CLAUDE.md rule 15: require() the real function, don't reimplement it
// here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
// BRO-2381 ship-check finding (Codex): pushReviewTextsCheckpoint() operates on
// `data/review-texts` relative to process.cwd() — a real private-repo
// checkout there (some dev machines clone it for local testing) would have
// its git identity/remote reconfigured, everything staged, and possibly a
// real commit made if calling this function past the gate. Tests below that
// exercise the "gate passes" path skip when a real checkout is present.
const HAS_REAL_REVIEW_TEXTS_CHECKOUT = fs.existsSync(path.join(process.cwd(), 'data', 'review-texts', '.git'));
const { shouldPushReviewTextsCheckpoint } = require('./lib/review-texts-checkpoint-gate.js');
const { pushReviewTextsCheckpoint } = require('./collect-review-texts.js');

test('shouldPushReviewTextsCheckpoint: ok only when both REVIEW_TEXTS_TOKEN and GITHUB_ACTIONS are set', () => {
  assert.deepEqual(
    shouldPushReviewTextsCheckpoint({ REVIEW_TEXTS_TOKEN: 'ghs_abc', GITHUB_ACTIONS: 'true' }),
    { ok: true, reason: null }
  );
});

test('shouldPushReviewTextsCheckpoint: no-ops with a reason when REVIEW_TEXTS_TOKEN is missing', () => {
  const result = shouldPushReviewTextsCheckpoint({ GITHUB_ACTIONS: 'true' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /REVIEW_TEXTS_TOKEN/);
});

test('shouldPushReviewTextsCheckpoint: no-ops with a reason when GITHUB_ACTIONS is missing (local dev)', () => {
  const result = shouldPushReviewTextsCheckpoint({ REVIEW_TEXTS_TOKEN: 'ghs_abc' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /GitHub Actions/);
});

test('shouldPushReviewTextsCheckpoint: no-ops with a reason when both are missing', () => {
  const result = shouldPushReviewTextsCheckpoint({});
  assert.equal(result.ok, false);
  assert.match(result.reason, /REVIEW_TEXTS_TOKEN/);
  assert.match(result.reason, /GitHub Actions/);
});

// Integration-level: pushReviewTextsCheckpoint() itself must consult the
// same gate rather than re-deriving the condition inline (the original bug
// was exactly this kind of drift becoming silent). Exercised against
// process.env directly since that's the real call site's contract; every
// case restores the original env afterward.
function withEnv(overrides, fn) {
  const original = { REVIEW_TEXTS_TOKEN: process.env.REVIEW_TEXTS_TOKEN, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test('pushReviewTextsCheckpoint: no-ops and logs why when REVIEW_TEXTS_TOKEN is missing', () => {
  const lines = withEnv({ REVIEW_TEXTS_TOKEN: undefined, GITHUB_ACTIONS: 'true' }, () =>
    captureLogs(() => pushReviewTextsCheckpoint(42))
  );
  assert.ok(
    lines.some((l) => l.includes('Skipping review-texts checkpoint push') && l.includes('REVIEW_TEXTS_TOKEN')),
    `expected a visible skip reason, got: ${JSON.stringify(lines)}`
  );
});

test('pushReviewTextsCheckpoint: no-ops silently-safe (does not throw) when not in CI', () => {
  withEnv({ REVIEW_TEXTS_TOKEN: undefined, GITHUB_ACTIONS: undefined }, () => {
    assert.doesNotThrow(() => pushReviewTextsCheckpoint(0));
  });
});

test('pushReviewTextsCheckpoint: passes the gate (does not early-return on the token check) when both env vars are set', (t) => {
  if (HAS_REAL_REVIEW_TEXTS_CHECKOUT) {
    // A real private-repo checkout is present — calling pushReviewTextsCheckpoint()
    // past the gate would reconfigure its git identity/remote, stage everything
    // in it, and could commit real uncommitted work. Skip rather than risk that;
    // the pure-function tests above already cover this exact case.
    t.skip('data/review-texts/.git exists — skipping to avoid mutating a real private-repo checkout');
    return;
  }
  // With both set, the function proceeds past the gate to the private-repo
  // checkout check — which fails safe with its own distinct log line when
  // data/review-texts/.git isn't present (true both in local dev and in this
  // test's environment). The point under test is that it does NOT emit the
  // "Skipping review-texts checkpoint push" gate message in this case — that
  // would mean the gate is still blocking a run that should be allowed through.
  const lines = withEnv({ REVIEW_TEXTS_TOKEN: 'ghs_abc', GITHUB_ACTIONS: 'true' }, () =>
    captureLogs(() => pushReviewTextsCheckpoint(1))
  );
  assert.ok(
    !lines.some((l) => l.includes('Skipping review-texts checkpoint push')),
    `gate should not have blocked this call, got: ${JSON.stringify(lines)}`
  );
});

// BRO-2691: SHOW_FILTER must restrict candidates, and the report must not
// present resumed (progress.json) cross-show state as this run's work.
const { isShowFilterActive, parseShowFilter, isInShowScope, showIdOfReviewId, summarizeRunScope } = require('./lib/show-scope.js');

test('BRO-2691: parseShowFilter trims, drops empties; empty filter = no restriction', () => {
  assert.deepEqual([...parseShowFilter(' a-1 , b-2,, ')], ['a-1', 'b-2']);
  assert.equal(parseShowFilter('').size, 0);
  assert.equal(isInShowScope('anything', parseShowFilter('')), true);
});

test('BRO-2691: isInShowScope only admits listed shows', () => {
  const set = parseShowFilter('romeo-and-juliet-off-broadway-2026,benevolent-off-broadway-2026');
  assert.equal(isInShowScope('benevolent-off-broadway-2026', set), true);
  assert.equal(isInShowScope('fly-you-fools-off-broadway-2026', set), false);
});

test('BRO-2691: summarizeRunScope separates this run from resumed state and flags out-of-scope', () => {
  const set = parseShowFilter('a-show');
  const s = summarizeRunScope({
    runProcessed: ['a-show/x.json'], runFailed: ['a-show/y.json'], filterSet: set,
    resumedProcessed: 100, resumedFailed: 72,
  });
  assert.deepEqual(s.shows, ['a-show']);
  assert.deepEqual(s.outOfScopeShows, []);
  assert.deepEqual(s.inheritedFromResume, { processed: 100, failed: 72 });
  const bad = summarizeRunScope({ runFailed: ['other/z.json'], filterSet: set });
  assert.deepEqual(bad.outOfScopeShows, ['other']);
  assert.equal(showIdOfReviewId('a-show/x.json'), 'a-show');
});

test('BRO-2691: collect-review-texts.js builds its filter from the shared helper and gates the queue + main loop', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'scripts', 'collect-review-texts.js'), 'utf8');
  assert.match(src, /showFilterSet: parseShowFilter\(process\.env\.SHOW_FILTER\)/);
  assert.doesNotMatch(src, /!CONFIG\.showFilter\)/); // one predicate: isShowFilterActive
  assert.match(src, /if \(!isInShowScope\(showId, CONFIG\.showFilterSet, CONFIG\.showFilter\)\) continue;/);
  assert.match(src, /isInShowScope\(showIdOfReviewId\(review\.reviewId\), CONFIG\.showFilterSet, CONFIG\.showFilter\)/);
  assert.match(src, /thisRun: summarizeRunScope\(/);
});

test('BRO-2691: degenerate SHOW_FILTER (",") fails closed: matches nothing, not everything', () => {
  const raw = ',';
  const set = parseShowFilter(raw);
  assert.equal(set.size, 0);
  assert.equal(isShowFilterActive(set, raw), true);
  assert.equal(isInShowScope('any-show', set, raw), false);
  assert.equal(isShowFilterActive(parseShowFilter(''), ''), false);
});

// ─── BRO-3059: where do duplicate state.failed entries really come from? ───
// Card hypothesis: concurrent collect-review-texts.js processes (opening-night-
// poller.yml, collect-we-ob-reviews.yml, collect-review-texts.yml) race on
// data/collection-state/progress.json and BOTH failures for one reviewId
// survive. Measured here with real file I/O, the real guard functions and
// real `git merge-file` (the line-merge git applies to this file):
//   1. file-level race is last-writer-wins -> one copy, NOT a duplicate
//      (the other process's ids are LOST instead)
//   2. identical tail insertions from two processes merge to ONE line in git
//   3. the mechanism that really duplicates is RETRY_FAILED=true inside ONE
//      process, which shouldSkipAlreadyAttempted deliberately allows; the
//      write-time dedupe (dedupeAttemptState, called by saveState) removes it.
const { shouldSkipAlreadyAttempted, dedupeAttemptState } = require('./lib/collection-attempt-guard.js');

const freshState = () => ({ processed: [], failed: ['r-old'] });
function procRun(file, reviewId, { retryFailed = false } = {}) {
  // load -> attempt -> push to failed (as main() does) -> save, one "process"
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!shouldSkipAlreadyAttempted(st, reviewId, retryFailed)) st.failed.push(reviewId);
  return st;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bro3059-'));

test('BRO-3059: two concurrent processes on one progress.json file are last-writer-wins, not duplicated', (t) => {
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'progress.json');
  fs.writeFileSync(file, JSON.stringify(freshState()));
  // Both load the SAME snapshot before either saves (the race window).
  const same = [procRun(file, 'r-new'), procRun(file, 'r-new')];
  fs.writeFileSync(file, JSON.stringify(same[0]));
  fs.writeFileSync(file, JSON.stringify(same[1]));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).failed, ['r-old', 'r-new']);
  // Different ids: the earlier writer's id is LOST, not merged (loss, not duplication).
  const a = procRun(file, 'r-a');
  const b = procRun(file, 'r-b');
  fs.writeFileSync(file, JSON.stringify(a));
  fs.writeFileSync(file, JSON.stringify(b));
  const final = JSON.parse(fs.readFileSync(file, 'utf8')).failed;
  assert.ok(final.includes('r-b') && !final.includes('r-a'));
});

test('BRO-3059: git line-merge of two processes appending the same failed id collapses to one entry (identical-append case only)', (t) => {
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const doc = (ids) => JSON.stringify({ failed: ids, processed: [] }, null, 2) + '\n';
  fs.writeFileSync(path.join(dir, 'base.json'), doc(['r-old']));
  fs.writeFileSync(path.join(dir, 'a.json'), doc(['r-old', 'r-new']));
  fs.writeFileSync(path.join(dir, 'b.json'), doc(['r-old', 'r-new']));
  const merged = execFileSync('git', ['merge-file', '-p', 'a.json', 'base.json', 'b.json'], { cwd: dir, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(merged).failed, ['r-old', 'r-new']);
});

test('BRO-3059: RETRY_FAILED in ONE process re-appends the same id (the real duplicate source); write-time dedupe collapses it', (t) => {
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'progress.json');
  fs.writeFileSync(file, JSON.stringify(freshState()));
  // Without retry the in-process guard blocks the repeat attempt.
  assert.equal(shouldSkipAlreadyAttempted(freshState(), 'r-old', false), true);
  // With RETRY_FAILED=true (opening-night-poller.yml, collect-we-ob-reviews.yml) it does not.
  const st = procRun(file, 'r-old', { retryFailed: true });
  assert.deepEqual(st.failed, ['r-old', 'r-old']);
  const removed = dedupeAttemptState(st); // what saveState() runs before writing
  assert.equal(removed.failed, 1);
  assert.deepEqual(st.failed, ['r-old']);
});
