// BRO-4831: the production lane driver. Real runProductionLane (CLAUDE.md section 15) with injected deps; nothing here
// touches a lease store, a scraper or a scorer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const driver = require('../../scripts/lib/opening-night-lane/driver.js');
const { runLaneNight } = require('../../scripts/lib/opening-night-lane/lane-runner.js');

const SHOW = { id: 'test-show-2026', title: 'Test Show' };
const NIGHT = '2026-10-20';

function harness(over = {}) {
  const calls = { pages: [], claim: 0, release: 0, heartbeat: 0, run: 0 };
  let tick = null;
  const deps = {
    armCheck: async () => ({ arm: true, reason: 'last-rehearsal-passed' }),
    page: async (p) => { calls.pages.push(p); },
    claim: async () => { calls.claim++; return { ok: true }; },
    heartbeat: async () => { calls.heartbeat++; return { ok: true }; },
    release: async () => { calls.release++; return { ok: true }; },
    runNight: async () => { calls.run++; return { passes: 3, admitted: [], published: [], errors: [], failed: [], unpublished: [] }; },
    setInterval: (fn) => { tick = fn; return 1; },
    clearInterval: () => { tick = null; },
    log: () => {},
    ...over,
  };
  return { deps, calls, tick: () => tick && tick(), run: () => driver.runProductionLane({ show: SHOW, night: NIGHT, holder: 'gha-1', deps }) };
}

test('arm refusal: digest alert naming the reason, exit 3, and no lease is ever claimed', async () => {
  const h = harness({ armCheck: async () => ({ arm: false, reason: 'lane-changed-since-rehearsal' }) });
  const out = await h.run();
  assert.equal(out.exit, 3);
  assert.equal(h.calls.claim, 0);
  assert.equal(h.calls.run, 0);
  assert.equal(h.calls.pages.length, 1);
  assert.match(h.calls.pages[0].conditionKey, /^opening-night-lane-arm-refused:test-show-2026:2026-10-20$/);
  assert.match(h.calls.pages[0].title, /lane-changed-since-rehearsal/);
});

test('lease held by the other starter: stand down quietly (exit 3, no alert, no run)', async () => {
  const h = harness({ claim: async () => ({ ok: false, reason: 'held-by-other', holder: 'mac-1' }) });
  const out = await h.run();
  assert.equal(out.exit, 3);
  assert.equal(h.calls.pages.length, 0);
  assert.equal(h.calls.run, 0);
});

test('a claim failure that is not held-by-other alerts and exits 1', async () => {
  const h = harness({ claim: async () => ({ ok: false, reason: 'state-unreadable', detail: 'ls-remote failed' }) });
  const out = await h.run();
  assert.equal(out.exit, 1);
  assert.match(h.calls.pages[0].conditionKey, /claim-failed/);
});

test('a definitive heartbeat loss stops the night through shouldStop and alerts once; exit 4', async () => {
  let shouldStopSeen;
  const h = harness({
    heartbeat: async () => ({ ok: false, reason: 'expired' }),
    runNight: async ({ shouldStop }) => {
      assert.equal(shouldStop(), false);
      await h.tick(); await h.tick(); // two failed heartbeats
      shouldStopSeen = shouldStop();
      return { passes: 1, admitted: [], published: [], errors: [], failed: [], unpublished: [] };
    },
  });
  const out = await h.run();
  assert.equal(shouldStopSeen, true);
  assert.equal(out.exit, 4);
  assert.equal(h.calls.pages.filter((p) => /lease-lost/.test(p.conditionKey)).length, 1, 'alerted once, not per heartbeat');
  assert.equal(h.calls.release, 1);
});

test('a transient heartbeat failure alerts once and does not stop the night', async () => {
  let stopped;
  const h = harness({
    heartbeat: async () => ({ ok: false, reason: 'push-failed' }),
    runNight: async ({ shouldStop }) => { await h.tick(); await h.tick(); stopped = shouldStop(); return { passes: 1, admitted: [], published: [], errors: [], failed: [], unpublished: [] }; },
  });
  const out = await h.run();
  assert.equal(stopped, false);
  assert.equal(out.exit, 0);
  assert.equal(h.calls.pages.filter((p) => /heartbeat-failing/.test(p.conditionKey)).length, 1);
});

test('the lease is released even when the night throws; exit 1 with a crash alert', async () => {
  const h = harness({ runNight: async () => { throw new Error('boom'); } });
  const out = await h.run();
  assert.equal(out.exit, 1);
  assert.equal(h.calls.release, 1);
  assert.match(h.calls.pages[0].conditionKey, /crashed/);
});

test('unpublished scored reviews are a nonzero exit with a summary alert; a clean night is exit 0 with no alert', async () => {
  const dirty = harness({ runNight: async () => ({ passes: 5, admitted: [{}], published: [], errors: [], failed: [{ key: 'k2', reason: 'x' }], unpublished: ['k1'] }) });
  const out = await dirty.run();
  assert.equal(out.exit, 4);
  assert.match(dirty.calls.pages[0].title, /1 unpublished, 1 failed/);
  const clean = harness();
  assert.equal((await clean.run()).exit, 0);
  assert.equal(clean.calls.pages.length, 0);
});

test('buildRealLaneDeps refuses before any lease work when scorer keys are missing', () => {
  assert.throws(() => driver.buildRealLaneDeps({ show: SHOW, night: NIGHT, holder: 'h', repoDir: '.', coreDir: '.', env: {} }), /missing scorer keys ANTHROPIC_API_KEY, OPENAI_API_KEY/);
  assert.throws(() => driver.buildRealLaneDeps({ show: SHOW, night: NIGHT, holder: 'h', repoDir: '.', coreDir: '.', env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' } }), /routeAlert and ScorerClass are required/);
});

test('the production driver persists scored reviews before publishing and skips them on restart', async (t) => {
  const runner = require('../../scripts/lib/opening-night-lane/lane-runner.js');
  const discovery = require('../../scripts/lib/opening-night-lane/discovery.js');
  const inline = require('../../scripts/lib/opening-night-lane/inline-score.js');
  const realPorts = require('../../scripts/lib/opening-night-lane/real-ports.js');
  const ledger = require('../../scripts/lib/opening-night-lane/ledger.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4835-driver-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const show = { ...SHOW, openingDate: NIGHT };
  const url = 'https://www.theguardian.com/stage/2026/oct/20/test-show-review';
  const text = 'The performances and staging make this production a delight. '.repeat(20);
  const ledgerDir = path.join(dir, 'ledger');
  let scored = 0;
  let doc = { reviews: [] };
  const savedRows = () => {
    const root = path.join(dir, 'data', 'review-texts', show.id);
    return fs.existsSync(root) ? fs.readdirSync(root).map(f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'))) : [];
  };
  t.mock.method(discovery, 'bwwRoundupAdapter', () => ({ name: 'archived', discover: async () => [{ url, outletId: 'guardian', source: 'aggregator', aggregatorCited: true }] }));
  // Every adapter factory except the one mocked above: a new adapter must never reach the real network from this test (BRO-4820: it cost 43s).
  for (const name of Object.keys(discovery).filter(k => /Adapter$/.test(k) && k !== 'bwwRoundupAdapter')) {
    t.mock.method(discovery, name, () => ({ name, discover: async () => [] }));
  }
  t.mock.method(inline, 'realFetchPorts', () => ({
    fetchPage: async () => ({ content: text }), extractArticle: html => html,
    extractMeta: () => ({ criticName: 'Test Critic', publishDate: NIGHT }),
  }));
  t.mock.method(realPorts, 'createRealPublishPorts', () => ({
    updateReviews: async fn => {
      const rows = savedRows();
      assert.equal(rows.length, 1, 'the source record must exist before publishing');
      assert.equal(rows[0].assignedScore, 83);
      assert.deepEqual(rows[0].ensembleData, { modelCount: 2 });
      const out = fn(doc); doc = out.doc; return out;
    },
    regenShow: async () => {}, deploy: async () => {},
    fetchLiveShow: async () => ({ rv: doc.reviews.map(r => ({ u: r.url })) }),
  }));
  t.mock.method(runner, 'runLaneNight', opts => runLaneNight({
    ...opts, maxPasses: 1, dryRun: true, now: () => Date.parse(`${NIGHT}T12:00:00Z`), wait: async () => {},
  }));
  class Scorer {
    async scoreReviewFile() {
      scored++;
      return { success: true, scoredFile: { assignedScore: 83, ensembleData: { modelCount: 2 } } };
    }
  }
  const deps = driver.buildRealLaneDeps({
    show, night: NIGHT, openingDate: NIGHT, holder: 'test', repoDir: dir, coreDir: dir, ledgerDir,
    env: { ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: 'test' }, routeAlert: async () => {}, ScorerClass: Scorer,
  });
  const first = await deps.runNight({ shouldStop: () => false });
  assert.deepEqual(first.errors, []);
  assert.equal(first.published[0].verified.length, 1);
  assert.equal(savedRows()[0].fullText, text.trim());
  assert.deepEqual(doc.reviews, savedRows(), 'publish exactly the persisted record');
  assert.ok(ledger.readLedger(ledgerDir, show.id, NIGHT).events.some(e => e.stage === 'scored'));
  const restarted = await deps.runNight({ shouldStop: () => false });
  assert.equal(restarted.admitted.length, 0);
  assert.equal(savedRows().length, 1);
  assert.equal(scored, 1);
});

test('onDiskUrlsFor returns only this show\'s URLs and tolerates a missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4831-'));
  const f = path.join(dir, 'reviews.json');
  fs.writeFileSync(f, JSON.stringify({ reviews: [{ showId: SHOW.id, url: 'https://a.com/1' }, { showId: 'other', url: 'https://b.com/2' }, { showId: SHOW.id }] }));
  assert.deepEqual(driver.onDiskUrlsFor(f, SHOW.id), ['https://a.com/1']);
  assert.deepEqual(driver.onDiskUrlsFor(path.join(dir, 'nope.json'), SHOW.id), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runLaneNight honours shouldStop: no discovery pass runs once it is true', async () => {
  let fetched = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4831-ledger-'));
  const res = await runLaneNight({
    show: SHOW, night: NIGHT, adapters: [{ name: 'a', kind: 'aggregator', phase: 'main', discover: async () => { fetched++; return []; } }],
    fetchText: async () => '', ledgerDir: dir, fetchReview: async () => ({}), scoreReview: async () => 50,
    publishPorts: {}, now: () => 0, wait: async () => {}, shouldStop: () => true,
  });
  assert.equal(res.stopped, true);
  assert.equal(res.passes, 0);
  assert.equal(fetched, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an alert that throws (from the heartbeat timer or the summary) never crashes the night or skips the release', async () => {
  const logs = [];
  const h = harness({
    page: async () => { throw new Error('router down'); },
    heartbeat: async () => ({ ok: false, reason: 'expired' }),
    log: (m) => logs.push(m),
    runNight: async () => { await h.tick(); return { passes: 1, admitted: [], published: [], errors: [], failed: [], unpublished: ['k1'] }; },
  });
  const out = await h.run();
  assert.equal(out.exit, 4, 'the summary alert failing does not turn the result into a rejection');
  assert.equal(h.calls.release, 1);
  assert.ok(logs.some((m) => /alert failed \(router down\)/.test(m)));
});

test('the lane folder does not pull the alert router into the arm hash', () => {
  const rehearsal = require('../../scripts/lib/opening-night-lane/rehearsal.js');
  const files = rehearsal.laneCodeFiles().map((f) => path.basename(f));
  assert.ok(files.includes('driver.js'));
  assert.ok(!files.includes('owner-alert-router.js'), 'alert router edits must not disarm the lane');
  assert.ok(!files.includes('linear-client.js'));
});

// BRO-4835: the live workflow caps the lane step at 280 min; the lane's own window must end before that.
import fsWin from 'node:fs';
test('live workflow sets a lane window shorter than the lane step timeout', () => {
  const y = fsWin.readFileSync(new URL('../../.github/workflows/opening-night-lane-live.yml', import.meta.url), 'utf8');
  const win = Number(/OPENING_NIGHT_LANE_WINDOW_MIN:\s*'?(\d+)'?/.exec(y)[1]);
  const cap = Number(/id: lane\s+timeout-minutes:\s*(\d+)/.exec(y)[1]);
  assert.ok(win > 0 && win < cap, `window ${win} must be below the step cap ${cap}`);
  assert.match(fsWin.readFileSync(new URL('../../scripts/lib/opening-night-lane/driver.js', import.meta.url), 'utf8'), /OPENING_NIGHT_LANE_WINDOW_MIN/);
});
