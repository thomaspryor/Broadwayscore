// BRO-6321: bare one-word generic title "Baby" must not match celebrity-baby headlines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { passesGenericTitleIdentity } = require('./generic-title-guard');
const { titleMatchesShow } = require('./rss-discovery');
// The six real junk headlines/URLs from _pending/baby-off-west-end-2026.
const junk = [
  'https://www.nbcnewyork.com/entertainment/entertainment-news/hilary-swank-announces-pregnant-baby-no-3/6559878/',
  'https://www.nbcnewyork.com/entertainment/entertainment-news/tyler-cameron-fiancee-tate-madden-baby-dwts-dedication-night-routine/6561611/',
  'https://www.nbcnewyork.com/news/national-international/top-baby-names-trends-odyssey-yellowstone-heated-rivalry/6561184/',
  'https://www.nbcnewyork.com/entertainment/entertainment-news/alex-cooper-welcomes-baby-boy-husband-matt-kaplan/6561122/',
  'Kaley Cuoco and Tom Pelphrey welcome 2nd baby',
  'Hilary Swank announces pregnancy, baby No. 3',
];
test('Baby: celebrity-baby headlines/URLs fail identity', () => {
  for (const j of junk) { assert.equal(passesGenericTitleIdentity(j, 'Baby'), false, j); assert.equal(titleMatchesShow(j, 'Baby'), false, j); }
});
test('Baby: real review headlines still pass', () => {
  for (const h of ['Review: Baby at the Hampstead Theatre', "Baby review - a tender musical revival", 'Baby: the musical returns']) {
    assert.equal(passesGenericTitleIdentity(h, 'Baby'), true, h);
  }
});
test('non-generic one-word titles untouched', () => {
  assert.equal(passesGenericTitleIdentity('Wicked cast news', 'Wicked'), true);
});
test('Baby: bare headline and review-adjacent forms pass', () => {
  for (const h of ['Baby', "Maltby and Shire's Baby review – tender revival", 'https://x.com/stage/maltby-shire-baby-musical-review', 'https://x.com/the-musical-baby-review']) {
    assert.equal(passesGenericTitleIdentity(h, 'Baby'), true, h);
  }
});
