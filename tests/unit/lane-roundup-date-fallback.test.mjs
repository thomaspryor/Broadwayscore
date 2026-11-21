// BRO-7587: Downstate's Cititour review (page carries no publish date) was fetched at 10:02pm, held "incomplete card (no
// publishDate)" for three reads and dropped to the regular pipeline, which published it at 2:12am. The roundup that cites a
// review dates it provisionally (dateSource 'roundup-article', as the regular pipeline stamps it).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runLaneNight } = require('../../scripts/lib/opening-night-lane/lane-runner.js');
const trust = require('../../scripts/lib/opening-night-lane/trust-model.js');
const d = require('../../scripts/lib/opening-night-lane/discovery.js');

const NIGHT = new Date().toISOString().slice(0, 10);
const SHOW = { id: 'test-show-2026', title: 'Test Show', openingDate: NIGHT };
const URL1 = 'https://cititour.com/NYC_Broadway/Test-Show/1412';
const TEXT = 'Cititour.com Review. A full review of the production, with a byline of Brian Scott Lipton. '.repeat(30);

function night({ aggregatorDate, pageDate = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7587-'));
  let doc = { reviews: [] };
  const run = runLaneNight({
    show: SHOW, night: NIGHT, openingDate: NIGHT, ledgerDir: dir, dryRun: true, maxPasses: 1, passIntervalMs: 0,
    adapters: [{ name: 'bww-roundup', kind: 'aggregator', phase: 'main', discover: async () => [{ url: URL1, source: 'aggregator', aggregatorCited: true, ...(aggregatorDate ? { aggregatorDate } : {}) }] }],
    fetchText: async () => '',
    fetchReview: async () => ({ outletId: 'cititour', outlet: 'Cititour', criticName: 'Brian Scott Lipton', fullText: TEXT, isFullReview: true, publishDate: pageDate }),
    scoreReview: async () => 95,
    publishPorts: {
      updateReviews: async (fn) => { const out = fn(doc); doc = out.doc; return out; },
      regenShow: async () => ({}), deploy: async () => {},
      fetchLiveShow: async () => ({ rv: doc.reviews.map((r) => ({ u: r.url })) }),
    },
    now: () => Date.now(), wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  return { run: run.finally(() => fs.rmSync(dir, { recursive: true, force: true })), getDoc: () => doc };
}

test('a roundup-cited review whose page has no date publishes in its first pass, dated by the roundup (provisional)', async () => {
  const { run, getDoc } = night({ aggregatorDate: NIGHT });
  await run;
  const row = getDoc().reviews.find((r) => r.outletId === 'cititour');
  assert.ok(row, 'Cititour not published: held as an incomplete card (no publishDate)');
  assert.equal(String(row.publishDate).slice(0, 10), NIGHT);
  assert.equal(row.dateSource, 'roundup-article');
});

test('a page date wins over the roundup date', async () => {
  const { run, getDoc } = night({ aggregatorDate: NIGHT, pageDate: NIGHT });
  await run;
  const row = getDoc().reviews.find((r) => r.outletId === 'cititour');
  assert.ok(row);
  assert.notEqual(row.dateSource, 'roundup-article');
});

test('no roundup date and no page date: still held (never dated from the opening date)', async () => {
  const { run, getDoc } = night({ aggregatorDate: null });
  await run;
  assert.equal(getDoc().reviews.length, 0);
});

test('roundupFallbackDate: within one day of the night only', () => {
  assert.deepEqual(trust.roundupFallbackDate({ aggregatorDate: '2026-11-15', night: '2026-11-15' }), { publishDate: '2026-11-15', dateSource: 'roundup-article' });
  assert.ok(trust.roundupFallbackDate({ aggregatorDate: '2026-11-16', night: '2026-11-15' }));
  assert.equal(trust.roundupFallbackDate({ aggregatorDate: '2026-11-10', night: '2026-11-15' }), null, 'an older roundup is another production\'s');
  assert.equal(trust.roundupFallbackDate({ aggregatorDate: null, night: '2026-11-15' }), null);
});

test('roundupPageDate: page date, else the -YYYYMMDD in the BWW article URL', () => {
  const bww = 'https://www.broadwayworld.com/article/Review-Roundup-DOWNSTATE-Opens-on-Broadway-Updating-Live-20261115';
  assert.equal(d.roundupPageDate('<html></html>', bww), '2026-11-15');
  assert.equal(d.roundupPageDate('<meta property="article:published_time" content="2026-11-14T22:00:00Z">', bww), '2026-11-14');
  assert.equal(d.roundupPageDate('<html></html>', 'https://example.com/a'), null);
});

test('the BWW roundup adapter carries the roundup date through discovery onto the admitted review', async () => {
  const RR = 'https://www.broadwayworld.com/article/Review-Roundup-TEST-SHOW-Opens-On-Broadway-' + NIGHT.replace(/-/g, '');
  const NYT = 'https://www.nytimes.com/2026/11/15/theater/test-show-review.html';
  const home = `<html><body><a href="${RR}">Review Roundup: TEST SHOW</a></body></html>`;
  const roundup = `<html><body><div class="disnep-area"><a href="${NYT}">Jesse Green, The New York Times</a></div></body></html>`;
  const fetchText = async (u) => (u === 'https://www.broadwayworld.com/' ? home : u === RR ? roundup : '<html></html>');
  const r = await d.runDiscoveryPass({
    show: SHOW, night: NIGHT, now: Date.now(), startedAt: Date.now() - 3600e3, fetchText, timeZone: 'America/New_York',
    adapters: [d.bwwRoundupAdapter()],
  });
  assert.ok(r.admitted.length > 0, `nothing admitted: ${JSON.stringify(r.rejected)} ${JSON.stringify(r.errors)}`);
  assert.ok(r.admitted.every((a) => a.aggregatorDate === NIGHT), JSON.stringify(r.admitted));
});
