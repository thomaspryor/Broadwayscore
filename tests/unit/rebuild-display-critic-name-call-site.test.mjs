/**
 * S7-T2 (2026 data audit, BRO-4204): reviews.json carries the critic DISPLAY
 * name or null, produced by exactly one displayCriticName() call at the
 * emission site in scripts/rebuild-all-reviews.js. Consumers keep no map of
 * their own: src/lib/data-reviews.ts groups by the emitted name and
 * scripts/generate-mobile-show-details.js emits it unchanged, matching
 * TOP_CRITICS as an exact-string set of canonical spellings.
 *
 * These are source-shape assertions on purpose: the rebuild cannot be
 * required (it runs on load and writes reviews.json), and the regression
 * this guards is a second call or a second map creeping back in.
 *
 * Run: node --test tests/unit/rebuild-display-critic-name-call-site.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { displayCriticName } = require('../../scripts/lib/critic-display-name.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

/**
 * Source with `//` line comments and `/* *\/` blocks blanked (same length, so
 * offsets still line up). Line comments go first: a `//` comment that quotes
 * a glob like `scripts/lib/*.js` would otherwise open a block comment that
 * swallows everything up to the next `*\/`.
 */
function code(src) {
  return src
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, pre) => pre + ' '.repeat(m.length - pre.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
}

const rebuild = code(read('scripts/rebuild-all-reviews.js'));
const mobile = code(read('scripts/generate-mobile-show-details.js'));
const dataReviews = code(read('src/lib/data-reviews.ts'));

test('rebuild-all-reviews.js requires the helper and calls displayCriticName() exactly once', () => {
  assert.match(rebuild, /require\('\.\/lib\/critic-display-name'\)/, 'helper is required');
  const calls = rebuild.match(/displayCriticName\(/g) || [];
  assert.equal(calls.length, 1, `expected exactly one displayCriticName( call, found ${calls.length}`);
});

test('the one call is inside the criticName emission of the review record', () => {
  const emission = rebuild.indexOf('criticName: (() => {');
  assert.ok(emission > 0, 'criticName emission IIFE exists');
  const callAt = rebuild.indexOf('displayCriticName(');
  const closeAt = rebuild.indexOf('})(),', emission);
  assert.ok(callAt > emission && callAt < closeAt, 'displayCriticName( sits between the emission IIFE open and its close');
  // The sibling-recovered byline (card #190) is what the helper receives —
  // recovery picks WHICH raw string, the helper decides HOW it displays.
  const body = rebuild.slice(emission, closeAt);
  assert.match(body, /resolveCriticName\(normalizeCriticName\(data\.criticName\)/);
  assert.match(body, /displayCriticName\(\s*resolved\.name/);
  // Emitted value is the helper's result, never the resolved raw name.
  assert.match(body, /return display;/);
  assert.doesNotMatch(body, /return resolved\.name/);
});

test('no second display transformation after emission: the post-hoc entity decode no longer touches criticName', () => {
  assert.doesNotMatch(rebuild, /review\.criticName = decodeHtmlEntities\(review\.criticName\)/);
});

test('consumers keep no critic-name map: data-reviews.ts and the mobile generator read the emitted name as is', () => {
  for (const [label, src] of [['src/lib/data-reviews.ts', dataReviews], ['scripts/generate-mobile-show-details.js', mobile]]) {
    assert.doesNotMatch(src, /CRITIC_NAME_FIXES\s*[:=]/, `${label}: no fixes map`);
    assert.doesNotMatch(src, /critic-name-fixes\.json/, `${label}: no fixes import`);
    assert.doesNotMatch(src, /displayCriticName/, `${label}: the helper runs at emission only`);
  }
  assert.match(mobile, /cn: r\.criticName \|\| null/, 'mobile JSON emits the name unchanged');
});

function topCriticsFrom(src, label) {
  const m = src.match(/const TOP_CRITICS(?::\s*ReadonlySet<string>)? = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, `${label}: TOP_CRITICS literal found`);
  const names = Array.from(m[1].matchAll(/'([^']+)'/g), (x) => x[1]);
  assert.ok(names.length >= 10, `${label}: TOP_CRITICS has entries`);
  return names;
}

test('every TOP_CRITICS copy is an exact-string set of canonical display names (fixed points of displayCriticName)', () => {
  // The TS side's set lives in src/config/scoring.ts (engine.ts imports it).
  const copies = [
    ['scripts/generate-mobile-show-details.js', mobile],
    ['src/config/scoring.ts', code(read('src/config/scoring.ts'))],
    ['scripts/lib/compute-critic-score.js', code(read('scripts/lib/compute-critic-score.js'))],
  ];
  const sets = copies.map(([label, src]) => [label, topCriticsFrom(src, label)]);
  for (const [label, names] of sets) {
    for (const name of names) {
      assert.equal(displayCriticName(name), name, `${label}: "${name}" is what the emitter writes`);
    }
  }
  // The three copies agree (drift = a top critic silently losing T1 in one consumer).
  const [, a] = sets[0];
  for (const [label, names] of sets.slice(1)) {
    assert.deepEqual([...names].sort(), [...a].sort(), `${label} matches the mobile generator's set`);
  }
});
