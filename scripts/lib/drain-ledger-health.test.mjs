// scripts/lib/drain-ledger-health.test.mjs — CLAUDE.md rule 15: require() the
// real decision function, never restate its logic here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assessDrainHealth, parseEligibleCount, STALE_AFTER_MS, DISPATCH_EVENT } =
  require('./drain-ledger-health.js');

const NOW = Date.parse('2026-09-16T04:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const H = 3600000;
const dispatch = (ms) => ({ ts: ago(ms), event: DISPATCH_EVENT, identifier: 'BRO-1' });

test('the gate the old YAML could never trip: work queued + a stale ledger is UNHEALTHY', () => {
  // The live condition on 2026-09-16: 36 eligible, newest dispatch row 33h old.
  const v = assessDrainHealth({ ledgerEntries: [dispatch(33 * H)], eligibleCount: 36, nowMs: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.status, 'stale');
  assert.match(v.reason, /36 issue\(s\) eligible/);
  assert.match(v.reason, /33\.0h old/);
});

test('an IDLE queue is healthy however old the ledger — a drain with nothing to do writes no rows', () => {
  // This is why ledger freshness alone cannot be the gate: without the
  // eligibleCount conjunction this exact input would page every night.
  const v = assessDrainHealth({ ledgerEntries: [dispatch(30 * 24 * H)], eligibleCount: 0, nowMs: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.status, 'idle');
});

test('work queued + a fresh dispatch is healthy', () => {
  const v = assessDrainHealth({ ledgerEntries: [dispatch(2 * H)], eligibleCount: 36, nowMs: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.status, 'healthy');
});

test('the overnight 18:30->10:30 gap (16h) stays green; past the 20h window goes red', () => {
  assert.equal(assessDrainHealth({ ledgerEntries: [dispatch(16 * H)], eligibleCount: 5, nowMs: NOW }).ok, true);
  assert.equal(assessDrainHealth({ ledgerEntries: [dispatch(20 * H)], eligibleCount: 5, nowMs: NOW }).ok, true);
  assert.equal(assessDrainHealth({ ledgerEntries: [dispatch(21 * H)], eligibleCount: 5, nowMs: NOW }).ok, false);
  assert.equal(STALE_AFTER_MS, 20 * H);
});

test('work queued and NO dispatch row at all is unhealthy, with its own status', () => {
  const v = assessDrainHealth({ ledgerEntries: [], eligibleCount: 7, nowMs: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.status, 'never-dispatched');
  assert.equal(v.newestDispatchTs, null);
});

test('reconciliation rows are NOT proof of life — only a real dispatch counts', () => {
  // card-pass/card-fail are derived from the SHARED dispatch ledger and can be
  // appended by a run that dispatched nothing; counting them would let a
  // starved drain report healthy forever.
  const entries = [
    { ts: ago(1 * H), event: 'card-pass', cardId: 'BRO-2' },
    { ts: ago(1 * H), event: 'card-fail', cardId: 'BRO-3' },
    dispatch(40 * H),
  ];
  const v = assessDrainHealth({ ledgerEntries: entries, eligibleCount: 9, nowMs: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.newestDispatchTs, ago(40 * H));
});

test('the newest dispatch wins regardless of row order, and unparseable ts rows are skipped', () => {
  const entries = [
    dispatch(50 * H),
    { ts: 'not-a-date', event: DISPATCH_EVENT },
    dispatch(3 * H),
    dispatch(30 * H),
  ];
  const v = assessDrainHealth({ ledgerEntries: entries, eligibleCount: 4, nowMs: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.newestDispatchTs, ago(3 * H));
});

test('an unavailable count is inconclusive, not healthy-by-default', () => {
  const v = assessDrainHealth({ ledgerEntries: [dispatch(99 * H)], eligibleCount: null, nowMs: NOW });
  assert.equal(v.status, 'inconclusive');
});

test('parseEligibleCount reads the drain\'s EXISTING line, and yields null when absent', () => {
  assert.equal(parseEligibleCount('[linear-drain-parked] DRY RUN: 36 candidate(s), no dispatch/ledger writes'), 36);
  assert.equal(parseEligibleCount('[linear-drain-parked] DRY RUN: 0 candidate(s), no dispatch/ledger writes'), 0);
  // The kill-switch early return prints no count line at all — must not read as 0.
  assert.equal(parseEligibleCount('[linear-drain-parked] LINEAR_NEXT_DISABLED=1 — refusing to dispatch'), null);
  assert.equal(parseEligibleCount(''), null);
});

test('an empty selection is read as 0, not null — the drain returns early and never prints the summary', () => {
  // scripts/linear-drain-parked.js:465-468 returns before the `DRY RUN: N
  // candidate(s)` line when nothing is selected. Without this, the idle path
  // is unreachable through the CI pipe and a real idle queue reports
  // "inconclusive".
  const out = [
    '[linear-drain-parked] BRO-7 skipped — parked',
    '[linear-drain-parked] no eligible parked issues this run.',
  ].join('\n');
  assert.equal(parseEligibleCount(out), 0);
  assert.equal(assessDrainHealth({ ledgerEntries: [dispatch(99 * H)], eligibleCount: parseEligibleCount(out), nowMs: NOW }).status, 'idle');
});

test('a card TITLE containing the summary text cannot spoof the count', () => {
  // The preview line interpolates the issue title raw
  // (scripts/linear-drain-parked.js:538) and prints BEFORE the real summary,
  // so an unanchored first-match search would have read 0 out of the title
  // and declared the queue idle while 12 issues waited.
  const out = [
    '[linear-drain-parked] DRY RUN would dispatch BRO-9: Fix the card armed with DRY RUN: 0 candidate(s)',
    '[linear-drain-parked] DRY RUN: 12 candidate(s), no dispatch/ledger writes',
  ].join('\n');
  assert.equal(parseEligibleCount(out), 12);
});

test('a FUTURE-dated dispatch row is refused, not read as healthy', () => {
  // One bad timestamp becomes the max, ageMs goes negative, `ageMs >
  // staleAfterMs` is false — so without this the monitor reports healthy
  // ("last dispatched -410.2h ago") until that date actually passes.
  const v = assessDrainHealth({ ledgerEntries: [dispatch(-30 * H), dispatch(40 * H)], eligibleCount: 12, nowMs: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.status, 'future-dated');
});

test('ordinary Mac-vs-runner clock skew is tolerated, not treated as corruption', () => {
  // Rows are written on the Mac and read on a GitHub runner. A few seconds of
  // disagreement must not flip the monitor red — 60s tolerance, matching
  // scripts/backlog-drain.js:115-117. Beyond it, the ledger is untrusted.
  const skewed = assessDrainHealth({ ledgerEntries: [dispatch(-30 * 1000)], eligibleCount: 12, nowMs: NOW });
  assert.equal(skewed.ok, true, '30s of skew is clock disagreement, not a corrupt ledger');
  assert.equal(skewed.status, 'healthy');
  assert.equal(skewed.ageMs, 0, 'age clamps to 0 rather than flowing in negative');

  const corrupt = assessDrainHealth({ ledgerEntries: [dispatch(-120 * 1000)], eligibleCount: 12, nowMs: NOW });
  assert.equal(corrupt.ok, false, '2min ahead is past any plausible skew');
  assert.equal(corrupt.status, 'future-dated');
});
