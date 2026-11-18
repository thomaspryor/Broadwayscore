// Owner decision 2026-11-18 (BRO-7805): every audience source's ratings count
// and display however few there are; only the cross-source total
// (src/config/audience-grade.json minReviews) gates the grade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { isSourceActive, calculateCombinedScore } = require('./audience-weighting.js');

test('a Theatr sample under 10 votes still counts', () => {
  const theatr = { score: 57, reviewCount: 7 };
  assert.equal(isSourceActive('theatr', theatr, { category: 'broadway' }), true);
  const { weights } = calculateCombinedScore({ mezzanine: { score: 45, reviewCount: 16 }, theatr }, { category: 'broadway' });
  assert.ok(weights.theatr > 0, 'Theatr gets weight');
});

test('site components carry no per-source Theatr vote floor', () => {
  for (const f of ['src/components/AudienceBuzzCard.tsx', 'src/components/SortableAudienceBuzzTable.tsx', 'scripts/generate-mobile-show-details.js']) {
    const src = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /theatr'\s*&&\s*\([^)]*reviewCount[^)]*\)\s*<\s*10/, `${f} hardcodes a Theatr floor`);
  }
});
