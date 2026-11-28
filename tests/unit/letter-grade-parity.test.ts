/**
 * Letter-grade conversion parity invariant.
 *
 * Why this test exists: five files independently defined a letter-grade→0-100
 * table and drifted into two camps (2026-06-29). The canonical camp (A=90):
 * src/config/scoring.ts LETTER_GRADE_MAP, scripts/lib/score-extractors.js, and
 * scripts/lib/score-conversion-rules.js. The drifted camp (A=95, and worse at the
 * low end — D=65/F=50): scripts/lib/star-parse.js (audit-only, tripped ~20 false
 * HARD flags) and src/lib/admin-ingest-score.ts (LIVE manual-ingest path, scored
 * every ingested letter grade far too high). Both were re-pointed at the canonical
 * map; this test makes any future copy-paste drift fail in CI immediately, the
 * same way tier-config-consistency.test.ts guards TIER_WEIGHTS.
 *
 * Runs in the tsx lane (reads the .ts canonical). Do NOT move to the plain
 * `node --test` scripts/lib lane — importing .ts there fails to load.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { LETTER_GRADE_MAP } from '../../src/config/scoring';
import { parseScore } from '../../src/lib/admin-ingest-score';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LETTER_GRADES: extractorsMap } = require('../../scripts/lib/score-extractors');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LETTER_GRADES: rulesMap } = require('../../scripts/lib/score-conversion-rules');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseStar } = require('../../scripts/lib/star-parse');

test('score-extractors.js LETTER_GRADES == canonical LETTER_GRADE_MAP', () => {
  assert.deepEqual(extractorsMap, LETTER_GRADE_MAP);
});

test('score-conversion-rules.js LETTER_GRADES == canonical LETTER_GRADE_MAP', () => {
  assert.deepEqual(rulesMap, LETTER_GRADE_MAP);
});

test('star-parse.js (the audit) converts every grade to the canonical value', () => {
  for (const [grade, val] of Object.entries(LETTER_GRADE_MAP)) {
    assert.equal(parseStar(grade)?.score, val, `parseStar(${grade})`);
  }
});

test('admin-ingest-score.ts (live manual ingest) converts every grade to canonical', () => {
  for (const [grade, val] of Object.entries(LETTER_GRADE_MAP)) {
    assert.equal(parseScore(grade)?.score, val, `parseScore(${grade})`);
  }
  // The bug this guards: a low grade must NOT inflate (D was 65, must be 35).
  assert.equal(parseScore('D')?.score, 35);
  assert.equal(parseScore('F')?.score, 20);
});
