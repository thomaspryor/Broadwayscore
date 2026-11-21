import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const urls = require('../../data/show-score-urls.json');
const { isProductionMismatch } = require('../../scripts/lib/show-score-url-map');

test('the 2013 Other Place does not reuse the later production page', () => {
  const id = 'the-other-place-2013';
  const url = 'https://www.show-score.com/broadway-shows/the-other-place';
  assert.notEqual(urls.shows[id], url);
  assert.ok(urls._productionMismatchAt[id]);
  assert.equal(isProductionMismatch(urls, id, url, Date.parse(urls._productionMismatchAt[id])), true);
});
