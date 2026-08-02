import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  computeArmState,
  computeCollapseState,
  daysBetween,
  dedupeEntries,
  detectDeadArms,
  indexLedger,
  volumeInWindow,
} = require('./arm-yield.js');
const { ARMS, selectArms } = require('./arm-registry.js');

const DAY = 24 * 60 * 60 * 1000;

/** Build a date→count map ending at `end`, from an array read left-to-right as oldest→newest. */
function series(end, counts) {
  const map = new Map();
  const endMs = Date.parse(`${end}T00:00:00Z`);
  counts.forEach((n, i) => {
    const day = new Date(endMs - (counts.length - 1 - i) * DAY).toISOString().slice(0, 10);
    map.set(day, n);
  });
  return map;
}

// ── The card's acceptance criteria, as executable fixtures ───────────────────
// "A simulated 3-day zero-yield window on a normally-productive arm raises
//  exactly one owner-visible alert, and a genuinely sparse arm (NYSR) over the
//  same window raises none."

test('3-day zero window on a daily arm is dead (threshold floors at 3)', () => {
  // 27 days producing every single day, then three days of nothing.
  const daily = series('2026-07-30', [...Array(27).fill(4), 0, 0, 0]);
  const state = computeArmState(daily, { asOf: '2026-07-30' });
  assert.equal(state.verdict, 'dead');
  assert.equal(state.daysSinceLastYield, 3);
  assert.equal(state.threshold, 3, 'a never-quiet arm gets the 3-day floor');
});

test('2-day zero window on the same arm is NOT dead — the floor is a floor', () => {
  const daily = series('2026-07-30', [...Array(28).fill(4), 0, 0]);
  assert.equal(computeArmState(daily, { asOf: '2026-07-30' }).verdict, 'healthy');
});

test('sparse arm (real nysr July 2026 shape) survives the same 3-day window', () => {
  // Real nysr yields, 2026-07-01..07-30 (see data/audit/arm-yield-ledger.jsonl):
  // an 8-day publishing gap 07-18..07-25 while perfectly healthy.
  const nysr = series('2026-07-30', [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 0, 6, 3, 0, 0, 1,
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 0,
  ]);
  const state = computeArmState(nysr, { asOf: '2026-07-30' });
  assert.equal(state.verdict, 'healthy');
  assert.ok(state.threshold >= 9, `sparse arm threshold should exceed its 8d gap, got ${state.threshold}`);
  // And the trailing 3 zero days at the end of that window still do not trip it.
  const plusThree = series('2026-08-02', [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 0, 6, 3, 0, 0, 1,
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 0, 0, 0, 0,
  ]);
  assert.equal(computeArmState(plusThree, { asOf: '2026-08-02' }).verdict, 'healthy');
});

test('exactly one arm is reported dead when only one arm is silent', () => {
  const dailyLive = series('2026-07-30', Array(30).fill(4));
  const dailyDead = series('2026-07-30', [...Array(27).fill(4), 0, 0, 0]);
  const entries = [];
  for (const [id, map] of [['a', dailyLive], ['b', dailyDead], ['c', dailyLive]]) {
    for (const [date, itemsFound] of map) entries.push({ arm: id, date, itemsFound });
  }
  const arms = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const { dead } = detectDeadArms(entries, arms, { asOf: '2026-07-30' });
  assert.equal(dead.length, 1);
  assert.equal(dead[0].id, 'b');
});

// ── Threshold derivation ─────────────────────────────────────────────────────

test('threshold is the longest quiet gap the arm has shown, plus a 2-day margin', () => {
  // Yields every 5th day → 4-day quiet gaps → threshold 6.
  const everyFifth = series('2026-07-30', Array.from({ length: 30 }, (_, i) => (i % 5 === 4 ? 3 : 0)));
  const state = computeArmState(everyFifth, { asOf: '2026-07-30' });
  assert.equal(state.longestPriorGap, 4);
  assert.equal(state.threshold, 6);
  assert.equal(state.verdict, 'healthy');
});

test('an arm with too few productive days is never judged', () => {
  const barely = series('2026-07-30', [...Array(28).fill(0), 1, 0]);
  const state = computeArmState(barely, { asOf: '2026-07-30' });
  assert.equal(state.verdict, 'insufficient-history');
});

test('a brand-new arm with no productive day yet cannot alert', () => {
  const fresh = series('2026-07-30', [0, 0, 0, 0, 0]);
  assert.equal(computeArmState(fresh, { asOf: '2026-07-30' }).verdict, 'no-history');
});

test('an arm dead longer than the ledger IS reported, not written off as unjudgeable', () => {
  // scoring-audit: monthly cron, 5/5 failures since 2026-03-01. Its last
  // success predates the whole retained ledger, so a naive "no baseline, skip"
  // would make the longest outage the quietest one.
  const longDead = series('2026-07-30', Array(120).fill(0));
  const state = computeArmState(longDead, { asOf: '2026-07-30' });
  assert.equal(state.verdict, 'dead');
  assert.ok(state.daysSinceLastYield >= 119);
});

// ── The detector's own blindness ─────────────────────────────────────────────

test('a ledger that stopped being written reports unobserved, never healthy', () => {
  const stale = series('2026-07-20', Array(30).fill(4));
  const state = computeArmState(stale, { asOf: '2026-07-30' });
  assert.equal(state.verdict, 'unobserved');
  assert.match(state.reason, /recorder/);
});

test('observation age inside the tolerance still judges normally', () => {
  const slightlyStale = series('2026-07-28', Array(30).fill(4));
  assert.equal(computeArmState(slightlyStale, { asOf: '2026-07-30' }).verdict, 'healthy');
});

// ── Collapse rule ────────────────────────────────────────────────────────────

test('collapse catches the orchestrator shape that silence cannot', () => {
  // Real scheduled-success counts, 2026-07-03..07-30. Note the stray 1s on
  // 07-19 and 07-30: they reset any consecutive-zero counter, which is exactly
  // why the silence rule alone reports this arm as healthy on the audit date.
  const orchestrator = series('2026-07-30', [
    2, 3, 3, 1, 1, 1, 2, 2, 2, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
  ]);
  assert.equal(computeArmState(orchestrator, { asOf: '2026-07-30' }).verdict, 'healthy');
  const collapse = computeCollapseState(orchestrator, { asOf: '2026-07-30' });
  assert.equal(collapse.verdict, 'collapsed');
  assert.ok(collapse.ratio < 0.2, `expected <20% of peak, got ${collapse.ratio}`);
});

test('a steady healthy arm is not called collapsed', () => {
  const steady = series('2026-07-30', Array(60).fill(5));
  assert.equal(computeCollapseState(steady, { asOf: '2026-07-30' }).verdict, 'healthy');
});

test('low-volume arms are exempt from the collapse ratio (noise floor)', () => {
  // 3 items in 60 days: any ratio here is noise, and silence already covers it.
  const trickle = series('2026-07-30', Array.from({ length: 60 }, (_, i) => (i % 20 === 0 ? 1 : 0)));
  assert.equal(computeCollapseState(trickle, { asOf: '2026-07-30' }).verdict, 'not-applicable');
});

test('collapse is only applied to arms declared cadence:steady', () => {
  const bursty = series('2026-07-30', [
    ...Array(20).fill(3), ...Array(40).fill(0),
  ]);
  const entries = [];
  for (const [date, itemsFound] of bursty) {
    entries.push({ arm: 'outlet:x', date, itemsFound }, { arm: 'workflow:x', date, itemsFound });
  }
  const { states } = detectDeadArms(
    entries,
    [{ id: 'outlet:x' }, { id: 'workflow:x', cadence: 'steady' }],
    { asOf: '2026-07-30' }
  );
  const byId = Object.fromEntries(states.map((s) => [s.id, s]));
  assert.equal(byId['outlet:x'].collapse.verdict, 'not-applicable');
  assert.notEqual(byId['workflow:x'].collapse.verdict, 'not-applicable');
});

test('an arm already dead by silence is not double-reported as collapsed', () => {
  const silent = series('2026-07-30', [...Array(40).fill(5), ...Array(20).fill(0)]);
  const entries = [...silent].map(([date, itemsFound]) => ({ arm: 'w', date, itemsFound }));
  const { dead, collapsed } = detectDeadArms(entries, [{ id: 'w', cadence: 'steady' }], { asOf: '2026-07-30' });
  assert.equal(dead.length, 1);
  assert.equal(collapsed.length, 0, 'one outage must not produce two alerts');
});

// ── Ledger plumbing ──────────────────────────────────────────────────────────

test('indexLedger sums same-day rows and skips malformed ones', () => {
  const byArm = indexLedger([
    { arm: 'a', date: '2026-07-30', itemsFound: 2 },
    { arm: 'a', date: '2026-07-30', itemsFound: 3 },
    { arm: 'a', date: 'not-a-date', itemsFound: 9 },
    { arm: 'a', date: '2026-07-29', itemsFound: -1 },
    null,
  ]);
  assert.equal(byArm.get('a').get('2026-07-30'), 5);
  assert.equal(byArm.get('a').has('2026-07-29'), false);
});

test('dedupeEntries makes re-recording a day idempotent, not additive', () => {
  const merged = dedupeEntries([
    { arm: 'a', date: '2026-07-30', itemsFound: 2 },
    { arm: 'a', date: '2026-07-30', itemsFound: 7 },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].itemsFound, 7, 'the later write replaces the earlier one');
});

test('volumeInWindow / daysBetween arithmetic is calendar-correct', () => {
  assert.equal(daysBetween('2026-07-01', '2026-07-30'), 29);
  assert.equal(daysBetween('2026-02-27', '2026-03-02'), 3);
  const m = series('2026-07-30', [1, 2, 3, 4]);
  assert.equal(volumeInWindow(m, '2026-07-30', 2), 7);
  assert.equal(volumeInWindow(m, '2026-07-30', 10), 10);
});

// ── Registry integrity ───────────────────────────────────────────────────────

test('registry ids are unique and every arm is well-formed', () => {
  const ids = new Set();
  for (const arm of ARMS) {
    assert.ok(!ids.has(arm.id), `duplicate arm id ${arm.id}`);
    ids.add(arm.id);
    assert.ok(arm.label, `${arm.id} needs a label for the alert text`);
    if (arm.kind === 'workflow') {
      assert.match(arm.workflow, /\.yml$/, `${arm.id} needs a workflow filename`);
      assert.equal(arm.cadence, 'steady', 'workflow arms must opt into the collapse rule');
    } else {
      assert.ok(Array.isArray(arm.outletIds) && arm.outletIds.length, `${arm.id} needs outletIds`);
      assert.notEqual(arm.cadence, 'steady', 'bursty outlet arms must not use the collapse rule');
    }
  }
});

test('selectArms resolves known ids and surfaces unknown ones', () => {
  const ok = selectArms('outlet:nysr');
  assert.equal(ok.arms.length, 1);
  assert.equal(ok.unknown.length, 0);
  const bad = selectArms('outlet:nysr,outlet:nope');
  assert.deepEqual(bad.unknown, ['outlet:nope']);
  assert.equal(selectArms(null).arms.length, ARMS.length);
});
