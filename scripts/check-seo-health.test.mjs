/**
 * Regression tests for the SEO health alerting guards (task #530).
 *
 * The 2026-07-26 "impressions down 34%" card was a false alarm: a third-party
 * scraper issuing `site:` / stacked-exact-phrase queries stopped on 2026-07-15,
 * taking ~12K zero-click desktop impressions with it while real clicks ROSE 13%.
 * These tests pin the classifier and the three suppression arms so that shape
 * never pages the owner again — and, just as importantly, so a genuine ranking
 * loss still does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  hasBotQueryShape,
  isBotQueryRow,
  summarizeBotQueries,
  botDropExplainsDecline,
} = require('./lib/seo-bot-query-signature.js');
const { detectAnomalies, sampleShowPages, buildCWVPages } = require('./check-seo-health.js');

// Real queries pulled from GSC for sc-domain:broadwayscorecard.com, 2026-07-01..14.
const REAL_BOT_QUERIES = [
  'site:broadwayscorecard.com/show/hamilton "show score"',
  'site:broadwayscorecard.com/show/moulin-rouge "show score"',
  '"hadestown (broadway)" "91%" "show score"',
  '"the lion king (broadway)" "92%" "show-score"',
  '"aladdin (broadway)" "87%" "show score"',
];

// Real organic queries from the same window.
const REAL_ORGANIC_QUERIES = [
  'broadway show reviews',
  'best broadway shows',
  'giulia the poison queen of palermo review',
  'meg stalter oh mary review',
  'broadway scorecard',
  'show-score hamilton broadway rating', // no quotes, no operator — human-shaped
];

test('hasBotQueryShape flags site: operators and stacked exact-phrases', () => {
  for (const q of REAL_BOT_QUERIES) {
    assert.equal(hasBotQueryShape(q), true, `should be bot-shaped: ${q}`);
  }
});

test('hasBotQueryShape leaves organic queries alone', () => {
  for (const q of REAL_ORGANIC_QUERIES) {
    assert.equal(hasBotQueryShape(q), false, `should be organic: ${q}`);
  }
});

test('a single quoted phrase is not enough to call a query bot-shaped', () => {
  assert.equal(hasBotQueryShape('"oh mary" review'), false);
  assert.equal(hasBotQueryShape('"oh mary" "broadway"'), true);
});

test('hasBotQueryShape tolerates junk input', () => {
  for (const q of [undefined, null, '', '   ', 42, {}]) {
    assert.equal(hasBotQueryShape(q), false);
  }
});

test('isBotQueryRow requires zero clicks — a click proves a human was there', () => {
  assert.equal(isBotQueryRow({ keys: ['site:broadwayscorecard.com "show score"'], clicks: 0, impressions: 220 }), true);
  assert.equal(isBotQueryRow({ keys: ['site:broadwayscorecard.com "show score"'], clicks: 3, impressions: 220 }), false);
  assert.equal(isBotQueryRow({ query: '"a" "b"', clicks: 0, impressions: 10 }), true);
  assert.equal(isBotQueryRow(null), false);
});

test('summarizeBotQueries reproduces the observed 2026-07 split', () => {
  // Shape of the real data: bot queries carried impressions and zero clicks;
  // organic queries carried the clicks.
  const rows = [
    { keys: ['site:broadwayscorecard.com/show/hamilton "show score"'], clicks: 0, impressions: 169 },
    { keys: ['"hadestown (broadway)" "91%" "show score"'], clicks: 0, impressions: 400 },
    { keys: ['broadway show reviews'], clicks: 12, impressions: 222 },
    { keys: ['best broadway shows'], clicks: 1, impressions: 455 },
  ];
  const s = summarizeBotQueries(rows);
  assert.equal(s.botQueries, 2);
  assert.equal(s.botImpressions, 569);
  assert.equal(s.totalImpressions, 1246);
  assert.equal(s.organicImpressions, 677);
  assert.equal(s.totalQueries, 4);
  assert.ok(s.botShare > 0.45 && s.botShare < 0.46, `botShare ${s.botShare}`);
  assert.equal(s.examples.length, 2);
});

test('summarizeBotQueries handles an empty / non-array input', () => {
  for (const input of [[], null, undefined]) {
    const s = summarizeBotQueries(input);
    assert.equal(s.botImpressions, 0);
    assert.equal(s.botShare, 0);
  }
});

// --- botDropExplainsDecline ---
//
// Contract: suppression requires (a) a real site-wide decline, (b) a bot retreat
// that is a material share of it, (c) ORGANIC impressions holding flat, and
// (d) an untruncated census. Nothing is extrapolated.

/** The real 2026-07 event, on the 14-day windows it was measured over. */
const REAL_EVENT = {
  impressionsDelta: 40462,          // 164,968 -> 124,506
  botImpressionsDelta: 11894,       // 14,571 -> 2,677
  organicImpressionsDelta: -6238,   // 35,412 -> 41,650, i.e. organic GREW
  priorOrganicImpressions: 35412,
};

test('the real 2026-07 bot exodus is recognised', () => {
  assert.equal(botDropExplainsDecline(REAL_EVENT), true);
});

test('a truncated census never suppresses', () => {
  assert.equal(botDropExplainsDecline({ ...REAL_EVENT, truncated: true }), false);
});

test('bot impressions must actually have fallen', () => {
  assert.equal(botDropExplainsDecline({ ...REAL_EVENT, botImpressionsDelta: 0 }), false);
  assert.equal(botDropExplainsDecline({ ...REAL_EVENT, botImpressionsDelta: -500 }), false);
});

test('there must be a decline to explain', () => {
  assert.equal(botDropExplainsDecline({ ...REAL_EVENT, impressionsDelta: -500 }), false);
});

test('an immaterial bot retreat cannot explain a decline', () => {
  // Reviewer scenario S1b: 200 departing bot impressions must not license a
  // suppression just because the decline they are measured against is small.
  assert.equal(botDropExplainsDecline({
    impressionsDelta: 1000, botImpressionsDelta: 200,
    organicImpressionsDelta: 0, priorOrganicImpressions: 30000,
  }), false, 'below the absolute floor of 1000 bot impressions');
  assert.equal(botDropExplainsDecline({
    impressionsDelta: 1000, botImpressionsDelta: 999,
    organicImpressionsDelta: 0, priorOrganicImpressions: 30000,
  }), false, 'still under the absolute floor');
  // Clears the absolute floor but not the 20% share of a large decline.
  assert.equal(botDropExplainsDecline({
    impressionsDelta: 40000, botImpressionsDelta: 7999,
    organicImpressionsDelta: 0, priorOrganicImpressions: 30000,
  }), false, 'under the 20% share');
  assert.equal(botDropExplainsDecline({
    impressionsDelta: 40000, botImpressionsDelta: 8000,
    organicImpressionsDelta: 0, priorOrganicImpressions: 30000,
  }), true, 'clears both floors');
});

test('organic impressions falling blocks suppression — the whole point', () => {
  // Codex scenario 1: a genuine 37K organic loss alongside a 3K bot loss.
  assert.equal(botDropExplainsDecline({
    impressionsDelta: 40000, botImpressionsDelta: 20000,
    organicImpressionsDelta: 12000, priorOrganicImpressions: 30000, // organic -40%
  }), false);
  // Just past the flat tolerance.
  assert.equal(botDropExplainsDecline({
    impressionsDelta: 40000, botImpressionsDelta: 20000,
    organicImpressionsDelta: 1501, priorOrganicImpressions: 30000, // -5.003%
  }), false);
  // Just inside it.
  assert.equal(botDropExplainsDecline({
    impressionsDelta: 40000, botImpressionsDelta: 20000,
    organicImpressionsDelta: 1500, priorOrganicImpressions: 30000, // -5.0%
  }), true);
});

test('no organic baseline means no claim that organic held', () => {
  assert.equal(botDropExplainsDecline({ ...REAL_EVENT, priorOrganicImpressions: 0 }), false);
});

test('no coverage/extrapolation parameters are consulted any more', () => {
  // The removed design would have flipped this to true via 1/coverage scaling.
  // 2K of bot retreat against an 80K decline is simply not the explanation.
  assert.equal(botDropExplainsDecline({
    impressionsDelta: 80000, botImpressionsDelta: 2000,
    organicImpressionsDelta: 0, priorOrganicImpressions: 50000,
    namedImpressions: 1000, totalImpressions: 120000, // ignored
  }), false);
});

// --- detectAnomalies integration ---

/** Four identical prior weeks, so the 4-week average is exactly `impressions`. */
function history({ clicks, impressions, position }) {
  return Array.from({ length: 4 }, (_, i) => ({
    date: `2026-06-${String(7 + i * 7).padStart(2, '0')}`,
    clicks, impressions, position,
  }));
}

/** botSignature shaped like the real 2026-07 event, on the weekly scale. */
function realBotSignature(overrides = {}) {
  return {
    botImpressions: 2677,
    priorBotImpressions: 14571,
    organicImpressions: 41650,
    priorOrganicImpressions: 35412,
    namedImpressions: 44327,
    truncated: false,
    examples: ['site:broadwayscorecard.com/show/hamilton "show score"'],
    ...overrides,
  };
}

test('bot-cluster departure no longer raises impressions_drop (the #530 false alarm)', () => {
  // Impressions -35%, clicks UP, position worse by 3 — outside the old
  // positionHealthy <= 2 clause, which is what let the original card through.
  const issues = detectAnomalies(
    { clicks: 1240, impressions: 58000, position: 12.4, botSignature: realBotSignature() },
    history({ clicks: 1150, impressions: 89000, position: 9.4 })
  );
  assert.deepEqual(issues.map(i => i.type), []);
});

test('the same drop WITHOUT a bot explanation still alerts', () => {
  const issues = detectAnomalies(
    {
      clicks: 1240, impressions: 58000, position: 12.4,
      botSignature: realBotSignature({ botImpressions: 2600, priorBotImpressions: 2700 }),
    },
    history({ clicks: 1150, impressions: 89000, position: 9.4 })
  );
  assert.ok(issues.some(i => i.type === 'impressions_drop' && i.severity === 'error'),
    `expected impressions_drop, got ${JSON.stringify(issues)}`);
});

test('S2: clicks -14% with impressions -35% and position +9 must NOT be silent', () => {
  // The reviewer case that the old `clicksDrop < 0.15` bar let through: it also
  // sits under the separate clicks_drop threshold of 0.25, so nothing fired.
  const issues = detectAnomalies(
    { clicks: 989, impressions: 58000, position: 18.4, botSignature: realBotSignature() },
    history({ clicks: 1150, impressions: 89000, position: 9.4 })
  );
  assert.ok(issues.some(i => i.type === 'impressions_drop'), 'impressions_drop must fire');
  assert.ok(issues.some(i => i.type === 'position_worse'), 'position_worse must fire');
});

test('S1b: a tiny bot delta must not silence a big position collapse', () => {
  const issues = detectAnomalies(
    {
      clicks: 1150, impressions: 88000, position: 17.4, // +8 spots, impressions -1%
      botSignature: realBotSignature({ botImpressions: 100, priorBotImpressions: 300 }),
    },
    history({ clicks: 1150, impressions: 89000, position: 9.4 })
  );
  assert.ok(issues.some(i => i.type === 'position_worse'), 'position_worse must fire');
});

test('a real ranking loss — organic down — alerts even alongside bot churn', () => {
  const issues = detectAnomalies(
    {
      clicks: 500, impressions: 58000, position: 12.4,
      botSignature: realBotSignature({ organicImpressions: 20000, priorOrganicImpressions: 40000 }),
    },
    history({ clicks: 1150, impressions: 89000, position: 9.4 })
  );
  assert.ok(issues.some(i => i.type === 'impressions_drop'), 'impressions_drop must survive');
  assert.ok(issues.some(i => i.type === 'clicks_drop'), 'clicks_drop must fire');
});

test('a truncated or empty census falls back to alerting', () => {
  const issues = detectAnomalies(
    { clicks: 1240, impressions: 58000, position: 12.4, botSignature: realBotSignature({ truncated: true }) },
    history({ clicks: 1150, impressions: 89000, position: 9.4 })
  );
  assert.ok(issues.some(i => i.type === 'impressions_drop'),
    'a census that hit the row cap must never buy silence');
});

test('position_worse is suppressed as an averaging artefact of the same event', () => {
  const issues = detectAnomalies(
    { clicks: 1240, impressions: 58000, position: 16.4, botSignature: realBotSignature() },
    history({ clicks: 1150, impressions: 89000, position: 9.4 })
  );
  assert.equal(issues.filter(i => i.type === 'position_worse').length, 0);
});

test('position_worse still warns when nothing explains it', () => {
  const issues = detectAnomalies(
    { clicks: 1240, impressions: 89000, position: 16.4, botSignature: null },
    history({ clicks: 1150, impressions: 89000, position: 9.4 })
  );
  assert.ok(issues.some(i => i.type === 'position_worse'));
});

test('a missing botSignature falls back to the old clicks+position guard', () => {
  const issues = detectAnomalies(
    { clicks: 1150, impressions: 58000, position: 9.5, botSignature: null },
    history({ clicks: 1150, impressions: 89000, position: 9.4 })
  );
  assert.deepEqual(issues.map(i => i.type), [], 'clicks flat + position flat still suppresses');
});

// --- sampleShowPages / buildCWVPages (BRO-175) ---
//
// CWV_PAGES used to hardcode exactly one show page (/show/hamilton) out of
// ~2800 show routes. These pin sampleShowPages() to pick a diverse,
// reproducible-per-week set spanning every show category instead.

const FIXTURE_SHOWS = [
  ...Array.from({ length: 6 }, (_, i) => ({ slug: `bway-${i}`, category: 'broadway' })),
  ...Array.from({ length: 6 }, (_, i) => ({ slug: `off-bway-${i}`, category: 'off-broadway' })),
  ...Array.from({ length: 6 }, (_, i) => ({ slug: `we-${i}`, category: 'west-end' })),
  ...Array.from({ length: 6 }, (_, i) => ({ slug: `owe-${i}`, category: 'off-west-end' })),
  ...Array.from({ length: 6 }, (_, i) => ({ slug: `regional-${i}`, category: 'regional' })),
];

test('sampleShowPages picks more than one show page', () => {
  const picks = sampleShowPages(FIXTURE_SHOWS, { weekIndex: 3 });
  assert.ok(picks.length > 1, `expected a diverse sample, got ${picks.length}`);
});

test('sampleShowPages spans every category present, not just one', () => {
  const picks = sampleShowPages(FIXTURE_SHOWS, { weekIndex: 3 });
  const categories = new Set(
    picks.map(slug => FIXTURE_SHOWS.find(s => s.slug === slug).category)
  );
  assert.equal(categories.size, 5, `expected all 5 categories represented, got ${[...categories]}`);
});

test('sampleShowPages is reproducible for the same weekIndex', () => {
  const a = sampleShowPages(FIXTURE_SHOWS, { weekIndex: 7 });
  const b = sampleShowPages(FIXTURE_SHOWS, { weekIndex: 7 });
  assert.deepEqual(a, b);
});

test('sampleShowPages rotates its picks across different weekIndex values', () => {
  const a = sampleShowPages(FIXTURE_SHOWS, { weekIndex: 1 });
  const b = sampleShowPages(FIXTURE_SHOWS, { weekIndex: 2 });
  assert.notDeepEqual(a, b, 'consecutive weeks should not pick the identical sample forever');
});

test('sampleShowPages never exceeds the requested sample size', () => {
  const picks = sampleShowPages(FIXTURE_SHOWS, { weekIndex: 5, sampleSize: 10 });
  assert.ok(picks.length <= 10);
});

test('sampleShowPages returns an empty array for empty/invalid input', () => {
  assert.deepEqual(sampleShowPages([]), []);
  assert.deepEqual(sampleShowPages(null), []);
  assert.deepEqual(sampleShowPages(undefined), []);
});

test('buildCWVPages includes the static pages plus a diverse set of show pages', () => {
  const pages = buildCWVPages(FIXTURE_SHOWS);
  const showPages = pages.filter(url => url.includes('/show/'));
  assert.ok(showPages.length > 1, `expected multiple show pages, got ${showPages.length}`);
  assert.ok(pages.some(url => url.endsWith('/west-end')), 'static west-end page must survive');
  assert.ok(pages.some(url => url.endsWith('/off-broadway')), 'static off-broadway page must survive');
});

test('the real shows.json produces a diverse, non-hamilton-only sample', () => {
  const shows = require('../data/shows.json').shows;
  const pages = buildCWVPages(shows);
  const showPages = pages.filter(url => url.includes('/show/'));
  assert.ok(showPages.length > 1, `expected multiple show pages sampled, got ${showPages.length}`);
  assert.ok(
    !(showPages.length === 1 && showPages[0].endsWith('/show/hamilton')),
    'must not regress to sampling exactly one hardcoded show page'
  );
});
