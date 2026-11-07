// BRO-6532: bulk-workflow dispatches are capped by in-flight runs so land.yml
// and test.yml get runners. require()s the real decision, counter, CLI and the
// per-show downstream dispatcher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CAPS, decideCap, countInFlight, checkCap } = require('./workflow-queue-cap.js');
const { dispatchDownstream } = require('./land-ingested-reviews.js');
const cli = require('../capped-workflow-dispatch.js');

const run = (file) => ({ path: `.github/workflows/${file}@refs/heads/main` });
const page = (runs) => ({ workflow_runs: runs });
// api stub: status -> runs on the repo-wide pages
const apiFor = (byStatus, calls = []) => (args) => {
  calls.push(args[0]);
  const m = args[0].match(/status=([a-z_]+)/);
  return page(byStatus[m[1]] || []);
};

test('decideCap defers at the cap and allows below it', () => {
  const cap = CAPS['llm-ensemble-score.yml'];
  assert.equal(decideCap({ workflow: 'llm-ensemble-score.yml', active: cap }).ok, false);
  assert.equal(decideCap({ workflow: 'llm-ensemble-score.yml', active: cap - 1 }).ok, true);
});

test('decideCap never caps land, test or other non-bulk workflows', () => {
  for (const wf of ['land.yml', 'test.yml', 'vercel-deploy.yml', 'opening-night-reviews.yml']) {
    assert.equal(decideCap({ workflow: wf, active: 500 }).ok, true, wf);
  }
});

test('decideCap: priority, kill switch and unreadable counts all allow', () => {
  const wf = 'gather-reviews.yml';
  assert.equal(decideCap({ workflow: wf, active: 99, priority: true }).ok, true);
  assert.equal(decideCap({ workflow: wf, active: 99, disabled: true }).ok, true);
  assert.equal(decideCap({ workflow: wf, active: null }).ok, true);
});

test('gather cap matches its 2-slot FIFO gate (each run fans out to 10 jobs)', () => {
  assert.equal(CAPS['gather-reviews.yml'], 2);
});

test('countInFlight counts only the named workflow across in_progress, queued and pending in 3 calls', () => {
  const calls = [];
  const api = apiFor({
    in_progress: [run('ingest-urls.yml'), run('ingest-urls.yml'), run('land.yml')],
    queued: [run('ingest-urls.yml'), run('test.yml')],
    pending: [run('ingest-urls.yml')],
  }, calls);
  assert.equal(countInFlight({ workflow: 'ingest-urls.yml', api }), 4);
  assert.equal(calls.length, 3);
});

test('countInFlight uses exact per-workflow totals when a page is full', () => {
  const full = Array.from({ length: 100 }, () => run('test.yml'));
  const api = (args) => {
    if (args[0].includes('/workflows/')) return { total_count: 7 };
    return page(args[0].includes('status=queued') ? full : []);
  };
  assert.equal(countInFlight({ workflow: 'gather-reviews.yml', api }), 21);
});

test('countInFlight returns null (fail open) when the API throws', () => {
  assert.equal(countInFlight({ workflow: 'ingest-urls.yml', api: () => { throw new Error('HTTP 403'); } }), null);
  const logs = [];
  const d = checkCap({ workflow: 'ingest-urls.yml', api: () => { throw new Error('x'); }, env: {}, log: (m) => logs.push(m) });
  assert.equal(d.ok, true);
  assert.match(logs.join('\n'), /::warning::/);
});

test('checkCap makes no API call for non-bulk, priority or disabled dispatches', () => {
  const api = () => { throw new Error('should not be called'); };
  assert.equal(checkCap({ workflow: 'land.yml', api, env: {} }).ok, true);
  assert.equal(checkCap({ workflow: 'ingest-urls.yml', priority: true, api, env: {} }).ok, true);
  assert.equal(checkCap({ workflow: 'ingest-urls.yml', api, env: { WORKFLOW_CAP_DISABLED: '1' } }).ok, true);
});

test('dispatchDownstream defers a non-urgent show\'s scoring over the cap but still rebuilds', () => {
  const ran = [];
  const out = dispatchDownstream({
    showId: 'some-show', newReviews: 2, log: () => {},
    exec: (cmd) => ran.push(cmd),
    capCheck: () => ({ ok: false, reason: '6 runs in flight (cap 6)' }),
    urgent: () => false,
  });
  assert.equal(ran.some((c) => c.includes('llm-ensemble-score.yml')), false);
  assert.equal(ran.some((c) => c.includes('rebuild-reviews.yml')), true);
  assert.deepEqual(out.find((r) => r.name === 'LLM Ensemble Score'), { name: 'LLM Ensemble Score', ok: true, deferred: true });
});

test('dispatchDownstream always scores an opening-night show, and any show under the cap', () => {
  for (const [ok, urgent] of [[false, true], [true, false]]) {
    const ran = [];
    dispatchDownstream({
      showId: 'x', newReviews: 1, log: () => {}, exec: (cmd) => ran.push(cmd),
      capCheck: () => ({ ok, reason: 'r' }), urgent: () => urgent,
    });
    assert.equal(ran.some((c) => c.includes('llm-ensemble-score.yml -f show_id=x')), true, `ok=${ok} urgent=${urgent}`);
  }
});

test('CLI: exit 3 when deferred, 0 and one dispatch when there is room, 1 on bad args', () => {
  const sent = [];
  const send = (x) => sent.push(x);
  const full = () => ({ ok: false, reason: 'full' });
  const room = () => ({ ok: true, reason: 'room' });
  assert.equal(cli.main(['--workflow=ingest-urls.yml', '-f', 'show_id=a'], { check: full, send, log: () => {} }), cli.EXIT_DEFERRED);
  assert.equal(sent.length, 0);
  assert.equal(cli.main(['--workflow=ingest-urls.yml', '-f', 'show_id=a', '-f', 'urls=u1 o'], { check: room, send, log: () => {} }), 0);
  assert.deepEqual(sent, [{ workflow: 'ingest-urls.yml', inputs: { show_id: 'a', urls: 'u1 o' }, ref: 'main' }]);
  assert.equal(cli.main(['-f', 'x=1'], { check: room, send, log: () => {} }), 1);
});

test('CLI wait is clamped under the 10-minute tool limit and polls until room', () => {
  assert.equal(cli.parseArgs(['--workflow=a.yml', '--wait-min=60']).waitMin, cli.MAX_WAIT_MIN);
  let t = 0;
  let n = 0;
  const d = cli.waitForRoom({
    workflow: 'a.yml', waitMin: 5, log: () => {},
    check: () => ({ ok: ++n >= 3, reason: 'r' }), wait: (ms) => { t += ms; }, now: () => t,
  });
  assert.equal(d.ok, true);
  assert.equal(n, 3);
});
