import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { sampleIndexCoverageUrls, tallyByCategory, indexCoverageVerdict, describeIndexCoverage, SAMPLE_QUOTAS } = require('./index-coverage-sample.js');
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

test('core sample prefers live shows over closed history', () => {
  const pool = [...mk('broadway', 100).map((x, i) => ({ ...x, status: i < 20 ? 'open' : 'closed' })), ...mk('off-broadway', 100).map((x, i) => ({ ...x, status: i < 20 ? 'open' : 'closed' }))];
  const s = sampleIndexCoverageUrls(pool, 'h');
  const liveSlugs = new Set(pool.filter(x => x.status === 'open').map(x => x.slug));
  assert.ok(s.every(e => liveSlugs.has(e.url.replace('h/show/', ''))));
  assert.equal(s.length, 20);
});

test('core with too few live shows is topped up from closed ones', () => {
  const pool = [{ slug: 'a', category: 'broadway', status: 'open' }, ...mk('broadway', 30).map(x => ({ ...x, status: 'closed' }))];
  const s = sampleIndexCoverageUrls(pool, 'h');
  assert.equal(s.length, 12);
  assert.ok(s.some(e => e.url === 'h/show/a'));
});

test('zero core inspected (fallback sample or every call failed) falls back to the overall rule, never healthy', () => {
  const byCategory = { unknown: { indexed: 0, total: 2 } };
  assert.equal(indexCoverageVerdict({ indexed: 0, total: 2, byCategory }).warn, true);
  assert.equal(indexCoverageVerdict({ indexed: 0, total: 0, byCategory: {} }).warn, false);
});

test('health-check.js row uses the verdict helper (guard against reverting the wiring)', () => {
  const src = fs.readFileSync(new URL('../health-check.js', import.meta.url), 'utf8');
  assert.match(src, /indexCoverageVerdict\(data\.indexCoverage\)/);
  assert.doesNotMatch(src, /indexed \/ total < 0\.5/);
});

test('describeIndexCoverage shows overall and core rates', () => {
  const t = describeIndexCoverage({ rate: 13, indexed: 4, total: 30, byCategory: { broadway: { indexed: 4, total: 8 } } });
  assert.match(t, /13% \(4\/30\)/);
  assert.match(t, /Broadway\/Off-Broadway 50% \(4\/8\)/);
  assert.equal(describeIndexCoverage({ rate: 13, indexed: 4, total: 30 }), '13% (4/30)');
});
