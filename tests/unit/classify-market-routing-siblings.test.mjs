// Unit tests for the same-market same-title disambiguation cascade in
// scripts/lib/market-routing.js (added 2026-05-17, "same-title-disambig" plan).
//
// Per feedback_test_extraction_pattern.md: we require() the real
// classifyMarketRouting and exercise it against synthetic fixtures — no
// logic is copied into this file. Each subtest below exercises a *distinct*
// branch of the cascade so a regression in any one branch surfaces as a
// targeted failure.
//
// Branches covered:
//   1. Clean reroute (≥2 signals on sibling, sibling > current)
//   2. Ambiguous wrongProduction flag (current 0 signals, sibling ≥1)
//   3. Plain accept when ALL candidates tie at 0 signals
//   4. Null-category short-circuit (skips the new branch entirely)
//   5. DISABLE_PRODUCTION_DISAMBIG env-var rollback (back to pre-2026-05-17)
//   6. Venue-substring denylist — "broadway" token must NOT fire
//   7. Cross-market Tier 1 reroute still works (this branch unchanged)
//
// All fixtures are designed so Tier 1 (sibling ≤30d / current >90d from
// publishDate) does NOT fire — that block runs *before* the same-market
// branch and would otherwise short-circuit. Test 7 inverts this to confirm
// Tier 1 still fires for the cross-market case.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyMarketRouting, buildSiblingIndex } =
  require('../../scripts/lib/market-routing.js');

// ---------------------------------------------------------------------------
// Fixture shows. titanique-2026 (BW) + titanique-off-broadway-2022 are the
// same-market same-title pair (both map to the 'nyc' pool). hadestown is the
// cross-market sanity case for Tier 1.
// ---------------------------------------------------------------------------
const BASE_SHOWS = [
  {
    id: 'titanique-2026',
    title: 'Titanique',
    openingDate: '2026-05-01',
    category: 'broadway',
    venue: 'Hayes Theater',
  },
  {
    id: 'titanique-off-broadway-2022',
    title: 'Titanique',
    openingDate: '2022-06-13',
    closingDate: '2023-09-04',
    category: 'off-broadway',
    venue: 'Daryl Roth Theatre',
  },
  // Cross-market Tier 1 case
  {
    id: 'hadestown-2019',
    title: 'Hadestown',
    openingDate: '2019-04-17',
    category: 'broadway',
    venue: 'Walter Kerr Theatre',
  },
  {
    id: 'hadestown-west-end-2024',
    title: 'Hadestown',
    openingDate: '2024-02-21',
    category: 'west-end',
    venue: 'Lyric Theatre',
  },
];

const baseIndex = buildSiblingIndex(BASE_SHOWS);

test('1. clean reroute when sibling has 2 signals (url-year + publish-date) and current has 0', () => {
  // publishDate 2023-04-01 is INSIDE the 2022 off-Broadway production window
  // [2022-04-14, 2023-10-04] but 292d from sibling open → Tier 1 won't fire.
  // URL /2022/... gives url-year=2022 (matches sibling open year). Current
  // (2026 opening) is too far in either dimension.
  const decision = classifyMarketRouting({
    showId: 'titanique-2026',
    url: 'https://example.com/2022/06/titanique-off-broadway-review/',
    outletId: 'example',
    publishDate: '2023-04-01',
    category: 'broadway',
    siblingIndex: baseIndex,
  });
  assert.equal(decision.action, 'reroute', `expected reroute, got ${JSON.stringify(decision)}`);
  assert.equal(decision.targetShowId, 'titanique-off-broadway-2022');
  assert.match(decision.reason || '', /same-title-sibling:/);
  assert.match(decision.reason || '', /url-year/);
  assert.match(decision.reason || '', /publish-date/);
});

test('2. ambiguous wrongProduction flag when sibling has 1 signal and current has 0', () => {
  // URL carries no /YYYY/MM/ pattern → no url-year signal anywhere. publishDate
  // 2023-04-01 still inside the 2022 off-Broadway window (publish-date signal
  // for sibling only). Current titanique-2026: no signals.
  const decision = classifyMarketRouting({
    showId: 'titanique-2026',
    url: 'https://example.com/reviews/titanique-review/',
    outletId: 'example',
    publishDate: '2023-04-01',
    category: 'broadway',
    siblingIndex: baseIndex,
  });
  assert.equal(decision.action, 'accept', `expected accept, got ${JSON.stringify(decision)}`);
  assert.equal(decision.flag, 'wrongProduction');
  assert.equal(decision.reason, 'ambiguous-production');
  assert.ok(Array.isArray(decision.signalsByCandidate));
  const sibEntry = decision.signalsByCandidate.find(s => s.id === 'titanique-off-broadway-2022');
  const curEntry = decision.signalsByCandidate.find(s => s.id === 'titanique-2026');
  assert.ok(sibEntry && sibEntry.signals.includes('publish-date'),
    `sibling should carry publish-date signal: ${JSON.stringify(sibEntry)}`);
  assert.equal(curEntry.signals.length, 0, 'current show should have zero signals');
});

test('3. plain accept (no flag) when ALL candidates tie at 0 signals', () => {
  // publishDate 2024-01-01 falls outside both production windows
  // (sibling closes 2023-09-04 + 30d = 2023-10-04; current opens 2026-05-01
  // - 60d = 2026-03-02). URL has no year. → 0 signals everywhere.
  const decision = classifyMarketRouting({
    showId: 'titanique-2026',
    url: 'https://example.com/reviews/titanique/',
    outletId: 'example',
    publishDate: '2024-01-01',
    category: 'broadway',
    siblingIndex: baseIndex,
  });
  assert.equal(decision.action, 'accept', `expected accept, got ${JSON.stringify(decision)}`);
  assert.equal(decision.flag, undefined, 'no flag for tied-zero case');
  assert.equal(decision.signalsByCandidate, undefined);
});

test('4. null-category short-circuit (one sibling lacks category)', () => {
  // Adding a third Titanique sibling with category:null must skip the new
  // same-market branch entirely (per market-routing.js:282–283). Same inputs
  // as test 1 — would otherwise reroute. Expected: plain accept.
  const showsWithNull = [
    ...BASE_SHOWS,
    {
      id: 'titanique-unknown-2025',
      title: 'Titanique',
      openingDate: '2025-01-01',
      category: null,
      venue: null,
    },
  ];
  const idx = buildSiblingIndex(showsWithNull);
  const decision = classifyMarketRouting({
    showId: 'titanique-2026',
    url: 'https://example.com/2022/06/titanique-off-broadway-review/',
    outletId: 'example',
    publishDate: '2023-04-01',
    category: 'broadway',
    siblingIndex: idx,
  });
  assert.equal(decision.action, 'accept', `expected plain accept, got ${JSON.stringify(decision)}`);
  assert.equal(decision.flag, undefined, 'must not flag — branch was skipped');
  assert.equal(decision.reason, undefined, 'no reason — fell through to bare accept');
});

test('5. DISABLE_PRODUCTION_DISAMBIG=true env-var rolls back to pre-2026-05-17 behavior', () => {
  // Same input as test 1 (would otherwise reroute). With the kill switch on,
  // the new branch is skipped and we fall through to plain accept. Save/restore
  // env so the toggle doesn't leak into other subtests.
  const prev = process.env.DISABLE_PRODUCTION_DISAMBIG;
  process.env.DISABLE_PRODUCTION_DISAMBIG = 'true';
  try {
    const decision = classifyMarketRouting({
      showId: 'titanique-2026',
      url: 'https://example.com/2022/06/titanique-off-broadway-review/',
      outletId: 'example',
      publishDate: '2023-04-01',
      category: 'broadway',
      siblingIndex: baseIndex,
    });
    assert.equal(decision.action, 'accept', `expected accept, got ${JSON.stringify(decision)}`);
    assert.equal(decision.flag, undefined);
    assert.equal(decision.targetShowId, undefined);
  } finally {
    if (prev === undefined) delete process.env.DISABLE_PRODUCTION_DISAMBIG;
    else process.env.DISABLE_PRODUCTION_DISAMBIG = prev;
  }
});

test('6. venue-substring denylist — "broadway" token must NOT fire even when URL contains it', () => {
  // Sibling venue "Broadway Theatre". URL contains the token "broadway" but
  // outside any /YYYY/ pattern, and publishDate is outside the window. If the
  // denylist works, no venue-substring signal fires → sibling has 0 signals →
  // plain accept (NOT ambiguous flag). A regression in GENERIC_VENUE_SLUGS
  // would surface here as an unexpected wrongProduction flag.
  const shows = [
    {
      id: 'samename-2026',
      title: 'Samename',
      openingDate: '2026-05-01',
      category: 'broadway',
      venue: 'Hayes Theater',
    },
    {
      id: 'samename-2010',
      title: 'Samename',
      openingDate: '2010-03-01',
      closingDate: '2010-09-01',
      category: 'broadway',
      venue: 'Broadway Theatre',
    },
  ];
  const idx = buildSiblingIndex(shows);
  const decision = classifyMarketRouting({
    showId: 'samename-2026',
    url: 'https://example.com/reviews/broadway/samename-revival/',
    outletId: 'example',
    publishDate: '2024-01-01',
    category: 'broadway',
    siblingIndex: idx,
  });
  assert.equal(decision.action, 'accept', `expected plain accept, got ${JSON.stringify(decision)}`);
  assert.equal(decision.flag, undefined, '"broadway" venue token must be denylisted');
});

test('8. cross-market Tier 1 fires at 32 days with CROSS_MARKET_SIBLING_CLOSE_DAYS=60 (oh-mary-style)', () => {
  // Mirrors finding 8 from same-title-confusion.json: oh-mary-2024 (BW, opened
  // 2024-07-11) with 1minutecritic review publishDate 2026-01-19 → distToSib=32d
  // (to oh-mary-west-end-2025 opened 2025-12-18). Was accepted under 30d threshold.
  // With 60d cross-market threshold it should reroute to the WE sibling.
  const shows = [
    {
      id: 'oh-mary-bw-2024',
      title: 'Oh, Mary!',
      openingDate: '2024-07-11',
      category: 'broadway',
      venue: 'Lyceum Theatre',
    },
    {
      id: 'oh-mary-we-2025',
      title: 'Oh, Mary!',
      openingDate: '2025-12-18',
      category: 'west-end',
      venue: 'Garrick Theatre',
    },
  ];
  const idx = buildSiblingIndex(shows);
  const decision = classifyMarketRouting({
    showId: 'oh-mary-bw-2024',
    url: 'https://1minutecritic.com/oh-mary-broadway-review/',
    outletId: 'one-minute-critic',
    publishDate: '2026-01-19',   // 32d after oh-mary-we-2025 opening, 557d after oh-mary-bw-2024 opening
    category: 'broadway',
    siblingIndex: idx,
  });
  assert.equal(decision.action, 'reroute', `expected cross-market reroute at 32d, got ${JSON.stringify(decision)}`);
  assert.equal(decision.targetShowId, 'oh-mary-we-2025');
  assert.match(decision.reason || '', /32d/);
});

test('7. cross-market Tier 1 reroute still fires (hadestown WE-2024 review of 2019 BW opening)', () => {
  // Sanity check: the new same-market branch must NOT regress the existing
  // Tier 1 cross-market reroute. hadestown-west-end-2024 dir + 2019-04-17
  // publishDate → distToSib (BW 2019) = 0d ≤ 30; distToCurrent (WE 2024) =
  // ~1771d > 90 → Tier 1 reroutes to hadestown-2019. Our new branch (which
  // runs AFTER Tier 1) is never reached.
  const decision = classifyMarketRouting({
    showId: 'hadestown-west-end-2024',
    url: 'https://www.nytimes.com/2019/04/17/theater/hadestown-review.html',
    outletId: 'nytimes',
    publishDate: '2019-04-17',
    category: 'west-end',
    siblingIndex: baseIndex,
  });
  assert.equal(decision.action, 'reroute');
  assert.equal(decision.targetShowId, 'hadestown-2019');
  // Reason should reference the Tier 1 date proximity, NOT the same-title-sibling string.
  assert.doesNotMatch(decision.reason || '', /same-title-sibling/);
  assert.match(decision.reason || '', /publishDate/);
});
