// BRO-7786: the lane guard opens at the earliest observed embargo drop (minus a margin), not a fixed 90 min before the market hour.
// Real functions only (CLAUDE.md section 15); profiles built by the real buildProfiles from synthetic recorded nights.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dp = require('../../scripts/lib/embargo-drop-profiles.js');
const pw = require('../../scripts/lib/opening-night-lane/preembargo-window.js');
const af = require('../../scripts/lib/opening-night-lane/auto-fallback.js');
const RL = require('../../scripts/lib/readiness-lane.js');

const MIN = 60000;
const Z = (s) => Date.parse(s);
const SHOW = { id: 'iawl-2026', category: 'broadway', openingDate: '2026-11-18' }; // market default 03:00Z on 11-19
const MARKET_HOUR = Z('2026-11-19T03:00:00Z');

// n recorded Broadway nights whose real drop sat `offsets[i]` minutes from the market hour (negative = early).
function profilesFor(offsets, category = 'broadway') {
  const nights = {};
  offsets.forEach((off, i) => {
    const openingDate = `2026-0${1 + (i % 9)}-${String(10 + i).padStart(2, '0')}`;
    const hour = Z(require('../../scripts/lib/press-night-record.js').marketEmbargoAt({ category, openingDate }));
    nights[`s${i}`] = { showId: `s${i}`, category, openingDate, observed: { source: 'observed-cluster', at: new Date(hour + off * MIN).toISOString() } };
  });
  return dp.buildProfiles({ nights });
}

test('observedStartMs: earliest drop minus margin, floored at embargo - 180, never later than the default start', () => {
  const E = MARKET_HOUR, def = E - 90 * MIN;
  assert.equal(pw.observedStartMs({ embargoMs: E, earliestDropMs: E - 120 * MIN, startMs: def }), E - (120 + pw.EARLY_DROP_MARGIN_MIN) * MIN);
  assert.equal(pw.observedStartMs({ embargoMs: E, earliestDropMs: E - 400 * MIN, startMs: def }), E - pw.MAX_OBSERVED_LEAD_MIN * MIN, 'capped');
  assert.equal(pw.observedStartMs({ embargoMs: E, earliestDropMs: E + 30 * MIN, startMs: def }), def, 'a late earliest drop never delays the start');
  assert.equal(pw.observedStartMs({ embargoMs: E, earliestDropMs: undefined, startMs: def }), def);
  assert.equal(pw.observedStartMs({ embargoMs: E, earliestDropMs: NaN, startMs: def }), def);
});

test('nightTimes: >=5 observed nights start the guard at the earliest drop minus the margin and say so', () => {
  const t = af.nightTimes(SHOW, '2026-11-18', { dropProfiles: profilesFor([-120, -30, 0, 0, 10, 40]) });
  assert.equal(t.laneStartMs, MARKET_HOUR - 135 * MIN, '01:00Z drop minus 15 min = 00:45Z');
  assert.equal(t.drop.basis, 'observed');
  assert.equal(t.watchEndMs, t.laneStartMs + (af.LANE_WINDOW_PREEMBARGO_MIN + af.LEASE_TTL_MIN) * MIN);
  assert.match(af.guardStartText(t), /set by the earliest drop in 6 recorded nights/);
  assert.ok(t.laneStartMs <= Z('2026-11-19T01:00:00Z'), 'open at or before the earliest recorded drop (the It\'s A Wonderful Life readiness case)');
});

test('nightTimes: an observed market whose earliest drop is not earlier than the default keeps embargo - 90 and says so', () => {
  const t = af.nightTimes(SHOW, '2026-11-18', { dropProfiles: profilesFor([-60, -30, 0, 0, 10]) });
  assert.equal(t.laneStartMs, MARKET_HOUR - 90 * MIN);
  assert.match(af.guardStartText(t), /the market default; the earliest of 5 recorded nights/);
});

test('nightTimes: a guess basis (4 nights), no profile or an unreadable profile keeps embargo - 90 and labels it a GUESS', () => {
  for (const p of [profilesFor([-120, -100, -90, -80]), null, {}]) {
    const t = af.nightTimes(SHOW, '2026-11-18', { dropProfiles: p });
    assert.equal(t.laneStartMs, MARKET_HOUR - 90 * MIN);
    assert.match(af.guardStartText(t), /a GUESS/);
  }
});

test('nightTimes: the early start is guard-only. A confirmed embargo with the guard off still starts at embargo - 30, with no profile lookup', () => {
  const confirmed = { ...SHOW, reviewEmbargoAt: '2026-11-19T03:00:00Z' };
  const t = af.nightTimes(confirmed, '2026-11-18', { dropProfiles: profilesFor([-120, -30, 0, 0, 10, 40]) });
  assert.equal(t.laneStartMs, MARKET_HOUR - 30 * MIN);
  assert.equal(t.drop, null);
  assert.equal(af.guardStartText(t), 'pre-embargo guard off');
});

test('paid spend: the earlier window is still direct-only until embargo - 30 (windowActive / guardPorts unchanged)', async () => {
  const t = af.nightTimes(SHOW, '2026-11-18', { dropProfiles: profilesFor([-120, -30, 0, 0, 10, 40]) });
  const at = t.laneStartMs + MIN; // inside the new early part of the window
  assert.equal(pw.windowActive({ enabled: true, embargoMs: t.embargoMs, nowMs: at }), true);
  const seen = [];
  const ports = pw.guardPorts({ enabled: true, fetchPage: async (u, o) => { seen.push(o.directOnly === true); return {}; }, search: async () => 'serp', isActive: () => pw.windowActive({ enabled: true, embargoMs: t.embargoMs, nowMs: at }) });
  await ports.fetchPage('https://x.example/a');
  assert.deepEqual(seen, [true], 'no paid tier at 00:46Z');
  await assert.rejects(() => ports.search('q'), (e) => e.laneDeferred === true);
});

test('dropEvidence: a review at the earliest observed drop counts once the floor follows the new start (the old 90-min floor discarded it)', () => {
  const t = af.nightTimes(SHOW, '2026-11-18', { dropProfiles: profilesFor([-120, -30, 0, 0, 10, 40]) });
  const admitted = [{ url: 'u', publishDate: '2026-11-19T01:00:00.000Z' }];
  const oldFloor = t.embargoMs - pw.MAX_LEAD_MIN * MIN;
  assert.equal(pw.dropEvidence({ admitted, night: '2026-11-18', floorMs: oldFloor }).lifted, false, 'old floor: 01:00Z is before 01:30Z');
  assert.equal(pw.dropEvidence({ admitted, night: '2026-11-18', floorMs: Math.min(oldFloor, t.laneStartMs) }).lifted, true);
});

test('planNightWait / planNightStart use the same observed start as nightTimes', () => {
  const dropProfiles = profilesFor([-120, -30, 0, 0, 10, 40]);
  const start = MARKET_HOUR - 135 * MIN;
  const w = af.planNightWait({ show: SHOW, night: '2026-11-18', now: new Date(start - 10 * MIN), dropProfiles });
  assert.equal(w.action, 'sleep-go'); assert.equal(w.sleepMin, 10);
});

test('readiness text: the lane guard start in the readiness check is the lane\'s own start, with its basis', () => {
  const dpm = require('../../scripts/lib/embargo-drop-profiles.js');
  const real = dpm.loadBenchProfiles();
  if (!real || !real.markets.broadway || real.markets.broadway.n < dpm.MIN_NIGHTS_FOR_OBSERVED) return; // bench not present in this checkout
  const out = RL.embargoVerdict ? RL.embargoVerdict(SHOW, Z('2026-11-18T12:00:00Z')) : null;
  if (!out) return;
  assert.match(out.detail, /guard opens 2026-11-19T00:45:00.000Z/);
  assert.match(out.detail, /set by the earliest drop/);
  assert.doesNotMatch(out.detail, /caught only after it/);
});
