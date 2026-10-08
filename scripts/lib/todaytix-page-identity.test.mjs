// Tests for TodayTix page identity (BRO-4851). The fixture mirrors the real
// __NEXT_DATA__ shape of todaytix.com/london/shows/45696-the-shitheads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractTodaytixPageIdentity, todaytixPageMatchesShow } = require('./todaytix-page-identity.js');

const page = (product, extra = {}) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: { pageProps: { product, ...extra } },
})}</script></html>`;
const SHITHEADS = { id: 45696, displayName: 'The Shitheads', venue: { name: 'Royal Court' }, startingDate: '2026-02-06', closingDate: '2026-03-14' };
const show = { id: 'the-shitheads-west-end-2026', title: 'The Shitheads', venue: 'Royal Court', previewsStartDate: '2026-02-13', closingDate: '2026-03-14' };

test('reads the page\'s own product', () => {
  assert.deepEqual(extractTodaytixPageIdentity(page(SHITHEADS)),
    { id: '45696', title: 'The Shitheads', venue: 'Royal Court', start: '2026-02-06', end: '2026-03-14' });
  assert.equal(extractTodaytixPageIdentity('<html>no data</html>'), null);
  assert.equal(extractTodaytixPageIdentity('<script id="__NEXT_DATA__">{bad json</script>'), null);
});

test('matches only on id + title + venue + overlapping dates', () => {
  const id = extractTodaytixPageIdentity(page(SHITHEADS));
  assert.equal(todaytixPageMatchesShow(id, show, 45696), true);
  assert.equal(todaytixPageMatchesShow(id, show, 11111), false); // asked for another id
  assert.equal(todaytixPageMatchesShow(id, { ...show, title: 'Shitheads II' }, 45696), false);
  assert.equal(todaytixPageMatchesShow(id, { ...show, venue: 'Young Vic' }, 45696), false);
  assert.equal(todaytixPageMatchesShow(id, { ...show, previewsStartDate: '2027-01-10', closingDate: '2027-02-01' }, 45696), false);
});

test('a recycled id whose page lists our show only in a related carousel does not match', () => {
  const recycled = page(
    { id: 45696, displayName: 'Radiolab Live', venue: { name: 'Southbank Centre' } },
    { relatedProducts: [SHITHEADS] },
  );
  assert.equal(todaytixPageMatchesShow(extractTodaytixPageIdentity(recycled), show, 45696), false);
});
