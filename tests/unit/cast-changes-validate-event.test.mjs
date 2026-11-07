import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

// Require the REAL validateEvent (now exported + guarded by require.main so the
// import doesn't launch a scrape). Tests the date normalization/validation that
// defends dedup against mixed precision (YYYY-MM vs YYYY-MM-DD) and impossible
// calendar dates that new Date() silently rolls forward.
const require = createRequire(import.meta.url);
const { validateEvent, cleanExpiredEvents } = require('../../scripts/scrape-cast-changes.js');

test('validateEvent accepts a full ISO date', () => {
  const e = { type: 'closure', name: 'X', date: '2026-06-28' };
  assert.equal(validateEvent(e), true);
  assert.equal(e.date, '2026-06-28');
});

test('validateEvent normalizes month-only YYYY-MM to the first of the month', () => {
  const e = { type: 'closure', name: 'X', date: '2026-06' };
  assert.equal(validateEvent(e), true);
  assert.equal(e.date, '2026-06-01', 'month-only coerced for precision-consistent dedup');
});

test('validateEvent rejects impossible calendar dates (would silently roll forward)', () => {
  assert.equal(validateEvent({ type: 'closure', name: 'X', date: '2026-02-31' }), false);
  assert.equal(validateEvent({ type: 'closure', name: 'X', date: '2026-13-01' }), false);
  assert.equal(validateEvent({ type: 'closure', name: 'X', date: '2026-00-10' }), false);
});

test('validateEvent rejects non-date garbage', () => {
  assert.equal(validateEvent({ type: 'arrival', name: 'X', date: 'June 2026' }), false);
});

test('validateEvent normalizes endDate too', () => {
  const e = { type: 'absence', name: 'X', date: '2026-06-01', endDate: '2026-07' };
  assert.equal(validateEvent(e), true);
  assert.equal(e.endDate, '2026-07-01');
});

test('validateEvent allows missing date', () => {
  assert.equal(validateEvent({ type: 'note', note: 'no date here' }), true);
});

test('validateEvent rejects unknown type', () => {
  assert.equal(validateEvent({ type: 'wat', name: 'X' }), false);
});

// Integration regression for the EBT / Mariska Hargitay P0 (2026-07-21):
// cleanExpiredEvents is the function that mutates currentCast from queued
// upcoming events. All dates below are fixed in the distant past so the
// test is valid regardless of when it runs (TODAY is real wall-clock time).
test('cleanExpiredEvents: replacement removes ALL role-variant duplicates, and a late-discovered fully-elapsed arrival is preserved in history', () => {
  const existing = {
    shows: {
      'every-brilliant-thing-2026': {
        currentCast: [
          { name: 'Daniel Radcliffe', role: 'Narrator/Protagonist', since: '2020-02-21' },
          { name: 'Daniel Radcliffe', role: 'Nameless protagonist', since: '2020-02-21' },
        ],
        upcoming: [
          // Both the departure AND the replacement's whole limited run were
          // discovered in the same late scrape, after both had already
          // elapsed — the exact Hargitay scenario.
          { type: 'departure', name: 'Daniel Radcliffe', role: 'Narrator', date: '2020-05-24', note: 'Final bow', sourceUrl: 'https://playbill.com/a', sourceType: 'playbill', addedDate: '2020-07-11' },
          { type: 'arrival', name: 'Mariska Hargitay', role: 'Narrator/Protagonist', date: '2020-05-26', endDate: '2020-07-05', note: 'Broadway debut', sourceUrl: 'https://playbill.com/b', sourceType: 'playbill', addedDate: '2020-07-11' },
          { type: 'departure', name: 'Mariska Hargitay', role: 'Narrator/Protagonist', date: '2020-07-05', note: 'Final bow', sourceUrl: 'https://playbill.com/c', sourceType: 'playbill', addedDate: '2020-07-11' },
          { type: 'arrival', name: 'Tracee Ellis Ross', role: 'Narrator/Protagonist', date: '2020-07-07', note: 'Broadway debut', sourceUrl: 'https://playbill.com/d', sourceType: 'playbill', addedDate: '2020-07-11' },
        ],
      },
    },
  };

  cleanExpiredEvents(existing);

  const show = existing.shows['every-brilliant-thing-2026'];

  // Radcliffe fully gone — both role-variant duplicates removed by one event.
  assert.equal(show.currentCast.some(c => c.name === 'Daniel Radcliffe'), false);
  // Hargitay's whole run had already ended before it was discovered — she is
  // NOT currently cast.
  assert.equal(show.currentCast.some(c => c.name === 'Mariska Hargitay'), false);
  // Ross is the only currently-cast member.
  assert.deepEqual(show.currentCast.map(c => c.name), ['Tracee Ellis Ross']);

  // Hargitay's stint is preserved in history, not silently discarded.
  const hargitayHistory = show.history.find(h => h.name === 'Mariska Hargitay');
  assert.ok(hargitayHistory, 'Hargitay stint must be recorded in history, not dropped');
  assert.equal(hargitayHistory.since, '2020-05-26');
  assert.equal(hargitayHistory.until, '2020-07-05');

  // Radcliffe's stint is also recorded in history (both duplicate entries
  // collapse to a single departure record via the first-removed entry).
  const radcliffeHistory = show.history.filter(h => h.name === 'Daniel Radcliffe');
  assert.equal(radcliffeHistory.length, 2, 'one history row per removed currentCast duplicate');
  assert.ok(radcliffeHistory.every(h => h.until === '2020-05-24'));
});
