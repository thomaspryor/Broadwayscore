/**
 * Regression: a "no-star" outlet (one that publishes review TEXT but no star
 * rating) must still be LLM-scoreable. The LLM ensemble scores text into
 * `assignedScore` (a composite); it never fabricates an `originalScore` (the raw
 * published star), so the "no fabricated star on no-star outlets" invariant is
 * enforced by check-score-integrity.js — NOT by refusing to score.
 *
 * Bug (2026-05-30): scripts/llm-scoring/is-scoreable.ts had drifted from its JS
 * mirror by adding `NO_STAR_OUTLETS = new Set(['london-theatre'])` and a gate
 * `if (NO_STAR_OUTLETS.has(data.outletId)) return false`. That silently blocked
 * ALL scoring for london-theatre, orphaning 5 real West End reviews unscored
 * (beetlejuice, care, end-of-the-rainbow, equus, one-flew-over-the-cuckoos-nest)
 * with the scorer logging only "[SKIP] ...: unknown".
 *
 * Two guards below:
 *  1. Behavior — the JS mirror (canonical) scores a london-theatre review.
 *  2. Drift — the TS source must not reintroduce an outlet-name blocklist.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isScoreable } = require('../../scripts/lib/is-scoreable.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const longReviewText = 'Beetlejuice the musical has arrived, loud and proud, at the Prince Edward Theatre. '.repeat(20);

describe('isScoreable — no-star outlet (london-theatre) regression', () => {
  test('london-theatre review with complete text IS scoreable', () => {
    const data = {
      contentTier: 'complete',
      isFullReview: true,
      fullText: longReviewText,
      outletId: 'london-theatre',
      criticName: 'Anya Ryan',
    };
    assert.strictEqual(isScoreable(data, { id: 'beetlejuice-west-end-2026', status: 'open' }), true,
      'A no-star outlet that publishes review text must be sent to the LLM scorer');
  });

  test('TS source does not reintroduce an outlet-name scoreability blocklist', () => {
    // Strip comments so the guard matches CODE only (this file's own comment
    // mentions NO_STAR_OUTLETS by name to explain the regression).
    const ts = readFileSync(join(ROOT, 'scripts/llm-scoring/is-scoreable.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/NO_STAR_OUTLETS\s*=/.test(ts),
      'is-scoreable.ts must not declare a no-star outlet blocklist — the star invariant lives in check-score-integrity.js');
    assert.ok(!/\.has\(\s*data\.outletId\s*\)\s*\)\s*return false/.test(ts),
      'is-scoreable.ts must not block scoring by outletId membership');
  });
});
