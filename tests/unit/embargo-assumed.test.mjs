// BRO-7740: a market-default embargo is a guess, never a fact. Real functions only (CLAUDE.md section 15).
// Blue Man Group (2026-11-17, Broadway): reviews dropped 02:00Z, an hour before the assumed 03:00Z embargo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rec = require('../../scripts/lib/press-night-record.js');
const pw = require('../../scripts/lib/opening-night-lane/preembargo-window.js');
const af = require('../../scripts/lib/opening-night-lane/auto-fallback.js');
const lom = require('../../scripts/lib/opening-night-lane/lane-only-markets.js');
const plan = require('../../scripts/lib/press-night-poll-plan.js');
const RL = require('../../scripts/lib/readiness-lane.js');

const MIN = 60000;
const Z = (s) => Date.parse(s);
const BMG = { id: 'blue-man-group-a-new-holiday-surprise-2026', category: 'broadway', openingDate: '2026-11-17' };
const CONFIRMED = { ...BMG, reviewEmbargoAt: '2026-11-18T03:00:00Z' };

test('embargoInfo: market default is assumed, a valid reviewEmbargoAt is not', () => {
  assert.deepEqual([rec.embargoInfo(BMG).source, rec.embargoInfo(BMG).assumed], ['market-default', true]);
  assert.deepEqual([rec.embargoInfo(CONFIRMED).source, rec.embargoInfo(CONFIRMED).assumed], ['override', false]);
  assert.equal(rec.embargoAssumed(BMG), true);
  assert.equal(rec.embargoAssumed({ ...BMG, reviewEmbargoAt: 'garbage' }), true, 'an invalid override is ignored, so still a guess');
  assert.equal(lom.embargoInfoForNight(BMG, '2026-11-17').assumed, true);
  assert.equal(lom.embargoInfoForNight(CONFIRMED, '2026-11-17').assumed, false);
  assert.equal(lom.embargoInfoForNight(CONFIRMED, '2026-11-20').assumed, true, 'another night than the opening night has no confirmed embargo');
});

test('nightTimes: an assumed embargo starts the lane at embargo - 90 min with the longer window; a confirmed one keeps embargo - 30', () => {
  const a = af.nightTimes(BMG, '2026-11-17', { dropProfiles: null }); // no profile = the market-default start; the observed start is tested in lane-guard-observed-drop.test.mjs
  assert.equal(a.laneStartMs, Z('2026-11-18T01:30:00Z'));
  assert.equal(a.guard.reason, 'assumed-embargo');
  assert.equal(a.watchEndMs, a.laneStartMs + (af.LANE_WINDOW_PREEMBARGO_MIN + af.LEASE_TTL_MIN) * MIN);
  const c = af.nightTimes(CONFIRMED, '2026-11-17');
  assert.equal(c.laneStartMs, Z('2026-11-18T02:30:00Z'));
  assert.equal(c.guard.enabled, false);
});

test('guardMode: the owner variable and an assumed embargo each turn it on; neither leaves it off (the variable default is untouched)', () => {
  assert.deepEqual(pw.guardMode({ flagOn: false, assumed: false }), { enabled: false, reason: 'off' });
  assert.equal(pw.guardMode({ flagOn: true, assumed: false }).reason, 'flag');
  assert.equal(pw.guardMode({ flagOn: false, assumed: true }).reason, 'assumed-embargo');
  assert.equal(af.laneGuardMode(BMG, '2026-11-17', false).enabled, true);
  assert.equal(af.laneGuardMode(CONFIRMED, '2026-11-17', false).enabled, false);
});

test('dropEvidence: only a review dated tonight or later lifts the guard; undated, older or on-disk admits do not', () => {
  const night = '2026-11-17';
  assert.equal(pw.dropEvidence({ admitted: [{ url: 'u1' }], night }).lifted, false, 'no publish date');
  assert.equal(pw.dropEvidence({ admitted: [{ url: 'u1', publishDate: '2026-11-03' }], night }).lifted, false, 'a preview-period review');
  assert.equal(pw.dropEvidence({ admitted: [{ url: 'u1', publishDate: '2026-11-17' }], night, onDiskUrls: ['u1'] }).lifted, false, 'already on disk');
  assert.equal(pw.dropEvidence({ admitted: [{ url: 'u1', publishDate: '2026-11-17' }], night, floorMs: Z('2026-11-18T01:30:00Z') }).lifted, false, 'a bare date proves nothing');
  const floorMs = Z('2026-11-18T01:30:00Z');
  assert.equal(pw.dropEvidence({ admitted: [{ url: 'u1', publishDate: '2026-11-18T01:00:00.000Z' }], night, floorMs }).lifted, false, 'the evening before, as UTC');
  assert.equal(pw.dropEvidence({ admitted: [{ url: 'u1', publishDate: '2026-11-18T02:00:00.000Z' }], night, floorMs }).lifted, true);
  assert.equal(pw.dropEvidence({ admitted: [], night }).lifted, false);
});

test('Blue Man Group replay: lane running and in post-embargo mode by 02:05Z', async () => {
  const t = af.nightTimes(BMG, '2026-11-17');
  const dropAt = Z('2026-11-18T02:00:30Z'), check = Z('2026-11-18T02:05:00Z');
  assert.ok(t.laneStartMs <= dropAt, 'the lane is already running when the review lands');
  assert.ok(t.guard.enabled, 'and fetching direct-only (no spend) until then');
  // Same wiring as driver.wireLaneNight: guardPorts over an isActive() that a detected drop closes.
  let lifted = null;
  const calls = [];
  const isActive = () => lifted == null && pw.windowActive({ enabled: true, embargoMs: t.embargoMs, nowMs: now });
  let now = dropAt - 10 * MIN;
  const ports = pw.guardPorts({ enabled: true, fetchPage: async (u, o) => { calls.push(o.directOnly === true); return { ok: true }; }, search: async () => 'serp', isActive });
  await ports.fetchPage('https://example.com/a');
  now = dropAt;
  const d = pw.dropEvidence({ admitted: [{ url: 'https://tm.example/blue-man', publishDate: '2026-11-18T02:00:00.000Z' }], night: '2026-11-17', floorMs: t.embargoMs - pw.MAX_LEAD_MIN * MIN });
  assert.ok(d.lifted); lifted = now;
  now = check;
  await ports.fetchPage('https://example.com/b');
  assert.deepEqual(calls, [true, false], 'direct-only before the drop, the full chain after it');
  assert.equal(isActive(), false, 'post-embargo mode by 02:05Z, 55 min before the assumed embargo');
  // Without the detector the guard would still be forced direct-only at 02:05Z (it closes at 02:30Z).
  assert.equal(pw.windowActive({ enabled: true, embargoMs: t.embargoMs, nowMs: check }), true);
});

test('poll plan: fast polling opens 90 min before an assumed embargo, not before a confirmed one', () => {
  const emb = Z('2026-11-18T03:00:00Z'), at = emb - 60 * MIN;
  const mk = (assumed) => [{ id: 'x', category: 'broadway', embargoMs: emb, assumed }];
  assert.equal(plan.pollIntervalMin({ shows: mk(true), nowMs: at, defaultMin: 15 }).intervalMin, plan.FAST_MIN);
  assert.equal(plan.pollIntervalMin({ shows: mk(false), nowMs: at, defaultMin: 15 }).intervalMin, 15);
});

test('readiness: an assumed embargo within 36h of opening warns; a confirmed one passes; far-off assumed passes with a note', () => {
  const now = Z('2026-11-17T12:00:00Z');
  const a = RL.embargoVerdict(BMG, now);
  assert.equal(a.status, 'warn'); assert.match(a.detail, /market default/);
  assert.equal(RL.embargoVerdict(CONFIRMED, now).status, 'pass');
  const far = RL.embargoVerdict(BMG, Z('2026-11-01T12:00:00Z'));
  assert.equal(far.status, 'pass'); assert.match(far.detail, /assumed market default/);
});
