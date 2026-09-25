// The named-non-review-URL rule must be enforced by the REBUILD, not only by
// explainExclusion(). Until 2026-09-25 it lived only in explainExclusion, so
// nytg /show/ listings and Stage /news/ items from SERP discovery stayed on
// the site (la-traviata-off-broadway-2026, the-infinite-wrench, kiss-of-the-
// spider-woman-1993, mamma-mia-2001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isNamedNonReviewUrlRecord, explainExclusion } = require('./review-guards.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const junk = {
  showId: 'mamma-mia-2001', outletId: 'thestage', criticName: 'Unknown', source: 'serp-discovery',
  url: 'https://www.thestage.co.uk/news/mamma-mia-to-return-to-broadway-after-10-years-away',
  assignedScore: 60, contentTier: 'stub',
};

test('predicate: unvetted SERP record on a curated non-review URL shape', () => {
  assert.equal(isNamedNonReviewUrlRecord(junk), true);
  assert.equal(isNamedNonReviewUrlRecord({ ...junk, url: 'https://www.newyorktheatreguide.com/show/25619-la-traviata' }), true);
  assert.equal(isNamedNonReviewUrlRecord({ ...junk, source: 'show-score-playwright' }), false, 'vetted source untouched');
  assert.equal(isNamedNonReviewUrlRecord({ ...junk, namedNonReviewUrlManualClear: true }), false, 'escape hatch');
  assert.equal(isNamedNonReviewUrlRecord({ ...junk, url: 'https://www.thestage.co.uk/reviews/mamma-mia-review' }), false, 'real review path');
  assert.equal(isNamedNonReviewUrlRecord(null), false);
});

test('explainExclusion and the predicate agree', () => {
  assert.equal(explainExclusion(junk, { id: 'mamma-mia-2001' }), 'namedNonReviewUrl');
});

test('rebuild-all-reviews.js enforces the predicate in its main loop', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'rebuild-all-reviews.js'), 'utf8');
  assert.match(src, /if \(isNamedNonReviewUrlRecord\(data\)\) \{\s*logExclusion\("skippedNamedNonReviewUrl"/);
  assert.ok(
    src.indexOf('isNamedNonReviewUrlRecord(data)') < src.indexOf('logExclusion("skippedNonReview"'),
    'must run before the later branches that write flags back to disk',
  );
});
