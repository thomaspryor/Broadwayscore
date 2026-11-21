// BRO-5993: the lane drops a syndicated copy the way the rebuild does (syndication-pairs.js). The Oct 22 shadow run
// scored the NY Daily News reprint of Chris Jones's Chicago Tribune review, which the site never shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runLaneNight } = require('../../scripts/lib/opening-night-lane/lane-runner.js');

const NIGHT = '2026-10-22';
const SHOW = { id: 'test-show-2026', title: 'Test Show', openingDate: NIGHT };
const TRIB = 'https://www.chicagotribune.com/2026/10/22/review-test-show/';
const NYDN = 'https://www.nydailynews.com/2026/10/22/broadway-review-test-show/';

async function night(urls, critic = 'Chris Jones', onDiskRows = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5993-synd-'));
  const scored = [];
  let doc = { reviews: [] };
  let clock = Date.parse(`${NIGHT}T23:00:00Z`);
  const res = await runLaneNight({
    show: SHOW, night: NIGHT, openingDate: NIGHT, ledgerDir: dir, dryRun: true, maxPasses: 1, onDiskRows,
    adapters: [{ name: 'roundup', kind: 'aggregator', phase: 'main', discover: async () => urls.map((url) => ({ url, source: 'aggregator', aggregatorCited: true })) }],
    fetchText: async () => '',
    fetchReview: async (a) => ({ outletId: a.url.includes('tribune') ? 'chicagotribune' : 'nydailynews', outlet: 'x', criticName: critic, fullText: 'A full review of the production. '.repeat(40), publishDate: NIGHT }),
    scoreReview: async (row) => { scored.push(row.outletId); return 70; },
    // A fake site that shows whatever was merged, and a clock that moves on every wait.
    publishPorts: { updateReviews: async (fn) => { const out = fn(doc); doc = out.doc; return out; }, regenShow: async () => ({}), deploy: async () => {}, fetchLiveShow: async () => ({ rv: doc.reviews.map((r) => ({ u: r.url })) }) },
    now: () => clock, wait: async (ms) => { clock += ms || 1000; },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { res, scored };
}

test('primary first: the copy is skipped before scoring, with the reason', async () => {
  const { res, scored } = await night([TRIB, NYDN]);
  assert.deepEqual(scored, ['chicagotribune'], 'no scoring spend on the copy');
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /syndicated copy of the chicagotribune review by Chris Jones/);
  assert.deepEqual(res.failed, []);
});

test('copy first: it is pulled from the publish queue when its primary arrives in the same pass', async () => {
  const { res } = await night([NYDN, TRIB]);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].key, /nydailynews/);
  const published = res.published.flatMap((p) => p.merge ? [p.merge.added] : []);
  assert.deepEqual(published, [1], 'only the Tribune row reaches the merge');
});

test('a copy with no primary tonight is kept (Culture Sauce runs when TheWrap has another critic)', async () => {
  const { res, scored } = await night([NYDN]);
  assert.deepEqual(scored, ['nydailynews']);
  assert.deepEqual(res.skipped, []);
});

test('a primary the regular pipeline already published (reviews.json) still stops the copy', async () => {
  const { res, scored } = await night([NYDN], 'Chris Jones', [{ criticName: 'Chris Jones', outletId: 'chicagotribune' }]);
  assert.deepEqual(scored, []);
  assert.equal(res.skipped.length, 1);
});

test('critic names match the way the rebuild matches them (case, diacritics, punctuation)', async () => {
  const { res } = await night([NYDN], 'CHRIS  JONES', [{ criticName: 'Chris Jones', outletId: 'chicagotribune' }]);
  assert.equal(res.skipped.length, 1);
});
