import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyMarketRouting, buildSiblingIndex } =
  require('../../scripts/lib/market-routing.js');

// ---------------------------------------------------------------------------
// Fixture shows: Book of Mormon (BW 2011 / WE 2013), single-production baseline,
// two-BW-revival case, long-runner (Phantom WE 1986 / BW 1988), transfer case.
// ---------------------------------------------------------------------------
const SHOWS = [
  { id: 'book-of-mormon-2011', title: 'The Book of Mormon', openingDate: '2011-03-24', category: 'broadway' },
  { id: 'the-book-of-mormon-west-end-2024', title: 'The Book of Mormon', openingDate: '2013-03-21', category: 'west-end' },

  { id: 'the-phantom-of-the-opera-1988', title: 'The Phantom of the Opera', openingDate: '1988-01-26', category: 'broadway' },
  { id: 'the-phantom-of-the-opera-west-end-1986', title: 'The Phantom of the Opera', openingDate: '1986-10-09', category: 'west-end' },

  { id: 'oh-mary-2024', title: 'Oh, Mary!', openingDate: '2024-07-11', category: 'broadway' },
  { id: 'oh-mary-west-end-2025', title: 'Oh, Mary!', openingDate: '2025-06-30', category: 'west-end' },

  // Single-production baseline (no siblings)
  { id: 'unique-show-2026', title: 'Unique New Show', openingDate: '2026-04-01', category: 'broadway' },
];

const index = buildSiblingIndex(SHOWS);

test('reroutes 2011 Washington Post review from WE-2024 dir to BW-2011 dir', () => {
  const decision = classifyMarketRouting({
    showId: 'the-book-of-mormon-west-end-2024',
    url: 'http://www.washingtonpost.com/entertainment/theater/2011/03/24/book-of-mormon-review/',
    outletId: 'washingtonpost',
    publishDate: '2011-03-24',
    category: 'west-end',
    siblingIndex: index,
  });
  assert.equal(decision.action, 'reroute');
  assert.equal(decision.targetShowId, 'book-of-mormon-2011');
});

test('keeps 2013 WE-opening review in WE-2024 dir (current-show window)', () => {
  const decision = classifyMarketRouting({
    showId: 'the-book-of-mormon-west-end-2024',
    url: 'https://www.thestage.co.uk/reviews/book-of-mormon-prince-of-wales-review',
    outletId: 'thestage',
    publishDate: '2013-03-22',
    category: 'west-end',
    siblingIndex: index,
  });
  assert.equal(decision.action, 'accept');
});

test('rejects obvious Broadway-slug URL for WE show with no matching sibling', () => {
  const decision = classifyMarketRouting({
    showId: 'unique-show-2026',
    url: 'https://example.com/reviews/unique-new-show-broadway-review',
    outletId: 'example',
    publishDate: '2026-04-02',
    category: 'west-end',
    siblingIndex: index,
  });
  assert.equal(decision.action, 'reject');
  assert.ok(/Broadway URL pattern/.test(decision.reason || ''), `Expected Broadway URL reason, got: ${decision.reason}`);
});

test('accepts review for Broadway show with no market signals', () => {
  const decision = classifyMarketRouting({
    showId: 'unique-show-2026',
    url: 'https://www.nytimes.com/2026/04/02/theater/unique-show-review.html',
    outletId: 'nytimes',
    publishDate: '2026-04-02',
    category: 'broadway',
    siblingIndex: index,
  });
  assert.equal(decision.action, 'accept');
});

test('reroutes Phantom 1988 Broadway-opening review from WE-1986 dir', () => {
  const decision = classifyMarketRouting({
    showId: 'the-phantom-of-the-opera-west-end-1986',
    url: 'http://www.nytimes.com/1988/01/27/theater/phantom-of-the-opera-review.html',
    outletId: 'nytimes',
    publishDate: '1988-01-27',
    category: 'west-end',
    siblingIndex: index,
  });
  assert.equal(decision.action, 'reroute');
  assert.equal(decision.targetShowId, 'the-phantom-of-the-opera-1988');
});

test('reroutes Oh Mary BW-opening review (2024-07) from WE-2025 dir', () => {
  const decision = classifyMarketRouting({
    showId: 'oh-mary-west-end-2025',
    url: 'https://www.nytimes.com/2024/07/12/theater/oh-mary-review.html',
    outletId: 'nytimes',
    publishDate: '2024-07-12',
    category: 'west-end',
    siblingIndex: index,
  });
  assert.equal(decision.action, 'reroute');
  assert.equal(decision.targetShowId, 'oh-mary-2024');
});

test('keeps WE Oh Mary review within 30 days of WE opening', () => {
  const decision = classifyMarketRouting({
    showId: 'oh-mary-west-end-2025',
    url: 'https://www.thestage.co.uk/reviews/oh-mary-garrick-review',
    outletId: 'thestage',
    publishDate: '2025-07-01',
    category: 'west-end',
    siblingIndex: index,
  });
  assert.equal(decision.action, 'accept');
});

test('accepts when allowCrossMarket override is set', () => {
  const decision = classifyMarketRouting({
    showId: 'the-book-of-mormon-west-end-2024',
    url: 'http://www.washingtonpost.com/2011/03/24/book-of-mormon-review/',
    outletId: 'washingtonpost',
    publishDate: '2011-03-24',
    category: 'west-end',
    allowCrossMarket: true,
    siblingIndex: index,
  });
  assert.equal(decision.action, 'accept');
  assert.match(decision.reason, /opt-in/);
});

test('does not reroute when sibling is already visited (cycle guard)', () => {
  const visited = new Set(['book-of-mormon-2011']);
  const decision = classifyMarketRouting({
    showId: 'the-book-of-mormon-west-end-2024',
    url: 'http://www.washingtonpost.com/2011/03/24/book-of-mormon-review/',
    outletId: 'washingtonpost',
    publishDate: '2011-03-24',
    category: 'west-end',
    visited,
    siblingIndex: index,
  });
  assert.equal(decision.action, 'accept');
});

test('accepts when publishDate is missing (no date-based reroute possible)', () => {
  const decision = classifyMarketRouting({
    showId: 'the-book-of-mormon-west-end-2024',
    url: 'https://www.thestage.co.uk/reviews/book-of-mormon-review',
    outletId: 'thestage',
    publishDate: null,
    category: 'west-end',
    siblingIndex: index,
  });
  assert.equal(decision.action, 'accept');
});

test('does NOT Tier-2 reroute cross-market UK review with no Broadway URL marker', () => {
  // a-dolls-house-off-west-end-2026 has null openingDate → Tier 1 skipped.
  // Closest sibling by year is BW a-dolls-house-2023 (distance 1 from 2022 vs 4
  // from 2026). But the review is a UK Guardian piece, no Broadway markers.
  // Must NOT reroute to BW.
  const SHOWS_WITH_OWE = [
    { id: 'a-dolls-house-2023', title: "A Doll's House", openingDate: '2023-03-09', category: 'broadway' },
    { id: 'a-dolls-house-off-west-end-2026', title: "A Doll's House", openingDate: null, category: 'off-west-end' },
  ];
  const idx = buildSiblingIndex(SHOWS_WITH_OWE);
  const decision = classifyMarketRouting({
    showId: 'a-dolls-house-off-west-end-2026',
    url: 'https://www.theguardian.com/stage/2022/jun/15/a-dolls-house-review',
    outletId: 'guardian',
    publishDate: '2022-06-15',
    category: 'off-west-end',
    siblingIndex: idx,
  });
  assert.equal(decision.action, 'accept');
});

test('DOES Tier-2 reroute cross-market when URL has Broadway marker', () => {
  const SHOWS_WITH_OWE = [
    { id: 'a-dolls-house-2023', title: "A Doll's House", openingDate: '2023-03-09', category: 'broadway' },
    { id: 'a-dolls-house-off-west-end-2026', title: "A Doll's House", openingDate: null, category: 'off-west-end' },
  ];
  const idx = buildSiblingIndex(SHOWS_WITH_OWE);
  // Same scenario but the URL has an explicit /broadway/ marker — the signal
  // makes Tier 2 cross-market routing safe.
  // Note: isBroadwayUrl check runs against the URL; reject Guard H is gated
  // by category+isLondonMarket. Tier 2 fires first and returns reroute.
  const decision = classifyMarketRouting({
    showId: 'a-dolls-house-off-west-end-2026',
    url: 'https://www.nytimes.com/2023/03/10/theater/a-dolls-house-broadway-review.html',
    outletId: 'nytimes',
    publishDate: '2023-03-10',
    category: 'off-west-end',
    siblingIndex: idx,
  });
  assert.equal(decision.action, 'reroute');
  assert.equal(decision.targetShowId, 'a-dolls-house-2023');
});

test('buildSiblingIndex groups by normalized title and excludes self', () => {
  const entry = index.get('the-book-of-mormon-west-end-2024');
  assert.ok(entry);
  assert.equal(entry.siblings.length, 1);
  assert.equal(entry.siblings[0].id, 'book-of-mormon-2011');
  // No entry for a show with no same-title siblings
  assert.equal(index.get('unique-show-2026'), undefined);
});
