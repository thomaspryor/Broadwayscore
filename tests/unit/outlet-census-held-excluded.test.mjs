// BRO-7999 R2: the census counts reviews held only by excluded files as their own bucket, outside
// recall, and never writes their URLs. Requires the real functions (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const census = require('../../scripts/lib/outlet-census.js');

const giant = { id: 'giant-2026', title: 'Giant', market: 'broadway', venue: 'Music Box Theatre', openingDate: '2026-03-23', closingDate: '2026-06-28', cast: [], creativeTeam: [] };
const URL_HIDDEN = 'https://www.theatermania.com/news/review-giant-hidden/';
const URL_LIVE = 'https://www.theatermania.com/news/review-giant-live/';
const rows = [
  { showId: giant.id, outletId: 'theatermania', url: URL_HIDDEN, excludedRule: 'wrongProduction' },
  { showId: giant.id, outletId: 'theatermania', url: URL_LIVE },
  // the same URL held live once and excluded once is live
  { showId: giant.id, outletId: 'theatermania', url: URL_LIVE, excludedRule: 'nonReview' },
];
function ctx() {
  const idx = census.buildCorpusIndexes(rows);
  return { shows: [giant], nycIds: new Set([giant.id]), corpus: idx.live, corpusExcluded: idx.excludedOnly, outletShowUrls: census.buildOutletShowIndex(rows), nycVenues: census.nycVenuePhrases([giant]) };
}
const item = (url) => ({ outletId: 'theatermania', sourceSaysReview: true, headline: 'Giant review', publishDate: '2026-04-01', url });

test('indexes: a URL held only by excluded files is excluded-only; one live copy makes it live', () => {
  const { live, excludedOnly } = census.buildCorpusIndexes(rows);
  assert.ok(excludedOnly.has(census.urlKey(URL_HIDDEN)));
  assert.ok(!live.has(census.urlKey(URL_HIDDEN)));
  assert.ok(live.has(census.urlKey(URL_LIVE)));
  assert.ok(!excludedOnly.has(census.urlKey(URL_LIVE)));
});

test('bucket: held only by an excluded file is held-excluded with no show ids; a live copy stays held', () => {
  const c = ctx();
  const hidden = census.bucketItem(item(URL_HIDDEN), c);
  assert.equal(hidden.bucket, 'held-excluded');
  assert.deepEqual(hidden.held, []);
  assert.deepEqual(hidden.matchedIds, []);
  assert.equal(census.bucketItem(item(URL_LIVE), c).bucket, 'held');
});

test('bucket: without an excluded index behaviour is unchanged (reviews.json-only runs)', () => {
  const { live } = census.buildCorpusIndexes(rows);
  const c = { shows: [giant], nycIds: new Set([giant.id]), corpus: live, outletShowUrls: new Map(), nycVenues: [] };
  assert.notEqual(census.bucketItem(item(URL_HIDDEN), c).bucket, 'held-excluded');
});

test('summary: held-excluded is counted but outside recall', () => {
  const s = census.summarize([{ bucket: 'held' }, { bucket: 'gap' }, { bucket: 'held-excluded' }, { bucket: 'held-excluded' }]);
  assert.equal(s.counts['held-excluded'], 2);
  assert.equal(s.recall, 0.5);
});

test('leak guard: held-excluded rows are dropped from public output and the guard throws on any that remain', () => {
  const results = [{ bucket: 'held', url: URL_LIVE }, { bucket: 'held-excluded', url: URL_HIDDEN, headline: 'SECRET HEADLINE' }];
  const pub = census.publicResults(results);
  assert.equal(pub.length, 1);
  assert.doesNotMatch(JSON.stringify(pub), /hidden|SECRET HEADLINE/);
  assert.doesNotThrow(() => census.assertNoHeldExcludedRows({ items: pub }));
  assert.throws(() => census.assertNoHeldExcludedRows({ items: results }), /held-excluded/);
  assert.throws(() => census.assertNoHeldExcludedRows({ misfiles: [{ bucket: 'held-excluded' }] }), /held-excluded/);
});

test('leak guard: no committed census report or manifest carries a held-excluded row', () => {
  const dir = path.join(ROOT, 'data', 'audit', 'outlet-census');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'vacuity: reports exist');
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.doesNotThrow(() => census.assertNoHeldExcludedRows(doc), f);
  }
});

test('bucket: an excluded file filed under another market show is still held-excluded, and its URL never reaches alt-url output', () => {
  const other = { id: 'other-west-end-2026', title: 'Other', market: 'west-end', venue: 'Apollo', openingDate: '2026-03-01', cast: [], creativeTeam: [] };
  const rs = [{ showId: other.id, outletId: 'theatermania', url: URL_HIDDEN, excludedRule: 'wrongProduction' }];
  const idx = census.buildCorpusIndexes(rs);
  const c = { shows: [giant], nycIds: new Set([giant.id]), corpus: idx.live, corpusExcluded: idx.excludedOnly, outletShowUrls: census.buildOutletShowIndex(rs.filter((r) => !r.excludedRule)), nycVenues: census.nycVenuePhrases([giant]) };
  assert.equal(census.bucketItem(item(URL_HIDDEN), c).bucket, 'held-excluded');
  assert.equal(c.outletShowUrls.size, 0, 'excluded URLs stay out of the outlet index');
});

test('leak guard: an excluded URL or filename anywhere in a nested value throws', () => {
  const ex = new Set([URL_HIDDEN, 'giant-2026/theatermania--critic.json']);
  assert.doesNotThrow(() => census.assertNoHeldExcludedRows({ items: [{ url: URL_LIVE }] }, ex));
  assert.throws(() => census.assertNoHeldExcludedRows({ gaps: [{ heldUrls: [URL_HIDDEN] }] }, ex), /excluded review URL/);
  assert.throws(() => census.assertNoHeldExcludedRows({ misfiles: [{ file: 'giant-2026/theatermania--critic.json' }] }, ex), /excluded review URL/);
});
