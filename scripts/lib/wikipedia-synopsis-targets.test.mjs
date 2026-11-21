import test from 'node:test';
import assert from 'node:assert/strict';
import pkg from './wikipedia-synopsis-match.js';

const { selectSynopsisTargets } = pkg;
const missing = (id, extra = {}) => ({ id, title: id, category: 'broadway', ...extra });

test('active tour parents precede an unfillable backlog before the daily limit', () => {
  const backlog = Array.from({ length: 25 }, (_, i) => missing(`backlog-${i}`));
  const parent = missing('revival-1998', { status: 'closed' });
  const tour = missing('tour-2025', {
    category: 'tour', status: 'open', tourOf: parent.id,
    synopsis: 'The tour already has its own synopsis, but its parent still needs one.',
  });
  const shows = [...backlog, parent, tour];
  const before = structuredClone(shows);
  const backlogIds = new Set(backlog.map(s => s.id));

  // BRO-7437 changed what the 19 rows BEHIND the parent are, and deliberately
  // so: this list used to be sliced in source order, which meant rows 20..24
  // were never attempted on any day. The old `deepEqual(targets.slice(1),
  // backlog.slice(0, 19))` asserted exactly that starvation. The two claims
  // this test actually exists to make — the parent comes first, and nothing is
  // mutated — are unchanged and still checked on every day of the month.
  for (let day = 1; day <= 31; day++) {
    const now = new Date(Date.UTC(2026, 0, day));
    const targets = selectSynopsisTargets(shows, { limit: 20, now });
    assert.equal(targets.length, 20, `day ${day}`);
    assert.equal(targets[0], parent, `active tour parent must lead on day ${day}`);
    assert.ok(targets.slice(1).every(s => backlogIds.has(s.id)), `day ${day}: only backlog rows behind the parent`);
    assert.equal(new Set(targets.map(s => s.id)).size, 20, `day ${day}: no duplicates`);
  }
  assert.deepEqual(shows, before, 'selection must not mutate records or source order');

  // Strictly stronger than the old source-order assertion: the whole backlog
  // is now reached across a month, instead of rows 20..24 never being tried.
  const reached = new Set();
  for (let day = 1; day <= 31; day++) {
    const now = new Date(Date.UTC(2026, 0, day));
    for (const s of selectSynopsisTargets(shows, { limit: 20, now })) reached.add(s.id);
  }
  for (const s of backlog) {
    assert.ok(reached.has(s.id), `${s.id} is never attempted on any day of the month`);
  }
});

test('upcoming and preview tours also prioritize their parents, closed and standalone tours do not', () => {
  const parents = ['ordinary', 'closed-parent', 'upcoming-parent', 'preview-parent'].map(id => missing(id));
  const tours = [
    missing('closed-tour', { category: 'tour', status: 'closed', tourOf: 'closed-parent' }),
    missing('upcoming-tour', { category: 'tour', status: 'upcoming', tourOf: 'upcoming-parent' }),
    missing('preview-tour', { category: 'tour', status: 'previews', tourOf: 'preview-parent' }),
    missing('standalone', { category: 'tour', status: 'open' }),
  ];
  assert.deepEqual(selectSynopsisTargets([...parents, ...tours]).map(s => s.id),
    ['upcoming-parent', 'preview-parent', 'ordinary', 'closed-parent']);
});

test('filters apply before limiting; valid synopses and tours stay excluded', () => {
  const valid = missing('valid', { synopsis: 'A young governess joins a widowed captain and his children as they escape their homeland together.' });
  const broadway = missing('broadway');
  const london = missing('london', { category: 'west-end' });
  const legacy = missing('legacy', { category: undefined });
  const tour = missing('tour', { category: 'tour', status: 'open', tourOf: broadway.id });
  const shows = [valid, broadway, london, legacy, tour];
  assert.deepEqual(selectSynopsisTargets(shows, { category: 'west-end', limit: 1 }), [london]);
  assert.deepEqual(selectSynopsisTargets(shows, { category: 'broadway' }), [broadway, legacy]);
  assert.deepEqual(selectSynopsisTargets(shows, { onlyShow: legacy.id, limit: 1 }), [legacy]);
  assert.deepEqual(selectSynopsisTargets(shows, { onlyShow: valid.id }), []);
  assert.deepEqual(selectSynopsisTargets(shows, { onlyShow: tour.id }), []);
  assert.deepEqual(selectSynopsisTargets(shows, { limit: 0 }), [broadway, london, legacy]);
});
