import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { sampleIndexCoverageUrls, tallyByCategory, indexCoverageVerdict, SAMPLE_QUOTAS } = require('./index-coverage-sample.js');
const fs = require('fs');

// Shaped like the real catalogue: regional/West End dwarf the NYC categories.
const mk = (cat, n) => Array.from({ length: n }, (_, i) => ({ slug: `${cat}-${i}`, category: cat }));
const shows = [...mk('broadway', 50), ...mk('off-broadway', 40), ...mk('west-end', 500), ...mk('off-west-end', 100), ...mk('regional', 900), ...mk('tour', 5)];

test('sample is quota stratified, so regional cannot dominate', () => {
  const s = sampleIndexCoverageUrls(shows, 'https://x.test');
  const by = {};
  for (const e of s) by[e.category] = (by[e.category] || 0) + 1;
  assert.deepEqual(by, SAMPLE_QUOTAS);
  assert.equal(s.length, 30);
  assert.ok(s.every(e => e.url.startsWith('https://x.test/show/')));
});

test('empty bucket drops its quota instead of throwing', () => {
  assert.equal(sampleIndexCoverageUrls(mk('broadway', 3), 'h').length, 3);
  assert.deepEqual(sampleIndexCoverageUrls(null, 'h'), []);
});

test('the 2026-11-18 failure (4/30, unknown regional/West End pages) no longer warns when core pages are indexed', () => {
  const cov = tallyByCategory([
    ...Array(11).fill({ category: 'broadway', indexed: true }), { category: 'broadway', indexed: false },
    ...Array(6).fill({ category: 'off-broadway', indexed: true }), ...Array(2).fill({ category: 'off-broadway', indexed: false }),
    ...Array(10).fill({ category: 'regional', indexed: false }),
  ]);
  assert.equal(indexCoverageVerdict({ indexed: 17, total: 30, byCategory: cov }).warn, false);
});

test('a genuinely unindexed core still warns', () => {
  const byCategory = { broadway: { indexed: 2, total: 12 }, 'off-broadway': { indexed: 2, total: 8 }, regional: { indexed: 4, total: 4 } };
  const v = indexCoverageVerdict({ indexed: 8, total: 24, byCategory });
  assert.equal(v.warn, true);
  assert.match(v.message, /Broadway/);
});

test('legacy snapshot without byCategory keeps the old rule', () => {
  assert.equal(indexCoverageVerdict({ indexed: 4, total: 30 }).warn, true);
  assert.equal(indexCoverageVerdict({ indexed: 20, total: 30 }).warn, false);
  assert.equal(indexCoverageVerdict(undefined).warn, false);
});

test('the SEO job uses the stratified sampler (guard: uniform shuffle must not return)', () => {
  const src = fs.readFileSync(new URL('../check-seo-health.js', import.meta.url), 'utf8');
  assert.match(src, /sampleIndexCoverageUrls\(shows/);
  assert.doesNotMatch(src, /showUrls\.sort\(\(\) => Math\.random\(\) - 0\.5\)/);
});
