import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decidePrematurePreviews } = require('./premature-previews.js');

const today = '2026-09-29';
const show = (over) => ({ status: 'previews', previewsStartDate: null, openingDate: null, openingDateSource: null, ...over });

test('KEVIN!!!!!: venue-page run start in December, status previews in September → upcoming', () => {
  const d = decidePrematurePreviews(show({ openingDate: '2026-12-05', openingDateSource: 'venue-page:soho-playhouse' }), today);
  assert.equal(d.to, 'upcoming');
});
test('PHYL: ShowScore "Opens Oct 03" with no previews date → upcoming until it arrives', () => {
  assert.equal(decidePrematurePreviews(show({ openingDate: '2026-10-03', openingDateSource: 'showscore' }), today).to, 'upcoming');
  assert.equal(decidePrematurePreviews(show({ openingDate: '2026-09-29', openingDateSource: 'showscore' }), today), null);
});
test('future previewsStartDate → upcoming, whatever the opening source', () => {
  assert.equal(decidePrematurePreviews(show({ previewsStartDate: '2026-10-06', openingDate: '2026-10-20', openingDateSource: 'playbill' }), today).to, 'upcoming');
});
test('previews already begun → left alone', () => {
  assert.equal(decidePrematurePreviews(show({ previewsStartDate: '2026-09-20', openingDate: '2026-10-20', openingDateSource: 'venue-page:x' }), today), null);
  assert.equal(decidePrematurePreviews(show({ previewsStartDate: today, openingDate: '2026-10-20' }), today), null);
});
test('no previews date and a confirmed press-night source → left alone (show may be mid-previews)', () => {
  assert.equal(decidePrematurePreviews(show({ openingDate: '2026-10-20', openingDateSource: 'playbill' }), today), null);
  assert.equal(decidePrematurePreviews(show({ openingDate: '2026-10-20', openingDateSource: null }), today), null);
});
test('non-previews statuses and garbage dates → no decision', () => {
  for (const status of ['open', 'upcoming', 'announced', 'closed']) {
    assert.equal(decidePrematurePreviews(show({ status, openingDate: '2026-12-05', openingDateSource: 'venue-page:x' }), today), null);
  }
  assert.equal(decidePrematurePreviews(show({ openingDate: 'TBA', openingDateSource: 'venue-page:x' }), today), null);
  assert.equal(decidePrematurePreviews(null, today), null);
});
