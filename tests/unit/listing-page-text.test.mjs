// BRO-5375: a listing, search or tag-archive page stored as a review is
// garbage at collection (content-quality) and found in the corpus by
// audit-listing-page-text.js. Invented placeholder text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isGarbageContent, detectListingPageText } = require('../../scripts/lib/content-quality.js');
const { listingSignals } = require('../../scripts/audit-listing-page-text.js');

const REVIEW = Array.from({ length: 12 }, (_, i) => `The cast sings the score with conviction and the staging is crisp, scene ${i}.`).join(' ');

test('listing headers at the start are garbage', () => {
  for (const h of ['You searched for the play that goes wrong - The BroadwayBlog', 'Search results for: hamilton', 'Posts Tagged ‘Cats’', 'Tag Archives: Cats', 'Category Archives - Reviews', 'Archives for the tag Cats']) {
    const r = isGarbageContent(`${h}\n\n${REVIEW}`);
    assert.equal(r.isGarbage, true, h);
    assert.match(r.reason, /^Listing\/search page/, h);
  }
});

test('the same words inside a review are not a listing page', () => {
  assert.equal(detectListingPageText(`${REVIEW} You searched for meaning and found farce.`).detected, false);
  assert.equal(detectListingPageText(`In the archives for the category of farce, this one ranks high. ${REVIEW}`).detected, false);
  assert.equal(isGarbageContent(REVIEW).isGarbage, false);
});

test('corpus signals: header, repeated read-more links, several dated posts', () => {
  assert.deepEqual(listingSignals(REVIEW), []);
  assert.ok(listingSignals(`You searched for x\n${REVIEW}`).some((s) => s.startsWith('header:')));
  const posts = ['May 1, 2024', 'May 8, 2024', 'June 2, 2024', 'June 9, 2024'].map((d, i) => `Post ${i} ${d} A short teaser. Read more`).join('\n');
  const s = listingSignals(posts);
  assert.ok(s.includes('readmore:4'), JSON.stringify(s));
  assert.ok(s.includes('dated:4'), JSON.stringify(s));
  assert.deepEqual(listingSignals(`${REVIEW} Opened May 1, 2024. Read more`), [], 'one dated link is a normal footer');
});
