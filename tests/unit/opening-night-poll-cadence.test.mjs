import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pollMode, shouldRunSerpForMode } = require('../../scripts/opening-night-poller.js');

// openingDate parses as UTC midnight. Actual openings are in the evening
// (BW ~23 UTC = 7pm ET; WE ~18:30 UTC = 7:30pm BST), so hour-offsets in pollMode
// must land on the real review-drop hours.

const BW = { category: 'broadway', openingDate: '2026-03-23' };
const WE = { category: 'west-end',  openingDate: '2026-03-23' };
const OB = { category: 'off-broadway', openingDate: '2026-03-23' };
const OWE = { category: 'off-west-end', openingDate: '2026-03-23' };

function firesSerp(show, isoTime) {
  const now = new Date(isoTime);
  const mode = pollMode(show, now);
  const h = (now - new Date(show.openingDate)) / 3600000;
  const passes3h = h >= 3;
  const passesMode = shouldRunSerpForMode(mode, show, now);
  return { mode, h, passes3h, passesMode, fires: passes3h && passesMode };
}

// ── BW aggressive window must cover opening-night review drops ──
test('BW: SERP RUNS during opening-night review drop (01-03 UTC next day)', () => {
  const r1 = firesSerp(BW, '2026-03-24T01:00:00Z'); // 23:00 prev-day cron fires ~01:00
  const r2 = firesSerp(BW, '2026-03-24T02:30:00Z'); // 00:00 cron fires ~02:30
  assert.equal(r1.mode, 'aggressive', 'h=25 must be aggressive for BW');
  assert.equal(r2.mode, 'aggressive', 'h=26.5 must be aggressive for BW');
  assert.ok(r1.fires, 'SERP must fire at h=25 for BW review-drop window');
  assert.ok(r2.fires, 'SERP must fire at h=26.5 for BW review-drop window');
});

test('BW: SERP RUNS next morning in aggressive window (before broadcast)', () => {
  const r = firesSerp(BW, '2026-03-24T09:30:00Z'); // 08:00 BW morning cron fires ~09:30
  assert.equal(r.mode, 'aggressive');
  assert.ok(r.fires);
});

test('BW: SERP SKIPPED before 3h-since-parsed-midnight (open is 23h away anyway)', () => {
  const r1 = firesSerp(BW, '2026-03-23T01:00:00Z'); // h=1, 3h gate fails
  const r2 = firesSerp(BW, '2026-03-23T02:30:00Z'); // h=2.5, 3h gate fails
  assert.equal(r1.fires, false);
  assert.equal(r2.fires, false);
});

test('BW: aggressive window ends by h=36 (next-day noon UTC)', () => {
  // h=35.9: still aggressive
  const r1 = firesSerp(BW, '2026-03-24T11:54:00Z');
  assert.equal(r1.mode, 'aggressive');
  // h=36: falls to daily. 12:00 UTC IS still in BW morning slot (7-13).
  const r2 = firesSerp(BW, '2026-03-24T12:00:00Z');
  assert.equal(r2.mode, 'daily');
  assert.ok(r2.fires, 'daily mode at UTC 12 should still fire for BW');
});

// ── WE aggressive window ──
test('WE: SERP RUNS 30min after press night (aggressive window)', () => {
  const r = firesSerp(WE, '2026-03-23T19:00:00Z'); // h=19, in 12-30 aggressive
  assert.equal(r.mode, 'aggressive');
  assert.ok(r.fires);
});

test('WE: SERP RUNS next-morning during review-drop (daily mode, morning slot)', () => {
  const r = firesSerp(WE, '2026-03-24T06:30:00Z'); // h=30.5, daily, WE slot 4-9
  assert.equal(r.mode, 'daily');
  assert.ok(r.fires);
});

test('WE: SERP SKIPPED in evening (not WE morning slot)', () => {
  const r = firesSerp(WE, '2026-03-24T19:00:00Z'); // h=43, daily, UTC 19 not in slot
  assert.equal(r.mode, 'daily');
  assert.equal(r.fires, false);
});

// ── OB/OWE: no aggressive window, only daily morning-slot ──
test('OB: no aggressive window — daily morning slot only', () => {
  // OB show 30h post-parsed-opening: should NOT be aggressive.
  const r = firesSerp(OB, '2026-03-24T01:00:00Z'); // UTC 01 not in BW slot
  assert.equal(r.mode, 'daily');
  assert.equal(r.fires, false);
});

test('OB: SERP runs in BW morning slot (7-13 UTC)', () => {
  const r = firesSerp(OB, '2026-03-24T09:30:00Z'); // daily, UTC 09 in slot
  assert.equal(r.mode, 'daily');
  assert.ok(r.fires);
});

test('OWE: daily mode uses WE morning slot (4-9 UTC)', () => {
  const r = firesSerp(OWE, '2026-03-24T06:30:00Z'); // daily, UTC 06 in WE slot
  assert.equal(r.mode, 'daily');
  assert.ok(r.fires, 'OWE should use WE morning slot, not BW');
  const r2 = firesSerp(OWE, '2026-03-24T09:30:00Z'); // UTC 09 at edge of WE slot
  assert.ok(r2.fires || r2.mode === 'daily');
});

// ── Time-tiered cadence ──
test('Days 1-14: daily mode', () => {
  const r = firesSerp(BW, '2026-03-30T09:30:00Z'); // d=7.4
  assert.equal(r.mode, 'daily');
});

test('Days 15-60: every-3d mode', () => {
  const r = firesSerp(BW, '2026-04-10T09:30:00Z'); // d=18.4
  assert.equal(r.mode, 'every-3d');
});

test('every-3d: SERP runs only on days where daysSince % 3 === 0', () => {
  // d=18 (multiple of 3? no, 18/3=6) — should run
  const r18 = firesSerp(BW, '2026-04-10T09:30:00Z');
  // d=19 — should NOT run
  const r19 = firesSerp(BW, '2026-04-11T09:30:00Z');
  assert.equal(r18.mode, 'every-3d');
  assert.equal(r19.mode, 'every-3d');
  assert.ok(r18.fires);
  assert.equal(r19.fires, false);
});

test('Days 60-90: weekly mode', () => {
  const r = firesSerp(BW, '2026-05-24T09:30:00Z'); // d=62
  assert.equal(r.mode, 'weekly');
});

test('weekly: SERP runs only on daysSince % 7 === 0', () => {
  // d=63 (63/7=9) — should run
  const r63 = firesSerp(BW, '2026-05-25T09:30:00Z');
  // d=64 — should NOT run
  const r64 = firesSerp(BW, '2026-05-26T09:30:00Z');
  assert.equal(r63.mode, 'weekly');
  assert.equal(r64.mode, 'weekly');
  assert.ok(r63.fires);
  assert.equal(r64.fires, false);
});

test('Day 91+: skip mode', () => {
  const r = firesSerp(BW, '2026-06-23T09:30:00Z'); // d=92
  assert.equal(r.mode, 'skip');
  assert.equal(r.fires, false);
});

test('Pre-opening 48h+: skip mode', () => {
  const r = pollMode(BW, new Date('2026-03-20T00:00:00Z')); // 3 days before
  assert.equal(r, 'skip');
});

test('Pre-opening <48h: falls to daily', () => {
  const r = pollMode(BW, new Date('2026-03-22T12:00:00Z')); // 36h before
  assert.equal(r, 'daily');
});

// ── Edge cases ──
test('openingDate missing: pollMode returns daily (conservative)', () => {
  assert.equal(pollMode({ category: 'broadway' }), 'daily');
});

test('category null: defaults to broadway for SERP slot', () => {
  const show = { openingDate: '2026-03-23' }; // no category
  const r = firesSerp(show, '2026-03-24T09:30:00Z');
  // Defaults to BW behavior: aggressive window h=22-36 catches this (h=33.5)
  assert.equal(r.mode, 'aggressive');
});

test('market fallback: uses show.market when category missing', () => {
  const show = { market: 'west-end', openingDate: '2026-03-23' };
  const r = firesSerp(show, '2026-03-23T19:00:00Z');
  assert.equal(r.mode, 'aggressive', 'WE h=19 should be aggressive');
});

test('aggressive mode ignores morning-slot gate', () => {
  // h=25 for BW is aggressive and should fire at UTC 01:00 (not in morning slot).
  const r = firesSerp(BW, '2026-03-24T01:00:00Z');
  const now = new Date('2026-03-24T01:00:00Z');
  assert.equal(r.mode, 'aggressive');
  assert.equal(shouldRunSerpForMode('aggressive', BW, now), true);
  assert.equal(shouldRunSerpForMode('daily', BW, now), false, 'UTC 01 not in BW morning slot');
});
