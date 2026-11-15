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
  assert.match(mostlyOld, /^\*Pride\* has moved from the Dorfman Theatre to the Bridge Theatre\./);
  assert.match(mostlyOld, /86\/100 from 25 critics comes mostly from reviews of the earlier run/);
  const mixed = movedNote(show, { avg: 80, count: 10 }, 'Pride', { fresh: 8, total: 10 });
  assert.match(mixed, /draws on reviews of both runs/);
  assert.equal(movedNote({ venue: 'Bridge Theatre' }, null, 'Pride'), null, 'no priorRuns');
  assert.equal(movedNote({ venue: 'Bridge Theatre', priorRuns: [{ venue: 'Bridge Theatre' }] }, null, 'Pride'), null, 'same venue');
  assert.equal(movedNote(show, null, 'Pride'), 'Pride has moved from the Dorfman Theatre to the Bridge Theatre.');
});

test('the committed overrides file is well formed and every row names its week, edition and approver', () => {
  const rows = loadOverrides();
  assert.ok(rows.length >= 1);
  for (const r of rows) {
    assert.match(r.weekStart, /^\d{4}-\d{2}-\d{2}$/);
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
  assert.match(movedNote(show, agg, 'X', { fresh: 1, total: 10 }), /mostly from reviews of the earlier run/);
});
