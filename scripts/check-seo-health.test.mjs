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
const { detectAnomalies } = require('./check-seo-health.js');

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

test('botDropExplainsDecline needs a real decline on both sides', () => {
  assert.equal(botDropExplainsDecline({ impressionsDelta: 10000, botImpressionsDelta: 8000 }), true);
  assert.equal(botDropExplainsDecline({ impressionsDelta: 10000, botImpressionsDelta: 5000 }), true);
  assert.equal(botDropExplainsDecline({ impressionsDelta: 10000, botImpressionsDelta: 4999 }), false);
  // Impressions UP — nothing to explain.
  assert.equal(botDropExplainsDecline({ impressionsDelta: -500, botImpressionsDelta: 8000 }), false);
  // Bot traffic GREW while impressions fell — that is not the explanation.
  assert.equal(botDropExplainsDecline({ impressionsDelta: 10000, botImpressionsDelta: -200 }), false);
});

test('botDropExplainsDecline scales the visible delta by named-query coverage', () => {
  // The real 2026-07 numbers: 11,894 visible bot impressions lost against a
  // 40,462 site-wide decline (29%) — unconvincing at face value, decisive once
  // divided by the 30.3% of impressions GSC actually named.
  const real = {
    impressionsDelta: 40462,
    botImpressionsDelta: 11894,
    namedImpressions: 49983,
    totalImpressions: 164968,
  };
  assert.equal(botDropExplainsDecline(real), true);
  // Without the coverage figures it does NOT clear the bar — proving the scaling
  // is what decides this case, not a loosened threshold.
  assert.equal(botDropExplainsDecline({
    impressionsDelta: real.impressionsDelta,
    botImpressionsDelta: real.botImpressionsDelta,
  }), false);
});

test('botDropExplainsDecline will not amplify a vanishing query sample without limit', () => {
  // 1% coverage clamps to 5%, so a 100-impression bot delta reads as 2,000 — not
  // the 10,000 an unclamped 1/coverage would manufacture.
  assert.equal(botDropExplainsDecline({
    impressionsDelta: 8000, botImpressionsDelta: 100, namedImpressions: 1000, totalImpressions: 100000,
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

test('bot-cluster departure no longer raises impressions_drop (the #530 false alarm)', () => {
  // Modelled on the real event: impressions -35%, clicks UP, position worse by 3
  // (outside the old positionHealthy <= 2 clause, which is what let it through).
  const issues = detectAnomalies(
    {
      clicks: 1240, impressions: 58000, position: 12.4,
      botSignature: {
        botImpressions: 2677, priorBotImpressions: 14571, namedImpressions: 21000,
        examples: ['site:broadwayscorecard.com/show/hamilton "show score"'],
      },
    },
    history({ clicks: 1150, impressions: 89000, position: 9.4 })
  );
  assert.deepEqual(issues.map(i => i.type), []);
});

test('the same drop WITHOUT a bot explanation still alerts', () => {
  const issues = detectAnomalies(
    {
      clicks: 1240, impressions: 58000, position: 12.4,
      botSignature: { botImpressions: 2600, priorBotImpressions: 2700, namedImpressions: 21000, examples: [] },
    },
    history({ clicks: 1150, impressions: 89000, position: 9.4 })
  );
  assert.ok(issues.some(i => i.type === 'impressions_drop' && i.severity === 'error'),
    `expected impressions_drop, got ${JSON.stringify(issues)}`);
});

test('a real ranking loss — impressions AND clicks down — alerts even with bot churn', () => {
  const issues = detectAnomalies(
    {
      clicks: 500, impressions: 58000, position: 12.4,
      botSignature: {
        botImpressions: 2677, priorBotImpressions: 14571, namedImpressions: 21000,
        examples: ['site:broadwayscorecard.com "show score"'],
      },
    },
    history({ clicks: 1150, impressions: 89000, position: 9.4 })
  );
  assert.ok(issues.some(i => i.type === 'impressions_drop'), 'impressions_drop must survive a clicks collapse');
  assert.ok(issues.some(i => i.type === 'clicks_drop'), 'clicks_drop must fire');
});

test('position_worse is suppressed as an averaging artefact of the same event', () => {
  const issues = detectAnomalies(
    {
      clicks: 1240, impressions: 58000, position: 16.4, // +7 spots
      botSignature: {
        botImpressions: 2677, priorBotImpressions: 14571, namedImpressions: 21000,
        examples: ['site:broadwayscorecard.com "show score"'],
      },
    },
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
  // No GSC query data (fetch failed) — behaviour must be unchanged from before #530.
  const issues = detectAnomalies(
    { clicks: 1150, impressions: 58000, position: 9.5, botSignature: null },
    history({ clicks: 1150, impressions: 89000, position: 9.4 })
  );
  assert.deepEqual(issues.map(i => i.type), [], 'clicks flat + position flat still suppresses');
});
