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
  {
    file: 'scripts/compute-gold-lists.js',
    pattern: "isLondonMarket(s.category)",
    description:
      'Must use isLondonMarket(s.category) for WE detection, not ID string matching. ' +
      'ID-based detection breaks when naming conventions change.',
  },
  {
    file: 'scripts/compute-gold-lists.js',
    pattern: "s.category && s.category !== 'broadway'",
    description:
      'isBroadway() must exclude non-Broadway categories via category field, not ID matching.',
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
