/**
 * Regression Guards
 *
 * Lightweight grep-based tests that verify critical one-liner patterns
 * haven't been silently reverted by merge conflict resolutions.
 *
 * Background: Commit 8d725f33969 silently reverted the fuseResults !== null
 * guard during a merge conflict resolution, causing a flash-of-empty-results
 * bug. These tests catch that class of problem automatically.
 *
 * To add a new guard:
 *   1. Add an entry to CRITICAL_PATTERNS below
 *   2. Include a comment explaining WHY the pattern matters
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * Each entry: { file, pattern, description }
 * - file: relative path from repo root
 * - pattern: string or regex that MUST exist in the file
 * - description: why this pattern is critical (shown on failure)
 */
const CRITICAL_PATTERNS = [
  // Flash-of-empty-results fix: fuseResults is null while Fuse.js loads.
  // Using `fuseResults || []` instead causes an empty grid flash.
  // Reverted once in merge conflict resolution (commit 8d725f33969).
  {
    file: 'src/components/HomePageClient.tsx',
    pattern: 'fuseResults !== null',
    description:
      'fuseResults must use !== null check (not || []) to distinguish "loading" from "empty results". ' +
      'Without this, users see a flash of empty grid while Fuse.js loads.',
  },
  {
    file: 'src/components/WestEndPageClient.tsx',
    pattern: 'fuseResults !== null',
    description:
      'West End page must use same fuseResults !== null guard as homepage.',
  },
  {
    file: 'src/components/OffBroadwayPageClient.tsx',
    pattern: 'fuseResults !== null',
    description:
      'Off-Broadway page must use same fuseResults !== null guard as homepage.',
  },
  {
    file: 'src/components/OffWestEndPageClient.tsx',
    pattern: 'fuseResults !== null',
    description:
      'Off-West End page must use same fuseResults !== null guard as homepage.',
  },
  // Market detection: use show.category field, not ID string matching.
  // compute-gold-lists.js previously used .id.includes('west-end') which broke
  // when ID naming conventions changed. category field is the canonical source.
  // Post April 2026 refactor: classification splits WE / OWE / OB / BW into
  // disjoint sets — each is matched via an explicit category equality.
  {
    file: 'scripts/compute-gold-lists.js',
    pattern: "s.category === 'west-end'",
    description:
      'Must use explicit category equality for WE detection, not ID string matching. ' +
      'ID-based detection breaks when naming conventions change.',
  },
  {
    file: 'scripts/compute-gold-lists.js',
    pattern: "s.category === 'off-west-end'",
    description:
      'Off-West End must be its OWN set (not bundled with WE). Bundling caused ' +
      'OWE shows to appear on the West End Critical Gold list incorrectly.',
  },
  {
    file: 'scripts/compute-gold-lists.js',
    pattern: "s.category === 'off-broadway'",
    description:
      'Off-Broadway must be a distinct category set so the OB Critical Gold list ' +
      'only contains OB shows (added April 2026).',
  },
  // TodayTix London feed (location id=2) covers ALL London venues — SOLT West End
  // AND off-West End houses (Bridge, Young Vic, Donmar, Almeida, Park, Menier, etc.).
  // If 'off-west-end' is dropped from the London categories Set in update-show-status.js,
  // OWE shows stop getting closing-date extensions refreshed, their dates go stale, and
  // the grace-period auto-closer silently flips them to status=closed while they are
  // still running. Observed on 2026-04-22: Into the Woods (Bridge) stale-closed with
  // April 18 date while actually extended to May 30 (user report from Pauline).
  {
    file: 'scripts/update-show-status.js',
    pattern: /categories:\s*new\s+Set\(\[[^\]]*['"]off-west-end['"]/,
    description:
      "update-show-status.js London locations Set must include 'off-west-end'. " +
      "Without it, OWE shows never get TodayTix extension refreshes and auto-close " +
      "with stale dates. Observed for Into the Woods at Bridge Theatre on 2026-04-22.",
  },
  // titleFamilies must include all markets (WE/OB), not just Broadway.
  // classify-wrong-production.js and audit-pre2005-reviews.js previously filtered
  // to !s.category (Broadway-only), missing WE/OB title families entirely.
  {
    file: 'scripts/classify-wrong-production.js',
    pattern: /shows\.forEach\(s\s*=>\s*\{/,
    description:
      'titleFamilies must iterate ALL shows (forEach), not filter to Broadway-only. ' +
      'WE/OB shows need title families for wrongProduction classification.',
  },
  // excerpt-fields.js is the single source of truth for excerpt field names.
  // All consumers (text-quality.js, is-scoreable, index.ts, input-builder.ts,
  // merge-slug-directories.js, consolidate-duplicate-reviews.js) must import from it.
  {
    file: 'scripts/lib/excerpt-fields.js',
    pattern: 'lboRoundupExcerpt',
    description:
      'lboRoundupExcerpt must be in EXCERPT_FIELDS. WE reviews from LBO roundups ' +
      'often have no other text source — omitting this field silently blocks scoring.',
  },
  // Scoring gate scripts must use isScoreable() from lib, not inline flag checks.
  // Inline checks miss new flags when they're added to is-scoreable.js.
  {
    file: 'scripts/flag-single-model-for-rescore.js',
    pattern: 'isScoreable',
    description:
      'Must use isScoreable() for scoreability checks, not inline flag checks. ' +
      'Inline checks miss new exclusion flags when they are added.',
  },
  {
    file: 'scripts/flag-rescore-needed.js',
    pattern: 'isScoreable',
    description:
      'Must use isScoreable() for scoreability checks, not inline flag checks. ' +
      'Inline checks miss new exclusion flags when they are added.',
  },
  {
    file: 'scripts/recover-explicit-ratings.js',
    pattern: 'isScoreable',
    description:
      'Must use isScoreable() for scoreability checks, not inline flag checks. ' +
      'Inline checks miss new exclusion flags when they are added.',
  },
  // P0 score corruption guards (April 2026): aggregator star ratings must never
  // reach the P0 originalScore slot. WET scraper was the worst offender.
  {
    file: 'scripts/scrape-westendtheatre-roundups.js',
    pattern: 'aggregatorStars',
    description:
      'WET scraper must write to aggregatorStars, not originalScore. ' +
      'WET is an aggregator — its star ratings are third-party data, not outlet ratings.',
  },
  {
    file: 'scripts/scrape-westendtheatre-roundups.js',
    pattern: 'originalScore: null',
    description:
      'WET scraper must set originalScore: null explicitly. ' +
      'Without this, aggregator star ratings get P0 priority in scoring.',
  },
  {
    file: 'scripts/lib/rebuild-helpers.js',
    pattern: 'originalScoreCleared',
    description:
      'getBestScore must check originalScoreCleared flag to skip P0 for audited reviews. ' +
      'Without this guard, CI re-contamination overwrites score corrections.',
  },
  {
    file: 'scripts/lib/rebuild-helpers.js',
    pattern: 'AGGREGATOR_SOURCES_SET',
    description:
      'getBestScore must check scoreSource against aggregator set. ' +
      'Prevents aggregator scores from reaching P0 even if originalScoreCleared is missing.',
  },
  {
    file: 'scripts/collect-review-texts.js',
    pattern: 'originalScoreCleared',
    description:
      'collect-review-texts must skip re-extraction when originalScoreCleared is set. ' +
      'Without this, cleared scores get re-extracted from the same wrong page elements.',
  },
  // Blog review injection parity (April 2026): any script that computes critic
  // scores must load reviews via loadReviewsWithBlog() instead of reading
  // reviews.json directly. Otherwise its output diverges from the show page
  // (which injects blog reviews via src/lib/data-core.ts). Class bug surfaced
  // on Putnam County Spelling Bee (OB Critical Gold showed 89, show page 88).
  {
    file: 'scripts/compute-gold-lists.js',
    pattern: 'loadReviewsWithBlog',
    description: 'compute-gold-lists must use loadReviewsWithBlog() so gold list scores match show-page scores.',
  },
  {
    file: 'scripts/generate-mobile-show-details.js',
    pattern: 'loadReviewsWithBlog',
    description: 'generate-mobile-show-details must use loadReviewsWithBlog() so mobile per-show JSON matches show-page scores.',
  },
  {
    file: 'scripts/generate-mobile-data.js',
    pattern: 'loadReviewsWithBlog',
    description: 'generate-mobile-data must use loadReviewsWithBlog() so mobile-shows.json matches show-page scores.',
  },
  {
    file: 'scripts/generate-homepage-archive.js',
    pattern: 'loadReviewsWithBlog',
    description: 'generate-homepage-archive must use loadReviewsWithBlog() so homepage archive matches show-page scores.',
  },
  {
    file: 'scripts/generate-social-post.js',
    pattern: 'loadReviewsWithBlog',
    description: 'generate-social-post must use loadReviewsWithBlog() so social post scores match show-page scores.',
  },
  {
    file: 'scripts/generate-status-page.js',
    pattern: 'loadReviewsWithBlog',
    description: 'generate-status-page must use loadReviewsWithBlog() so public/opening-night-status.json scores match show-page scores.',
  },
];

/**
 * Negative patterns: things that must NOT appear in a file.
 * Each entry: { file, pattern, description }
 */
/**
 * Directory-level forbidden patterns: scanned across all .js files in a directory.
 * Each entry: { dir, pattern, description }
 */
const DIRECTORY_FORBIDDEN_PATTERNS = [
  // Never delete entire contentVerification object — it nukes classification
  // fields like wrongProduction, isFilmTv. Delete individual session subfields instead.
  {
    dir: 'scripts',
    glob: '*.js',
    pattern: /delete\s+\w+\.contentVerification\s*[;\n]/,
    description:
      'Must not delete entire contentVerification object — it nukes wrongProduction/isFilmTv flags. ' +
      'Delete individual session subfields (wrongArticle, verifiedAt, verifiedBy, reasoning) instead.',
  },
];

/**
 * Co-occurrence patterns: if pattern A exists in a file, pattern B must also exist.
 * Catches the class of bug where a new market/category is added but shared components
 * only check for existing categories, silently falling through to defaults.
 * Each entry: { dir, glob, patternA, patternB, description, exclude? }
 */
const CO_OCCURRENCE_PATTERNS = [
  // Any src/ file that checks === 'west-end' must also handle 'off-west-end'.
  // Without this, OWE shows silently fall through to Broadway defaults for
  // duration suffix, market labels, currency, SEO schemas, score thresholds, etc.
  // Fixed 14 instances of this bug on 2026-03-16.
  {
    dir: 'src',
    glob: '**/*.{ts,tsx}',
    patternA: "=== 'west-end'",
    patternB: 'off-west-end',
    description:
      'Files that check for west-end category must also handle off-west-end. ' +
      'Without this, OWE shows fall through to Broadway defaults (wrong currency, labels, thresholds).',
    exclude: [
      // These files legitimately filter to WE-only without needing OWE handling:
      'src/config/browse-pages.ts',       // WE browse pages intentionally filter to category=west-end
      'src/app/west-end/audience-buzz/page.tsx', // WE-only audience buzz page
      'src/hooks/useFormspreeCapture.ts',  // Email list routing (WE list handles both)
      'src/app/api/unsubscribe/route.ts',  // Unsubscribe routing
      'src/app/unsubscribe/UnsubscribeClient.tsx', // Unsubscribe UI
      'src/components/HeaderSubscribeButton.tsx', // Subscribe button market label
      'src/components/FooterEmailCapture.tsx',    // Uses Market type ('broadway'|'west-end'), OWE routed via hook
      'src/lib/market-utils.ts',                  // Source of truth — defines isLondonMarket() itself
      'src/lib/venue-classification.ts',           // Re-exports from market-utils + venue-specific logic
    ],
  },
];

const FORBIDDEN_PATTERNS = [
  // Never use ID string matching for market detection in gold lists
  {
    file: 'scripts/compute-gold-lists.js',
    pattern: /\.id\.includes\(['"]west-end['"]\)/,
    description:
      'Must not use .id.includes("west-end") for market detection. Use show.category instead.',
  },
  {
    file: 'scripts/compute-gold-lists.js',
    pattern: /\.id\.includes\(['"]off-broadway['"]\)/,
    description:
      'Must not use .id.includes("off-broadway") for market detection. Use show.category instead.',
  },
  // Never hardcode /nyc/ for TodayTix show URLs — WE/OWE shows live at /london/.
  // Hardcoding /nyc/ makes the JSON-LD fetch 404 for London shows, forcing a
  // fallback to LLM creative-team generation that hallucinates directors for
  // famous same-title revivals. Use the todayTixUrl() helper instead.
  {
    file: 'scripts/auto-fix-show-data.js',
    pattern: /['"`]https?:\/\/www\.todaytix\.com\/nyc\/shows\//,
    description:
      'Must not hardcode /nyc/ for TodayTix URLs. Use todayTixUrl(show, info) helper ' +
      'so WE/OWE shows get /london/ and JSON-LD director extraction works.',
  },
];

describe('Regression Guards — must exist', () => {
  for (const { file, pattern, description } of CRITICAL_PATTERNS) {
    test(`${file}: ${typeof pattern === 'string' ? pattern : pattern.source}`, () => {
      const filePath = join(ROOT, file);
      let content;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch (err) {
        assert.fail(`Cannot read ${file}: ${err.message}`);
      }

      const found =
        typeof pattern === 'string'
          ? content.includes(pattern)
          : pattern.test(content);

      assert.ok(
        found,
        `REGRESSION DETECTED in ${file}!\n` +
          `Expected pattern: ${pattern}\n` +
          `Reason: ${description}\n` +
          `This pattern may have been accidentally removed during a merge conflict resolution.`
      );
    });
  }
});

describe('Regression Guards — must NOT exist', () => {
  for (const { file, pattern, description } of FORBIDDEN_PATTERNS) {
    test(`${file}: forbid ${typeof pattern === 'string' ? pattern : pattern.source}`, () => {
      const filePath = join(ROOT, file);
      let content;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch (err) {
        assert.fail(`Cannot read ${file}: ${err.message}`);
      }

      const found =
        typeof pattern === 'string'
          ? content.includes(pattern)
          : pattern.test(content);

      assert.ok(
        !found,
        `FORBIDDEN PATTERN DETECTED in ${file}!\n` +
          `Found: ${pattern}\n` +
          `Reason: ${description}`
      );
    });
  }
});

describe('Regression Guards — co-occurrence patterns', () => {
  for (const { dir, glob, patternA, patternB, description, exclude = [] } of CO_OCCURRENCE_PATTERNS) {
    test(`${dir}/${glob}: files with "${patternA}" must also contain "${patternB}"`, () => {
      const dirPath = join(ROOT, dir);
      const violations = [];

      // Recursively find matching files
      function walk(d) {
        const entries = readdirSync(d, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(d, entry.name);
          if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.next') {
            walk(fullPath);
          } else if (entry.isFile()) {
            // Simple glob matching for **/*.{ts,tsx}
            const exts = glob.match(/\{([^}]+)\}/)?.[1]?.split(',') || [glob.replace('**/*.', '')];
            if (!exts.some(ext => entry.name.endsWith('.' + ext))) continue;

            const relPath = fullPath.replace(ROOT + '/', '');
            if (exclude.some(ex => relPath === ex)) continue;

            try {
              const content = readFileSync(fullPath, 'utf8');
              if (content.includes(patternA) && !content.includes(patternB)) {
                violations.push(relPath);
              }
            } catch (err) {
              // Skip unreadable files
            }
          }
        }
      }

      walk(dirPath);

      assert.strictEqual(
        violations.length,
        0,
        `CO-OCCURRENCE VIOLATION:\n` +
          `Files containing "${patternA}" but missing "${patternB}":\n` +
          `  ${violations.join('\n  ')}\n` +
          `Reason: ${description}`
      );
    });
  }
});

describe('Regression Guards — directory-level forbidden patterns', () => {
  for (const { dir, glob, pattern, description } of DIRECTORY_FORBIDDEN_PATTERNS) {
    test(`${dir}/${glob}: forbid ${pattern.source}`, () => {
      const dirPath = join(ROOT, dir);
      const ext = glob.replace('*', '');
      const files = readdirSync(dirPath).filter(f => f.endsWith(ext));
      const violations = [];

      for (const file of files) {
        const filePath = join(dirPath, file);
        try {
          const content = readFileSync(filePath, 'utf8');
          if (pattern.test(content)) {
            violations.push(file);
          }
          // Reset regex lastIndex for next file
          pattern.lastIndex = 0;
        } catch (err) {
          // Skip unreadable files
        }
      }

      assert.strictEqual(
        violations.length,
        0,
        `FORBIDDEN PATTERN in ${dir}/:\n` +
          `Pattern: ${pattern}\n` +
          `Found in: ${violations.join(', ')}\n` +
          `Reason: ${description}`
      );
    });
  }
});
