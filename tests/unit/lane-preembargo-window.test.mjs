// BRO-7280: the opt-in pre-embargo direct-only window. Real functions (CLAUDE.md section 15); nothing touches a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pw = require('../../scripts/lib/opening-night-lane/preembargo-window.js');
const driver = require('../../scripts/lib/opening-night-lane/driver.js');
const af = require('../../scripts/lib/opening-night-lane/auto-fallback.js');
const ls = require('../../scripts/lib/opening-night-lane/lane-switch.js');

const MIN = 60000;
const EMBARGO = Date.parse('2026-11-12T03:00:00Z'); // Broadway 22:00 ET
const OPEN = EMBARGO - 90 * MIN;                       // earliest window start
const CLOSE = EMBARGO - 30 * MIN;                      // normal lane start

test('parseFlag: only an explicit on is on; unset is off', () => {
  for (const v of ['on', 'ON', ' true ', '1', 'yes']) assert.equal(pw.parseFlag(v), true, v);
  for (const v of [undefined, null, '', 'off', 'false', '0', 'no', 'maybe']) assert.equal(pw.parseFlag(v), false, String(v));
});

test('windowActive: open before embargo - 30 min, closed from it; off never opens', () => {
  assert.equal(pw.windowActive({ enabled: true, embargoMs: EMBARGO, nowMs: OPEN }), true);
  assert.equal(pw.windowActive({ enabled: true, embargoMs: EMBARGO, nowMs: CLOSE - 1 }), true);
  assert.equal(pw.windowActive({ enabled: true, embargoMs: EMBARGO, nowMs: CLOSE }), false);
  assert.equal(pw.windowActive({ enabled: true, embargoMs: EMBARGO, nowMs: EMBARGO + MIN }), false);
  assert.equal(pw.windowActive({ enabled: false, embargoMs: EMBARGO, nowMs: OPEN }), false);
  assert.equal(pw.windowActive({ enabled: true, embargoMs: NaN, nowMs: OPEN }), false);
});

test('laneStartMs: off = embargo - 30; on = 19:30 local but never earlier than embargo - 90', () => {
  assert.equal(pw.laneStartMs({ embargoMs: EMBARGO, timeZone: 'America/New_York', enabled: false }), CLOSE);
  assert.equal(pw.laneStartMs({ embargoMs: EMBARGO, timeZone: 'America/New_York', enabled: true }), OPEN, '19:30 ET is 150 min out, capped at 90');
  const late = Date.parse('2026-11-12T08:00:00Z'); // a late override: 03:00 ET, 19:30 ET is 7.5h out
  assert.equal(pw.laneStartMs({ embargoMs: late, timeZone: 'America/New_York', enabled: true }), late - 90 * MIN);
  const west = Date.parse('2026-11-10T21:00:00Z'); // West End 21:00 GMT: 19:30 is 90 min out
  assert.equal(pw.laneStartMs({ embargoMs: west, timeZone: 'Europe/London', enabled: true }), west - 90 * MIN);
  const early = Date.parse('2026-11-10T20:00:00Z'); // 19:30 London is only 30 min out: start is the normal one, never after it
  assert.equal(pw.laneStartMs({ embargoMs: early, timeZone: 'Europe/London', enabled: true }), early - 30 * MIN);
});

test('guardPorts: off returns the very same ports', () => {
  const f = async () => 1; const s = async () => 2;
  const g = pw.guardPorts({ enabled: false, fetchPage: f, search: s, isActive: () => true });
  assert.equal(g.fetchPage, f); assert.equal(g.search, s);
});

test('guardPorts: in the window fetchPage is forced to directOnly and SERP is refused; outside, both pass through', async () => {
  const seen = []; let searched = 0; let active = true;
  const g = pw.guardPorts({ enabled: true, fetchPage: async (u, o) => { seen.push({ u, o }); return { content: 'x' }; }, search: async () => { searched++; return []; }, isActive: () => active });
  await g.fetchPage('https://a/1', { preferPlaywright: true, skipVerify: true });
  assert.deepEqual(seen[0].o, { preferPlaywright: true, skipVerify: true, directOnly: true });
  await assert.rejects(g.search('q'), (e) => e.laneDeferred === true && /pre-embargo/.test(e.message));
  assert.equal(searched, 0, 'no paid SERP in the window');
  active = false;
  await g.fetchPage('https://a/2', { skipVerify: true });
  assert.deepEqual(seen[1].o, { skipVerify: true }, 'after the window the options are untouched');
  await g.search('q');
  assert.equal(searched, 1);
});

test('guardPorts: a failure in the window is tagged laneDeferred; after it, not', async () => {
  let active = true;
  const g = pw.guardPorts({ enabled: true, fetchPage: async () => { throw new Error('403'); }, search: async () => [], isActive: () => active });
  await assert.rejects(g.fetchPage('https://a'), (e) => e.laneDeferred === true);
  active = false;
  await assert.rejects(g.fetchPage('https://a'), (e) => !e.laneDeferred);
});

// The unit that fails if a paid path runs in the window: every fetch the wired lane makes, discovery and review fetch
// alike, reaches the underlying fetchPage with directOnly, and the underlying one is only ever asked for directOnly
// until embargo - 30 min.
test('wireLaneNight: every lane fetch inside the window is directOnly; from embargo - 30 min none is forced', async (t) => {
  const runner = require('../../scripts/lib/opening-night-lane/lane-runner.js');
  let seen = null; let clock = OPEN;
  const calls = [];
  const base = {
    show: { id: 'x-2026', title: 'X', openingDate: '2026-11-11' }, night: '2026-11-11', ledgerDir: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pe7-')),
    laneFetch: { fetchPage: async (u, o) => { calls.push({ at: clock, o: o || {} }); return { content: '<html></html>' }; }, close: async () => {} },
    scoreText: async () => ({ score: 50 }), now: () => clock, wait: async () => {}, reviewTextsDir: '/nonexistent', onDiskUrls: [], onDiskRows: [],
    showScoreGuards: {}, search: async () => { throw new Error('PAID SERP RAN'); }, decodeImpl: null, publishPorts: {},
    preembargo: { enabled: true, embargoMs: EMBARGO },
  };
  t.mock.method(runner, 'runLaneNight', async (opts) => { seen = opts; return { passes: 0 }; });
  await driver.wireLaneNight(base)({});
  assert.equal(seen.serpClockStartMs, CLOSE, 'the SERP +3h clock starts at the normal lane start, not the early one');

  await seen.fetchText('https://tb.example/page', { preferPlaywright: true });
  await seen.fetchText('https://news.google.com/rss/articles/abc', { preferPlaywright: true, skipVerify: true });
  await seen.fetchReview({ url: 'https://www.timeout.com/newyork/theater/x-review', key: 'k1' }).catch((e) => { calls.reviewErr = String(e && e.message); });
  assert.ok(calls.length >= 3, 'fetchText and fetchReview must each reach fetchPage');
  assert.ok(calls.every((c) => c.o.directOnly === true), 'a paid path ran inside the window');

  const serp = seen.adapters.find((a) => /serp/i.test(a.name));
  assert.ok(serp, 'serp adapter present');

  clock = CLOSE;
  calls.length = 0;
  await seen.fetchText('https://tb.example/page', { preferPlaywright: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].o.directOnly, undefined, 'at embargo - 30 min fetching is normal again');
});

test('wireLaneNight: preembargo absent or disabled changes nothing', async (t) => {
  const runner = require('../../scripts/lib/opening-night-lane/lane-runner.js');
  let seen = null; const calls = [];
  const base = {
    show: { id: 'x-2026', title: 'X', openingDate: '2026-11-11' }, night: '2026-11-11', ledgerDir: '/nonexistent',
    laneFetch: { fetchPage: async (u, o) => { calls.push(o || {}); return { content: '<html></html>' }; }, close: async () => {} },
    scoreText: async () => ({ score: 50 }), now: () => OPEN, wait: async () => {}, reviewTextsDir: '/nonexistent', onDiskUrls: [], onDiskRows: [],
    showScoreGuards: {}, search: async () => [], decodeImpl: null, publishPorts: {},
  };
  t.mock.method(runner, 'runLaneNight', async (opts) => { seen = opts; return { passes: 0 }; });
  for (const preembargo of [undefined, null, { enabled: false, embargoMs: EMBARGO }]) {
    await driver.wireLaneNight({ ...base, preembargo })({});
    assert.equal(seen.serpClockStartMs, undefined);
    await seen.fetchText('https://a', { skipVerify: true });
  }
  assert.ok(calls.every((o) => o.directOnly === undefined));
});

test('inline scoring: a failure caused by the window is not an attempt, so it never goes permanent', async () => {
  const inline = require('../../scripts/lib/opening-night-lane/inline-score.js');
  let clock = 0;
  const s = inline.createInlineScoring({
    show: { id: 'x-2026', title: 'X' }, night: '2026-11-11', ledgerDir: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pe-')), now: () => clock,
    fetchPage: async () => { const e = new Error('403'); e.laneDeferred = true; throw e; },
    extractArticle: () => '', extractMeta: () => ({}), scoreText: async () => ({ score: 50 }), allShows: [],
  });
  for (let i = 0; i < 12; i++) {
    clock += 60 * 1000;
    await assert.rejects(s.fetchReview({ url: 'https://www.nytimes.com/r', key: 'k' }), (e) => e.name !== 'LanePermanentError' && !/for good/.test(e.message));
  }
});

test('nightTimes: default unchanged; on starts earlier and runs the longer window', () => {
  const show = { id: 'x-2026', category: 'broadway', openingDate: '2026-11-11' };
  const off = af.nightTimes(show, '2026-11-11');
  assert.equal(off.laneStartMs, CLOSE);
  assert.equal(off.watchEndMs, CLOSE + (af.LANE_WINDOW_MIN + af.LEASE_TTL_MIN) * MIN);
  const on = af.nightTimes(show, '2026-11-11', { preembargo: true });
  assert.equal(on.laneStartMs, OPEN);
  assert.equal(on.watchEndMs, OPEN + (af.LANE_WINDOW_PREEMBARGO_MIN + af.LEASE_TTL_MIN) * MIN);
  assert.ok(on.watchEndMs >= off.watchEndMs - 30 * MIN, 'the tail is at most 30 min shorter');
  const wait = af.planNightWait({ show, night: '2026-11-11', now: new Date(OPEN - 10 * MIN), preembargo: true });
  assert.equal(wait.action, 'sleep-go'); assert.equal(wait.sleepMin, 10);
  assert.equal(af.planNightWait({ show, night: '2026-11-11', now: new Date(OPEN - 10 * MIN) }).sleepMin, 70);
});

test('lane switch: the new variable takes only on (clear = off); other variables unchanged', () => {
  assert.ok(ls.ALLOWED_VARIABLES.includes('LANE_PREEMBARGO_DIRECT_ONLY'));
  assert.deepEqual(ls.validateSwitch({ action: 'set', variable: 'LANE_PREEMBARGO_DIRECT_ONLY', value: 'on' }), { ok: true, variable: 'LANE_PREEMBARGO_DIRECT_ONLY', op: 'set', value: 'on' });
  assert.equal(ls.validateSwitch({ action: 'set', variable: 'LANE_PREEMBARGO_DIRECT_ONLY', value: 'broadway' }).ok, false);
  assert.equal(ls.validateSwitch({ action: 'set', variable: 'LANE_PREEMBARGO_DIRECT_ONLY', value: '' }).ok, false);
  assert.equal(ls.validateSwitch({ action: 'clear', variable: 'LANE_PREEMBARGO_DIRECT_ONLY', value: '' }).op, 'delete');
  assert.equal(ls.validateSwitch({ action: 'set', variable: 'LANE_STANDDOWN', value: 'all' }).ok, true);
});

test('workflows: the lane job reads the night-wait output, the switch workflow offers the variable, the default window is unchanged', async () => {
  const fs = await import('node:fs');
  const live = fs.readFileSync(new URL('../../.github/workflows/opening-night-lane-live.yml', import.meta.url), 'utf8');
  assert.match(live, /OPENING_NIGHT_LANE_WINDOW_MIN: '270'/);
  assert.match(live, /LANE_PREEMBARGO_DIRECT_ONLY: \$\{\{ needs\.night-wait\.outputs\.preembargo \}\}/);
  assert.equal((live.match(/vars\.LANE_PREEMBARGO_DIRECT_ONLY/g) || []).length, 1, 'night-wait is the only reader of the variable');
  assert.match(fs.readFileSync(new URL('../../.github/workflows/opening-night-lane-switch.yml', import.meta.url), 'utf8'), /LANE_PREEMBARGO_DIRECT_ONLY\]/);
});

test('laneStartMs: an embargo before 19:30 local starts at the normal embargo - 30 min; small-hours embargoes use the evening before', () => {
  const pw = require('../../scripts/lib/opening-night-lane/preembargo-window.js');
  const e1900 = Date.parse('2026-11-11T00:00:00Z'); // 19:00 New York
  assert.equal(pw.laneStartMs({ embargoMs: e1900, timeZone: 'America/New_York', enabled: true }), e1900 - 30 * 60000);
  const e0130 = Date.parse('2026-11-11T01:30:00Z'); // 20:30 New York
  assert.equal(pw.laneStartMs({ embargoMs: e0130, timeZone: 'America/New_York', enabled: true }), Date.parse('2026-11-11T00:30:00Z'));
});

test('guardPorts marks in-window pages laneDirectOnly; inline scoring defers a short one without an attempt', async () => {
  const pw = require('../../scripts/lib/opening-night-lane/preembargo-window.js');
  const inline = require('../../scripts/lib/opening-night-lane/inline-score.js');
  const g = pw.guardPorts({ enabled: true, fetchPage: async () => ({ content: '<html></html>' }), search: async () => [], isActive: () => true });
  assert.equal((await g.fetchPage('https://a')).laneDirectOnly, true);
  let clock = 0;
  const s = inline.createInlineScoring({ show: { id: 'x', title: 'X' }, night: '2026-11-11', ledgerDir: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pe9-')), now: () => clock, fetchPage: g.fetchPage, extractArticle: () => 'short', extractMeta: () => ({}), scoreText: async () => ({ score: 50 }), allShows: [] });
  for (let i = 0; i < 8; i++) {
    clock += 60000;
    await assert.rejects(s.fetchReview({ url: 'https://www.timeout.com/newyork/theater/x-review', key: 'k' }), (e) => e.name !== 'LanePermanentError' && /deferred/.test(e.message));
  }
});
