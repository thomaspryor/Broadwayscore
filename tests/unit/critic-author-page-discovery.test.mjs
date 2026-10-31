// TESTS-VS-DERIVED-DATA-EXEMPT: checks coverage of curated overrides using the shared active selection, without pinning review facts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { selectActiveCritics, authorSlug, discoveryCandidates, verifyAuthorPage, discoverAuthorPages }
  = require('../../scripts/lib/critic-author-page-discovery');
const pages = require('../../data/critic-author-pages.json');

const registry = { critics: {
  'nyt-critic': { displayName: 'NYT Critic', primaryOutlet: 'nytimes', totalReviews: 20 },
  'newyorker-critic': { displayName: 'New Yorker Critic', primaryOutlet: 'newyorker', totalReviews: 35 },
  'vulture-critic': { displayName: 'Vulture Critic', primaryOutlet: 'vulture', totalReviews: 70 },
  retired: { displayName: 'Retired Critic', primaryOutlet: 'nytimes', totalReviews: 400 },
  occasional: { displayName: 'Occasional Critic', primaryOutlet: 'newyorker', totalReviews: 19 },
  unknown: { displayName: 'Unknown', primaryOutlet: 'nytimes', totalReviews: 50 },
  lower: { displayName: 'Lower Tier', primaryOutlet: 'blog', totalReviews: 40 },
  undated: { displayName: 'Undated Critic', primaryOutlet: 'nytimes', totalReviews: 40 },
} };
const outlets = { outlets: { nytimes: { tier: 1 }, newyorker: { tier: 2 }, vulture: { tier: 1 }, blog: { tier: 3 } } };
const reviews = Object.values(registry.critics).filter(c => c.displayName !== 'Undated Critic')
  .map(c => ({ criticName: c.displayName, publishDate: c.displayName === 'Retired Critic' ? '2024-12-31' : '2025-01-01' }));
// Include older and undated duplicates to exercise the latest-date selection.
reviews.push({ criticName: 'NYT Critic', publishDate: '2020-01-01' }, { criticName: 'NYT Critic' });
const active = selectActiveCritics(registry, reviews, outlets);
const candidates = discoveryCandidates(active, {});
const pageFor = c => ({ content: `<html><head><link rel="canonical" href="${c.url}"></head><body><h1>${c.name}</h1></body></html>`, status: 200 });

test('shares the audit active set: date floor, 20 reviews, T1/T2, known name', () => {
  assert.deepEqual(active.map(c => c.slug), ['vulture-critic', 'newyorker-critic', 'nyt-critic']);
  assert.equal(active.find(c => c.slug === 'nyt-critic').lastDate, '2025-01-01');
  assert.deepEqual(selectActiveCritics(registry.critics, reviews, outlets.outlets), active);
});

test('derives deterministic names and correct outlet URL and override keys', () => {
  assert.equal(authorSlug('  Zoë O’Neill.  '), 'zoe-oneill');
  assert.equal(authorSlug('Laura Collins-Hughes'), 'laura-collins-hughes');
  assert.deepEqual(candidates.map(c => [c.key, c.url]), [
    ['vulture', 'https://www.vulture.com/author/vulture-critic/'],
    ['newyorker', 'https://www.newyorker.com/contributors/new-yorker-critic'],
    ['nyt', 'https://www.nytimes.com/by/nyt-critic'],
  ]);
});

test('existing BWW or former-outlet overrides do not suppress current-outlet discovery', () => {
  const input = { 'nyt-critic': { bww: 'NYT-Critic', vulture: 'old-outlet' },
    'newyorker-critic': { newyorker: 'custom-slug' }, _schema: {} };
  assert.deepEqual(discoveryCandidates(active, input).map(c => c.slug), ['vulture-critic', 'nyt-critic']);
  assert.deepEqual(discoveryCandidates([{ slug: 'blogger', name: 'Blog Critic', outlet: 'blog' }], input), []);
});

test('verifies author identity in content for all three outlets', () => {
  for (const c of candidates) assert.equal(verifyAuthorPage(pageFor(c), c), true, c.key);
  const c = candidates[0];
  assert.equal(verifyAuthorPage({ content: '<h1>Jesse Green</h1>' }, { ...c, name: 'Jesse Green' }), true);
});

test('rejects non-200, empty, challenge, unrelated author and soft-404 responses', () => {
  const c = candidates[0];
  for (const page of [null, {}, { ...pageFor(c), status: 404 }, { ...pageFor(c), statusCode: 403 },
    { content: '' }, { content: '<title>Just a moment...</title>' },
    { content: `<h1>Not Found</h1><p>${c.name}</p>` },
    { content: `<h1>Another Person</h1><p>${c.name}</p>` },
    { content: `<script>const error = '<h1>${c.name}</h1>';</script><h1>Not Found</h1>` },
    { content: `<template><h1>${c.name}</h1></template><h1>Not Found</h1>` },
    { content: `<!-- <h1>${c.name}</h1> --><h1>Not Found</h1>` }]) {
    assert.equal(verifyAuthorPage(page, c), false);
  }
});

test('rejects homepage, cross-domain and unrelated-author redirects/canonicals', () => {
  const c = candidates[0];
  for (const url of ['https://www.vulture.com/', 'https://example.com/author/vulture-critic/',
    'https://www.vulture.com/author/someone-else/']) {
    assert.equal(verifyAuthorPage({ ...pageFor(c), finalUrl: url }, c), false);
    assert.equal(verifyAuthorPage({ content: `<link rel="canonical" href="${url}"><h1>${c.name}</h1>` }, c), false);
  }
  assert.equal(verifyAuthorPage({ ...pageFor(c), finalUrl: c.url.slice(0, -1) }, c), true);
});

test('records verified pages, preserving all metadata and other overrides; reruns make zero calls', async () => {
  const original = { _schema: { purpose: 'preserve me' }, 'nyt-critic': { bww: 'NYT-Critic' },
    historical: { nyt: 'historical' } };
  const before = structuredClone(original);
  const calls = [];
  const result = await discoverAuthorPages(active, original, async url => {
    calls.push(url);
    return pageFor(candidates.find(c => c.url === url));
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(original, before);
  assert.deepEqual(result.overrides['nyt-critic'], { bww: 'NYT-Critic', nyt: 'nyt-critic' });
  assert.deepEqual(result.overrides._schema, original._schema);
  assert.deepEqual(result.overrides.historical, original.historical);
  assert.deepEqual(result.results.map(r => r.status), ['added', 'added', 'added']);
  const again = await discoverAuthorPages(active, result.overrides, () => assert.fail('already discovered'));
  assert.deepEqual(again.results, []);
  assert.deepEqual(again.overrides, result.overrides);
});

test('skips failed/unverified probes and continues to other critics', async () => {
  const result = await discoverAuthorPages(active, {}, async url => {
    if (url.includes('vulture.com')) throw new Error('HTTP 403');
    if (url.includes('newyorker.com')) return { content: '<h1>Not found</h1>', status: 200 };
    return pageFor(candidates.find(c => c.url === url));
  });
  assert.deepEqual(result.overrides, { 'nyt-critic': { nyt: 'nyt-critic' } });
  assert.deepEqual(result.results.map(r => r.status), ['skipped', 'skipped', 'added']);
});

test('defers remaining probes once the run budget cannot fit another (BRO-6587)', async () => {
  const createRunBudget = require('../../scripts/lib/run-budget').createRunBudget;
  let clock = 0;
  const budget = createRunBudget(5, () => clock);
  const calls = [];
  const result = await discoverAuthorPages(active, {}, async url => {
    calls.push(url);
    clock += 3 * 60 * 1000; // each probe uses 3 of the 5 minutes
    return pageFor(candidates.find(c => c.url === url));
  }, budget);
  assert.equal(calls.length, 1);
  assert.deepEqual(result.results.map(r => r.status), ['added', 'deferred', 'deferred']);
  assert.equal(Object.keys(result.overrides).length, 1);
});

test('curated Jesse Green Vulture backfill preserves the prior NYT and BWW slugs', () => {
  assert.equal(pages['jesse-green'].vulture, 'jesse-green');
  assert.equal(pages['jesse-green'].nyt, 'jesse-green');
  assert.equal(pages['jesse-green'].bww, 'Jesse-Green');
});

const coreFiles = ['critic-registry', 'reviews', 'outlet-registry'].map(name => new URL(`../../data/${name}.json`, import.meta.url));
test('real active target-outlet critics have author-page overrides', {
  skip: coreFiles.some(file => !fs.existsSync(file)) ? 'private core data unavailable' : false,
}, () => {
  const [reg, rev, out] = coreFiles.map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
  const missing = discoveryCandidates(selectActiveCritics(reg, rev.reviews, out), pages);
  assert.deepEqual(missing.map(c => `${c.slug}:${c.key}`), [],
    'active T1/T2 critic(s) lack author-page overrides: run `node scripts/audit-critic-coverage.js --discover-author-pages` (or add the slug to data/critic-author-pages.json) and commit');
});
