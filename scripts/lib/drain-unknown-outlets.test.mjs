import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { planDrain, productionMismatch, isSaneOutletHost, ledgerKey } = require('./drain-unknown-outlets.js');
const { provisionalOutletIdFromHost } = require('./outlet-canonicalize.js');

const audit = JSON.parse(fs.readFileSync(new URL('../../data/audit/unknown-aggregator-outlets.json', import.meta.url), 'utf8'));
const shows = JSON.parse(fs.readFileSync(new URL('../../data/shows.json', import.meta.url), 'utf8')).shows;
const showsById = Object.fromEntries(shows.map(s => [s.id, s]));

test('only hosts with occurrences >= 2 are drained', () => {
  const { batch } = planDrain(audit, showsById, { batchSize: 10000 });
  const occ = Object.fromEntries(audit.outlets.map(o => [o.host, o.occurrences]));
  assert.ok(batch.length > 0);
  for (const b of batch) assert.ok(occ[b.host] >= 2, b.host);
});

test('issue example hosts are identified and passed through provisionalOutletIdFromHost', () => {
  const fixture = { outlets: [
    { host: 'cleveland.com', occurrences: 4, shows: ['s1'], sampleUrls: ['https://www.cleveland.com/2026/stereophonic-review.html'] },
    { host: 'sun-sentinel.com', occurrences: 4, shows: ['s1'], sampleUrls: ['https://www.sun-sentinel.com/2026/stereophonic-review/'] },
    { host: 'newcitystage.com', occurrences: 4, shows: ['s1'], sampleUrls: ['https://newcitystage.com/2026/stereophonic-review/'] },
  ] };
  const { batch } = planDrain(fixture, { s1: { title: 'Stereophonic' } });
  assert.deepEqual(batch.map(b => b.host), ['cleveland.com', 'sun-sentinel.com', 'newcitystage.com']);
  for (const e of batch) {
    assert.equal(e.outletId, provisionalOutletIdFromHost(e.host));
    assert.ok(e.args.includes(`--outlet=${e.outletId}`) && e.args.includes('--provisional'));
    assert.ok(e.args.includes(`--url=${e.url}`) && e.args.includes('--show=s1'));
  }
});

test('live backlog: every prepared ingest carries a derived, non-generic provisional id', () => {
  const { batch } = planDrain(audit, showsById, { batchSize: 10000 });
  for (const e of batch) {
    assert.equal(e.outletId, provisionalOutletIdFromHost(e.host));
    assert.ok(!['open', 'news', 'm'].includes(e.outletId), e.host);
  }
});

test('generic platform ids (open.substack.com -> "open") are not registered', () => {
  const fake = { outlets: [{ host: 'open.substack.com', occurrences: 3, shows: ['s1'], sampleUrls: ['https://open.substack.com/pub/x/p/stereophonic'] }] };
  const { batch, skipped } = planDrain(fake, { s1: { title: 'Stereophonic' } });
  assert.equal(batch.length, 0);
  assert.equal(skipped[0].reason, 'generic-outlet-id');
});

test('domain sanity check drops CDN/aggregator/social hosts even with many occurrences', () => {
  const fake = { outlets: [
    { host: 'show-score.com', occurrences: 30, sampleUrls: ['https://show-score.com/x'], shows: ['a'] },
    { host: 'd1.cloudfront.net', occurrences: 9, sampleUrls: ['https://d1.cloudfront.net/x'], shows: ['a'] },
    { host: 'google.com', occurrences: 9, sampleUrls: ['https://google.com/x'], shows: ['a'] },
  ] };
  const { batch, skipped } = planDrain(fake, { a: { title: 'A' } });
  assert.equal(batch.length, 0);
  assert.equal(skipped.length, 3);
  assert.equal(isSaneOutletHost('www.cleveland.com'), true);
});

test('url is paired to the show it is about; ambiguous or unmatched urls are skipped', () => {
  const fake = { outlets: [{ host: 'cleveland.com', occurrences: 2, shows: ['s1', 's2'], sampleUrls: [
    'https://www.cleveland.com/2026/stereophonic-review.html',
    'https://www.cleveland.com/2026/unrelated-story.html',
  ] }] };
  const { batch, skipped } = planDrain(fake, { s1: { title: 'Stereophonic' }, s2: { title: 'Wicked Witch' } });
  assert.deepEqual(batch.map(b => b.showId), ['s1']);
  assert.equal(skipped[0].reason, 'unpaired-show');
});

test('wrong-production pairings are refused (wildcard title, predates opening, US outlet on West End)', () => {
  const mk = (title, extra = {}) => ({ outlets: [{ host: 'spokesman.com', occurrences: 2, shows: ['s1'], sampleUrls: ['https://www.spokesman.com/stories/2019/jul/11/mj-review/'] }], _s: { s1: { title, ...extra } } });
  const run = f => planDrain(f, f._s);
  assert.equal(run(mk('MJ The Musical')).skipped[0].reason, 'unpaired-show'); // zero title tokens
  assert.equal(productionMismatch('https://x.com/2019/01/rent-review', { openingDate: '2026-10-08' }), 'predates-production');
  assert.equal(productionMismatch('https://x.com/2026/12/rent-review', { openingDate: '2026-10-08' }), null);
  assert.equal(productionMismatch('https://x.com/2026/12/rent-review', { openingDate: '2026-10-08', market: 'west-end' }), 'non-uk-outlet-for-west-end');
  assert.equal(productionMismatch('https://x.co.uk/2026/12/rent-review', { openingDate: '2026-10-08', market: 'west-end' }), null);
});

test('non-review, tour-stop and after-closing URLs are refused', () => {
  const bw = { openingDate: '2023-04-01', closingDate: '2023-12-31', market: 'off-broadway' };
  assert.equal(productionMismatch('https://x.com/shows/stereophonic', bw), 'non-review-url');
  assert.equal(productionMismatch('https://x.com/lean-to-to-make-world-premiere-at-59e59', bw), 'non-review-url');
  assert.equal(productionMismatch('https://x.com/2026/01/stereophonic-review', bw), 'after-closing');
  assert.equal(productionMismatch('https://x.com/2023/05/stereophonic-touring-review', bw), 'tour-stop');
  assert.equal(productionMismatch('https://x.com/matilda-review-emma-thompson-2022-10', { openingDate: '2026-01-01' }), 'predates-production');
  assert.equal(productionMismatch('https://x.com/2023/05/stereophonic-review', bw), null);
});

test('live backlog: no ingest targets a pre-opening year or a US outlet on a West End show', () => {
  const { batch } = planDrain(audit, showsById, { batchSize: 10000 });
  for (const b of batch) assert.equal(productionMismatch(b.url, showsById[b.showId]), null, b.key);
});

test('checkpoint: ledger entries are skipped on re-run (no duplicate ingests) and batches are capped', () => {
  const first = planDrain(audit, showsById, { batchSize: 3 });
  assert.equal(first.batch.length, 3);
  assert.ok(first.remaining >= 0);
  const ledger = Object.fromEntries(first.batch.map(b => [ledgerKey(b.showId, b.url), { status: 'ok' }]));
  const second = planDrain(audit, showsById, { batchSize: 10000, ledger });
  const keys = new Set(second.batch.map(b => b.key));
  for (const b of first.batch) assert.ok(!keys.has(b.key), 'already-ingested must not reappear');
  assert.equal(new Set(second.batch.map(b => b.key)).size, second.batch.length, 'no duplicate keys in a plan');
});
