// BRO-7548: the readiness check must see the opening-night lane (primary Broadway publisher), the embargo time,
// and recent pipeline changes. Requires the real functions (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('./lib/readiness-lane.js');

const NOW = Date.parse('2026-11-15T21:00:00Z');
const downstate = { id: 'downstate-2026', category: 'broadway', openingDate: '2026-11-15' };

test('embargo: Downstate opens reviews 2026-11-16T03:00Z, kick is 2h earlier', () => {
  const e = L.embargoFor(downstate);
  assert.equal(typeof e.embargoAt, 'string');
  assert.equal(new Date(e.embargoMs).toISOString(), '2026-11-16T03:00:00.000Z');
  assert.equal(e.kickAtMs, e.embargoMs - 120 * 60000);
  const v = L.embargoVerdict(downstate, NOW);
  assert.equal(v.status, 'warn', 'BRO-7740: a market-default embargo within 36h is flagged as a guess');
  assert.match(v.detail, /in 6\.0h/);
  assert.equal(L.embargoVerdict({ ...downstate, reviewEmbargoAt: '2026-11-16T03:00:00Z' }, NOW).status, 'pass');
});

test('embargo: no opening date warns instead of throwing', () => {
  assert.equal(L.embargoVerdict({ id: 'x', category: 'broadway' }, NOW).status, 'warn');
  assert.equal(L.embargoVerdict(null, NOW).status, 'warn');
});

test('arm: disarmed lane FAILS, unreadable result warns, armed passes', () => {
  assert.equal(L.armVerdict({ arm: true, reason: 'last-rehearsal-passed' }).status, 'pass');
  const off = L.armVerdict({ arm: false, reason: 'code-changed-since-rehearsal' });
  assert.equal(off.status, 'fail');
  assert.match(off.detail, /code-changed-since-rehearsal/);
  assert.equal(L.armVerdict(null).status, 'warn');
  assert.equal(L.armVerdict({}).status, 'warn');
});

const opts = (extra) => ({ showId: 'downstate-2026', night: '2026-11-15', label: 'lane night', kickAtMs: NOW + 3600000, nowMs: NOW, ...extra });

test('lane run: none yet before the kick warns, after the kick FAILS', () => {
  assert.equal(L.laneRunVerdict([], opts()).status, 'warn');
  assert.equal(L.laneRunVerdict([], opts({ kickAtMs: NOW - 5 * 60000 })).status, 'warn', 'inside the 20 min dispatch grace');
  assert.equal(L.laneRunVerdict([], opts({ kickAtMs: NOW - 21 * 60000 })).status, 'fail');
});

test('lane run: other shows or nights do not count', () => {
  const runs = [
    { displayTitle: 'Opening-night lane night other-show-2026 2026-11-15', status: 'in_progress', createdAt: 'a' },
    { displayTitle: 'Opening-night lane night downstate-2026 2026-11-08', status: 'in_progress', createdAt: 'b' },
  ];
  assert.equal(L.laneRunVerdict(runs, opts()).status, 'warn');
});

test('lane run: waiting/queued/in-progress passes; green passes; failed with nothing active FAILS', () => {
  const t = 'Opening-night lane night downstate-2026 2026-11-15';
  assert.equal(L.laneRunVerdict([{ displayTitle: t, status: 'in_progress', createdAt: 'a' }], opts()).status, 'pass');
  assert.equal(L.laneRunVerdict([{ displayTitle: t, status: 'queued', createdAt: 'a' }], opts()).status, 'pass');
  assert.equal(L.laneRunVerdict([{ displayTitle: t, status: 'completed', conclusion: 'success', createdAt: 'a' }], opts()).status, 'pass');
  const dead = L.laneRunVerdict([{ displayTitle: t, status: 'completed', conclusion: 'failure', createdAt: 'a' }], opts());
  assert.equal(dead.status, 'fail');
  assert.match(dead.detail, /failure/);
  // a failed run with a newer active one behind it is fine
  assert.equal(L.laneRunVerdict([
    { displayTitle: t, status: 'in_progress', createdAt: 'b' },
    { displayTitle: t, status: 'completed', conclusion: 'cancelled', createdAt: 'a' },
  ], opts()).status, 'pass');
});

test('changes: none passes; changes with armed lane pass and are listed; changes with disarmed lane FAIL', () => {
  assert.equal(L.changesVerdict([], { armed: true, windowHours: 48 }).status, 'pass');
  const commits = [
    { sha: 'aaaaaaaa1111', subject: 'fix scorer\nbody', at: '2026-11-14T10:00:00Z', paths: ['scripts/llm-scoring'] },
    { sha: 'bbbbbbbb2222', subject: 'serp tweak', at: '2026-11-15T10:00:00Z', paths: ['scripts/lib/url-discovery.js'] },
  ];
  const ok = L.changesVerdict(commits, { armed: true, windowHours: 48 });
  assert.equal(ok.status, 'pass');
  assert.ok(ok.detail.indexOf('bbbbbbbb') < ok.detail.indexOf('aaaaaaaa'), 'newest first');
  assert.equal(L.changesVerdict(commits, { armed: false, windowHours: 48 }).status, 'fail');
  assert.equal(L.changesVerdict(commits, { armed: null, windowHours: 48 }).status, 'warn');
  assert.equal(L.changesVerdict([], { armed: null, windowHours: 48 }).status, 'pass');
});

test('mergeCommitResponses dedupes by sha across per-path responses and tolerates junk', () => {
  const c = (sha, msg, date) => ({ sha, commit: { message: msg, committer: { date } } });
  const merged = L.mergeCommitResponses([[c('1', 'a', 'd1'), c('2', 'b', 'd2')], [c('2', 'b', 'd2'), c('3', 'c', 'd3')], null, { message: 'rate limited' }]);
  assert.deepEqual(merged.map((m) => m.sha).sort(), ['1', '2', '3']);
});

test('pipeline path list covers the lane, poller, scoring and clock', () => {
  for (const p of ['.github/workflows/opening-night-lane-live.yml', '.github/workflows/press-night-clock.yml', 'scripts/llm-scoring', 'scripts/lib/opening-night-lane']) {
    assert.ok(L.PIPELINE_PATHS.includes(p), p);
  }
});

test('nightOver: false before and during the night, true 12h after embargo, false without an embargo', () => {
  const e = L.embargoFor(downstate).embargoMs;
  assert.equal(L.nightOver(downstate, e - 3600000), false);
  assert.equal(L.nightOver(downstate, e + 11 * 3600000), false);
  assert.equal(L.nightOver(downstate, e + 13 * 3600000), true);
  assert.equal(L.nightOver({ id: 'x' }, NOW), false);
});

// Class guard: the readiness script must actually call the lane checks. Reverting the wiring (the BRO-7548 gap:
// a verdict blind to the lane) fails this.
test('check-opening-night-readiness.js is wired to the lane checks', () => {
  const src = fs.readFileSync(new URL('./check-opening-night-readiness.js', import.meta.url), 'utf8');
  for (const needle of ["require('./lib/readiness-lane')", 'RL.armVerdict', 'RL.laneRunVerdict', 'RL.changesVerdict', 'RL.embargoVerdict', 'opening-night-lane-live.yml', 'opening-night-lane-watchdog.yml', '--arm-check']) {
    assert.ok(src.includes(needle), `missing ${needle}`);
  }
});

test('lane run: a shadow or smoke run for the same show and night does not count as the production night run', () => {
  const runs = [
    { displayTitle: 'Opening-night lane shadow downstate-2026 2026-11-15', status: 'in_progress', createdAt: '2026-11-15T16:00:00Z' },
    { displayTitle: 'Opening-night lane smoke downstate-2026 2026-11-15', status: 'in_progress', createdAt: '2026-11-15T16:00:00Z' },
  ];
  assert.equal(L.laneRunVerdict(runs, opts({ mode: 'night' })).status, 'warn');
  assert.equal(L.laneRunVerdict(runs, opts({ mode: 'night', kickAtMs: NOW - 30 * 60000 })).status, 'fail');
  runs.push({ displayTitle: 'Opening-night lane night downstate-2026 2026-11-15', status: 'waiting', createdAt: '2026-11-15T16:00:00Z' });
  assert.equal(L.laneRunVerdict(runs, opts({ mode: 'night' })).status, 'pass');
  assert.equal(L.laneRunVerdict([{ displayTitle: 'Opening-night lane watchdog downstate-2026 2026-11-15', status: 'in_progress', createdAt: 'x' }], opts({ mode: 'watchdog' })).status, 'pass');
});

test('lane run: stuck in queued for over 30 min warns', () => {
  const t = 'Opening-night lane night downstate-2026 2026-11-15';
  const old = new Date(NOW - 45 * 60000).toISOString();
  const fresh = new Date(NOW - 5 * 60000).toISOString();
  assert.equal(L.laneRunVerdict([{ displayTitle: t, status: 'queued', createdAt: old }], opts({ mode: 'night' })).status, 'warn');
  assert.equal(L.laneRunVerdict([{ displayTitle: t, status: 'queued', createdAt: fresh }], opts({ mode: 'night' })).status, 'pass');
});

test('lane run: a longer show id that starts with this one does not match', () => {
  const runs = [{ displayTitle: 'Opening-night lane night downstate-2026-revival 2026-11-15', status: 'in_progress', createdAt: 'x' }];
  assert.equal(L.laneRunVerdict(runs, opts({ mode: 'night' })).status, 'warn');
});

test('changes: workflow/poller commits are not covered by the arm proof, even when armed', () => {
  const wf = [{ sha: 'cccccccc3333', subject: 'orchestrator tweak', at: '2026-11-15T09:00:00Z', paths: ['.github/workflows/opening-night-orchestrator.yml'] }];
  const v = L.changesVerdict(wf, { armed: true, windowHours: 48 });
  assert.equal(v.status, 'warn');
  assert.match(v.detail, /cccccccc/);
  const mixed = wf.concat([{ sha: 'dddddddd4444', subject: 'lane fix', at: '2026-11-15T08:00:00Z', paths: ['scripts/lib/opening-night-lane'] }]);
  assert.equal(L.changesVerdict(mixed, { armed: true, windowHours: 48 }).status, 'warn');
  assert.equal(L.changesVerdict([{ sha: 'e', subject: 'no paths known', at: 'x' }], { armed: true, windowHours: 48 }).status, 'warn');
});

test('mergeCommitResponses records which watched paths each commit touched', () => {
  const c = (sha) => ({ sha, commit: { message: 'm', committer: { date: 'd' } } });
  const m = L.mergeCommitResponses([[c('1')], [c('1'), c('2')]], ['scripts/llm-scoring', '.github/workflows/press-night-clock.yml']);
  assert.deepEqual(m.find((x) => x.sha === '1').paths, ['scripts/llm-scoring', '.github/workflows/press-night-clock.yml']);
  assert.deepEqual(m.find((x) => x.sha === '2').paths, ['.github/workflows/press-night-clock.yml']);
});

test('replayLaneVars follows the lane-switch ledger (set, set-var, delete-var; dry runs and failures ignored)', () => {
  const rows = [
    { mode: 'live', ok: true, changes: [{ variable: 'LANE_ONLY_MARKETS', op: 'set', to: 'broadway' }] },
    { mode: 'live', ok: true, changes: [{ variable: 'LANE_STANDDOWN', op: 'set', to: 'all' }] },
    { mode: 'dry-run', ok: true, changes: [{ variable: 'LANE_STANDDOWN', op: 'clear', to: '' }] },
    { mode: 'live', ok: false, changes: [{ variable: 'LANE_STANDDOWN', op: 'clear', to: '' }] },
  ];
  assert.deepEqual(L.replayLaneVars(rows), { onlyMarkets: 'broadway', standdown: 'all' });
  rows.push({ mode: 'live', ok: true, changes: [{ variable: 'LANE_STANDDOWN', op: 'delete-var', from: 'all', to: '' }] });
  assert.deepEqual(L.replayLaneVars(rows), { onlyMarkets: 'broadway', standdown: '' });
  assert.deepEqual(L.replayLaneVars([]), { onlyMarkets: '', standdown: '' });
});

test('laneAppliesTo: only covered, non-stood-down shows; West End and off-Broadway stay out when only broadway is set', () => {
  const vars = { onlyMarkets: 'broadway', standdown: '' };
  assert.equal(L.laneAppliesTo(vars, { category: 'broadway' }).applies, true);
  assert.equal(L.laneAppliesTo(vars, { category: 'west-end', market: 'west-end' }).applies, false);
  assert.equal(L.laneAppliesTo({ onlyMarkets: '', standdown: '' }, { category: 'broadway' }).applies, false);
  assert.equal(L.laneAppliesTo({ onlyMarkets: 'broadway', standdown: 'all' }, { category: 'broadway' }).applies, false);
});

test('simulated night (BRO-7781): pass, stale, failed, crashed and missing records; never fails readiness', () => {
  const at = new Date(NOW - 3 * 3600000).toISOString();
  const ok = { at, pass: true, checks: 23, failed: [], foundToLiveMedianMin: 11, reviews: 13 };
  assert.equal(L.simulatedNightVerdict(ok, NOW).status, 'pass');
  assert.match(L.simulatedNightVerdict(ok, NOW).detail, /23 checks/);
  const stale = { ...ok, at: new Date(NOW - (L.SIM_NIGHT_MAX_AGE_H + 1) * 3600000).toISOString() };
  assert.equal(L.simulatedNightVerdict(stale, NOW).status, 'warn');
  assert.match(L.simulatedNightVerdict(stale, NOW).detail, /stale/);
  const future = L.simulatedNightVerdict({ ...ok, at: new Date(NOW + 3 * 3600000).toISOString() }, NOW);
  assert.equal(future.status, 'warn');
  assert.match(future.detail, /in the future/);
  const garbled = L.simulatedNightVerdict({ ...ok, at: 'not-a-date' }, NOW);
  assert.equal(garbled.status, 'warn');
  assert.doesNotMatch(garbled.detail, /NaN/);
  const red = { ...ok, pass: false, failed: ['a', 'b', 'c', 'd'] };
  assert.equal(L.simulatedNightVerdict(red, NOW).status, 'warn');
  assert.match(L.simulatedNightVerdict(red, NOW).detail, /failed: a; b; c \(\+1 more\)/);
  assert.match(L.simulatedNightVerdict({ at, pass: false, error: 'boom' }, NOW).detail, /crashed: boom/);
  assert.equal(L.simulatedNightVerdict(null, NOW).status, 'warn');
  assert.equal(L.simulatedNightVerdict({ at: new Date(NOW + 3600000).toISOString(), pass: true }, NOW).status, 'warn');
});

// BRO-7808: embargo lifted days after the recorded openingDate.
test('late embargo: 3 same-day reviews 7 days after openingDate FAILS (Now You See Me Live)', () => {
  const show = { id: 'now-you-see-me-live-2026', category: 'broadway', openingDate: '2026-11-11' };
  const now = Date.parse('2026-11-19T03:30:00Z');
  const rv = ['culturesauce', 'nytg', 'theatermania'].map((o) => ({ outletId: o, publishDate: '2026-11-18' }));
  const v = L.lateEmbargoVerdict(show, rv, now);
  assert.equal(v.status, 'fail');
  assert.match(v.detail, /reviewEmbargoAt/);
  assert.equal(L.lateEmbargoVerdict(show, rv.slice(0, 2), now).status, 'skip', 'two reviews is not a burst');
  assert.equal(L.lateEmbargoVerdict(show, [{ outletId: 'bww', url: 'https://www.broadwayworld.com/article/Review-Roundup-X-Opens', publishDate: '2026-11-18' }], now).status, 'fail', 'roundup alone');
  assert.equal(L.lateEmbargoVerdict({ ...show, reviewEmbargoAt: '2026-11-19T03:00:00Z' }, rv, now).status, 'skip', 'recorded embargo silences it');
  assert.equal(L.lateEmbargoVerdict({ ...show, openingDate: '2026-11-17' }, rv, now).status, 'skip', 'press night under 2 days old');
});

test('late embargo (BRO-7808 review): no false positives on ordinary shows', () => {
  const show = { id: 's', category: 'broadway', status: 'open', openingDate: '2026-04-20' };
  const now = Date.parse('2026-04-26T12:00:00Z');
  const early = Array.from({ length: 12 }, (_, i) => ({ outletId: `o${i}`, publishDate: '2026-04-21' }));
  const trickle = ['a', 'b', 'c'].map((o) => ({ outletId: o, publishDate: '2026-04-25' }));
  assert.equal(L.lateEmbargoVerdict(show, [...early, ...trickle], now).status, 'skip', 'week-one trickle on top of a full press night');
  assert.equal(L.lateEmbargoVerdict(show, [{ outletId: 'theatrely', url: 'https://theatrely.com/post/a-september-review-roundup', publishDate: '2026-04-25' }], now).status, 'skip', 'unrelated roundup');
  assert.equal(L.lateEmbargoVerdict({ ...show, category: 'off-broadway' }, trickle.slice().concat(trickle), now).status, 'skip', 'non-lane market');
  assert.equal(L.lateEmbargoVerdict({ ...show, status: 'closed' }, trickle, now).status, 'skip', 'closed show');
  assert.equal(L.lateEmbargoVerdict(show, trickle.map((r) => ({ ...r, publishDate: undefined })), now).status, 'skip', 'no dates');
  assert.equal(L.lateEmbargoVerdict(show, [{ outletId: 'x', url: 'https://www.broadwayworld.com/article/Review-Roundup-X-Opens-on-Broadway', publishDate: '2026-04-25' }], now).status, 'fail', 'BWW roundup');
});
