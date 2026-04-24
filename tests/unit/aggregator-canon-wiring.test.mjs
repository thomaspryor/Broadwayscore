/**
 * Wiring test — each aggregator extractor imports and calls canonicalizeCritic
 * from scripts/lib/critic-canonicalization.js. If someone removes the wire
 * (refactor, copy-paste new extractor), this test breaks.
 *
 * Session 3 #13 + /what-else audit follow-up 2026-04-24.
 * Covers: DTLI, Playbill Verdict, BWW Reviews, NYSR.
 *
 * Show Score skipped: its real review-write path runs through gather-reviews
 * → rebuild-all-reviews which already canonicalizes at both stages.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const CHECKS = [
  { file: 'scripts/extract-dtli-reviews.js', description: 'DTLI extractor' },
  { file: 'scripts/scrape-playbill-verdict.js', description: 'Playbill Verdict scraper' },
  { file: 'scripts/scrape-bww-reviews.js', description: 'BWW Reviews scraper' },
  { file: 'scripts/scrape-nysr-reviews.js', description: 'NYSR scraper' },
  // gather-reviews already had this wired in Session 3 — included for completeness
  { file: 'scripts/gather-reviews.js', description: 'gather-reviews BWW RR extractor' },
  // rebuild-all-reviews — the post-hoc canonicalization pass
  { file: 'scripts/rebuild-all-reviews.js', description: 'rebuild-all-reviews' },
];

describe('aggregator critic canonicalization — wiring', () => {
  for (const check of CHECKS) {
    test(`${check.description} imports canonicalizeCritic`, () => {
      const contents = readFileSync(resolve(ROOT, check.file), 'utf8');
      assert.match(contents, /require\(['"]\.\/lib\/critic-canonicalization['"]\)/,
        `${check.file} must import from ./lib/critic-canonicalization — breaking this silently reverts the attribution fix for this aggregator`);
      assert.match(contents, /canonicalizeCritic\s*\(/,
        `${check.file} must actually CALL canonicalizeCritic (not just import it)`);
    });
  }
});
