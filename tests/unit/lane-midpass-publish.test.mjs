// BRO-7159 (Wanted pre-flight): the lane published only at the end of a discovery pass, so one hung or slow score held
// every review already scored in that pass back from the site. A pass that runs long now publishes what it has; an
// ordinary short pass still publishes once at its end (two deploy slots are the whole capacity; see lane-runner.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runLaneNight } = require('../../scripts/lib/opening-night-lane/lane-runner.js');

const NIGHT = '2026-11-09';
const SHOW = { id: 'test-show-2026', title: 'Test Show', openingDate: NIGHT };
const ONE = 'https://www.nytimes.com/2026/11/09/theater/test-show-review.html'; // outlets with no syndication pair: a
// possible copy (The Guardian may be The Observer's) is held to the end of the pass on purpose, see lane-runner.js
const TWO = 'https://variety.com/2026/legit/reviews/test-show-review-1236000000/';
const tick = () => new Promise((r) => setTimeout(r, 5));

function night({ midPassPublishAfterMs, scoreTwo, urls = [ONE, TWO] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7159-midpass-'));
  let doc = { reviews: [] };
  const deployed = []; const order = [];
  const run = runLaneNight({
    show: SHOW, night: NIGHT, openingDate: NIGHT, ledgerDir: dir, dryRun: true, maxPasses: 1, passIntervalMs: 0, midPassPublishAfterMs,
    adapters: [{ name: 'roundup', kind: 'aggregator', phase: 'main', discover: async () => urls.map((url) => ({ url, source: 'aggregator', aggregatorCited: true })) }],
    fetchText: async () => '',
    fetchReview: async (a) => ({ outletId: a.url.includes('nytimes') ? 'nytimes' : a.url.includes('guardian') ? 'guardian' : 'variety', outlet: 'x', criticName: a.url.includes('variety') ? 'Critic Two' : 'Critic One', fullText: 'A full review of the production. '.repeat(40), publishDate: NIGHT }),
    // Whichever candidate the runner scores second is the one that hangs.
    scoreReview: async (row) => { order.push(row.url); return order.length === 2 ? scoreTwo() : 70; },
    publishPorts: {
      updateReviews: async (fn) => { const out = fn(doc); doc = out.doc; return out; },
      regenShow: async () => ({}),
      deploy: async ({ expectedUrls }) => { deployed.push(...expectedUrls); },
      fetchLiveShow: async () => ({ rv: doc.reviews.map((r) => ({ u: r.url })) }),
    },
    now: () => Date.now(), wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  return { run: run.finally(() => fs.rmSync(dir, { recursive: true, force: true })), deployed, order };
}

test('candidate 2\'s score hangs: candidate 1 reaches the deploy port anyway, and both end published', async () => {
  let release;
  const hung = new Promise((r) => { release = r; });
  const { run, deployed, order } = night({ midPassPublishAfterMs: 20, scoreTwo: () => hung.then(() => 75) });
  // Wait for both: under a loaded full-suite run the mid-pass deploy can land before candidate 2 starts scoring.
  for (let i = 0; i < 400 && !(deployed.length && order.length === 2); i++) await tick();
  assert.equal(order.length, 2, 'candidate 2 is being scored (and hangs)');
  assert.deepEqual(deployed, [order[0]], 'candidate 1 deployed while candidate 2 is still being scored');
  release();
  const res = await run;
  assert.deepEqual(res.unpublished, []);
  assert.deepEqual([...deployed].sort(), [ONE, TWO].sort());
  assert.equal(res.published.length, 2, 'two batches: candidate 1 mid-pass, candidate 2 at the end of the pass');
});

test('an ordinary pass (no row waited the mid-pass bar) still publishes once, at its end', async () => {
  const { run, deployed } = night({ midPassPublishAfterMs: 60 * 60 * 1000, scoreTwo: async () => 75 });
  const res = await run;
  assert.equal(res.published.length, 1, 'one batch for the whole pass');
  assert.deepEqual([...deployed].sort(), [ONE, TWO].sort());
});

test('a possible syndicated copy is not published mid-pass: its primary may still be scored later in the pass', async () => {
  const GUARDIAN = 'https://www.theguardian.com/stage/2026/nov/09/test-show-review'; // may be The Observer's review
  let release;
  const hung = new Promise((r) => { release = r; });
  const { run, deployed, order } = night({ midPassPublishAfterMs: 20, scoreTwo: () => hung.then(() => 75), urls: [GUARDIAN, TWO] });
  for (let i = 0; i < 40; i++) await tick();
  assert.equal(order.length, 2);
  assert.ok(order[0] === GUARDIAN, `the runner scored ${order[0]} first; this test needs the possible copy first`);
  assert.deepEqual(deployed, [], 'held to the end of the pass');
  release();
  const res = await run;
  assert.deepEqual([...deployed].sort(), [GUARDIAN, TWO].sort());
  assert.deepEqual(res.unpublished, []);
});

test('a failed mid-pass publish restarts the row\'s wait: no retry on every timer tick (BRO-7159 review)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7159-retry-'));
  let release; const hung = new Promise((r) => { release = r; });
  let attempts = 0; let n = 0;
  const run = runLaneNight({
    show: SHOW, night: NIGHT, openingDate: NIGHT, ledgerDir: dir, dryRun: true, maxPasses: 1, passIntervalMs: 0, midPassPublishAfterMs: 200, midPassTickMs: 50, // production: a 30 s tick, a 5 min bar
    adapters: [{ name: 'roundup', kind: 'aggregator', phase: 'main', discover: async () => [ONE, TWO].map((url) => ({ url, source: 'aggregator', aggregatorCited: true })) }],
    fetchText: async () => '',
    fetchReview: async (a) => ({ outletId: a.url.includes('nytimes') ? 'nytimes' : 'variety', outlet: 'x', criticName: a.url.includes('variety') ? 'Critic Two' : 'Critic One', fullText: 'A full review of the production. '.repeat(40), publishDate: NIGHT }),
    scoreReview: async () => (++n === 2 ? hung.then(() => 75) : 70),
    publishPorts: { updateReviews: async () => { attempts++; throw new Error('push rejected'); }, regenShow: async () => ({}), deploy: async () => {}, fetchLiveShow: async () => ({ rv: [] }) },
    now: () => Date.now(), wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  await new Promise((r) => setTimeout(r, 560)); // ten ticks; the row first passes the bar at ~200 ms
  const during = attempts;
  release();
  await run.finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.ok(during >= 1, 'the first mid-pass publish was tried');
  assert.ok(during <= 3, `tried ${during} times in ~10 ticks: a re-queued row must wait the bar again`);
});

test('a held teaser that then fails for good is reported failed, not also still awaiting (BRO-7159 review)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7159-await-fail-'));
  let calls = 0;
  const res = await runLaneNight({
    show: SHOW, night: NIGHT, openingDate: NIGHT, ledgerDir: dir, dryRun: true, maxPasses: 2, passIntervalMs: 0,
    adapters: [{ name: 'roundup', kind: 'aggregator', phase: 'main', discover: async () => [{ url: ONE, source: 'aggregator', aggregatorCited: true }] }],
    fetchText: async () => '',
    fetchReview: async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('paywall teaser: awaiting an excerpt'), { awaiting: true });
      throw Object.assign(new Error('wrong show'), { permanent: true });
    },
    scoreReview: async () => 70,
    publishPorts: { updateReviews: async (fn) => fn({ reviews: [] }), regenShow: async () => ({}), deploy: async () => {}, fetchLiveShow: async () => ({ rv: [] }) },
    now: () => Date.now(), wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(calls, 2, 'the held teaser was re-offered on pass 2');
  assert.equal(res.failed.length, 1, 'failed for good');
  assert.deepEqual(res.awaiting, []);
});

test('an offline replay on a virtual clock starts no real-time mid-pass timer (BRO-7159 review)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7159-virtual-'));
  let clock = Date.parse('2026-03-01T23:00:00Z');
  const orig = globalThis.setInterval; let intervals = 0;
  globalThis.setInterval = (...args) => { intervals++; return orig(...args); };
  try {
    await runLaneNight({
      show: SHOW, night: NIGHT, openingDate: NIGHT, ledgerDir: dir, dryRun: true, maxPasses: 1, passIntervalMs: 0,
      adapters: [{ name: 'roundup', kind: 'aggregator', phase: 'main', discover: async () => [] }],
      fetchText: async () => '', fetchReview: async () => { throw new Error('unused'); }, scoreReview: async () => 70,
      publishPorts: { updateReviews: async (fn) => fn({ reviews: [] }), regenShow: async () => ({}), deploy: async () => {}, fetchLiveShow: async () => ({ rv: [] }) },
      now: () => clock, wait: async (ms) => { clock += ms; },
    });
  } finally { globalThis.setInterval = orig; fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(intervals, 0);
});

test('a publish that keeps failing at the end of the night is tried a few times, not 40 back to back (BRO-7159)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7159-flush-'));
  let attempts = 0;
  const res = await runLaneNight({
    show: SHOW, night: NIGHT, openingDate: NIGHT, ledgerDir: dir, dryRun: true, maxPasses: 1, passIntervalMs: 0, midPassPublishAfterMs: 60 * 60 * 1000,
    adapters: [{ name: 'roundup', kind: 'aggregator', phase: 'main', discover: async () => [{ url: ONE, source: 'aggregator', aggregatorCited: true }] }],
    fetchText: async () => '',
    fetchReview: async () => ({ outletId: 'nytimes', outlet: 'x', criticName: 'Critic One', fullText: 'A full review of the production. '.repeat(40), publishDate: NIGHT }),
    scoreReview: async () => 70,
    publishPorts: { updateReviews: async () => { attempts++; throw new Error('push rejected'); }, regenShow: async () => ({}), deploy: async () => {}, fetchLiveShow: async () => ({ rv: [] }) },
    now: () => Date.now(), wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.ok(attempts >= 2 && attempts <= 4, `${attempts} publish attempts`);
  assert.equal(res.unpublished.length, 1, 'the row is reported unpublished, so the driver pages for it');
});
