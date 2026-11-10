// BRO-7238 part 1: a syndicated copy published in pass N must come down when its original scores in pass N+1.
// Before this, the lane's merge kept both rows (the copy was only blocked while the original was still unscored).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runLaneNight } = require('../../scripts/lib/opening-night-lane/lane-runner.js');
const { mergeShowRows } = require('../../scripts/lib/opening-night-lane/publish.js');

const NIGHT = '2026-11-09';
const SHOW = { id: 'test-show-2026', title: 'Test Show', openingDate: NIGHT };
const COPY = 'https://www.nydailynews.com/2026/11/09/test-show-review/';
const ORIG = 'https://www.chicagotribune.com/2026/11/09/test-show-review/';
const OTHER = 'https://variety.com/2026/legit/reviews/test-show-review-1236000000/';

function night({ urlsByPass, failFirstPublishWithOriginal = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7238-'));
  let doc = { reviews: [] }; let pass = 0; let failed = false;
  const outletOf = (u) => (u.includes('nydailynews') ? 'nydailynews' : u.includes('chicagotribune') ? 'chicagotribune' : 'variety');
  const run = runLaneNight({
    show: SHOW, night: NIGHT, openingDate: NIGHT, ledgerDir: dir, dryRun: true, maxPasses: urlsByPass.length, passIntervalMs: 0,
    adapters: [{ name: 'roundup', kind: 'aggregator', phase: 'main', discover: async () => (urlsByPass[pass++] || []).map((url) => ({ url, source: 'aggregator', aggregatorCited: true })) }],
    fetchText: async () => '',
    fetchReview: async (a) => ({ outletId: outletOf(a.url), outlet: 'x', criticName: outletOf(a.url) === 'variety' ? 'Other Critic' : 'Chris Jones', fullText: 'A full review of the production. '.repeat(40), isFullReview: true, publishDate: NIGHT }),
    scoreReview: async () => 70,
    publishPorts: {
      updateReviews: async (fn) => {
        if (failFirstPublishWithOriginal && !failed && fn({ reviews: [] }).applied.some((r) => r.outletId === 'chicagotribune')) { failed = true; throw new Error('push rejected'); }
        const out = fn(doc); doc = out.doc; return out;
      },
      regenShow: async () => ({}), deploy: async () => {},
      fetchLiveShow: async () => ({ rv: doc.reviews.map((r) => ({ u: r.url })) }),
    },
    now: () => Date.now(), wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  return { run: run.finally(() => fs.rmSync(dir, { recursive: true, force: true })), getDoc: () => doc };
}

const outlets = (doc) => doc.reviews.map((r) => r.outletId).sort();

test('copy published in pass 1, original scores in pass 2: the copy is removed, the original stays', async () => {
  const { run, getDoc } = night({ urlsByPass: [[COPY, OTHER], [ORIG]] });
  const res = await run;
  assert.deepEqual(outlets(getDoc()), ['chicagotribune', 'variety']);
  assert.equal(res.removedCopies.length, 1);
  assert.match(res.removedCopies[0].reason, /syndicated copy of the chicagotribune review by Chris Jones/);
});

test('a failed publish of the original keeps the copy on the site and retries the removal with the original', async () => {
  const { run, getDoc } = night({ urlsByPass: [[COPY], [ORIG], []], failFirstPublishWithOriginal: true });
  const res = await run;
  assert.deepEqual(outlets(getDoc()), ['chicagotribune'], 'original in, copy out, after the retry');
  assert.equal(res.removedCopies.length, 1);
});

test('mergeShowRows remove: only the lane\'s own matching row goes; the removal list is optional', () => {
  const laneRow = (outletId, url) => ({ showId: SHOW.id, outletId, criticName: 'Chris Jones', url, assignedScore: 70 });
  const mk = (r) => require('../../scripts/lib/opening-night-lane/trust-model.js').isLaneReview(r, { openingDate: NIGHT });
  assert.equal(typeof mk, 'function');
  const doc = { reviews: [{ showId: SHOW.id, outletId: 'nydailynews', criticName: 'Chris Jones', url: COPY, assignedScore: 70 }] };
  // a regular-pipeline row (no lane provenance) is never removed
  const out = mergeShowRows(doc, SHOW.id, [], { openingDate: NIGHT, remove: [{ criticName: 'Chris Jones', outletId: 'nydailynews' }] });
  assert.equal(out.removed.length, 0);
  assert.equal(out.doc.reviews.length, 1);
  assert.equal(mergeShowRows(doc, SHOW.id, [], { openingDate: NIGHT }).removed.length, 0);
  void laneRow;
});
