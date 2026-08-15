import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSiblingIndex, classifyMarketRouting, collectSameTitleSignals } = require('./market-routing.js');

// Regional pre-Broadway run + its Broadway transfer, same normalized title,
// opened in the SAME calendar year (2025) — the exact configuration found
// 2026-08-14 collecting Broadway reviews onto the regional show page.
const regional = {
  id: 'two-strangers-carry-a-cake-across-new-york-at-art-regional-2025',
  title: 'Two Strangers (Carry A Cake Across New York)',
  category: 'regional',
  venue: "A.R.T.'s Loeb Drama Center, Cambridge, MA",
  openingDate: '2025-06-02',
  closingDate: null,
  status: 'closed',
  transferredTo: 'two-strangers-bway-2025',
};
const bway = {
  id: 'two-strangers-bway-2025',
  title: 'Two Strangers (Carry a Cake Across New York)',
  category: 'broadway',
  venue: 'Longacre Theatre',
  openingDate: '2025-11-20',
  closingDate: null,
  status: 'open',
  transferOf: regional.id,
};
const shows = [regional, bway];

test('Tier-1 date reroute: a Broadway-opening-night review filed under the regional sibling reroutes to Broadway', () => {
  const siblingIndex = buildSiblingIndex(shows);
  const decision = classifyMarketRouting({
    showId: regional.id,
    url: 'https://www.nytimes.com/2025/11/20/theater/two-strangers-carry-cake-review.html',
    outletId: 'nytimes',
    publishDate: 'November 20, 2025',
    category: 'regional',
    siblingIndex,
  });
  assert.equal(decision.action, 'reroute');
  assert.equal(decision.targetShowId, bway.id);
});

test('Tier-1 date reroute: a post-opening Broadway-run review filed under Broadway stays there (no reverse false positive)', () => {
  const siblingIndex = buildSiblingIndex(shows);
  const decision = classifyMarketRouting({
    showId: bway.id,
    url: 'https://www.thewrap.com/two-strangers-broadway-review/',
    outletId: 'thewrap',
    publishDate: 'November 20, 2025',
    category: 'broadway',
    siblingIndex,
  });
  assert.equal(decision.action, 'accept');
});

test('venue-substring signal: generic venue word ("center") does not false-match an outlet whose own name/domain contains it', () => {
  // "A.R.T.'s Loeb Drama Center" previously contributed the bare token
  // "center" (>=5 chars, not in the whole-venue GENERIC_VENUE_SLUGS set),
  // which substring-matched "thefrontrowcenter.com" — the OUTLET's own name
  // ("Front Row Center"), not a mention of the venue. That false signal fed
  // the same-title-sibling cascade and moved a confirmed Broadway review
  // (venue field: "Longacre Theatre") onto the regional show. Fixed by
  // filtering venue tokens through production-match-gate.js's VENUE_STOPWORDS
  // (center/centre/hall/house/studio/arts/stage/...) in addition to the
  // whole-slug GENERIC_VENUE_SLUGS check.
  const signals = collectSameTitleSignals(
    { openingDate: new Date(regional.openingDate), closingDate: null, venue: regional.venue },
    { url: 'https://thefrontrowcenter.com/2025/12/two-strangers-carry-a-cake-across-new-york/', publishDate: '2025-12-06' },
  );
  assert.ok(!signals.includes('venue-substring'), `expected no venue-substring false match, got: ${signals.join(', ')}`);
});

test('venue-substring signal: a real venue mention still matches (regression guard on the fix above)', () => {
  const signals = collectSameTitleSignals(
    { openingDate: new Date(bway.openingDate), closingDate: null, venue: bway.venue },
    { url: 'https://www.playbill.com/article/two-strangers-longacre-theatre-review', publishDate: '2025-11-20' },
  );
  assert.ok(signals.includes('venue-substring'), `expected venue-substring to fire for a genuine "longacre" mention, got: ${signals.join(', ')}`);
});
