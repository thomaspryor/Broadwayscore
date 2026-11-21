// validateBWWRoundupYear must not reject roundups for shows with a null
// openingDate. new Date(null) is 1970-01-01 (a VALID date), so the old NaN
// guard never fired and every roundup for a stuck-in-previews show was
// discarded as "~670 months after opening" (our-sinatra, 2026-09-27).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateBWWRoundupYear } = require('../../scripts/gather-reviews.js');

const ld = (iso) => `<script type="application/ld+json">{"datePublished":"${iso}"}</script>`;
const reviews = [{ outlet: 'BroadwayWorld' }, { outlet: 'The Knockturnal' }];

test('null openingDate keeps the roundup', () => {
  assert.equal(validateBWWRoundupYear(reviews, ld('2026-09-25T12:00:00Z'), null, 's', 'u').length, 2);
  assert.equal(validateBWWRoundupYear(reviews, ld('2026-09-25T12:00:00Z'), undefined, 's', 'u').length, 2);
  assert.equal(validateBWWRoundupYear(reviews, ld('2026-09-25T12:00:00Z'), '', 's', 'u').length, 2);
});

test('previewsStartDate anchor accepts a current roundup', () => {
  assert.equal(validateBWWRoundupYear(reviews, ld('2026-09-25T12:00:00Z'), '2026-09-11', 's', 'u').length, 2);
});

test('previewsStartDate anchor still rejects an older production roundup', () => {
  assert.equal(validateBWWRoundupYear(reviews, ld('2013-05-01T12:00:00Z'), '2026-09-11', 's', 'u').length, 0);
});

test('opened show with a current roundup is unchanged', () => {
  assert.equal(validateBWWRoundupYear(reviews, ld('2026-09-25T12:00:00Z'), '2026-09-24', 's', 'u').length, 2);
});

test('no dates at all: id year anchors, so an older production roundup is still rejected', () => {
  assert.equal(validateBWWRoundupYear(reviews, ld('2013-05-01T12:00:00Z'), null, 'hamlet-off-broadway-2026', 'u').length, 0);
  assert.equal(validateBWWRoundupYear(reviews, ld('2026-09-25T12:00:00Z'), null, 'hamlet-off-broadway-2026', 'u').length, 2);
});

test('productionYear: never 1970 for a null opening date', () => {
  const { productionYear } = require('../../scripts/gather-reviews.js');
  assert.equal(productionYear({ openingDate: '2026-09-15' }), 2026);
  assert.equal(productionYear({ openingDate: null, previewsStartDate: '2025-12-19' }), 2025);
  assert.equal(productionYear({ openingDate: null, id: 'el-quijote-off-broadway-2026' }), 2026);
  assert.equal(productionYear({ openingDate: null }), new Date().getFullYear());
});
