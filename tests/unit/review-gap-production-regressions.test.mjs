// BRO-6896 / BRO-7086: production identity, not the listing-page URL guard.
// TESTS-VS-DERIVED-DATA-EXEMPT: corpus assertion checks live-URL preservation, not pinned dates, scores or counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCensusProductionGuard } = require('../../scripts/lib/census-other-place');
const { platformOriginMirrorOf } = require('../../scripts/lib/outlet-canonicalize');

// Metadata recovered from the cases referenced by BRO-7086's November 7 comment.
// No publication date is known for the perform.ink candidate; its venue guard
// must work without inventing one from the URL.
const king = {
  id: 'king-of-the-yees-off-broadway-2026', title: 'King of the Yees', category: 'off-broadway',
  venue: 'Signature Theatre Company/Alice Griffin Jewel Box Theater',
  previewsStartDate: '2026-10-06', openingDate: '2026-10-19',
};
const goodmanUrl = 'https://perform.ink/review-king-of-the-yees-at-goodman-theatre/';

test('BRO-6896: the real census production guard rejects the Goodman staging', () => {
  const guard = createCensusProductionGuard({ reviews: [], normalizeUrl: u => u });
  assert.equal(guard(goodmanUrl, '', king, null)?.signal, 'place-in-slug');
});

const datedCases = [
  {
    // la-boheme-off-broadway-2025/wsj--by-tim-page.json, stored publishDate.
    url: 'https://www.wsj.com/opinion/a-transportive-boheme-returns-to-the-met-01f33e89',
    publishDate: '2025-10-13',
    show: {
      id: 'la-boheme-off-broadway-2026', title: 'La Bohème', category: 'off-broadway',
      venue: 'Metropolitan Opera House', previewsStartDate: '2026-09-25', openingDate: '2026-09-25',
    },
  },
  {
    // alice-in-wonderland-off-broadway-2026/all-that-dazzles-uk--all-that-dazzles.json.
    url: 'https://www.allthatdazzles.co.uk/post/review-alice-in-wonderland-riverside-studios',
    publishDate: '2026-07-22',
    show: {
      id: 'alice-in-wonderland-off-broadway-2026', title: 'Alice in Wonderland', category: 'off-broadway',
      venue: 'The Players Theatre', previewsStartDate: '2026-09-26', openingDate: '2026-09-26',
    },
  },
];

for (const { url, publishDate, show } of datedCases) {
  test(`BRO-6896 dated cousin: ${show.id} uses the stored publication date`, () => {
    const guard = createCensusProductionGuard({
      reviews: [{ showId: 'earlier-production', url, publishDate }], normalizeUrl: u => u,
    });
    assert.equal(guard(url, '', show, null)?.signal, 'date-before-production');
    const undated = createCensusProductionGuard({ reviews: [{ showId: 'earlier-production', url }], normalizeUrl: u => u });
    assert.equal(undated(url, '', show, null), null, 'a URL alone does not supply a publication date');
    assert.equal(guard(url, '', {
      ...show, priorRuns: [{ openingDate: publishDate, closingDate: publishDate, inheritReviews: true }],
    }, null), null, 'an explicitly inherited run keeps its coverage');
  });
}

test('held dates are lazy, cached, and fail open on missing dates or conflicting evidence', () => {
  const { url, publishDate, show } = datedCases[1];
  let loads = 0;
  const guard = createCensusProductionGuard({ reviews: [], normalizeUrl: u => u,
    loadShowFiles: () => { loads++; return [{ url, publishDate, wrongProduction: true }]; },
  });
  assert.equal(loads, 0);
  assert.equal(guard(url, '', show, null)?.signal, 'date-before-production');
  assert.equal(guard(url, '', show, null)?.signal, 'date-before-production');
  assert.equal(loads, 1);
  const overrides = ['allowEarlyDate', 'humanReviewedEarlyPublish', 'allowCrossMarket', 'wrongProductionManualClear', 'wrongProductionOverride'];
  for (const witness of [{ url }, { url, publishDate: show.openingDate },
    ...overrides.map(flag => ({ url, publishDate, [flag]: true })),
    { url, publishDate, humanReviewedWrongProduction: false }]) {
    const conflicted = createCensusProductionGuard({
      reviews: [{ showId: 'earlier-production', url, publishDate }], normalizeUrl: u => u,
      loadShowFiles: () => [witness],
    });
    assert.equal(conflicted(url, '', show, null), null);
  }
  const unreadable = createCensusProductionGuard({ reviews: [], normalizeUrl: u => u,
    loadShowFiles: () => { throw new Error('unreadable'); },
  });
  assert.equal(unreadable(url, '', show, null), null);
});

test('inherited previews before the declared opening stay eligible; non-inherited runs do not', () => {
  const { url, publishDate, show } = datedCases[0];
  const guard = createCensusProductionGuard({ reviews: [{ showId: 'earlier-run', url, publishDate }], normalizeUrl: u => u });
  for (const run of [{ openingDate: '2025-10-21' }, { openingDate: '2025-10-21', inheritReviews: true }, 'earlier-run']) {
    assert.equal(guard(url, '', { ...show, priorRuns: [run] }, null), null);
  }
  assert.equal(guard(url, '', { ...show, priorRuns: [{ openingDate: '2025-10-21', inheritReviews: false }] }, null)?.signal,
    'date-before-production');
});

test('live URLs and alternate URLs stay admitted only for the show that holds them', () => {
  const { url, publishDate, show } = datedCases[0];
  const guard = createCensusProductionGuard({
    reviews: [{ showId: show.id, url, alternateUrls: [goodmanUrl], publishDate }], normalizeUrl: u => u,
    loadShowFiles: () => { throw new Error('live reviews must not load files'); },
  });
  assert.equal(guard(url, '', show, null), null);
  assert.equal(guard(goodmanUrl, '', show, null), null);
  assert.equal(guard(goodmanUrl, '', king, null)?.signal, 'place-in-slug');
});

test('BRO-6896: the remaining Squarespace citation is a mirror only when its held twin exists', () => {
  const candidateUrl = 'https://synthesizer-accordion-e2w3.squarespace.com/king-of-the-yees-at-signature-theatre';
  const heldUrl = 'https://www.the100wordreview.com/king-of-the-yees-at-signature-theatre';
  const result = platformOriginMirrorOf({ candidateUrl, heldUrls: [heldUrl] });
  assert.equal(result.dup, true);
  assert.equal(result.matchedUrl, heldUrl);
  assert.equal(platformOriginMirrorOf({ candidateUrl, heldUrls: [] }).dup, false);
});

test('BRO-6896: the census production guard refuses zero live review URLs', (t) => {
  const reviewsPath = new URL('../../data/reviews.json', import.meta.url);
  const showsPath = new URL('../../data/shows.json', import.meta.url);
  if (!fs.existsSync(reviewsPath) || !fs.existsSync(showsPath)) {
    t.skip('private reviews.json or shows.json is not attached');
    return;
  }
  // This caller is already in test.yml on.push.paths. Use its normalizer for
  // the corpus scan, then exercise the actual caller on the Goodman candidate.
  const { acceptSerpCensusResult, gapUrlIdentity } = require('../../scripts/audit-show-review-gap');
  const rawReviews = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
  const rawShows = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const reviews = Array.isArray(rawReviews) ? rawReviews : rawReviews.reviews;
  const shows = Array.isArray(rawShows) ? rawShows : rawShows.shows;
  const byId = new Map(shows.map(show => [show.id, show]));
  assert.ok(reviews.length > 0, 'the corpus check must not pass on an empty file');
  const guard = createCensusProductionGuard({ reviews, normalizeUrl: gapUrlIdentity });
  const refused = [];
  let checked = 0;
  for (const row of reviews) {
    const show = byId.get(row.showId);
    if (!show) continue;
    for (const url of new Set([row.url, ...(row.alternateUrls || [])].filter(Boolean))) {
      if (guard(url, '', show, null)) refused.push({ showId: show.id, url });
      checked++;
    }
  }
  assert.ok(checked > 0, 'at least one real URL must be exercised');
  t.diagnostic(`${reviews.length} review rows; ${checked} primary/alternate URLs checked; ${refused.length} newly refused`);
  assert.deepEqual(refused, []);
  assert.equal(acceptSerpCensusResult({ url: goodmanUrl, title: 'King of the Yees review' }, {
    show: king, showInfo: {}, priorVetted: true,
  }), null, 'the live exemption must not admit the uncollected Goodman review');
});
