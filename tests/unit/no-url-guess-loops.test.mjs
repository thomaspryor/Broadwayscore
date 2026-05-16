/**
 * Regression guard — no aggregator URL-pattern Cartesian guess loops.
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
 * 2026-04-26 (Lost Boys readiness audit — see comment at line 2122). The
 * dead orphan scripts/scrape-bww-roundups.js was deleted in this commit.
 *
 * This test fails if the antipattern reappears anywhere in scripts/.
 * Authoritative discovery must be by listing scrape (bww-rr-discover.js,
 * dtli-homepage-scan.js, etc.), sitemap fetch, or SERP — never by
 * Cartesian-product slug guessing. See Notion card
 * 34b637c5-416f-8167-ad13-e443be1dee1e for the rationale.
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
];

// Hardcoded URL maps (one-time backfill tables keyed by showId, not runtime
// slug guesses) are not the antipattern.
const EXEMPT_FILES = new Set([
  'fetch-bww-roundups.js',
  'download-aggregator-pages.js',
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

test('no Cartesian URL-pattern guess loops targeting aggregator hosts', () => {
  // Match: `searchUrls.push(\`...AGGREGATOR_HOST...${anything}...\`)`
  // — i.e. a template-literal push with interpolation aimed at a known
  // aggregator hostname. Catches the BWW antipattern and any future copies.
  const offenders = [];
  for (const file of ALL_FILES) {
    const content = readFileSync(file, 'utf8');
    for (const host of AGGREGATOR_HOSTS) {
      const escapedHost = host.replace(/\./g, '\\.');
      const re = new RegExp(
        String.raw`searchUrls\.push\(\`[^\`]*` + escapedHost + String.raw`[^\`]*\$\{`,
        'g'
      );
      const matches = content.match(re);
      if (matches) {
        offenders.push(`${path.relative(SCRIPTS_DIR, file)} (host=${host}, ${matches.length} match(es))`);
      }
    }
  }
  assert.equal(
    offenders.length,
    0,
    `URL-guess loop antipattern detected — replace with listing-page scrape, sitemap, or SERP:\n  ${offenders.join('\n  ')}`
  );
});

test('no titleVariations array combined with aggregator URL template pushes', () => {
  // Catches the broader shape: file defines `titleVariations` AND uses it
  // inside an aggregator URL template literal. The Cartesian shape.
  const offenders = [];
  for (const file of ALL_FILES) {
    const content = readFileSync(file, 'utf8');
    if (!/titleVariations\s*=\s*\[/.test(content)) continue;
    for (const host of AGGREGATOR_HOSTS) {
      const escapedHost = host.replace(/\./g, '\\.');
      const re = new RegExp(
        String.raw`\`https?://[^\`]*` + escapedHost + String.raw`[^\`]*\$\{(?:title|t)\b`
      );
      if (re.test(content)) {
        offenders.push(`${path.relative(SCRIPTS_DIR, file)} (host=${host})`);
        break;
      }
    }
  }
  assert.equal(
    offenders.length,
    0,
    `File defines titleVariations AND uses it to build aggregator URLs (Cartesian guess pattern):\n  ${offenders.join('\n  ')}`
  );
});

test('regression-guard self-check: orphan scrape-bww-roundups.js stays deleted', () => {
  // Belt-and-suspenders: explicitly assert the dead orphan with the original
  // antipattern doesn't get re-added. Catches accidental restore from a stash.
  const orphan = path.join(SCRIPTS_DIR, 'scrape-bww-roundups.js');
  let exists = false;
  try {
    statSync(orphan);
    exists = true;
  } catch {
    /* expected: file should not exist */
  }
  assert.equal(
    exists,
    false,
    `scripts/scrape-bww-roundups.js was re-introduced. It is the historical home of the 36-URL Cartesian guess loop. If you genuinely need it back, replace the guess loop with a listing-page scrape first.`
  );
});
