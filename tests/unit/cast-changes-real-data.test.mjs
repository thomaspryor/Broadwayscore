/**
 * Real-data invariants for data/cast-changes.json.
 *
 * Unit tests on synthetic fixtures verify the filter logic, but the LIVE file
 * gets rewritten daily by the scraper and accumulates regressions if any
 * single filter slips. These invariants are cheap, run in CI, and catch the
 * 2026-05-23 newsletter class of bug before it ships:
 *   - Stale [AUTO-FLAGGED] entries leaking past the 30-day window
 *   - Absences whose endDate is in the past
 *   - Closure events contradicted by a later arrival (Chess case)
 *   - Per-actor departures on a show's closure date (Nicholas Christopher case)
 *
 * Plus a specific regression: chess-2025 must never re-introduce a
 * 'Nicholas Christopher departs' style event while JoJo's arrival run is
 * still in the data.
 *
 * timebomb-audit-exempt: the two 30-day-window tests read the LIVE data file
 * and measure age against real "today" by design — that's the whole point
 * (catch entries the daily auto-clear job failed to remove). Under
 * audit-time-bomb-tests.js's synthetic clock shift, TODAY jumps +Nd but the
 * file's addedDate/endDate values don't (the shift can't simulate the real
 * auto-clear job running for those N days), so every entry looks aged-out —
 * confirmed by reproducing: +30d flags ~260 unrelated entries, not one stale
 * literal. The real safety net is the daily unshifted test.yml run against
 * the actual current file; see scripts/audit-time-bomb-tests.js's own
 * "KNOWN LIMITATION" note for the same class of false positive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyPublicFilters,
  detectContradictions,
  detectCrossShowConflicts,
  isAutoFlaggedEvent,
  normalizeIdentifier,
} from '../../scripts/lib/cast-changes-filters.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '..', '..', 'data', 'cast-changes.json');
const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const TODAY = new Date();
const DAY_MS = 24 * 60 * 60 * 1000;

function eachUpcoming(fn) {
  for (const [showId, show] of Object.entries(data.shows || {})) {
    for (const event of show.upcoming || []) {
      fn(showId, event, show);
    }
  }
}

test('no [AUTO-FLAGGED] entries older than 30 days in upcoming', () => {
  const cutoff = new Date(TODAY.getTime() - 30 * DAY_MS);
  const offenders = [];
  eachUpcoming((showId, e) => {
    if (!isAutoFlaggedEvent(e)) return;
    if (!e.addedDate) return;
    const added = new Date(e.addedDate);
    if (added < cutoff) offenders.push(`${showId}: ${e.name} (${e.type}, added ${e.addedDate})`);
  });
  assert.deepEqual(offenders, [], `stale [AUTO-FLAGGED] entries found:\n${offenders.join('\n')}`);
});

test('no absence with endDate strictly before today', () => {
  const offenders = [];
  eachUpcoming((showId, e) => {
    if (e.type !== 'absence' || !e.endDate) return;
    const end = new Date(e.endDate);
    if (end < TODAY) offenders.push(`${showId}: ${e.name} absence ended ${e.endDate}`);
  });
  assert.deepEqual(offenders, [], `ended absences still in upcoming:\n${offenders.join('\n')}`);
});

test('no closure event contradicted by a later arrival in the same show', () => {
  const offenders = [];
  for (const [showId, show] of Object.entries(data.shows || {})) {
    const warnings = detectContradictions(show.upcoming || [], show.currentCast || []);
    for (const w of warnings.filter(w => w.kind === 'closure-vs-later-arrival')) {
      offenders.push(`${showId}: closure ${w.closureDate} but ${w.laterArrivals.map(a => `${a.name} arrives ${a.date}`).join(', ')}`);
    }
  }
  assert.deepEqual(offenders, [], `closure-vs-later-arrival contradictions:\n${offenders.join('\n')}`);
});

test('no per-actor departure on a closure date with closure note', () => {
  const offenders = [];
  for (const [showId, show] of Object.entries(data.shows || {})) {
    const closureDates = new Set(
      (show.upcoming || []).filter(e => e.type === 'closure').map(e => e.date),
    );
    if (closureDates.size === 0) continue;
    for (const e of show.upcoming || []) {
      if (e.type !== 'departure' || !e.date) continue;
      if (!closureDates.has(e.date)) continue;
      const note = (e.note || '').toLowerCase();
      if (note.includes('production closes') || note.includes('production ends')) {
        offenders.push(`${showId}: ${e.name} departure on closure date ${e.date} with closure note`);
      }
    }
  }
  assert.deepEqual(offenders, [], `closure-redundant departures:\n${offenders.join('\n')}`);
});

test('regression: closure event suppresses per-actor departures with closure note', () => {
  // Fixture-based, NOT dependent on live data. The 2026-05-23 newsletter bug
  // was: scraper emitted "production closes" as a per-actor departure for
  // Nicholas Christopher; UI rendered "Nicholas Christopher departs". This
  // test pins the fix unconditionally so it can't self-delete as live data
  // evolves.
  const fixture = [
    { type: 'closure', name: 'Chess', role: 'Production', date: '2026-06-14', addedDate: '2026-05-02' },
    { type: 'departure', name: 'Nicholas Christopher', role: 'Anatoly', date: '2026-06-14', addedDate: '2026-05-02', note: 'Production closes June 14, 2026 after second extension into Tony season' },
    { type: 'departure', name: 'Lea Michele', role: 'Florence', date: '2026-06-14', addedDate: '2026-05-02', note: 'Production ends' },
    { type: 'arrival', name: 'Joanna "JoJo" Levesque', role: 'Florence', date: '2026-06-23', endDate: '2026-09-13', addedDate: '2026-04-08' },
  ];
  const out = applyPublicFilters(fixture, new Date('2026-05-23'));
  const departures = out.filter(e => e.type === 'departure');
  assert.equal(
    departures.length,
    0,
    `regression: per-actor departures with closure note must be suppressed. Got: ${JSON.stringify(departures, null, 2)}`,
  );
});

test('chess-2025 live data: Nicholas Christopher MUST NOT appear as departure', () => {
  // Unconditional — does NOT short-circuit when JoJo's arrival is gone. The
  // bug class is "NC visible as departure" and must NEVER be true regardless
  // of other shape changes.
  const chess = data.shows && data.shows['chess-2025'];
  if (!chess) return; // genuinely OK if Chess data is removed entirely
  const filtered = applyPublicFilters(chess.upcoming || [], TODAY);
  const ncDepartures = filtered.filter(
    e => e.type === 'departure' && normalizeIdentifier(e.name) === normalizeIdentifier('Nicholas Christopher'),
  );
  assert.equal(
    ncDepartures.length,
    0,
    `regression: Nicholas Christopher visible as departure in chess-2025 — this is the 2026-05-23 newsletter bug class.\nDeparture: ${JSON.stringify(ncDepartures, null, 2)}`,
  );
});

test('no cross-show overlap conflicts (actor in two shows, no exit from either)', () => {
  const warnings = detectCrossShowConflicts(data.shows || {});
  assert.deepEqual(
    warnings,
    [],
    `cross-show overlap conflicts:\n${warnings.map(w => `  ${w.name} in ${w.showA} and ${w.showB}`).join('\n')}`,
  );
});

test('applyPublicFilters output across all shows is structurally sane', () => {
  for (const [showId, show] of Object.entries(data.shows || {})) {
    const out = applyPublicFilters(show.upcoming || [], TODAY);
    for (const e of out) {
      assert.ok(
        ['departure', 'arrival', 'absence', 'note', 'closure'].includes(e.type),
        `${showId}: unknown event type ${e.type}`,
      );
      assert.ok(typeof e.name === 'string' || e.type === 'note', `${showId}: event missing name`);
    }
  }
});
