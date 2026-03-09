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
import { readFileSync } from 'fs';
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
  // Market detection: use show.category field, not ID string matching.
  // compute-gold-lists.js previously used .id.includes('west-end') which broke
  // when ID naming conventions changed. category field is the canonical source.
  {
    file: 'scripts/compute-gold-lists.js',
    pattern: "show.category === 'west-end'",
    description:
      'Must use show.category for WE detection, not ID string matching. ' +
      'ID-based detection breaks when naming conventions change.',
  },
  {
    file: 'scripts/compute-gold-lists.js',
    pattern: "show.category && show.category !== 'broadway'",
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
];

/**
 * Negative patterns: things that must NOT appear in a file.
 * Each entry: { file, pattern, description }
 */
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
