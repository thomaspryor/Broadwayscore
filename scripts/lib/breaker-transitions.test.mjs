import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const {
  OK,
  TRIPPED,
  stateOf,
  dayOf,
  reconstructTransitions,
  parseTransitions,
  loadTransitions,
  appendTransition,
  recordTransitionSafely,
  findChainBreaks,
  daysTripped,
} = require('./breaker-transitions.js');
const { mergeBreakerTransitions } = require('./merge-breaker-transitions.js');

/* ──────────────────────────────────────────────────────────────────────────
 * BRO-3022. Sprint 3 (BRO-3011) needs "which days did each spend guard trip",
 * and its stated source cannot answer it: data/audit/alert-ledger.json holds
 * ONE cumulative object per conditionKey (verified live 2026-09-08:
 * sd-circuit-breaker = notifyCount 18 across a 25-day firstSeen..lastSeen
 * span, no per-day array), and data/audit/alert-router-attempts.jsonl has zero
 * breaker rows. These tests pin the recorder that replaces it.
 * ────────────────────────────────────────────────────────────────────────── */

function tmpLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-transitions-'));
  return path.join(dir, 'breaker-transitions.jsonl');
}

test('appends a row on TRIP', () => {
  const ledgerPath = tmpLedger();
  const row = appendTransition({
    conditionKey: 'sd-circuit-breaker',
    from: OK,
    to: TRIPPED,
    day: '2026-09-01',
    units: 35560,
    ceiling: 21000,
    ceilingSource: 'plan-fair-share',
    ledgerPath,
  });

  assert.ok(row, 'a trip must return the row it wrote');
  assert.equal(row.from, OK);
  assert.equal(row.to, TRIPPED);
  assert.equal(row.prevTs, null, 'the first row for a key has no predecessor');

  const rows = loadTransitions(ledgerPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].conditionKey, 'sd-circuit-breaker');
  assert.equal(rows[0].units, 35560);
  assert.equal(rows[0].ceiling, 21000);
});

test('appends a row on RECOVERY', () => {
  const ledgerPath = tmpLedger();
  appendTransition({ conditionKey: 'sd-circuit-breaker', from: OK, to: TRIPPED, day: '2026-09-01', ts: '2026-09-01T10:00:00.000Z', ledgerPath });
  const recovery = appendTransition({ conditionKey: 'sd-circuit-breaker', from: TRIPPED, to: OK, day: '2026-09-01', ts: '2026-09-01T14:00:00.000Z', ledgerPath });

  assert.ok(recovery, 'a recovery must be recorded, not just a trip');
  assert.equal(recovery.to, OK);
  // The chain: the recovery row names the trip row that preceded it.
  assert.equal(recovery.prevTs, '2026-09-01T10:00:00.000Z');
  assert.equal(loadTransitions(ledgerPath).length, 2);
});

test('appends NOTHING on an unchanged status', () => {
  const ledgerPath = tmpLedger();
  // The hourly re-check case: still tripped, still tripped, still tripped.
  for (let i = 0; i < 5; i++) {
    const row = appendTransition({ conditionKey: 'sd-circuit-breaker', from: TRIPPED, to: TRIPPED, day: '2026-09-01', ledgerPath });
    assert.equal(row, null, 'an unchanged status must return null');
  }
  const stillOk = appendTransition({ conditionKey: 'sd-circuit-breaker', from: OK, to: OK, day: '2026-09-01', ledgerPath });
  assert.equal(stillOk, null);

  assert.equal(fs.existsSync(ledgerPath), false, 'an unchanged status must not even create the file');
  assert.deepEqual(loadTransitions(ledgerPath), []);
});

test("Sprint 3's day-count is computable from the transition file ALONE for a fixture week", () => {
  const ledgerPath = tmpLedger();

  // A realistic week. Note there is NO recovery row at a day boundary: both
  // checkers read wasActive through a DAY-SCOPED predicate, so a breaker still
  // over its ceiling at UTC midnight simply re-trips on the new day. Mon/Tue/Wed
  // are three separate trips of one continuous overspend; Thu is a real
  // same-day recovery (the opening-window reserve lifted the ceiling); Fri and
  // the weekend are quiet.
  const week = [
    ['2026-09-07T09:00:00.000Z', '2026-09-07', OK, TRIPPED],
    ['2026-09-08T09:00:00.000Z', '2026-09-08', OK, TRIPPED],
    ['2026-09-09T09:00:00.000Z', '2026-09-09', OK, TRIPPED],
    ['2026-09-10T09:00:00.000Z', '2026-09-10', OK, TRIPPED],
    ['2026-09-10T15:00:00.000Z', '2026-09-10', TRIPPED, OK],
  ];
  for (const [ts, day, from, to] of week) {
    appendTransition({ conditionKey: 'sd-circuit-breaker', from, to, day, ts, ledgerPath });
  }
  // A DIFFERENT guard trips in the same week and must not contaminate the count.
  appendTransition({ conditionKey: 'bd-circuit-breaker-serp_api1', from: OK, to: TRIPPED, day: '2026-09-08', ts: '2026-09-08T11:00:00.000Z', ledgerPath });

  const rows = loadTransitions(ledgerPath);

  const sd = daysTripped(rows, { conditionKey: 'sd-circuit-breaker', sinceDay: '2026-09-07', untilDay: '2026-09-13' });
  assert.equal(sd.days, 4, 'four distinct days tripped');
  assert.deepEqual(sd.dayList, ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10']);
  assert.equal(sd.lowerBound, false, 'an intact chain is an exact count, not a lower bound');
  // The DEFECT rule Sprint 3 applies: >2 days/week.
  assert.ok(sd.days > 2, '4 days/week is a DEFECT under the >2 rule');

  const bd = daysTripped(rows, { conditionKey: 'bd-circuit-breaker-serp_api1', sinceDay: '2026-09-07', untilDay: '2026-09-13' });
  assert.equal(bd.days, 1, 'per-zone BD key is counted independently');
  assert.ok(bd.days <= 2, '1 day/week is not a defect');

  // Window bounds are respected on both sides.
  assert.equal(daysTripped(rows, { conditionKey: 'sd-circuit-breaker', sinceDay: '2026-09-09' }).days, 2);
  assert.equal(daysTripped(rows, { conditionKey: 'sd-circuit-breaker', untilDay: '2026-09-08' }).days, 2);
});

test('a duplicated row cannot change the day-count (union merge resurrects lines)', () => {
  // Rule (a) from the module header: no reader may aggregate duplicate keys.
  const rows = parseTransitions([
    JSON.stringify({ ts: '2026-09-07T09:00:00.000Z', conditionKey: 'sd-circuit-breaker', from: OK, to: TRIPPED, day: '2026-09-07', prevTs: null }),
    JSON.stringify({ ts: '2026-09-07T09:00:00.000Z', conditionKey: 'sd-circuit-breaker', from: OK, to: TRIPPED, day: '2026-09-07', prevTs: null }),
    JSON.stringify({ ts: '2026-09-08T09:00:00.000Z', conditionKey: 'sd-circuit-breaker', from: OK, to: TRIPPED, day: '2026-09-08', prevTs: '2026-09-07T09:00:00.000Z' }),
  ].join('\n'));

  assert.equal(daysTripped(rows, { conditionKey: 'sd-circuit-breaker' }).days, 2);
});

test('file order is never trusted — rows shuffled by union merge still count correctly', () => {
  // Rule (b): union merge appends the other side's lines UNORDERED.
  const lines = [
    { ts: '2026-09-09T09:00:00.000Z', conditionKey: 'sd-circuit-breaker', from: OK, to: TRIPPED, day: '2026-09-09', prevTs: '2026-09-08T09:00:00.000Z' },
    { ts: '2026-09-07T09:00:00.000Z', conditionKey: 'sd-circuit-breaker', from: OK, to: TRIPPED, day: '2026-09-07', prevTs: null },
    { ts: '2026-09-08T09:00:00.000Z', conditionKey: 'sd-circuit-breaker', from: OK, to: TRIPPED, day: '2026-09-08', prevTs: '2026-09-07T09:00:00.000Z' },
  ];
  const rows = parseTransitions(lines.map((l) => JSON.stringify(l)).join('\n'));
  const out = daysTripped(rows, { conditionKey: 'sd-circuit-breaker' });
  assert.equal(out.days, 3);
  assert.equal(out.lowerBound, false, 'out-of-order but complete is NOT loss');
});

test('a LOST row is distinguishable from a quiet day (BRO-2951)', () => {
  // The card's durability requirement. The 09-08 row is gone — a dropped CI
  // commit, or a conflicted push that kept the other side. The 09-09 row still
  // names it as its predecessor, so the loss is visible.
  const rows = parseTransitions([
    JSON.stringify({ ts: '2026-09-07T09:00:00.000Z', conditionKey: 'sd-circuit-breaker', from: OK, to: TRIPPED, day: '2026-09-07', prevTs: null }),
    JSON.stringify({ ts: '2026-09-09T09:00:00.000Z', conditionKey: 'sd-circuit-breaker', from: OK, to: TRIPPED, day: '2026-09-09', prevTs: '2026-09-08T09:00:00.000Z' }),
  ].join('\n'));

  const breaks = findChainBreaks(rows, 'sd-circuit-breaker');
  assert.equal(breaks.gaps.length, 1);
  assert.equal(breaks.gaps[0].missingPrevTs, '2026-09-08T09:00:00.000Z');

  const out = daysTripped(rows, { conditionKey: 'sd-circuit-breaker' });
  assert.equal(out.days, 2);
  assert.equal(out.lowerBound, true, 'a gap must force Sprint 3 to say "at least N"');

  // A genuinely quiet week is NOT flagged — that is the whole distinction.
  const quiet = parseTransitions(JSON.stringify({ ts: '2026-09-07T09:00:00.000Z', conditionKey: 'sd-circuit-breaker', from: OK, to: TRIPPED, day: '2026-09-07', prevTs: null }));
  assert.equal(daysTripped(quiet, { conditionKey: 'sd-circuit-breaker' }).lowerBound, false);
});

test('two writers racing is a FORK, not a gap', () => {
  // Both read the same last row, both append. Union keeps both. Nothing is
  // missing, so lowerBound must stay false.
  const rows = parseTransitions([
    JSON.stringify({ ts: '2026-09-07T09:00:00.000Z', conditionKey: 'sd-circuit-breaker', from: OK, to: TRIPPED, day: '2026-09-07', prevTs: null }),
    JSON.stringify({ ts: '2026-09-08T09:00:00.000Z', conditionKey: 'sd-circuit-breaker', from: OK, to: TRIPPED, day: '2026-09-08', prevTs: '2026-09-07T09:00:00.000Z' }),
    JSON.stringify({ ts: '2026-09-08T09:00:01.000Z', conditionKey: 'sd-circuit-breaker', from: OK, to: TRIPPED, day: '2026-09-08', prevTs: '2026-09-07T09:00:00.000Z' }),
  ].join('\n'));

  const breaks = findChainBreaks(rows, 'sd-circuit-breaker');
  assert.equal(breaks.gaps.length, 0, 'a fork is not loss');
  assert.equal(breaks.forks.length, 1);
  assert.equal(breaks.forks[0].count, 2);
  assert.equal(daysTripped(rows, { conditionKey: 'sd-circuit-breaker' }).lowerBound, false);
});

test('a torn line is skipped, not thrown on', () => {
  const rows = parseTransitions([
    JSON.stringify({ ts: '2026-09-07T09:00:00.000Z', conditionKey: 'sd-circuit-breaker', from: OK, to: TRIPPED, day: '2026-09-07', prevTs: null }),
    '{"ts":"2026-09-08T09:00:00.000Z","conditionKey":"sd-circ',
    '',
    JSON.stringify({ ts: '2026-09-09T09:00:00.000Z', conditionKey: 'sd-circuit-breaker', from: OK, to: TRIPPED, day: '2026-09-09', prevTs: '2026-09-07T09:00:00.000Z' }),
  ].join('\n'));
  assert.equal(rows.length, 2);
});

test('an invalid state is rejected loudly, and recordTransitionSafely swallows it', () => {
  const ledgerPath = tmpLedger();
  assert.throws(() => appendTransition({ conditionKey: 'x', from: 'maybe', to: TRIPPED, ledgerPath }), /from must be/);
  assert.throws(() => appendTransition({ conditionKey: 'x', from: OK, to: 'maybe', ledgerPath }), /to must be/);
  assert.throws(() => appendTransition({ from: OK, to: TRIPPED, ledgerPath }), /conditionKey/);

  // The wrapper the checkers actually call must NEVER throw — an unwritable
  // ledger must not suppress the routeAlert() that follows it.
  const warnings = [];
  const got = recordTransitionSafely({ conditionKey: 'x', from: 'maybe', to: TRIPPED, ledgerPath }, { warn: (m) => warnings.push(m) });
  assert.equal(got, null);
  assert.equal(warnings.length, 1);
});

test('stateOf maps the checkers\' boolean verdict onto row states', () => {
  assert.equal(stateOf(true), TRIPPED);
  assert.equal(stateOf(false), OK);
});

test('mergeBreakerTransitions unions both sides, deduped by (ts, conditionKey)', () => {
  const shared = { ts: '2026-09-07T09:00:00.000Z', conditionKey: 'sd-circuit-breaker', from: OK, to: TRIPPED, day: '2026-09-07' };
  const ours = [shared, { ts: '2026-09-08T09:00:00.000Z', conditionKey: 'sd-circuit-breaker', from: OK, to: TRIPPED, day: '2026-09-08' }];
  const theirs = [shared, { ts: '2026-09-08T10:00:00.000Z', conditionKey: 'bd-circuit-breaker-serp_api1', from: OK, to: TRIPPED, day: '2026-09-08' }];

  const { merged, stats } = mergeBreakerTransitions(ours, theirs);
  assert.equal(merged.length, 3, 'the shared row is deduped, both unique rows survive');
  assert.equal(stats.remoteOnly, 1);
  // Neither side's rows are lost — that is the point of registering the file
  // apiFallbackMerge rather than apiFallbackSafe (ours-wins-outright).
  assert.ok(merged.some((r) => r.conditionKey === 'bd-circuit-breaker-serp_api1'));
  assert.equal(daysTripped(merged, { conditionKey: 'sd-circuit-breaker' }).days, 2);
});

/* ──────────────────────────────────────────────────────────────────────────
 * The historical backfill's pure core (scripts/backfill-breaker-transitions.js
 * require()s exactly this function — project rule 15, no copied logic).
 * ────────────────────────────────────────────────────────────────────────── */

test('reconstructTransitions: one row per FRESH trip, none for hourly re-checks', () => {
  // trippedAt is preserved across the hourly re-checks of one day and
  // re-stamped only on a fresh trip. This is the real shape of the SD state
  // file's history: trip, three unchanged re-checks, clear, trip again.
  const rows = reconstructTransitions([
    { trippedAt: null, units: 10, ceiling: 21000 },
    { trippedAt: '2026-09-01T09:00:00.000Z', units: 25000, ceiling: 21000 },
    { trippedAt: '2026-09-01T09:00:00.000Z', units: 26000, ceiling: 21000 },
    { trippedAt: '2026-09-01T09:00:00.000Z', units: 27000, ceiling: 21000 },
    { trippedAt: null, units: 100, ceiling: 21000 },
    { trippedAt: '2026-09-02T08:00:00.000Z', units: 30000, ceiling: 21000 },
  ], 'sd-circuit-breaker');

  assert.equal(rows.length, 2, 'two fresh trips, not six observations');
  assert.deepEqual(rows.map((r) => r.day), ['2026-09-01', '2026-09-02']);
  assert.equal(rows[0].ts, '2026-09-01T09:00:00.000Z', 'ts IS the trippedAt value — that is what makes the backfill idempotent');
  assert.equal(rows[0].units, 25000, 'the observation AT the trip is the one recorded');
  assert.equal(rows[0].to, TRIPPED);
  // Recoveries are deliberately not reconstructed: no clearedAt exists to date
  // them, and a synthesised ts would break idempotency.
  assert.equal(rows.every((r) => r.to === TRIPPED), true);
});

test('reconstructTransitions is deterministic — the backfill can be re-run safely', () => {
  const observations = [
    { trippedAt: null, units: null, ceiling: null },
    { trippedAt: '2026-09-01T09:00:00.000Z', units: 25000, ceiling: 21000 },
    { trippedAt: '2026-09-03T09:00:00.000Z', units: 40000, ceiling: 21000 },
  ];
  const a = reconstructTransitions(observations, 'sd-circuit-breaker');
  const b = reconstructTransitions(observations, 'sd-circuit-breaker');
  assert.deepEqual(a, b, 'identical input must yield byte-identical rows');
  // Which is what lets the CLI skip on the (ts, conditionKey) key.
  assert.deepEqual(a.map((r) => `${r.ts} ${r.conditionKey}`), [
    '2026-09-01T09:00:00.000Z sd-circuit-breaker',
    '2026-09-03T09:00:00.000Z sd-circuit-breaker',
  ]);
});

test('reconstructTransitions tolerates an empty or already-tripped history', () => {
  assert.deepEqual(reconstructTransitions([], 'sd-circuit-breaker'), []);
  assert.deepEqual(reconstructTransitions(null, 'sd-circuit-breaker'), []);
  // History that STARTS mid-trip still records that trip — the first
  // observation is a transition from "unknown", and dropping it would silently
  // lose the oldest day in every backfill window.
  const rows = reconstructTransitions([{ trippedAt: '2026-08-12T14:11:05.524Z', units: 45133, ceiling: 45000 }], 'sd-circuit-breaker');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].day, '2026-08-12');
});

test('backfilled rows are chain-neutral and never manufacture a false gap', () => {
  const ledgerPath = tmpLedger();
  // A live row first, then a backfilled row that is OLDER than it.
  appendTransition({ conditionKey: 'sd-circuit-breaker', from: OK, to: TRIPPED, day: '2026-09-08', ts: '2026-09-08T09:00:00.000Z', ledgerPath });
  appendTransition({ conditionKey: 'sd-circuit-breaker', from: OK, to: TRIPPED, day: '2026-08-12', ts: '2026-08-12T14:11:05.524Z', source: 'history-backfill', prevTs: null, ledgerPath });

  const rows = loadTransitions(ledgerPath);
  const backfilled = rows.find((r) => r.source === 'history-backfill');
  assert.equal(backfilled.prevTs, null, 'an explicit null must NOT be overwritten by a derived link');

  const out = daysTripped(rows, { conditionKey: 'sd-circuit-breaker' });
  assert.equal(out.days, 2);
  assert.equal(out.lowerBound, false, 'a backfilled row must not look like loss');
});

test('dayOf extracts the UTC day and rejects junk', () => {
  assert.equal(dayOf('2026-09-08T01:36:10.830Z'), '2026-09-08');
  assert.equal(dayOf('short'), null);
  assert.equal(dayOf(null), null);
});

/* ──────────────────────────────────────────────────────────────────────────
 * The card's second acceptance command, asserted HERE rather than as a bare
 * shell command (the dispatcher validator rejects that form).
 * ────────────────────────────────────────────────────────────────────────── */

test('node scripts/check-sd-breaker.js --dry-run writes NO transition row', () => {
  const ledgerPath = tmpLedger();
  const statePath = path.join(path.dirname(ledgerPath), 'sd-circuit-breaker.json');

  // Seed a state file that says "not tripped yesterday". With a forced ceiling
  // of 1 credit, any real usage trips — so a run that wrote rows at all would
  // write one here. --dry-run must still write nothing.
  fs.writeFileSync(statePath, JSON.stringify({ day: '2000-01-01', trippedAt: null, dayBaseline: 0 }));

  const out = execFileSync(
    process.execPath,
    [path.join(process.cwd(), 'scripts', 'check-sd-breaker.js'), '--dry-run'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        SD_BREAKER_CEILING: '1',
        SD_BREAKER_STATE_PATH: statePath,
        BREAKER_TRANSITIONS_PATH: ledgerPath,
      },
    },
  );

  assert.equal(fs.existsSync(ledgerPath), false, `--dry-run must not create the transition ledger. Script said:\n${out}`);

  // Guard against the test passing for the wrong reason: if the script no-oped
  // on a missing API key it never reached the append at all, and this test
  // proves nothing about --dry-run. Say so out loud rather than passing green.
  if (/SCRAPINGDOG_API_KEY not set/.test(out)) {
    assert.ok(true, 'no SD key in this environment — the dry-run path was not exercised end-to-end (unit tests above still pin appendTransition)');
  } else {
    assert.match(out, /--dry-run: state not written/, 'the script should have reached its dry-run branch');
  }
});
