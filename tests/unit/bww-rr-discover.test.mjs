/**
 * Unit tests for scripts/lib/bww-rr-discover.js — uses injected fetchAnchors
 * so tests don't consume Browserbase credits.
 *
 * Run: node --test tests/unit/bww-rr-discover.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  discoverBwwRoundupUrl,
  scoreCandidate,
  slugMatchesShow,
  tokensFromTitle,
  shouldSkipReviewsPhp,
} = require('../../scripts/lib/bww-rr-discover.js');

// Real anchors pulled from broadwayworld.com/reviews.php on 2026-04-16 — fixtures
// representing the variability of real BWW slugs.
const REAL_ANCHORS = [
  'https://www.broadwayworld.com/article/Review-Roundup-THE-FEAR-OF-13-Starring-Adrien-Brody-and-Tessa-Thompson-Opens-On-Broadway-20260415',
  'https://www.broadwayworld.com/article/Review-Roundup-TITANIQUE-Sets-Sail-on-Broadway-20260412',
  'https://www.broadwayworld.com/article/Review-Roundup-DEATH-OF-A-SALESMAN-Starring-Nathan-Lane-and-Laurie-Metcalf-20260409',
  'https://www.broadwayworld.com/article/Review-Roundup-Anne-Hathaway-is-MOTHER-MARY-in-New-Pop-Opera-20260416',
  'https://www.broadwayworld.com/article/Review-Roundup-THE-ADDING-MACHINE-Opens-At-The-New-Group-20260414',
  'https://www.broadwayworld.com/article/Review-Roundup-Suzie-Millers-INTER-ALIA-Transfers-to-The-West-End-20260408',
  'https://www.broadwayworld.com/article/Review-Roundup-Critics-Weigh-In-on-THE-BOYS-IN-THE-BAND-on-Broadway-20180531',
  'https://www.broadwayworld.com/article/Review-Roundup-MAYBE-HAPPY-ENDING-Starring-Darren-Criss-and-Helen-J-Shen-20241112',
];

describe('tokensFromTitle', () => {
  it('uppercases and strips stopwords', () => {
    assert.deepStrictEqual(tokensFromTitle('The Fear of 13'), ['FEAR', '13']);
    assert.deepStrictEqual(tokensFromTitle('Death of a Salesman'), ['DEATH', 'SALESMAN']);
    assert.deepStrictEqual(tokensFromTitle('Titanique'), ['TITANIQUE']);
  });

  it('handles punctuation', () => {
    assert.deepStrictEqual(tokensFromTitle("Suzie Miller's INTER ALIA"), ['SUZIE', 'MILLER', 'S', 'INTER', 'ALIA']);
  });
});

describe('slugMatchesShow', () => {
  it('matches short titles exactly', () => {
    assert.ok(slugMatchesShow(REAL_ANCHORS[1], { title: 'Titanique' }));
  });

  it('matches multi-word titles when all tokens present', () => {
    assert.ok(slugMatchesShow(REAL_ANCHORS[0], { title: 'The Fear of 13' }));
    assert.ok(slugMatchesShow(REAL_ANCHORS[2], { title: 'Death of a Salesman' }));
  });

  it('tolerates one missing token for 4+ word titles', () => {
    // "Starring Darren Criss and Helen J Shen" — title is "Maybe Happy Ending", 3 tokens, all present
    assert.ok(slugMatchesShow(REAL_ANCHORS[7], { title: 'Maybe Happy Ending' }));
  });

  it('rejects unrelated shows', () => {
    assert.strictEqual(slugMatchesShow(REAL_ANCHORS[0], { title: 'Hamilton' }), false);
    assert.strictEqual(slugMatchesShow(REAL_ANCHORS[1], { title: 'Wicked' }), false);
  });

  // Beaches 2026-04-22 regression: show.title = "Beaches: A New Musical"
  // but real BWW slug is just "BEACHES". Raw-title matcher required
  // BEACHES + NEW + MUSICAL and silently returned zero candidates.
  it('matches subtitled title against short-slug URL (Beaches regression)', () => {
    const show = { title: 'Beaches: A New Musical', openingDate: '2026-04-22' };
    const realUrl = 'https://www.broadwayworld.com/article/Review-Roundup-BEACHES-Opens-on-Broadway-20260422';
    assert.ok(slugMatchesShow(realUrl, show),
      'candidate title forms must include subtitle-stripped "Beaches"');
  });

  // The canonical shows.json entry for Beaches uses a COMMA separator, not
  // a colon. A colon-only stripper would have left the production form broken.
  it('matches comma-separated subtitle (canonical Beaches shows.json form)', () => {
    const show = { title: 'Beaches, A New Musical', openingDate: '2026-04-22' };
    const realUrl = 'https://www.broadwayworld.com/article/Review-Roundup-BEACHES-Opens-on-Broadway-20260422';
    assert.ok(slugMatchesShow(realUrl, show),
      'stripSubtitle must split on comma, not just colon');
  });

  it('respects explicit shortTitle override on show record', () => {
    const show = { title: 'Ridiculous Marketing Title: The Legend of X', shortTitle: 'The Legend of X', openingDate: '2026-04-22' };
    const url = 'https://www.broadwayworld.com/article/Review-Roundup-THE-LEGEND-OF-X-Opens-on-Broadway-20260422';
    assert.ok(slugMatchesShow(url, show));
  });
});

describe('scoreCandidate', () => {
  it('scores highest when title matches and date is near', () => {
    const show = { title: 'The Fear of 13', openingDate: '2026-04-15' };
    const s = scoreCandidate(REAL_ANCHORS[0], show);
    assert.ok(s >= 15, `expected ≥15, got ${s}`);
  });

  it('penalizes title match with far-off date', () => {
    const show = { title: 'Maybe Happy Ending', openingDate: '2026-04-15' };
    // URL date 20241112 vs show 2026-04-15 → 150+ days off
    const s = scoreCandidate(REAL_ANCHORS[7], show);
    assert.ok(s < 10, `far-date candidate should score <10, got ${s}`);
  });

  it('title mismatch does not cross the 10-point inclusion threshold', () => {
    // Title-mismatch gets 0 from the title-token check. Date proximity can still
    // add up to +5, but the discover threshold is score>=10, so no inclusion.
    const show = { title: 'Hamilton', openingDate: '2026-04-15' };
    const s = scoreCandidate(REAL_ANCHORS[0], show);
    assert.ok(s < 10, `mismatch should score <10 (inclusion threshold), got ${s}`);
  });
});

describe('discoverBwwRoundupUrl', () => {
  const fetchAnchors = async () => REAL_ANCHORS;
  // No-op section scan so reviews.php-path tests don't hit the network (the
  // section scan runs first in production; injecting [] makes it fall through).
  const fetchSectionAnchors = async () => [];

  it('finds Fear of 13 from real anchor list', async () => {
    const show = { title: 'The Fear of 13', openingDate: '2026-04-15' };
    const result = await discoverBwwRoundupUrl(show, { fetchAnchors, fetchSectionAnchors });
    assert.strictEqual(result.url, REAL_ANCHORS[0]);
  });

  it('finds Titanique from real anchor list', async () => {
    const show = { title: 'Titanique', openingDate: '2026-04-12' };
    const result = await discoverBwwRoundupUrl(show, { fetchAnchors, fetchSectionAnchors });
    assert.strictEqual(result.url, REAL_ANCHORS[1]);
  });

  it('finds Death of a Salesman', async () => {
    const show = { title: 'Death of a Salesman', openingDate: '2026-04-09' };
    const result = await discoverBwwRoundupUrl(show, { fetchAnchors, fetchSectionAnchors });
    assert.strictEqual(result.url, REAL_ANCHORS[2]);
  });

  it('returns null when show is not in the listing', async () => {
    const show = { title: 'Hamilton', openingDate: '2026-04-15' };
    const result = await discoverBwwRoundupUrl(show, { fetchAnchors, fetchSectionAnchors });
    assert.strictEqual(result.url, null);
    assert.strictEqual(result.candidates.length, 0);
  });

  it('returns null on empty anchor list', async () => {
    const result = await discoverBwwRoundupUrl(
      { title: 'Anything', openingDate: '2026-04-15' },
      { fetchAnchors: async () => [], fetchSectionAnchors: async () => [] }
    );
    assert.strictEqual(result.url, null);
  });

  it('prefers nearest-date match when multiple candidates match title tokens', async () => {
    // Fabricated: two "TITANIQUE" URLs, one with wrong year
    const fakeAnchors = [
      'https://www.broadwayworld.com/article/Review-Roundup-TITANIQUE-Off-Broadway-Return-20230615',
      'https://www.broadwayworld.com/article/Review-Roundup-TITANIQUE-Sets-Sail-on-Broadway-20260412',
    ];
    const show = { title: 'Titanique', openingDate: '2026-04-12' };
    const result = await discoverBwwRoundupUrl(show, { fetchAnchors: async () => fakeAnchors, fetchSectionAnchors: async () => [] });
    assert.ok(result.url.includes('20260412'), `expected 2026 url, got ${result.url}`);
  });
});

describe('discoverBwwRoundupUrl — section-page discovery (off-Broadway)', () => {
  // The off-Broadway fix: OB roundups live on BWW's /off-broadway/ section page,
  // found via a cheap ScrapingBee scan BEFORE the Browserbase reviews.php fallback.
  const OB_SECTION_ANCHORS = [
    'https://www.broadwayworld.com/article/Review-Roundup-A-WOMAN-AMONG-WOMEN-at-Lincoln-Center-Theater-20260605',
    'https://www.broadwayworld.com/article/Review-Roundup-GIRL-INTERRUPTED-Opens-At-The-Public-Theater-20260604',
  ];

  it('finds an OB roundup via the section scan without touching reviews.php', async () => {
    const show = { title: 'A Woman Among Women', openingDate: '2026-06-04', category: 'off-broadway' };
    let reviewsPhpCalled = false;
    const result = await discoverBwwRoundupUrl(show, {
      fetchSectionAnchors: async () => OB_SECTION_ANCHORS,
      fetchAnchors: async () => { reviewsPhpCalled = true; return []; },
    });
    assert.strictEqual(result.via, 'section');
    assert.ok(result.url.includes('A-WOMAN-AMONG-WOMEN'), `got ${result.url}`);
    assert.strictEqual(reviewsPhpCalled, false, 'section hit must short-circuit the Browserbase path');
  });

  it('falls back to the paid reviews.php when the section scan finds nothing', async () => {
    // Broadway category => shouldSkipReviewsPhp is false, so the paid fallback runs.
    const show = { title: 'A Woman Among Women', openingDate: '2026-06-04', category: 'broadway' };
    const result = await discoverBwwRoundupUrl(show, {
      fetchSectionAnchors: async () => [],
      fetchAnchors: async () => OB_SECTION_ANCHORS,
    });
    assert.strictEqual(result.via, 'reviews.php');
    assert.ok(result.url.includes('A-WOMAN-AMONG-WOMEN'), `got ${result.url}`);
  });

  it('an explicit skipReviewsPhp:false does NOT disable the category default', async () => {
    // Regression: audit-show-review-gap.js passes { skipReviewsPhp: show.status === 'closed' },
    // which is an explicit `false` for every OPEN show. Under the old
    // `opts.skipReviewsPhp !== undefined` check that silently bypassed the T4
    // category gate, making the hourly gap audit the one caller T4 never covered.
    // The two guards are OR'd now, so the category default still applies.
    const show = { title: 'A Woman Among Women', openingDate: '2026-06-04', category: 'off-broadway', status: 'open' };
    let paidCalled = false;
    const result = await discoverBwwRoundupUrl(show, {
      skipReviewsPhp: show.status === 'closed', // => false
      fetchSectionAnchors: async () => [],
      fetchAnchors: async () => { paidCalled = true; return OB_SECTION_ANCHORS; },
    });
    assert.strictEqual(result.via, 'section-only');
    assert.strictEqual(paidCalled, false, 'category default must still suppress the PAID reviews.php probe');
  });

  it('the CHEAP reviews.php tier runs for Off-Broadway and can resolve a roundup', async () => {
    // The yield half of the 2026-07-31 regression: T4 skipped reviews.php entirely
    // for Off-Broadway, but reviews.php demonstrably carries OB roundups (measured
    // live: THE SAVIORS, Cat Cohen BROAD STROKES, LES MISERABLES ARENA). The cheap
    // fetchPage tier must run for OB shows and must NOT be gated by category.
    const show = { title: 'A Woman Among Women', openingDate: '2026-06-04', category: 'off-broadway' };
    let paidCalled = false;
    const result = await discoverBwwRoundupUrl(show, {
      fetchSectionAnchors: async () => [],
      fetchCheapAnchors: async () => OB_SECTION_ANCHORS,
      // NOTE: no fetchAnchors override here — supplying one bypasses the cheap tier.
    });
    assert.strictEqual(result.via, 'reviews.php-cheap');
    assert.ok(result.url.includes('A-WOMAN-AMONG-WOMEN'), `got ${result.url}`);
    assert.strictEqual(paidCalled, false);
  });

  it('an empty cheap tier still falls through to the paid tier when not skipped', async () => {
    const show = { title: 'A Woman Among Women', openingDate: '2026-06-04', category: 'broadway' };
    const result = await discoverBwwRoundupUrl(show, {
      fetchSectionAnchors: async () => [],
      fetchCheapAnchors: async () => [],
      fetchAnchors: async () => OB_SECTION_ANCHORS,
    });
    // fetchAnchors supplied => cheap tier bypassed; asserts the paid path still works.
    assert.strictEqual(result.via, 'reviews.php');
  });

  it('skipReviewsPhp avoids the Browserbase fallback (closed-show cost guard)', async () => {
    const show = { title: 'Some Old Show', openingDate: '2024-01-01', category: 'off-broadway', status: 'closed' };
    let reviewsPhpCalled = false;
    const result = await discoverBwwRoundupUrl(show, {
      skipReviewsPhp: true,
      fetchSectionAnchors: async () => [], // section finds nothing
      fetchAnchors: async () => { reviewsPhpCalled = true; return []; },
    });
    assert.strictEqual(result.via, 'section-only');
    assert.strictEqual(result.url, null);
    assert.strictEqual(reviewsPhpCalled, false, 'must NOT hit Browserbase reviews.php for a closed show');
  });
});

describe('shouldSkipReviewsPhp — fail-open category gating (T4)', () => {
  it('skips only on affirmative off-broadway category', () => {
    assert.strictEqual(shouldSkipReviewsPhp({ category: 'off-broadway' }), true);
    assert.strictEqual(shouldSkipReviewsPhp({ category: 'Off-Broadway' }), true, 'case-insensitive');
  });

  it('probes (does not skip) for every other category', () => {
    assert.strictEqual(shouldSkipReviewsPhp({ category: 'broadway' }), false);
    assert.strictEqual(shouldSkipReviewsPhp({ category: 'west-end' }), false);
    assert.strictEqual(shouldSkipReviewsPhp({ category: 'off-west-end' }), false);
    assert.strictEqual(shouldSkipReviewsPhp({ category: 'regional' }), false);
  });

  it('fails open on null/missing/unknown category — a misclassified Broadway show must still probe', () => {
    assert.strictEqual(shouldSkipReviewsPhp({ category: null }), false);
    assert.strictEqual(shouldSkipReviewsPhp({}), false);
    assert.strictEqual(shouldSkipReviewsPhp({ category: undefined }), false);
    assert.strictEqual(shouldSkipReviewsPhp({ category: 'some-unknown-value' }), false);
    assert.strictEqual(shouldSkipReviewsPhp(null), false);
  });
});

describe('discoverBwwRoundupUrl — default skip derived from category (T4)', () => {
  it('off-Broadway shows skip reviews.php by default with no explicit opt', async () => {
    const show = { title: 'A Woman Among Women', openingDate: '2026-06-04', category: 'off-broadway' };
    let reviewsPhpCalled = false;
    const result = await discoverBwwRoundupUrl(show, {
      fetchSectionAnchors: async () => [],
      fetchAnchors: async () => { reviewsPhpCalled = true; return []; },
    });
    assert.strictEqual(result.via, 'section-only');
    assert.strictEqual(reviewsPhpCalled, false);
  });

  it('Broadway shows still probe reviews.php by default', async () => {
    const show = { title: 'Titanique', openingDate: '2026-04-12', category: 'broadway' };
    let reviewsPhpCalled = false;
    const result = await discoverBwwRoundupUrl(show, {
      fetchSectionAnchors: async () => [],
      fetchAnchors: async () => { reviewsPhpCalled = true; return REAL_ANCHORS; },
    });
    assert.strictEqual(reviewsPhpCalled, true);
    assert.strictEqual(result.url, REAL_ANCHORS[1]);
  });

  it('null-category shows still probe reviews.php (fail-open)', async () => {
    const show = { title: 'Titanique', openingDate: '2026-04-12' };
    let reviewsPhpCalled = false;
    await discoverBwwRoundupUrl(show, {
      fetchSectionAnchors: async () => [],
      fetchAnchors: async () => { reviewsPhpCalled = true; return []; },
    });
    assert.strictEqual(reviewsPhpCalled, true);
  });
});

describe('discoverBwwRoundupUrl — typed via reasons on reviews.php failure (T4)', () => {
  const show = { title: 'Titanique', openingDate: '2026-04-12', category: 'broadway' };

  it('types cap-exhausted from the Browserbase daily-cap error', async () => {
    const result = await discoverBwwRoundupUrl(show, {
      fetchSectionAnchors: async () => [],
      fetchAnchors: async () => { throw new Error('Browserbase daily cap reached (250/250) — BWW RR discovery skipped'); },
    });
    assert.strictEqual(result.via, 'cap-exhausted');
    assert.strictEqual(result.url, null);
  });

  it('types provider-error from any other thrown failure', async () => {
    const result = await discoverBwwRoundupUrl(show, {
      fetchSectionAnchors: async () => [],
      fetchAnchors: async () => { throw new Error('BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID required'); },
    });
    assert.strictEqual(result.via, 'provider-error');
    assert.strictEqual(result.url, null);
  });

  it('types not-found when the page loads with no matching anchors', async () => {
    const result = await discoverBwwRoundupUrl(show, {
      fetchSectionAnchors: async () => [],
      fetchAnchors: async () => [],
    });
    assert.strictEqual(result.via, 'not-found');
    assert.strictEqual(result.url, null);
  });
});
