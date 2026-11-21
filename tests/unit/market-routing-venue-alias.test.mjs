// BRO-7077 (BRO-5386 follow-up): a slug that names the RSC by its initials
// ("as-you-like-it-rsc-review") belongs to the Royal Shakespeare Theatre run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildSiblingIndex, classifyMarketRouting } = require('../../scripts/lib/market-routing.js');

const shows = [
  { id: 'aylit-globe-2026', title: 'As You Like It', category: 'off-west-end', venue: "Shakespeare's Globe", openingDate: '2026-08-21', closingDate: '2026-10-25' },
  { id: 'aylit-rsc-2026', title: 'As You Like It', category: 'regional', venue: 'Royal Shakespeare Theatre, Stratford-upon-Avon', openingDate: '2026-10-06', closingDate: '2026-11-07' },
];
const idx = buildSiblingIndex(shows);
const route = (showId, url, publishDate) => classifyMarketRouting({ showId, url, publishDate, category: shows.find(s => s.id === showId).category, siblingIndex: idx });

test('"-rsc-" slug on the Globe show reroutes to the RSC run', () => {
  const d = route('aylit-globe-2026', 'https://www.thestage.co.uk/reviews/as-you-like-it-rsc-review', '2026-10-07');
  assert.equal(d.action, 'reroute');
  assert.equal(d.targetShowId, 'aylit-rsc-2026');
});
test('"-rsc-" slug on the RSC show itself stays', () => {
  assert.equal(route('aylit-rsc-2026', 'https://www.thestage.co.uk/reviews/as-you-like-it-rsc-review', '2026-10-07').action, 'accept');
});
test('"rsc" inside a longer word does not count', () => {
  assert.equal(route('aylit-globe-2026', 'https://example.com/as-you-like-it-rscene-review', '2026-10-07').action, 'accept');
});
test('Globe slug with no RSC mention stays', () => {
  assert.equal(route('aylit-globe-2026', 'https://example.com/as-you-like-it-globe-review', '2026-09-01').action, 'accept');
});

test('undated "-rsc-" slug on an RSC transfer at the Barbican stays put', () => {
  const sh = [
    { id: 'hamlet-barbican-2026', title: 'Hamlet', category: 'off-west-end', venue: 'Barbican Theatre', openingDate: '2026-12-01', closingDate: '2027-01-20' },
    { id: 'hamlet-rsc-2026', title: 'Hamlet', category: 'regional', venue: 'Royal Shakespeare Theatre, Stratford-upon-Avon', openingDate: '2026-09-01', closingDate: '2026-10-30' },
  ];
  const ix = buildSiblingIndex(sh);
  const d = classifyMarketRouting({ showId: 'hamlet-barbican-2026', url: 'https://example.com/hamlet-rsc-review', publishDate: null, category: 'off-west-end', siblingIndex: ix });
  assert.equal(d.action, 'accept');
});
