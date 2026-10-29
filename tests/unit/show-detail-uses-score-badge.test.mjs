// BRO-5581: the legacy show header must use the shared badge while preserving
// the page's coverage-floor decision and the existing responsive dimensions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../../src/app/show/[slug]/page.tsx', import.meta.url), 'utf8');
const scoreBox = page.match(/const scoreBox = \(([\s\S]*?)\n\s*\);/)?.[1] ?? '';

test('show detail imports and renders ScoreBadge from the shared card components', () => {
  assert.match(page, /import \{[^}]*\bScoreBadge\b[^}]*\} from '@\/components\/show-cards'/);
  assert.match(scoreBox, /<ScoreBadge\b/);
  assert.match(page, /\{scoreBox\}/, 'the shared badge must be rendered in the score row');
  assert.doesNotMatch(scoreBox, /<(?:div|span)\b/, 'do not hand-roll the score box');
});

test('show detail delegates score rounding and market colors to the shared badge', () => {
  assert.match(scoreBox, /score=\{score\}/);
  assert.match(scoreBox, /category=\{show\.category\}/);
  assert.doesNotMatch(page, /getScoreColorClass|const scoreColorClass/);
});

test('show detail keeps the existing large badge dimensions without local overrides', () => {
  assert.match(scoreBox, /size="lg"/);
  assert.doesNotMatch(scoreBox, /className=|style=/);
  assert.match(page, /<div className="flex-shrink-0">\{scoreBox\}<\/div>/,
    'the badge must not shrink beside long labels on mobile');
  assert.match(page, /className="pt-0\.5 min-w-0 break-words"/,
    'long tier labels must wrap beside the fixed-width badge');
});

test('show detail passes its final TBD decision without reapplying the review-count gate', () => {
  assert.match(page, /const showTBD = applyCoverageFloor\(/);
  assert.match(scoreBox, /reviewCount=\{showTBD \? 0 : undefined\}/,
    'zero keeps held scores TBD; undefined preserves scores protected by the coverage floor');
  assert.doesNotMatch(scoreBox, /status=\{show\.status\}/,
    'the coverage floor already accounts for status and can override it');
});
