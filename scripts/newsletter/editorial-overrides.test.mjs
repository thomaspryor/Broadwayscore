import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOverrides, activeOverrides, waivesFreshRunGate, displayTitleFor, movedNote } from './editorial-overrides.mjs';

const ROW = { weekStart: '2026-11-09', edition: 'west-end', showId: 'pride-x', displayTitle: 'Pride', waiveFreshRunGate: true };

test('a row applies only to its own week and edition', () => {
  assert.equal(activeOverrides([ROW], { weekStart: '2026-11-09', edition: 'west-end' }).length, 1);
  assert.equal(activeOverrides([ROW], { weekStart: '2026-11-16', edition: 'west-end' }).length, 0, 'next week');
  assert.equal(activeOverrides([ROW], { weekStart: '2026-11-09', edition: 'broadway' }).length, 0, 'other edition');
});

test('waiver and display title only for the named show', () => {
  const a = [ROW];
  assert.equal(waivesFreshRunGate(a, 'pride-x'), true);
  assert.equal(waivesFreshRunGate(a, 'other'), false);
  assert.equal(displayTitleFor(a, 'pride-x', 'Pride - Bridge Theatre'), 'Pride');
  assert.equal(displayTitleFor(a, 'other', 'Keep Me'), 'Keep Me');
  assert.equal(waivesFreshRunGate([{ ...ROW, waiveFreshRunGate: false }], 'pride-x'), false);
});

test('movedNote is built from priorRuns data and never invents a move', () => {
  const show = { venue: 'Bridge Theatre', priorRuns: [{ venue: 'Dorfman Theatre' }] };
  const mostlyOld = movedNote(show, { avg: 86.2, count: 25 }, '*Pride*', { fresh: 1, total: 25 });
  assert.match(mostlyOld, /^\*Pride\* has transferred, so its 86\/100 mostly reflects reviews of the earlier run/);
  assert.doesNotMatch(mostlyOld, /Dorfman|Bridge|critics/, 'no theatre names or critic counts');
  const mixed = movedNote(show, { avg: 80, count: 10 }, 'Pride', { fresh: 8, total: 10 });
  assert.match(mixed, /draws on reviews of both runs/);
  assert.equal(movedNote({ venue: 'Bridge Theatre' }, null, 'Pride'), null, 'no priorRuns');
  assert.equal(movedNote({ venue: 'Bridge Theatre', priorRuns: [{ venue: 'Bridge Theatre' }] }, null, 'Pride'), null, 'same venue');
  assert.equal(movedNote(show, null, 'Pride'), 'Pride has transferred.');
});

test('the committed overrides file is well formed and every row names its week, edition and approver', () => {
  const rows = loadOverrides();
  // Zero rows is valid: expired exceptions may be pruned once their week has passed.
  for (const r of rows) {
    assert.match(r.weekStart, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(new Date(r.weekStart + 'T12:00:00Z').getUTCDay(), 1, `${r.showId}: weekStart must be a Monday`);
    assert.ok(['broadway', 'west-end'].includes(r.edition), r.showId);
    assert.ok(r.showId && r.approvedBy, `row ${r.showId} needs approvedBy`);
  }
  assert.deepEqual(loadOverrides('/nonexistent/file.json'), [], 'missing file is empty, not a crash');
});

test('movedNote never claims "both runs" unless old and new reviews are both present', () => {
  const show = { venue: 'Bridge Theatre', priorRuns: [{ venue: 'Dorfman Theatre' }] };
  const agg = { avg: 80, count: 10 };
  assert.match(movedNote(show, agg, 'X', { fresh: 5, total: 10 }), /both runs/);
  assert.doesNotMatch(movedNote(show, agg, 'X', { fresh: null, total: 10 }), /both runs|earlier run/);
  assert.doesNotMatch(movedNote(show, agg, 'X', { fresh: 10, total: 10 }), /both runs|earlier run/);
  assert.match(movedNote(show, agg, 'X', { fresh: 1, total: 10 }), /mostly reflects reviews of the earlier run/);
});
