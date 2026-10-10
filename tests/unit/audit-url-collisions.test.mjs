/**
 * Unit tests for scripts/lib/url-collision-classify.js — the pure
 * classifier behind scripts/audit-url-collisions.js (BRO-62: audit 946
 * multi-critic URL collisions in review-texts).
 *
 * Run: node --test tests/unit/audit-url-collisions.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeFullTextForCompare,
  isUnknownCritic,
  isSafeAggregatorOutlet,
  isAlreadyExcluded,
  classifyCollisionGroup,
} = require('../../scripts/lib/url-collision-classify.js');

const body = (n, ch = 'x') => ch.repeat(n);

test('normalizeFullTextForCompare: collapses whitespace and lowercases', () => {
  assert.equal(normalizeFullTextForCompare('  Hello   World \n\n'), 'hello world');
  assert.equal(normalizeFullTextForCompare(''), '');
  assert.equal(normalizeFullTextForCompare(null), '');
});

test('isUnknownCritic: recognizes the Unknown placeholder', () => {
  assert.equal(isUnknownCritic('Unknown'), true);
  assert.equal(isUnknownCritic('unknown'), true);
  assert.equal(isUnknownCritic(''), true);
  assert.equal(isUnknownCritic(null), true);
  assert.equal(isUnknownCritic('Ben Brantley'), false);
});

test('isSafeAggregatorOutlet: bww-roundup and dtli are aggregators, a real outlet is not', () => {
  assert.equal(isSafeAggregatorOutlet('bww-roundup'), true);
  assert.equal(isSafeAggregatorOutlet('dtli'), true);
  assert.equal(isSafeAggregatorOutlet('nytimes'), false);
  assert.equal(isSafeAggregatorOutlet(null), false);
});

test('isAlreadyExcluded: any exclusion/duplicate field counts', () => {
  assert.equal(isAlreadyExcluded({ wrongShow: true }), true);
  assert.equal(isAlreadyExcluded({ wrongProduction: true }), true);
  assert.equal(isAlreadyExcluded({ duplicateOf: 'x.json' }), true);
  assert.equal(isAlreadyExcluded({ duplicateTextOf: 'x.json' }), true);
  assert.equal(isAlreadyExcluded({}), false);
});

// ---------------------------------------------------------------------------
// classifyCollisionGroup
// ---------------------------------------------------------------------------

test('classifyCollisionGroup: fewer than 2 entries is not a collision', () => {
  const r = classifyCollisionGroup('nytimes', [{ file: 'a.json', data: {} }]);
  assert.equal(r.category, 'not-a-collision');
});

test('classifyCollisionGroup: known aggregator outlet is always safe (BWW roundup, many critics)', () => {
  const entries = [
    { file: 'bww-roundup--critic-a.json', data: { criticName: 'Critic A', fullText: body(200, 'a') } },
    { file: 'bww-roundup--critic-b.json', data: { criticName: 'Critic B', fullText: body(200, 'b') } },
  ];
  const r = classifyCollisionGroup('bww-roundup', entries);
  assert.equal(r.category, 'safe-aggregator');
});

test('classifyCollisionGroup: isRoundupArticle/isCombinedReview flag clears a real-outlet group', () => {
  const entries = [
    { file: 'nytimes--a.json', data: { criticName: 'A', fullText: body(200, 'a'), isRoundupArticle: true } },
    { file: 'nytimes--b.json', data: { criticName: 'B', fullText: body(200, 'b') } },
  ];
  const r = classifyCollisionGroup('nytimes', entries);
  assert.equal(r.category, 'safe-flagged');
});

test('classifyCollisionGroup: already-excluded when only one file is still live', () => {
  const entries = [
    { file: 'nytimes--a.json', data: { criticName: 'A', fullText: body(200, 'a'), wrongShow: true } },
    { file: 'nytimes--b.json', data: { criticName: 'B', fullText: body(200, 'b') } },
  ];
  const r = classifyCollisionGroup('nytimes', entries);
  assert.equal(r.category, 'already-excluded');
});

test('classifyCollisionGroup: needs-review when content is too short to compare', () => {
  const entries = [
    { file: 'nytimes--a.json', data: { criticName: 'A', fullText: 'short' } },
    { file: 'nytimes--b.json', data: { criticName: 'B', fullText: 'also short' } },
  ];
  const r = classifyCollisionGroup('nytimes', entries);
  assert.equal(r.category, 'needs-review');
});

test('classifyCollisionGroup: needs-review when two named critics have genuinely different text', () => {
  const entries = [
    { file: 'nytimes--a.json', data: { criticName: 'Ben Brantley', fullText: body(300, 'a') } },
    { file: 'nytimes--b.json', data: { criticName: 'Charles Isherwood', fullText: body(300, 'b') } },
  ];
  const r = classifyCollisionGroup('nytimes', entries);
  assert.equal(r.category, 'needs-review');
});

test('classifyCollisionGroup: contamination-fixable when an Unknown file duplicates a named critic verbatim', () => {
  const text = body(300, 'a');
  const entries = [
    { file: 'nytimes--jesse-green.json', data: { criticName: 'Jesse Green', fullText: text } },
    { file: 'nytimes--unknown.json', data: { criticName: 'Unknown', fullText: text } },
  ];
  const r = classifyCollisionGroup('nytimes', entries);
  assert.equal(r.category, 'contamination-fixable');
  assert.equal(r.canonical, 'nytimes--jesse-green.json');
  assert.deepEqual(r.contaminated, ['nytimes--unknown.json']);
});

test('classifyCollisionGroup: contamination-fixable is case/whitespace-insensitive on content', () => {
  const entries = [
    { file: 'nytimes--jesse-green.json', data: { criticName: 'Jesse Green', fullText: `  ${body(300, 'a')}  \n` } },
    { file: 'nytimes--unknown.json', data: { criticName: '', fullText: body(300, 'a').toUpperCase() } },
  ];
  const r = classifyCollisionGroup('nytimes', entries);
  assert.equal(r.category, 'contamination-fixable');
});

test('classifyCollisionGroup: contamination-needs-review (NYSR-type) when two DIFFERENT named critics are byte-identical', () => {
  const text = body(300, 'a');
  const entries = [
    { file: 'hollywood-reporter--david-rooney.json', data: { criticName: 'David Rooney', fullText: text } },
    { file: 'hollywood-reporter--angie-han.json', data: { criticName: 'Angie Han', fullText: text } },
  ];
  const r = classifyCollisionGroup('hollywood-reporter', entries);
  assert.equal(r.category, 'contamination-needs-review');
  assert.deepEqual(
    r.files.sort(),
    ['hollywood-reporter--angie-han.json', 'hollywood-reporter--david-rooney.json'].sort()
  );
});

test('classifyCollisionGroup: 3+ files, mixed — one wrongShow-excluded, two identical Unknown/named remain', () => {
  const text = body(300, 'a');
  const entries = [
    { file: 'nytimes--a.json', data: { criticName: 'Old Wrong', fullText: body(100, 'z'), wrongShow: true } },
    { file: 'nytimes--jesse-green.json', data: { criticName: 'Jesse Green', fullText: text } },
    { file: 'nytimes--unknown.json', data: { criticName: 'Unknown', fullText: text } },
  ];
  const r = classifyCollisionGroup('nytimes', entries);
  assert.equal(r.category, 'contamination-fixable');
  assert.equal(r.canonical, 'nytimes--jesse-green.json');
});

test('classifyCollisionGroup: a file already carrying duplicateTextOf does not re-trigger', () => {
  const text = body(300, 'a');
  const entries = [
    { file: 'nytimes--jesse-green.json', data: { criticName: 'Jesse Green', fullText: text } },
    { file: 'nytimes--unknown.json', data: { criticName: 'Unknown', fullText: text, duplicateTextOf: 'nytimes--jesse-green.json' } },
  ];
  const r = classifyCollisionGroup('nytimes', entries);
  assert.equal(r.category, 'already-excluded');
});
