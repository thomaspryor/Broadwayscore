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

  it('falls back to reviews.php when the section scan finds nothing', async () => {
    const show = { title: 'A Woman Among Women', openingDate: '2026-06-04', category: 'off-broadway' };
    const result = await discoverBwwRoundupUrl(show, {
      fetchSectionAnchors: async () => [],
      fetchAnchors: async () => OB_SECTION_ANCHORS,
    });
    assert.strictEqual(result.via, 'reviews.php');
    assert.ok(result.url.includes('A-WOMAN-AMONG-WOMEN'), `got ${result.url}`);
  });
});
