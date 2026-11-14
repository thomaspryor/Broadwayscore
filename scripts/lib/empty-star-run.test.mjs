// BRO-7080: a run of only empty stars ("☆☆☆☆") was read as a 0-star verdict
// and pinned published reviews to a 0-30 band (Beetlejuice West End, Theatre
// South East: "the wait was worth it. Hilarious, heartfelt" scored 21).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractScore } = require('./score-extractors.js');
const { detectBandFromReviewFile } = require('./star-reliability.js');

test('a run of empty stars is not a rating', () => {
  const body = 'Beetlejuice at the Prince Edward. ... the wait was worth it. Hilarious, heartfelt\n☆☆☆☆';
  for (const outlet of ['camdennewjournal', 'theatre-south-east', 'westminsterextra', 'reviewsgate']) {
    const r = extractScore('', body, outlet);
    assert.ok(!r || !/^0\//.test(String(r.originalScore)), `${outlet}: ${JSON.stringify(r)}`);
  }
});

test('real filled runs still extract', () => {
  assert.equal(extractScore('', 'Great night.\n★★★★☆', 'camdennewjournal').originalScore, '4/5 stars');
  assert.equal(extractScore('', 'Poor.\n★☆☆☆☆', 'camdennewjournal').originalScore, '1/5 stars');
});

test('a stored 0/N star rating pins no band; 1/5 and 2/5 still do', () => {
  for (const raw of ['0/5 stars', '0/4 stars', '0/3 stars']) {
    assert.equal(detectBandFromReviewFile({ originalScore: raw, outletId: 'theatre-south-east' }), null, raw);
  }
  assert.deepEqual(
    [detectBandFromReviewFile({ originalScore: '1/5 stars', outletId: 'camdennewjournal' }).band.ceiling,
     detectBandFromReviewFile({ originalScore: '2/5 stars', outletId: 'camdennewjournal' }).band.floor],
    [30, 31]);
});

test('an empty decorative run before the real rating does not hide it (BRO-7080 ship-check)', () => {
  const { extractGenericStarRating } = require('./score-extractors.js');
  const r1 = extractGenericStarRating('Rate this: ☆☆☆☆☆ ... Our verdict ★★★★☆ a triumph', '');
  assert.equal(r1 && r1.originalScore, '4/5 stars');
  const r2 = extractGenericStarRating('Rate this: ☆☆☆☆☆', '<p>★★★☆☆</p>');
  assert.equal(r2 && r2.originalScore, '3/5 stars');
});
