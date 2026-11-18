// BRO-7779: no press night may have a stretch longer than 15 minutes with no collector running, from lane start -3h to
// embargo +6h, in any lane market, whether reviews drop 3h early, on time or 3h late, with or without the lane.
// Fake clock throughout: every time below comes from the real planners (press-night-clock planKicks/kindAction,
// auto-fallback nightTimes/planNightWait, press-night-watchdog evaluateTick/watchStartMs) driven at fixed instants.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const cov = require('../../scripts/lib/press-night-coverage.js');
const clock = require('../../scripts/lib/press-night-clock.js');
const wd = require('../../scripts/lib/press-night-watchdog.js');
const { defaultEmbargoAt } = require('../../scripts/lib/press-night-record.js');

const MIN = 60000;
const MARKETS = ['broadway', 'off-broadway', 'west-end', 'off-west-end'];
const DROPS = { early: -180, 'on time': 0, late: 180 };

function show(category, { confirmed = false } = {}) {
  const s = { id: `cov-${category}`, title: `Coverage ${category}`, category, status: 'previews', openingDate: '2026-12-03' };
  if (confirmed) s.reviewEmbargoAt = defaultEmbargoAt(s); // the same hour, but set by a person: guard off, short lane
  return s;
}

const fmt = (ms, embMs) => `E${ms >= embMs ? '+' : ''}${Math.round((ms - embMs) / MIN)}m`;

for (const category of MARKETS) {
  for (const confirmed of [false, true]) {
    for (const laneRuns of [true, false]) {
      for (const [label, dropMin] of Object.entries(DROPS)) {
        const name = `${category}, ${confirmed ? 'confirmed' : 'guessed'} embargo, lane ${laneRuns ? 'on' : 'off'}, reviews ${label}`;
        test(`no collector gap over ${cov.MAX_GAP_MIN} min: ${name}`, () => {
          const s = show(category, { confirmed });
          const { times, intervals } = cov.collectorsFor(s, { laneRuns });
          assert.ok(times, 'embargo known for a lane market');
          const w = cov.checkWindow(times);
          const g = cov.maxGap(intervals, w.fromMs, w.toMs);
          const plan = intervals.map((i) => `${i.who} ${fmt(i.fromMs, times.embargoMs)}..${fmt(i.toMs, times.embargoMs)}`).join(', ');
          assert.ok(g.gapMin <= cov.MAX_GAP_MIN,
            `${g.gapMin} min with no collector (${fmt(g.fromMs, times.embargoMs)}..${fmt(g.toMs, times.embargoMs)}); plan: ${plan || 'nothing'}`);
          const dropMs = times.embargoMs + dropMin * MIN;
          assert.ok(dropMs >= w.fromMs && dropMs <= w.toMs, 'the drop falls inside the checked window');
          assert.ok(intervals.some((i) => i.fromMs <= dropMs && i.toMs >= dropMs + 60 * MIN),
            `a collector is up at the drop (${fmt(dropMs, times.embargoMs)}) and for the hour after it; plan: ${plan}`);
        });
      }
    }
  }
}

test('watchdog: watches from the lane start, and starts the pipeline there when nothing runs (early drop)', () => {
  for (const category of MARKETS) {
    const s = show(category);
    const { times } = cov.collectorsFor(s);
    const startMs = wd.watchStartMs(s, s.openingDate);
    assert.ok(startMs <= times.laneStartMs, `${category}: watchdog starts at or before the lane start`);
    assert.ok(startMs < times.embargoMs, `${category}: watchdog starts before the embargo`);
    const r = wd.evaluateTick({ showId: s.id, embargoMs: times.embargoMs, watchStartMs: startMs, nowMs: times.laneStartMs,
      files: [], coreRows: [], liveRows: [], runs: [], normOutlet: (x) => x });
    assert.deepEqual(r.actions.map((a) => a.type), ['dispatch-orchestrator'], `${category}: no pipeline at the lane start -> start one`);
    // Before the watch window nothing happens (the clock's early orchestrator owns that stretch).
    const before = wd.evaluateTick({ showId: s.id, embargoMs: times.embargoMs, watchStartMs: startMs, nowMs: startMs - 5 * MIN,
      files: [], coreRows: [], liveRows: [], runs: [], normOutlet: (x) => x });
    assert.deepEqual(before.actions, []);
  }
});

test('the clock workflow and the orchestrator re-seed plan every lane market', () => {
  for (const m of MARKETS) assert.ok(clock.DEFAULT_CATEGORIES.includes(m), `${m} in DEFAULT_CATEGORIES`);
  const yml = readFileSync(new URL('../../.github/workflows/press-night-clock.yml', import.meta.url), 'utf8');
  const def = yml.match(/categories:\n(?:\s+\w+:.*\n)*?\s+default: '([^']*)'/);
  assert.ok(def, 'categories input default found');
  assert.deepEqual(def[1].split(',').sort(), [...clock.DEFAULT_CATEGORIES].sort());
  const orch = readFileSync(new URL('../../.github/workflows/opening-night-orchestrator.yml', import.meta.url), 'utf8');
  for (const m of orch.matchAll(/press-night-clock\.js next[^\n]*--categories=([\w,-]+)/g)) {
    assert.deepEqual(m[1].split(',').sort(), [...clock.DEFAULT_CATEGORIES].sort(), 'orchestrator re-seed categories');
  }
  // The workflow takes its per-kind action from kindAction (no second copy of the rule in bash).
  assert.match(yml, /press-night-clock\.js action --kind="\$KIND" --category="\$CATEGORY"/);
});

test('reviewer blockers stay fixed: watcher not restarted by the early run, watchdog uses the show market, ek ends at the kick', () => {
  const orch = readFileSync(new URL('../../.github/workflows/opening-night-orchestrator.yml', import.meta.url), 'utf8');
  const watcher = orch.slice(orch.indexOf('- name: Start aggregator URL watcher loop'));
  assert.match(watcher.slice(0, 2000), /if: [^\n]*inputs\.role != 'ek'/, 'the early run must not start the 270-min URL watcher loop');
  assert.match(orch, /DEADLINE=\$\(\( \$\(date \+%s\) \+ LOOP_MIN\*60 \)\)/, 'the loop honours deadline_minutes');
  const cli = readFileSync(new URL('../../scripts/press-night-watchdog.js', import.meta.url), 'utf8');
  assert.doesNotMatch(cli, /'market=broadway'/, 'the watchdog must not hardcode the Broadway market');
  const E = Date.parse('2026-12-04T03:00:00Z');
  assert.equal(clock.runMinutes('ek', E, E - 270 * MIN), 150);
  assert.equal(clock.runMinutes('kick', E, E - 120 * MIN), 240);
  // The on-time kick (created at -2h) never suppresses the tail run; a late kick (created after +10) does.
  assert.equal(clock.dedupedBy('tk', E + 110 * MIN, [E - 120 * MIN]), false);
  assert.equal(clock.dedupedBy('tk', E + 110 * MIN, [E + 30 * MIN]), true);
});

test('maxGap finds the hole', () => {
  const iv = [{ fromMs: 0, toMs: 10 * MIN }, { fromMs: 5 * MIN, toMs: 20 * MIN }, { fromMs: 50 * MIN, toMs: 60 * MIN }];
  assert.deepEqual(cov.maxGap(iv, 0, 60 * MIN), { gapMin: 30, fromMs: 20 * MIN, toMs: 50 * MIN });
  assert.equal(cov.maxGap(iv, 0, 70 * MIN).gapMin, 30);
  assert.equal(cov.maxGap([], 0, 15 * MIN).gapMin, 15);
});
