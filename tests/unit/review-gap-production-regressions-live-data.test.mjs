// LIVE-DATA-LANE: reads data/shows.json and data/reviews.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// Split from review-gap-production-regressions.test.mjs (BRO-7108): the one test that scans the real corpus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCensusProductionGuard } = require('../../scripts/lib/census-other-place');
const { platformOriginMirrorOf } = require('../../scripts/lib/outlet-canonicalize');

const king = {
  id: 'king-of-the-yees-off-broadway-2026', title: 'King of the Yees', category: 'off-broadway',
  venue: 'Signature Theatre Company/Alice Griffin Jewel Box Theater',
  previewsStartDate: '2026-10-06', openingDate: '2026-10-19',
};
const goodmanUrl = 'https://perform.ink/review-king-of-the-yees-at-goodman-theatre/';

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
