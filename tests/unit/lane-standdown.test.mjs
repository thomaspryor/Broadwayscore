// BRO-6617: LANE_STANDDOWN, the owner's switch that stands the opening-night lane down. Real parse/driver/runner
// functions (CLAUDE.md section 15) with injected deps; nothing here touches GitHub, a lease store, a scraper or a scorer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const standdown = require('../../scripts/lib/opening-night-lane/standdown.js');
const driver = require('../../scripts/lib/opening-night-lane/driver.js');
const { runLaneNight } = require('../../scripts/lib/opening-night-lane/lane-runner.js');

const BROADWAY = { id: 'test-show-2026', market: 'broadway', category: 'broadway' };
const OFF_BROADWAY = { id: 'ob-show-2026', market: 'broadway', category: 'off-broadway' };
const WEST_END = { id: 'we-show-2026', market: 'west-end', category: 'west-end' };
const NIGHT = '2026-10-20';
const flush = () => new Promise((r) => setImmediate(r));

test('unset or "off" values stand nothing down', () => {
  for (const v of [undefined, null, '', '   ', 'false', '0', 'off', 'none', 'No']) {
    assert.equal(standdown.standsDown(v, BROADWAY), false, `value ${JSON.stringify(v)}`);
    assert.equal(standdown.standsDown(v, WEST_END), false, `value ${JSON.stringify(v)}`);
  }
});

test('"broadway" stands down Broadway (and Off-Broadway, same market) but not the West End', () => {
  assert.equal(standdown.standsDown('broadway', BROADWAY), true);
  assert.equal(standdown.standsDown(' Broadway ', BROADWAY), true);
  assert.equal(standdown.standsDown('broadway', OFF_BROADWAY), true);
  assert.equal(standdown.standsDown('broadway', WEST_END), false);
  assert.equal(standdown.standsDown('west-end', WEST_END), true);
  assert.equal(standdown.standsDown('west-end', BROADWAY), false);
});

test('a category token matches only that category; lists and "all" work', () => {
  assert.equal(standdown.standsDown('off-broadway', OFF_BROADWAY), true);
  assert.equal(standdown.standsDown('off-broadway', BROADWAY), false);
  assert.equal(standdown.standsDown('broadway, west-end', WEST_END), true);
  for (const v of ['all', 'ALL', 'true', 'yes', '1', 'on']) assert.equal(standdown.standsDown(v, WEST_END), true, v);
});

test('an unknown token fails closed: a typo stands every market down', () => {
  assert.equal(standdown.standsDown('broadwy', WEST_END), true);
  assert.equal(standdown.standsDown('broadway,westend', WEST_END), true);
  assert.deepEqual(standdown.parseStanddown('broadwy').all, true);
});

test('readStanddownLive: 404 means unset, a value is returned, failures fall back to the job-start value', async () => {
  const res = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const base = { repo: 'o/r', token: 't', envValue: 'broadway' };
  assert.deepEqual(await standdown.readStanddownLive({ ...base, fetchImpl: res(404) }), { value: '', source: 'live' });
  assert.deepEqual(await standdown.readStanddownLive({ ...base, fetchImpl: res(200, { name: 'LANE_STANDDOWN', value: 'all' }) }), { value: 'all', source: 'live' });
  const forbidden = await standdown.readStanddownLive({ ...base, fetchImpl: res(403) });
  assert.equal(forbidden.value, 'broadway');
  assert.equal(forbidden.source, 'env-fallback');
  const threw = await standdown.readStanddownLive({ ...base, fetchImpl: async () => { throw new Error('network down'); } });
  assert.equal(threw.value, 'broadway');
  assert.equal((await standdown.readStanddownLive({ ...base, token: '' })).source, 'env-fallback');
});

test('readStanddownLive: a hung request times out and falls back', async () => {
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const keepAlive = setTimeout(() => {}, 5000); // AbortSignal.timeout's timer is unref'd; a real fetch holds the loop open
  const out = await standdown.readStanddownLive({ repo: 'o/r', token: 't', envValue: '', fetchImpl: hang, timeoutMs: 20 });
  clearTimeout(keepAlive);
  assert.equal(out.source, 'env-fallback');
  assert.equal(out.value, '');
});

test('readStanddownLive sends the token to the variables endpoint', async () => {
  let seen;
  await standdown.readStanddownLive({ repo: 'thomaspryor/Broadwayscore', token: 'abc', fetchImpl: async (url, opts) => { seen = { url, opts }; return { status: 404, ok: false }; } });
  assert.equal(seen.url, 'https://api.github.com/repos/thomaspryor/Broadwayscore/actions/variables/LANE_STANDDOWN');
  assert.equal(seen.opts.headers.Authorization, 'Bearer abc');
});

function harness({ show = BROADWAY, value = () => '', runNight, heartbeat } = {}) {
  const calls = { pages: [], claim: 0, release: 0, heartbeat: 0, armCheck: 0, logs: [] };
  let tick = null;
  const deps = {
    standdown: standdown.createStanddownCheck({ show, repo: 'o/r', token: 't', envValue: '',
      fetchImpl: async () => { const v = value(); return v ? { status: 200, ok: true, json: async () => ({ value: v }) } : { status: 404, ok: false }; } }),
    armCheck: async () => { calls.armCheck++; return { arm: true }; },
    page: async (p) => { calls.pages.push(p); },
    claim: async () => { calls.claim++; return { ok: true }; },
    heartbeat: heartbeat || (async () => { calls.heartbeat++; return { ok: true }; }),
    release: async () => { calls.release++; return { ok: true }; },
    runNight: runNight || (async () => ({ passes: 1, admitted: [], published: [], errors: [], failed: [], unpublished: [] })),
    setInterval: (fn) => { tick = fn; return 1; },
    clearInterval: () => { tick = null; },
    log: (m) => calls.logs.push(m),
  };
  return { deps, calls, tick: () => tick && tick(), run: () => driver.runProductionLane({ show, night: NIGHT, holder: 'gha-1', deps }) };
}

test('unset: the lane arms, claims, runs and exits 0 as today', async () => {
  const h = harness();
  const out = await h.run();
  assert.equal(out.exit, 0);
  assert.equal(h.calls.claim, 1);
  assert.equal(h.calls.release, 1);
});

test('set before the start: exit 3 for that market, before the arm check and the claim, no page', async () => {
  const h = harness({ value: () => 'broadway' });
  const out = await h.run();
  assert.equal(out.exit, 3);
  assert.equal(out.reason, 'stood-down:broadway');
  assert.equal(h.calls.armCheck, 0);
  assert.equal(h.calls.claim, 0);
  assert.equal(h.calls.release, 0);
  assert.equal(h.calls.pages.length, 0);
});

test('"broadway" leaves a West End lane running', async () => {
  const h = harness({ show: WEST_END, value: () => 'broadway' });
  const out = await h.run();
  assert.equal(out.exit, 0);
  assert.equal(h.calls.claim, 1);
});

test('a stand-down check that throws never stops the lane', async () => {
  const h = harness();
  h.deps.standdown = async () => { throw new Error('boom'); };
  const out = await h.run();
  assert.equal(out.exit, 0);
  assert.equal(h.calls.claim, 1);
});

test('set mid-run: the heartbeat stops the lane, abandons the queue, keeps the lease until in-flight work drains, then releases once', async () => {
  let current = '';
  let h;
  const seen = [];
  h = harness({
    value: () => current,
    runNight: async ({ shouldStop, abandonPending }) => {
      assert.equal(shouldStop(), false);
      assert.equal(abandonPending(), false);
      current = 'broadway'; // the owner flips the switch on their phone
      h.tick();
      await flush(); await flush();
      seen.push({ stop: shouldStop(), abandon: abandonPending(), releasedYet: h.calls.release });
      // Still holding the lease: the next heartbeat renews it rather than re-checking or paging.
      h.tick(); await flush(); await flush();
      return { passes: 2, admitted: [{}], published: [], errors: [], failed: [], unpublished: ['abc'] };
    },
  });
  const out = await h.run();
  assert.deepEqual(seen, [{ stop: true, abandon: true, releasedYet: 0 }]);
  assert.equal(h.calls.heartbeat, 2, 'the lease is renewed while in-flight publishes drain');
  assert.equal(h.calls.release, 1);
  assert.equal(out.exit, 3);
  assert.equal(out.reason, 'stood-down-mid-run:broadway');
  assert.equal(h.calls.pages.length, 0, 'no lease-lost or unpublished page for a deliberate stand-down');
});

test('a heartbeat still running when the timer fires again is not overlapped', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  let started = 0;
  let h;
  h = harness({
    heartbeat: async () => { started++; await slow; return { ok: true }; },
    runNight: async () => {
      h.tick(); await flush();
      h.tick(); await flush();
      release(); await flush(); await flush();
      return { passes: 1, admitted: [], published: [], errors: [], failed: [], unpublished: [] };
    },
  });
  await h.run();
  assert.equal(started, 1);
});

test('runLaneNight with abandonPending publishes nothing and reports the queue as unpublished', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6617-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let updates = 0;
  const show = { id: BROADWAY.id, title: 'Test Show', openingDate: NIGHT };
  const res = await runLaneNight({
    show, night: NIGHT, openingDate: NIGHT, ledgerDir: dir, fetchText: async () => '', maxPasses: 1,
    adapters: [{ name: 'a', kind: 'aggregator', phase: 'main',
      discover: async () => [{ url: 'https://www.theguardian.com/stage/2026/oct/20/test-show-review', outletId: 'guardian', source: 'aggregator', aggregatorCited: true }] }],
    fetchReview: async () => ({ outletId: 'guardian', outlet: 'The Guardian', criticName: 'Test Critic', fullText: 'A delight. '.repeat(80), publishDate: NIGHT }),
    scoreReview: async () => 80,
    publishPorts: { updateReviews: async () => { updates++; throw new Error('must not publish'); }, regenShow: async () => {}, deploy: async () => {}, fetchLiveShow: async () => ({ rv: [] }) },
    now: () => Date.parse(`${NIGHT}T23:00:00Z`), wait: async () => {}, abandonPending: () => true,
  });
  assert.equal(updates, 0);
  assert.equal(res.admitted.length, 1, 'the fixture must admit a review, or this test proves nothing');
  assert.equal(res.unpublished.length, 1);
});

test('a live read that falls back to the job-start value is logged once, not on every heartbeat', async () => {
  let h;
  h = harness({
    runNight: async () => { h.tick(); await flush(); await flush(); h.tick(); await flush(); await flush();
      return { passes: 1, admitted: [], published: [], errors: [], failed: [], unpublished: [] }; },
  });
  h.deps.standdown = standdown.createStanddownCheck({ show: BROADWAY, repo: 'o/r', token: 't', envValue: '', fetchImpl: async () => ({ status: 403, ok: false }) });
  const out = await h.run();
  assert.equal(out.exit, 0);
  assert.equal(h.calls.logs.filter((m) => m.includes('cannot read LANE_STANDDOWN live (HTTP 403)')).length, 1);
});

test('spaces inside an entry read as hyphens, so "West End" does not stand everything down', () => {
  assert.equal(standdown.standsDown('West End', WEST_END), true);
  assert.equal(standdown.standsDown('West End', BROADWAY), false);
  assert.equal(standdown.standsDown('off broadway', OFF_BROADWAY), true);
  assert.equal(standdown.standsDown('off broadway', BROADWAY), false);
  assert.equal(standdown.standsDown('west end, broadway', BROADWAY), true);
});

test('a heartbeat still reading the variable when the run ends finishes before the release, so no false lease-lost page', async () => {
  let resolveFetch;
  let released = false;
  let h;
  h = harness({
    heartbeat: async () => (released ? { ok: false, reason: 'no-lease' } : { ok: true }),
    runNight: async () => { h.tick(); await flush(); return { passes: 1, admitted: [], published: [], errors: [], failed: [], unpublished: [] }; },
  });
  let reads = 0;
  const clear = { standDown: false, value: '', source: 'live' };
  h.deps.standdown = () => (++reads === 1 ? Promise.resolve(clear) : new Promise((r) => { resolveFetch = () => r(clear); }));
  h.deps.release = async () => { released = true; h.calls.release++; return { ok: true }; };
  let done = false;
  const run = h.run().then((o) => { done = true; return o; });
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(done, false, 'the release waits for the heartbeat still in progress');
  assert.equal(released, false);
  resolveFetch();
  const out = await run;
  assert.equal(out.exit, 0);
  assert.equal(h.calls.pages.length, 0);
  assert.equal(h.calls.release, 1);
});

test('a lease lost after a stand-down still exits as lease lost', async () => {
  let current = '';
  let h;
  h = harness({
    value: () => current,
    heartbeat: async () => ({ ok: false, reason: 'no-lease' }),
    runNight: async () => { current = 'broadway'; h.tick(); await flush(); await flush(); await flush();
      return { passes: 1, admitted: [], published: [], errors: [], failed: [], unpublished: [] }; },
  });
  const out = await h.run();
  assert.notEqual(out.exit, 3);
  assert.ok(h.calls.pages.some((p) => /lost the lease/.test(p.title)));
});
