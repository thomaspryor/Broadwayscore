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
];

describe('Regression Guards', () => {
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
