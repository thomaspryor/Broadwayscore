/**
 * Topology guard: rebuild-fast.yml MUST run flag-wrong-production-by-date before
 * the rebuild step.
 *
 * Rationale (Notion 386637c5-416f-81b9): the date-based contamination flagger only
 * ran in the daily full rebuild (rebuild-reviews.yml). During opening-night windows
 * the rapid fast-rebuilds — and the post-scoring rebuild-fast dispatched by
 * llm-ensemble-score — skipped it, so freshly SERP-discovered prior-production reviews
 * (e.g. Glengarry WE 2026 counting the 2025 Broadway Culkin/Odenkirk reviews from
 * EW/NYDaily/Yahoo) stayed wrongProduction:false and inflated the live count for days,
 * until a daily full rebuild — itself a known cancellation magnet. The flagger is
 * pure-local and respects priorRuns + manual-clear, so it is safe in the fast path.
 * If this step is ever dropped, the opening-night contamination window reopens.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const yml = readFileSync(join(here, '../../.github/workflows/rebuild-fast.yml'), 'utf8');

describe('rebuild-fast contamination guard', () => {
  test('runs flag-wrong-production-by-date', () => {
    assert.match(yml, /node scripts\/flag-wrong-production-by-date\.js/,
      'rebuild-fast.yml must run flag-wrong-production-by-date.js (opening-night contamination guard)');
  });

  test('runs the flagger before the rebuild step', () => {
    const flagIdx = yml.indexOf('flag-wrong-production-by-date.js');
    const rebuildIdx = yml.indexOf('rebuild-all-reviews.js');
    assert.ok(flagIdx > -1 && rebuildIdx > -1, 'both steps must be present');
    assert.ok(flagIdx < rebuildIdx,
      'the date flagger must run BEFORE rebuild so contaminants are excluded from this build');
  });
});
