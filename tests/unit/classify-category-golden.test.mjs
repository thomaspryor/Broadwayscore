/**
 * Golden-fixture test for classifyCategory.
 *
 * Pins the output of every known award category string through
 * classifyCategory(). Any future change to the classifier must update
 * this fixture explicitly — preventing silent regressions when new
 * ceremony patterns are added (e.g. OBIE "Direction" accidentally
 * re-bucketing existing Tony Direction wins).
 *
 * To update the fixture after an intentional change:
 *   node -e "
 *     const { classifyCategory } = require('./scripts/lib/classify-category.js');
 *     const fs = require('fs');
 *     // ... regenerate and write tests/fixtures/classify-category-baseline.json
 *   "
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { classifyCategory } = require(path.join(__dirname, '../../scripts/lib/classify-category.js'));
const fixture = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/classify-category-baseline.json'), 'utf8'));

test('classifyCategory golden fixture — all categories produce expected output', () => {
  const entries = Object.entries(fixture);
  assert.ok(entries.length >= 50, `Fixture must have ≥50 entries, got ${entries.length}`);

  const failures = [];
  for (const [category, expected] of entries) {
    const actual = classifyCategory(category);
    const match = JSON.stringify(actual) === JSON.stringify(expected);
    if (!match) {
      failures.push({ category, expected, actual });
    }
  }

  if (failures.length > 0) {
    const lines = failures.map(f =>
      `  "${f.category}": expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`
    );
    assert.fail(`classifyCategory golden fixture has ${failures.length} mismatch(es):\n${lines.join('\n')}\n\nTo update the fixture after an intentional change, regenerate tests/fixtures/classify-category-baseline.json.`);
  }
});
