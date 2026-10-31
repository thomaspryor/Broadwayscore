// BRO-6649 (plan v2 Step 3): the lane's deploy port. Real functions only (CLAUDE.md section 15); the dispatcher and pager are stubs,
// so nothing here starts a Vercel deploy.
// TESTS-VS-DERIVED-DATA-EXEMPT: synthetic show JSON and urls only; no real data is read or pinned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dp = require('../../scripts/lib/opening-night-lane/deploy-port.js');
const pub = require('../../scripts/lib/opening-night-lane/publish.js');

const SHOW = 'test-show-2026';
const U = (n) => `https://example.com/review-${n}`;
const doc = (...ns) => ({ rv: ns.map((n) => ({ u: U(n) })) });
function mk(extra = {}) {
  let t = 0; const calls = []; const pages = [];
  const port = dp.createDeployPort({
    show: SHOW, night: '2026-10-30', now: () => t, log: () => {}, ...extra,
    dispatch: extra.dispatch || (async () => { calls.push(t); return { ok: true }; }),
    page: async (o) => { pages.push(o); },
  });
  return { port, calls, pages, tick: (ms) => { t += ms; } };
}

test('one dispatch per batch, and none while one is in flight', async () => {
  const { port, calls } = mk();
  assert.deepEqual(port.deploy({ expectedUrls: [U(1)] }), { dispatched: true });
  assert.equal(port.deploy({ expectedUrls: [U(2)] }).coalesced, true);
  assert.equal(port.deploy({ expectedUrls: [U(3)] }).coalesced, true);
  await port.idle();
  assert.equal(calls.length, 1);
});

test('deploy() returns before the dispatch call finishes (it never spends the batch verify budget)', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const { port } = mk({ dispatch: async () => { await gate; return { ok: true }; } });
  const r = port.deploy({ expectedUrls: [U(1)] }); // synchronous
  assert.equal(r.dispatched, true);
  assert.equal(port.deploy({ expectedUrls: [U(2)] }).coalesced, true, 'a second batch during the slow dispatch queues, it does not dispatch');
  release(); await port.idle();
});

test('the open dispatch ends when its URLs are seen live; queued URLs not yet live get one trailing dispatch', async () => {
  const { port, calls, tick } = mk();
  port.deploy({ expectedUrls: [U(1)] }); await port.idle();
  tick(60_000);
  port.deploy({ expectedUrls: [U(2)] }); // batch B arrives at +1 min
  port.observe(doc(1)); await port.idle(); // site shows A only
  assert.equal(calls.length, 2, 'trailing dispatch for B');
  port.observe(doc(1, 2)); await port.idle();
  assert.equal(port.isOpen(), false);
  assert.equal(calls.length, 2);
});

test('queued URLs already live need no trailing dispatch', async () => {
  const { port, calls } = mk();
  port.deploy({ expectedUrls: [U(1)] }); await port.idle();
  port.deploy({ expectedUrls: [U(2)] });
  port.observe(doc(1, 2)); await port.idle();
  assert.equal(calls.length, 1);
  assert.equal(port.isOpen(), false);
});

test('a batch with nothing landed dispatches nothing', async () => {
  const { port, calls } = mk();
  assert.equal(port.deploy({ expectedUrls: [] }).dispatched, false);
  await port.idle();
  assert.equal(calls.length, 0);
});

test('the in-flight state ends at the ceiling, and a URL that never shows is dispatched at most MAX times in total', async () => {
  const { port, calls, tick } = mk();
  port.deploy({ expectedUrls: [U(1)] }); await port.idle();
  for (let i = 0; i < 20; i++) { tick(dp.CEILING_MS + 1); port.observe(doc()); await port.idle(); } // 20 ceilings, never live
  assert.equal(calls.length, dp.MAX_DISPATCHES_PER_URL);
  // a re-queued batch carrying the same URL (lane-runner puts missing rows back) does not reset the cap
  port.deploy({ expectedUrls: [U(1)] }); await port.idle();
  assert.equal(calls.length, dp.MAX_DISPATCHES_PER_URL);
});

test('a failed dispatch pages once (digest), does not throw, and its URLs are retried on the next poll', async () => {
  let n = 0;
  const { port, pages } = mk({ dispatch: async () => (++n === 1 ? { ok: false, error: 'HTTP 500' } : { ok: true }) });
  port.deploy({ expectedUrls: [U(1)] }); await port.idle();
  assert.equal(pages.length, 1);
  assert.equal(pages[0].disposition, 'digest');
  assert.match(pages[0].conditionKey, /lane-deploy-dispatch:test-show-2026:2026-10-30/);
  port.observe(doc()); await port.idle(); // not live yet: retry
  assert.equal(n, 2);
  assert.equal(port.isOpen(), true);
});

test('ghDispatcher dispatches vercel-deploy.yml with the press-night source and retries rate limits', async () => {
  const argvs = []; let n = 0; const slept = []; let opts;
  const d = dp.ghDispatcher({ sleep: async (ms) => { slept.push(ms); }, exec: (cmd, args, o) => { opts = o; argvs.push([cmd, ...args]); if (++n < 3) throw Object.assign(new Error('x'), { stderr: 'HTTP 403 rate limit' }); return ''; } });
  assert.deepEqual(await d(), { ok: true });
  assert.deepEqual(argvs[0], ['gh', 'workflow', 'run', 'vercel-deploy.yml', '--ref', 'main', '-f', 'source=lane-press-night']);
  assert.deepEqual(slept, [5000, 15000]);
  assert.ok(opts.timeout > 0 && opts.timeout <= 60_000, 'gh must not be able to hang the event loop');
  const denied = dp.ghDispatcher({ sleep: async () => { throw new Error('should not sleep'); }, exec: () => { throw Object.assign(new Error('x'), { stderr: 'HTTP 403: Resource not accessible by integration' }); } });
  assert.equal((await denied()).ok, false, 'a permissions 403 is not retried');
  const bad = dp.ghDispatcher({ sleep: async () => {}, exec: () => { throw Object.assign(new Error('x'), { stderr: 'HTTP 404 not found' }); } });
  assert.equal((await bad()).ok, false);
});

function publishWith(live, { timeoutMs = 60_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6649-'));
  let t = 0; const deployed = []; const timeoutPages = [];
  const row = { showId: SHOW, outlet: 'Out', criticName: 'C', url: U(1), assignedScore: 80, contentTier: 'complete', productionVerified: 'aggregator', openingNightLane: { show: SHOW, night: '2026-10-30', source: 'aggregator', seenAt: '2026-10-31T00:30:00.000Z' } };
  const ports = {
    updateReviews: async (fn) => fn({ reviews: [] }) && { applied: [row], added: 1, replaced: 0, kept: 0 },
    regenShow: async () => ({ missing: [] }),
    deploy: async (a) => { deployed.push(a); return {}; },
    fetchLiveShow: async () => live(t),
    pageLiveTimeout: async (o) => { timeoutPages.push(o); },
  };
  return { dir, deployed, timeoutPages, run: () => pub.publishLaneReviews({ show: SHOW, night: '2026-10-30', rows: [{ key: U(1), row }], ledgerDir: dir, ports, dryRun: true, now: () => t, sleep: async (ms) => { t += ms; }, pollMs: 15_000, timeoutMs }) };
}

test('publish hands the deploy port the batch URLs; verified-live comes from the site fetch', async () => {
  const h = publishWith((t) => (t >= 30_000 ? doc(1) : doc()));
  const res = await h.run();
  assert.deepEqual(h.deployed[0], { show: SHOW, night: '2026-10-30', expectedUrls: [U(1)] });
  assert.equal(res.verified.length, 1);
  assert.equal(res.timedOut, false);
  assert.equal(res.ms, 30_000, 'live-at is the first poll that saw the URL, not the dispatch');
  assert.equal(h.timeoutPages.length, 0);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('publish pages once on timeout and reports the rows as missing (lane keeps the lease and re-queues)', async () => {
  const h = publishWith(() => doc());
  const res = await h.run();
  assert.equal(res.timedOut, true);
  assert.deepEqual(res.missing, [U(1)]);
  assert.equal(h.timeoutPages.length, 1);
  assert.deepEqual(h.timeoutPages[0].missing.length, 1);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('night job: a job-level permissions block keeps contents: write beside actions: write; other jobs get no actions: write', () => {
  const y = fs.readFileSync(new URL('../../.github/workflows/opening-night-lane-live.yml', import.meta.url), 'utf8');
  const night = y.slice(y.indexOf('\n  night:'), y.indexOf('\n  shadow:'));
  assert.match(night, /permissions:\n\s+contents: write\n\s+actions: write/);
  assert.match(night, /OPENING_NIGHT_LANE_DEPLOY_DISPATCH: '1'/);
  assert.match(night, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  // BRO-6621: night-wait re-dispatches itself (gh workflow run), so it holds actions: write with read-only contents.
  const nightWait = y.slice(y.indexOf('\n  night-wait:'), y.indexOf('\n  night:'));
  assert.match(nightWait, /permissions:\n\s+contents: read\n\s+actions: write/);
  assert.doesNotMatch(y.slice(0, y.indexOf('\n  night-wait:')) + y.slice(y.indexOf('\n  shadow:')), /actions: write/);
});

const real = require('../../scripts/lib/opening-night-lane/real-ports.js');
test('real ports: dispatch is off unless the env switch is set; with it on, fetchLiveShow feeds the deploy port', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6649rp-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'reviews.json'), '{"reviews":[]}');
  fs.writeFileSync(path.join(dir, 'reviews.json'), '{"reviews":[]}');
  const base = { show: SHOW, repoDir: dir, coreDir: dir, holder: 'h', fetchImpl: async () => ({ ok: true, json: async () => doc(1) }) };
  const dispatched = [];
  const off = real.createRealPublishPorts({ ...base, env: {}, dispatchDeploy: undefined });
  assert.match((await off.deploy({ expectedUrls: [U(1)] })).shippedBy, /core-data push/);
  const on = real.createRealPublishPorts({ ...base, env: {}, dispatchDeploy: async () => { dispatched.push(1); return { ok: true }; }, page: async () => {} });
  await on.deploy({ show: SHOW, night: '2026-10-30', expectedUrls: [U(1), U(2)] });
  await on.fetchLiveShow(SHOW); // shows U(1) only
  assert.equal(dispatched.length, 1, 'U(2) is still missing: the open dispatch stays open, no second one');
  const timeoutPages = []; const withPage = real.createRealPublishPorts({ ...base, env: {}, page: async (o) => { timeoutPages.push(o); } });
  await withPage.pageLiveTimeout({ show: SHOW, night: '2026-10-30', missing: [U(2)], ms: 1_200_000 });
  assert.equal(timeoutPages[0].disposition, 'human');
  fs.rmSync(dir, { recursive: true, force: true });
});
