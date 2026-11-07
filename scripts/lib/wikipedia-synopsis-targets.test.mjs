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
  const targets = selectSynopsisTargets(shows, { limit: 20 });
  assert.equal(targets.length, 20);
  assert.equal(targets[0], parent);
  assert.deepEqual(targets.slice(1), backlog.slice(0, 19));
  assert.deepEqual(shows, before, 'selection must not mutate records or source order');
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
