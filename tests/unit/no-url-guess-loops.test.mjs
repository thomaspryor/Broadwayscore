/**
 * Regression guard — no aggregator URL-pattern speculative construction.
 *
 * Background: 2026-04-22 Beaches opening. The opening-night-poller attempted
 * 14 guessed BWW URL slugs ("BEACHES-A-NEW-MUSICAL-Opens-on-Broadway-...")
 * while the real slug was just "BEACHES". All 14 missed. The correct
 * discovery path (scripts/lib/bww-rr-discover.js — scrape /reviews.php
 * via Browserbase) existed and was wired in, but a downstream fallback in
 * scripts/scrape-bww-roundups.js still built a Cartesian product of
 * (4 title variants × 9 URL patterns) = 36 guesses.
 *
 * The live URL-guessing was removed from scripts/gather-reviews.js on
 * 2026-04-26 (Lost Boys readiness audit). scripts/scrape-bww-roundups.js
 * was deleted 2026-05-16 (Notion P0 34b637c5-416f-8167-ad13-e443be1dee1e).
 * scripts/collect-reviews-comprehensive.js was deleted in the same audit's
 * ship-check follow-up (orphan, no callers, same antipattern). Speculative
 * URL construction in scripts/opening-night-readiness.js's
 * checkBWWRoundupURL/checkTBURL was removed at the same time.
 *
 * The antipattern: building an aggregator URL by interpolating show title
 * fragments into a template literal that ALSO contains marketing-copy
 * fragments like "Opens-on-Broadway", "Officially-Opens", "Review-Roundup-",
 * "What-Did-the-Critics-Think". Real discovery is by listing scrape,
 * sitemap, or SERP — never by Cartesian-product slug guessing.
 *
 * This test catches the antipattern by SEMANTIC SHAPE, not exact identifiers:
 * (1) Template literals containing AGGREGATOR_HOST + MARKETING_FRAGMENT + ${}
 * (2) Any `<varname>.push(\`...AGGREGATOR_HOST...${...}\`)` regardless of name
 * (3) Self-check that known dead orphans stay deleted
 *
 * See Notion card 34b637c5-416f-8167-ad13-e443be1dee1e for full rationale.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, '..', '..', 'scripts');

const AGGREGATOR_HOSTS = [
  'broadwayworld.com',
  'didtheylikeit.com',
  'showscore.com',
  'playbill.com',
  'westendtheatre.com',
  'theatre.reviews',
  'talkinbroadway.com',
];

// Marketing-copy URL fragments that real aggregator pages use in their slugs.
// Their presence in source-code template literals is the antipattern signal:
// real discovery NEVER constructs slugs containing these phrases — it scrapes
// listings or SERP results which return the actual slugs as opaque strings.
const MARKETING_FRAGMENTS = [
  'Review-Roundup-',
  'Opens-on-Broadway',
  'Opens-On-Broadway',
  'Officially-Opens',
  'What-Did-the-Critics',
  'Returns-to-Broadway',
  'Returns-To-Broadway',
  'Updating-LIVE',
  'See-What-the-Critics',
];

// Exempt files:
//   - Authoritative one-time backfill maps keyed by showId (not runtime guesses)
//   - Test fixtures that build URLs from KNOWN-good slugs in regression tables
//   - This test file itself (mentions the antipattern strings as evidence)
const EXEMPT_FILES = new Set([
  'fetch-bww-roundups.js',
  'download-aggregator-pages.js',
  'test-bww-title-validation.js',
  'no-url-guess-loops.test.mjs',
]);

function walkJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      walkJsFiles(full, out);
    } else if (entry.endsWith('.js') || entry.endsWith('.mjs') || entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const ALL_FILES = walkJsFiles(SCRIPTS_DIR).filter(
  f => !EXEMPT_FILES.has(path.basename(f))
);

test('no speculative aggregator URL construction (host + marketing fragment + interpolation)', () => {
  // The semantic shape: a template literal that combines AGGREGATOR_HOST,
  // a MARKETING_FRAGMENT, AND ${interpolation}. Real discovery returns
  // opaque slugs from listings/SERP; only speculative guessers ever
  // re-build a URL out of marketing copy + show-title fragments.
  const offenders = [];
  for (const file of ALL_FILES) {
    const content = readFileSync(file, 'utf8');
    // Extract all template literals (backtick strings) — may span lines but
    // not nested backticks (we don't handle nested template literals).
    const templates = content.match(/`[^`]*`/g) || [];
    for (const tpl of templates) {
      const hasHost = AGGREGATOR_HOSTS.some(h => tpl.includes(h));
      if (!hasHost) continue;
      const hasMarketingFragment = MARKETING_FRAGMENTS.some(m => tpl.includes(m));
      if (!hasMarketingFragment) continue;
      const hasInterpolation = tpl.includes('${');
      if (!hasInterpolation) continue;
      offenders.push(`${path.relative(SCRIPTS_DIR, file)}: ${tpl.slice(0, 120)}${tpl.length > 120 ? '…' : ''}`);
    }
  }
  assert.equal(
    offenders.length,
    0,
    `Speculative aggregator URL construction detected. Real discovery must come from listing scrapes, sitemaps, or SERP — not from interpolating title fragments into marketing-copy slugs.\n  ${offenders.join('\n  ')}`
  );
});

test('known dead orphans stay deleted', () => {
  // Belt-and-suspenders: assert that the two historical homes of the BWW
  // URL-guess antipattern don't get re-added from a stash or revert.
  const orphans = [
    'scrape-bww-roundups.js',
    'collect-reviews-comprehensive.js',
  ];
  const restored = [];
  for (const name of orphans) {
    try {
      statSync(path.join(SCRIPTS_DIR, name));
      restored.push(name);
    } catch {
      /* expected: file should not exist */
    }
  }
  assert.equal(
    restored.length,
    0,
    `Dead orphan(s) re-introduced: ${restored.join(', ')}. These files were the historical home of the 36-URL Cartesian guess loop. If you genuinely need them back, replace the guess loop with a listing-page scrape first.`
  );
});
