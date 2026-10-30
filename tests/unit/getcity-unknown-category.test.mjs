import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const unregister = require('tsx/cjs/api').register();
after(unregister);
const { getCity, getShowById, getRelatedShowsAlgorithmic } = require('../../src/lib/data-core');

test('missing and unrecognized categories share the NYC recommendation bucket', () => {
  for (const category of [undefined, null, '', 'off-off-broadway', 'future-category']) {
    assert.equal(getCity({ category }), 'nyc', String(category));
  }
});

test('existing markets retain their recommendation buckets', () => {
  for (const [category, city] of [
    ['broadway', 'nyc'], ['off-broadway', 'nyc'],
    ['west-end', 'london'], ['off-west-end', 'london'],
    ['regional', 'regional'], ['tour', 'tour'],
  ]) {
    assert.equal(getCity({ category }), city, category);
  }
  assert.equal(getCity({ category: 'regional', venue: 'Royal Shakespeare Theatre' }), 'london');
  assert.equal(getCity({ category: 'regional', venue: 'Goodman Theatre' }), 'regional');
  assert.equal(getCity({ category: 'regional', localOnly: true }), 'local');
  assert.equal(getCity({ category: 'regional', discoverySource: 'theatreinchicago' }), 'local');
  assert.equal(getCity({ category: 'unknown', localOnly: true }), 'local');
});

test('an unenumerated NYC category keeps real shows connected to related shows', () => {
  for (const id of ['hamilton-2015', 'wicked-2003', 'the-lion-king-1997']) {
    const show = getShowById(id);
    assert.ok(show, `${id} is in the real show data`);
    const expected = getRelatedShowsAlgorithmic(show).map(s => s.id);
    assert.ok(expected.length > 0, `${id} has recommendations`);
    assert.deepEqual(
      getRelatedShowsAlgorithmic({ ...show, category: 'off-off-broadway' }).map(s => s.id),
      expected,
      id,
    );
  }
});
