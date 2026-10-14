import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { urlNamesOtherShow } = createRequire(import.meta.url)('./url-names-other-show.js');

const own = { id: 'a-month-in-the-country-west-end-2026', title: 'A Month in the Country' };
const care = { id: 'care-west-end-2026', title: 'Care Home Stories' };
const zeldin = { id: 'zeldin-care-west-end-2026', title: 'Care' };

test('BRO-2746 fixture: Stage CARE URL filed under A Month in the Country is caught', () => {
  const care2 = { id: 'care-west-end-2026', title: 'Care Review Young Vic' };
  const hit = urlNamesOtherShow('https://www.thestage.co.uk/reviews/care-review-young-vic-london-alexander-zeldin', own, [care2]);
  assert.equal(hit.showId, 'care-west-end-2026');
});
test('URL naming its own show is clean', () => {
  assert.equal(urlNamesOtherShow('https://www.thestage.co.uk/reviews/a-month-in-the-country-review-donmar-warehouse', own, [care]), null);
});
test('one-word titles never fire (generic-word rubber stamp)', () => {
  assert.equal(urlNamesOtherShow('https://x.com/reviews/care-review-young-vic', own, [zeldin]), null);
});
test('own title present wins even if another show is also named', () => {
  const both = 'https://x.com/a-month-in-the-country-vs-care-home-stories';
  assert.equal(urlNamesOtherShow(both, own, [care]), null);
});
test('bad url / empty candidates are safe', () => {
  assert.equal(urlNamesOtherShow('not a url', own, [care]), null);
  assert.equal(urlNamesOtherShow('https://x.com/care-home-stories', own, []), null);
});
