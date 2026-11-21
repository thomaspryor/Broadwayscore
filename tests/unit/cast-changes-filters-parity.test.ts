import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import * as ts from '../../src/lib/cast-changes-filters';

// The cast-changes filter logic is duplicated across two runtimes:
//   - scripts/lib/cast-changes-filters.js  (Node scraper / audit / newsletter)
//   - src/lib/cast-changes-filters.ts      (Next.js web app)
// They are supposed to be line-for-line MIRRORS, but every prior bug-fix risked
// silent drift (the recurring desync that shipped closure-render bugs). The
// existing cast-changes-filters.test.mjs only imports the .js, so it NEVER
// guarded parity. This test imports BOTH and asserts identical output on shared
// fixtures — the .js↔.ts mirror claim is now enforced, not just commented.
type AnyFn = (...a: unknown[]) => unknown;
const requireCjs = createRequire(import.meta.url);
const js: Record<string, AnyFn> = requireCjs('../../scripts/lib/cast-changes-filters.js');
const tsAny = ts as unknown as Record<string, AnyFn>;

const TODAY = new Date('2026-05-31T12:00:00Z');

// A deliberately nasty mix: closures (dup + distinct dates), departures that
// restate a closing, an ended absence, a stale [AUTO-FLAGGED] row, undated
// rows, name/role variants, and future/past dates.
const FIXTURE = [
  { type: 'closure', name: 'show-2026', role: 'Production', date: '2026-09-20', note: 'short', addedDate: '2026-02-20' },
  { type: 'closure', name: 'The Show', role: 'Production', date: '2026-09-20', note: 'Final performance at the Foo Theatre on September 20, 2026.', addedDate: '2026-05-27' },
  { type: 'closure', name: 'The Show', role: 'Production', date: '2026-11-29', note: 'later closing', addedDate: '2026-04-01' },
  { type: 'departure', name: 'Jane Doe', role: 'Lead', date: '2026-09-20', note: 'production closes', addedDate: '2026-05-10' },
  { type: 'departure', name: 'Sam Roe', role: 'Ensemble', date: '2026-06-15', note: 'moving on', addedDate: '2026-05-12' },
  { type: 'arrival', name: 'Joanna "JoJo" Levesque', role: '', date: '2026-07-01', addedDate: '2026-05-15' },
  { type: 'arrival', name: 'Joanna Levesque', role: 'Roxie', date: '2026-07-01', addedDate: '2026-05-14' },
  { type: 'absence', name: 'Out Actor', role: 'Swing', date: '2026-05-01', endDate: '2026-05-20' },
  { type: 'arrival', name: 'Flag Me', role: 'X', note: '[AUTO-FLAGGED] verify', addedDate: '2026-01-01' },
  { type: 'departure', name: 'No Date', role: 'Y', note: 'production closes' },
];

function deepEqualBoth(name: string, jsOut: unknown, tsOut: unknown) {
  assert.deepEqual(jsOut, tsOut, `${name}: .js and .ts output diverge`);
}

test('parity: applyPublicFilters (full pipeline) identical', () => {
  deepEqualBoth(
    'applyPublicFilters',
    js.applyPublicFilters(FIXTURE, TODAY),
    ts.applyPublicFilters(FIXTURE as never, TODAY),
  );
});

test('parity: per-filter outputs identical', () => {
  const fns = [
    'filterAutoFlagged',
    'dedupeByPersonShow',
    'dedupeClosures',
    'reconcileClosure',
  ] as const;
  for (const fn of fns) {
    deepEqualBoth(fn, js[fn](FIXTURE), tsAny[fn](FIXTURE));
  }
  deepEqualBoth('filterStaleAbsences', js.filterStaleAbsences(FIXTURE, TODAY), ts.filterStaleAbsences(FIXTURE as never, TODAY));
  deepEqualBoth('filterPastEvents', js.filterPastEvents(FIXTURE, TODAY, 7), ts.filterPastEvents(FIXTURE as never, TODAY, 7));
  deepEqualBoth('filterStaleAddedDates', js.filterStaleAddedDates(FIXTURE, TODAY, 60), ts.filterStaleAddedDates(FIXTURE as never, TODAY, 60));
});

test('parity: reconcileClosureDateWithClosingDate identical', () => {
  for (const canonical of ['2026-11-29', undefined, '2026-09-20', 'garbage']) {
    deepEqualBoth(
      `reconcileClosureDateWithClosingDate(${canonical})`,
      js.reconcileClosureDateWithClosingDate(FIXTURE, canonical),
      ts.reconcileClosureDateWithClosingDate(FIXTURE as never, canonical as never),
    );
  }
});

test('parity: earliestAddedDate identical across edge inputs', () => {
  const cases: Array<[unknown, unknown]> = [
    ['2026-05-27', '2026-05-19'],
    [undefined, '2026-05-19'],
    ['2026-05-19', null],
    [undefined, undefined],
    ['garbage', '2026-05-19'],
  ];
  for (const [a, b] of cases) {
    deepEqualBoth(
      `earliestAddedDate(${a},${b})`,
      js.earliestAddedDate(a, b),
      ts.earliestAddedDate(a as never, b as never),
    );
  }
});

test('parity: normalizeIdentifier + noteMatchesClosurePhrase identical', () => {
  for (const s of ['Joanna "JoJo" Levesque', "O'Hara", 'Mary (Todd) Lincoln', '']) {
    deepEqualBoth(`normalizeIdentifier(${s})`, js.normalizeIdentifier(s), ts.normalizeIdentifier(s));
  }
  for (const n of ['production closes', 'show closes', 'random note', undefined]) {
    deepEqualBoth(`noteMatchesClosurePhrase(${n})`, js.noteMatchesClosurePhrase(n), ts.noteMatchesClosurePhrase(n as never));
  }
});
