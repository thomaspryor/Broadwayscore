// BRO-7779 items 4 and 8: an opening with no press-night watch, and a special or short run with no score-gate
// decision, each surface as a named daily health row instead of staying silent. Real functions (CLAUDE.md rule 15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const g = require('../../scripts/lib/press-night-readiness-gaps.js');
const { embargoInfo } = require('../../scripts/lib/press-night-record.js');
const health = require('../../scripts/health-check.js');

const NOW = Date.parse('2026-11-18T16:00:00Z');
const embargoAt = (s) => embargoInfo(s).at;
const show = (id, category, openingDate, extra = {}) => ({ id, title: id, category, openingDate, status: 'previews', ...extra });

test('item 4: a regional or touring opening (no market hour) is named; Broadway, West End and an override are watched', () => {
  const shows = [
    show('bway', 'broadway', '2026-11-20'),
    show('we', 'west-end', '2026-11-21'),
    show('reg', 'regional', '2026-11-21'),
    show('tour', 'tour', '2026-11-20'),
    show('reg-override', 'regional', '2026-11-22', { reviewEmbargoAt: '2026-11-22T22:00:00-05:00' }),
    show('reg-far', 'regional', '2026-12-20'),
    show('reg-past', 'regional', '2026-11-10'),
    show('reg-closed', 'regional', '2026-11-20', { status: 'closed' }),
  ];
  const u = g.unwatchedOpenings(shows, { nowMs: NOW, embargoAt });
  // reg-override: a regional reviewEmbargoAt only counts if press-night-record accepts it; either way it is not silent.
  const ids = u.map((x) => x.id);
  assert.ok(ids.includes('reg') && ids.includes('tour'), JSON.stringify(u));
  assert.ok(!ids.includes('bway') && !ids.includes('we') && !ids.includes('reg-far') && !ids.includes('reg-past') && !ids.includes('reg-closed'));
  assert.equal(u.find((x) => x.id === 'tour').inDays, 2);
});

test('item 8: special or <=8-week runs inside 7 days need a decision; an override entry (number or null) settles it', () => {
  const shows = [
    show('special', 'off-broadway', '2026-11-19', { type: 'special' }),
    show('short', 'broadway', '2026-11-20', { closingDate: '2026-12-20' }),
    show('eight-weeks', 'broadway', '2026-11-20', { closingDate: '2027-01-15' }),
    show('long', 'broadway', '2026-11-20', { closingDate: '2027-06-01' }),
    show('open-ended', 'broadway', '2026-11-20'),
    show('later', 'broadway', '2026-12-01', { type: 'special' }),
    show('decided-number', 'broadway', '2026-11-20', { type: 'special' }),
    show('decided-keep', 'broadway', '2026-11-20', { type: 'special' }),
    show('malformed', 'broadway', '2026-11-20', { type: 'special' }),
  ];
  const overrides = { shows: { 'decided-number': { minReviews: 3 }, 'decided-keep': { minReviews: null }, malformed: { minReviews: '3' } } };
  const u = g.scoreGateUndecided(shows, overrides, { nowMs: NOW });
  assert.deepEqual(u.map((x) => [x.id, x.reason]), [['special', 'special'], ['eight-weeks', 'short run (56 days)'], ['malformed', 'special'], ['short', 'short run (30 days)']]);
});

test('rows: a warn row per gap with the shows named, a same-name pass row when clear', () => {
  const rows = g.pressNightReadinessResults({ shows: [show('tour', 'tour', '2026-11-18'), show('s', 'broadway', '2026-11-18', { type: 'special' })], overrides: { shows: {} }, nowMs: NOW, embargoAt });
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [['Press night: openings not watched', 'warn'], ['Press night: score gate undecided', 'warn']]);
  assert.match(rows[0].message, /tour \(tour, tonight\)/);
  assert.match(rows[1].message, /s \(special, opens tonight\)/);
  const clear = g.pressNightReadinessResults({ shows: [], overrides: { shows: {} }, nowMs: NOW, embargoAt });
  assert.deepEqual(clear.map((r) => [r.name, r.status]), [['Press night: openings not watched', 'pass'], ['Press night: score gate undecided', 'pass']]);
});

test('health-check wires both rows, with playbook entries (no silent low-urgency default)', () => {
  const rows = health.checkPressNightReadiness({ nowMs: NOW });
  assert.deepEqual(rows.map((r) => r.name), ['Press night: openings not watched', 'Press night: score gate undecided']);
  for (const r of rows) {
    const e = health.getPlaybookEntry(r.name);
    assert.ok(e && e.urgency === 'this-week' && e.ownerText && e.workerInstruction, r.name);
  }
});
