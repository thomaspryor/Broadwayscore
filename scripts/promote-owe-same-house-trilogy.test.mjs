import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { findSameHouseTokenMatch, findDuplicate } = createRequire(import.meta.url)('./promote-owe-venue-candidates.js');

const row = { id: 'the-inequalities-trilogy-off-west-end-2027', title: 'The Inequalities Trilogy', venue: 'Almeida Theatre', previewsStartDate: '2027-03-22', closingDate: '2027-05-22' };
const cand = { title: 'The Inequalities', venue: 'Almeida Theatre', discoverySource: 'venue-page:almeida-theatre', listingFirstDate: '2027-03-22', listingLastDate: '2027-05-22' };

test('BRO-5975: "The Inequalities" dedupes to the Trilogy row at the same house', () => {
  assert.ok(findSameHouseTokenMatch(cand, [row]));
  assert.ok(findDuplicate(cand, [row]));
});
test('one shared word with a non-format extra word is not a duplicate', () => {
  const other = { ...row, title: 'The Inequalities of Love' };
  assert.equal(findSameHouseTokenMatch(cand, [other]), null);
});
