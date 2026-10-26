/**
 * BRO-2735: zero-text _pending stubs swallowed T1/T2 reviews.
 *
 * Before the fix, replay-pending-bylines.js met a zero-text, byline-less
 * _pending stub with a quiet "no byline detected — keep in pending" and a clean
 * exit: no event, no alert, no re-fetch of the body, and nothing watched how
 * long the stub sat there. These tests drive the REAL processShow() against a
 * temp review-texts tree with an injected (mocked) fetchPage / routeAlert /
 * emitStage — no network, no email, no real ledger writes — and run the REAL
 * validate-review-texts.js CLI against a seeded fixture tree for the age guard.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// scripts/ (this suite lives in scripts/lib/ so the scripts/lib/*.test.mjs glob collects it).
const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const replay = require('../replay-pending-bylines.js');
const { REPORT_ONLY_CHECKS, CATASTROPHIC_CHECKS, HEALABLE_CHECKS } = require('./review-texts-gate.js');
const { STALE_PENDING_CHECK } = require('./pending-review-health.js');

const NOW = new Date('2026-10-12T12:00:00Z');
const SHOW = {
  id: 'zephyr-test-show-west-end-2026', title: 'Zephyr Nights', venue: 'Harold Pinter Theatre',
  openingDate: '2026-10-10', previewsStartDate: '2026-09-25', category: 'west-end', market: 'west-end', status: 'open',
};
const URL_ = 'https://www.theguardian.com/stage/2026/oct/11/zephyr-nights-review';
const para = (i) => `<p>Zephyr Nights at the Harold Pinter Theatre is a gripping evening of theatre, paragraph ${i}. The cast of Zephyr Nights delivers performances with real conviction, and the direction keeps the tension taut across two acts while the design shimmers under moody light.</p>`;
const BODY = Array.from({ length: 14 }, (_, i) => para(i)).join('\n');
const articleHtml = ({ author = null, body = BODY } = {}) =>
  `<html><head><title>Zephyr Nights review – a gripping evening</title>` +
  `<script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', datePublished: '2026-10-11T08:00:00Z',
    ...(author ? { author: { '@type': 'Person', name: author } } : {}) })}</script>` +
  `</head><body><article>${body}</article></body></html>`;

function zeroTextStub(extra = {}) {
  return {
    showId: SHOW.id, outletId: 'guardian', outlet: 'The Guardian', criticName: 'Unknown', url: URL_,
    publishDate: null, fullText: null, isFullReview: false, originalScore: null, contentTier: 'stub',
    contentTierReason: 'No text content', source: 'theatre-reviews', pendingReason: 'no-byline', ...extra,
  };
}

function seed(stub = zeroTextStub(), file = 'guardian--5ec6daf9.json') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2735-replay-'));
  const dir = path.join(root, '_pending', SHOW.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(root, SHOW.id), { recursive: true });
  const filepath = path.join(dir, file);
  fs.writeFileSync(filepath, JSON.stringify(stub, null, 2));
  return { root, dir, filepath, file };
}

function fakes({ fetchImpl } = {}) {
  const calls = { fetch: [], alert: [], emit: [] };
  return {
    calls,
    deps: {
      fetch: async (url) => { calls.fetch.push(url); return fetchImpl ? fetchImpl(url) : { content: articleHtml(), source: 'mock' }; },
      alert: async (opts) => { calls.alert.push(opts); return { action: 'digest' }; },
      emit: (ev) => { calls.emit.push(ev); },
      now: () => NOW,
      budget: { exceeded: () => false, minutes: 0 },
    },
  };
}

async function run(seeded, f, extra = {}) {
  const r = await replay.processShow(SHOW.id, { root: seeded.root, show: SHOW, dryRun: false, explicitScope: false, ...f.deps, ...extra });
  if (r.alertPromise) await r.alertPromise;
  return r;
}

for (const dryRun of [false, true]) {
  test(`BWW section stub already landed at /article/ is redundant (dryRun=${dryRun})`, async (t) => {
    const article = 'Review-ZEPHYR-NIGHTS-20261011';
    const s = seed(zeroTextStub({
      outletId: 'broadwayworld', outlet: 'BroadwayWorld',
      url: `https://www.broadwayworld.com/westend/article/${article}`,
      pendingUnrecoverableAt: '2026-10-11T00:00:00Z',
    }), 'broadwayworld--1234abcd.json');
    t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
    const primaryPath = path.join(s.root, SHOW.id, 'broadwayworld--jane-critic.json');
    const primary = JSON.stringify({
      showId: SHOW.id, outletId: 'broadwayworld', criticName: 'Jane Critic',
      url: `https://www.broadwayworld.com/article/${article}`,
      fullText: 'Zephyr Nights is a gripping evening of theatre. '.repeat(40),
    });
    fs.writeFileSync(primaryPath, primary);
    const stubBefore = fs.readFileSync(s.filepath, 'utf8');
    const f = fakes({ fetchImpl: () => { throw new Error('redundant stub must never fetch'); } });
    const result = await run(s, f, { explicitScope: true, dryRun });
    assert.equal(result.droppedRedundant, 1);
    assert.equal(result.unrecoverable, 0);
    assert.equal(result.refetched, 0);
    assert.deepEqual(f.calls, { fetch: [], alert: [], emit: [] });
    assert.equal(fs.readFileSync(primaryPath, 'utf8'), primary);
    assert.equal(fs.existsSync(s.filepath), dryRun);
    if (dryRun) assert.equal(fs.readFileSync(s.filepath, 'utf8'), stubBefore);
  });
}

describe('replay-pending-bylines: zero-text stub is not silently kept (BRO-2735)', () => {
  test('page with no byline and no recoverable body → pending-unrecoverable event + owner alert', async () => {
    const s = seed();
    const f = fakes({ fetchImpl: () => ({ content: '<html><head><title>Zephyr Nights</title></head><body><p>Subscribe.</p></body></html>', source: 'mock' }) });
    const r = await run(s, f);
    assert.equal(r.unrecoverable, 1, 'zero-text no-byline stub must be counted unrecoverable');
    assert.equal(r.promoted, 0);
    assert.deepEqual(f.calls.fetch, [URL_], 're-fetch attempted via the injected fetchPage');
    assert.equal(f.calls.emit.length, 1);
    assert.equal(f.calls.emit[0].stage, 'pending-unrecoverable');
    assert.equal(f.calls.emit[0].showId, SHOW.id);
    assert.equal(f.calls.alert.length, 1);
    assert.equal(f.calls.alert[0].disposition, 'human');
    assert.equal(f.calls.alert[0].conditionKey, `pending-unrecoverable:${SHOW.id}`);
    assert.match(f.calls.alert[0].description, /guardian--5ec6daf9\.json/);
    // stub kept (never deleted) and stamped so the event fires once per stub
    const after = JSON.parse(fs.readFileSync(s.filepath, 'utf8'));
    assert.ok(after.pendingUnrecoverableAt);
  });

  test('second run does not re-emit the stage event for an already-stamped stub (alert still routed; router cooldown dedups)', async () => {
    const s = seed(zeroTextStub({ pendingUnrecoverableAt: '2026-10-11T00:00:00Z' }));
    const f = fakes({ fetchImpl: () => { throw new Error('net::ERR_TIMED_OUT'); } });
    const r = await run(s, f);
    assert.equal(r.unrecoverable, 1);
    assert.equal(f.calls.emit.length, 0);
    assert.equal(f.calls.alert.length, 1);
  });

  test('fetch failure on a zero-text stub is unrecoverable, not a quiet keep', async () => {
    const s = seed();
    const f = fakes({ fetchImpl: () => { throw new Error('blocked'); } });
    const r = await run(s, f);
    assert.equal(r.unrecoverable, 1);
    assert.match(f.calls.alert[0].description, /fetch failed: blocked/);
  });

  test('stub that has text but no byline is kept quietly (not unrecoverable)', async () => {
    const s = seed(zeroTextStub({ fullText: 'Zephyr Nights is good. '.repeat(40), contentTier: 'truncated' }));
    const f = fakes({ fetchImpl: () => ({ content: '<html><head><title>Zephyr Nights</title></head><body><p>x</p></body></html>', source: 'mock' }) });
    const r = await run(s, f);
    assert.equal(r.unrecoverable, 0);
    assert.equal(f.calls.alert.length, 0);
  });

  test('dry-run reports but never alerts, emits or writes', async () => {
    const s = seed();
    const before = fs.readFileSync(s.filepath, 'utf8');
    const f = fakes({ fetchImpl: () => ({ content: null }) });
    const r = await run(s, f, { dryRun: true });
    assert.equal(r.unrecoverable, 1);
    assert.equal(f.calls.alert.length, 0);
    assert.equal(f.calls.emit.length, 0);
    assert.equal(fs.readFileSync(s.filepath, 'utf8'), before);
  });

  test('outside the post-opening week and not named explicitly → logged, no alert', async () => {
    const s = seed();
    const f = fakes({ fetchImpl: () => ({ content: null }) });
    const old = { ...SHOW, openingDate: '2026-08-01' };
    const r = await run(s, f, { show: old });
    assert.equal(r.unrecoverable, 1);
    assert.equal(f.calls.alert.length, 0);
    const named = fakes({ fetchImpl: () => ({ content: null }) });
    const r2 = await run(seed(), named, { show: old, explicitScope: true });
    assert.equal(r2.unrecoverable, 1);
    assert.equal(named.calls.alert.length, 1, '--show/--shows alerts after opening');
    const pre = fakes({ fetchImpl: () => ({ content: null }) });
    const r3 = await run(seed(), pre, { show: { ...SHOW, openingDate: '2026-10-20' }, explicitScope: true });
    assert.equal(r3.unrecoverable, 1);
    assert.equal(pre.calls.alert.length, 0, 'pre-opening empty stubs are expected — never alert');
  });
});

describe('replay-pending-bylines: re-fetch path rebuilds the record (BRO-2735)', () => {
  test('URL + no body + byline in page → promoted file rebuilt with the fetched body', async () => {
    const s = seed(zeroTextStub({ someStaleJunk: 'should not survive a rebuild' }));
    const f = fakes({ fetchImpl: () => ({ content: articleHtml({ author: 'Jane Critic' }), source: 'mock' }) });
    const r = await run(s, f);
    assert.deepEqual(f.calls.fetch, [URL_]);
    assert.equal(r.refetched, 1);
    assert.equal(r.promoted, 1);
    assert.equal(r.unrecoverable, 0);
    assert.equal(f.calls.alert.length, 0);
    const out = JSON.parse(fs.readFileSync(path.join(s.root, SHOW.id, 'guardian--jane-critic.json'), 'utf8'));
    assert.ok(out.fullText && out.fullText.length > 1000, 'body recovered');
    assert.ok(['complete', 'truncated'].includes(out.contentTier));
    assert.equal(out.criticName, 'Jane Critic');
    assert.ok(out.pendingRefetchedAt);
    assert.equal(out.someStaleJunk, 'should not survive a rebuild', 'non-body stub fields (exclusion flags, provenance) are carried');
    assert.equal(out.needsTextRetry, undefined);
    assert.equal(fs.existsSync(s.filepath), false, 'stub removed after promotion');
  });

  test('URL + no body + no byline but body recoverable → pending stub rewritten with text, not unrecoverable', async () => {
    const s = seed();
    const f = fakes({ fetchImpl: () => ({ content: articleHtml(), source: 'mock' }) });
    const r = await run(s, f);
    assert.equal(r.unrecoverable, 0);
    assert.equal(r.promoted, 0);
    assert.equal(r.refetched, 1);
    assert.equal(f.calls.alert.length, 0);
    const after = JSON.parse(fs.readFileSync(s.filepath, 'utf8'));
    assert.ok(after.fullText && after.fullText.length > 1000);
    assert.ok(after.pendingRefetchedAt);
  });
});

describe('_pending age guard in validate-review-texts.js (BRO-2735)', () => {
  test('stale_pending is report-only under --gate (not catastrophic, not healable)', () => {
    assert.equal(STALE_PENDING_CHECK, 'stale_pending');
    assert.ok(REPORT_ONLY_CHECKS.has('stale_pending'));
    assert.equal(CATASTROPHIC_CHECKS.has('stale_pending'), false);
    assert.equal(HEALABLE_CHECKS.has('stale_pending'), false);
  });

  function fixtureDataDir() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2735-validate-'));
    const rt = path.join(dataDir, 'review-texts');
    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const daysAgo = (n) => new Date(today.getTime() - n * 86400e3);
    const shows = [
      { id: 'stale-show-2026', title: 'Stale Show', openingDate: iso(daysAgo(2)) },
      { id: 'pre-opening-show-2026', title: 'Pre Show', openingDate: iso(daysAgo(-3)) },
      { id: 'old-show-2026', title: 'Old Show', openingDate: iso(daysAgo(30)) },
    ];
    fs.writeFileSync(path.join(dataDir, 'shows.json'), JSON.stringify({ shows }));
    fs.writeFileSync(path.join(dataDir, 'outlet-registry.json'), JSON.stringify({ outlets: { guardian: {} } }));
    fs.mkdirSync(path.join(rt, 'stale-show-2026'), { recursive: true });
    fs.writeFileSync(path.join(rt, 'stale-show-2026', 'guardian--a-critic.json'),
      JSON.stringify({ showId: 'stale-show-2026', outletId: 'guardian', criticName: 'A Critic', url: 'https://x.test/a' }));
    const firstSeenAt = new Date(today.getTime() - 30 * 3600e3).toISOString();
    for (const s of shows) {
      const d = path.join(rt, '_pending', s.id);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'guardian--1234abcd.json'),
        JSON.stringify(zeroTextStub({ showId: s.id, firstSeenAt })));
    }
    return dataDir;
  }

  const runValidator = (dataDir, args) => spawnSync(process.execPath, [path.join(HERE, 'validate-review-texts.js'), ...args], {
    env: { ...process.env, VALIDATE_REVIEW_TEXTS_DATA_DIR: dataDir }, encoding: 'utf8',
  });

  test('default mode FAILS on a seeded stale stub (post-opening only); --gate passes', () => {
    const dataDir = fixtureDataDir();
    const def = runValidator(dataDir, ['--json']);
    assert.equal(def.status, 1, `default validator must fail on stale_pending\n${def.stdout}\n${def.stderr}`);
    const parsed = JSON.parse(def.stdout);
    const stale = parsed.errors.filter(e => e.check === 'stale_pending');
    assert.equal(stale.length, 1, 'only the show 2 days after opening flags (pre-opening and 30d-old do not)');
    assert.match(stale[0].file, /_pending\/stale-show-2026\//);
    assert.equal(parsed.summary.stalePending, 1);

    const gate = runValidator(dataDir, ['--gate']);
    assert.equal(gate.status, 0, `--gate must not block on stale_pending\n${gate.stdout}\n${gate.stderr}`);
    assert.match(gate.stdout, /report-only error\(s\) \(stale_pending\)/);
  });
});

describe('replay-pending-bylines: closes the pending-unrecoverable condition (BRO-6338)', () => {
  // A redundant stub (its article already landed) leaves nothing unrecoverable.
  const redundantSeed = () => {
    const article = 'Review-ZEPHYR-NIGHTS-20261011';
    const s = seed(zeroTextStub({
      outletId: 'broadwayworld', outlet: 'BroadwayWorld', url: `https://www.broadwayworld.com/westend/article/${article}`,
    }), 'broadwayworld--1234abcd.json');
    fs.writeFileSync(path.join(s.root, SHOW.id, 'broadwayworld--jane-critic.json'), JSON.stringify({
      showId: SHOW.id, outletId: 'broadwayworld', criticName: 'Jane Critic',
      url: `https://www.broadwayworld.com/article/${article}`, fullText: 'Zephyr Nights is a gripping evening of theatre. '.repeat(40),
    }));
    return s;
  };

  test('complete scan with zero unrecoverable stubs resolves the show condition', async (t) => {
    const s = redundantSeed();
    t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
    const resolved = [];
    const r = await run(s, fakes(), { resolve: (key) => resolved.push(key) });
    assert.equal(r.unrecoverable, 0);
    assert.deepEqual(resolved, [`pending-unrecoverable:${SHOW.id}`]);
  });

  test('dry run, budget stop and a still-unrecoverable stub never resolve it', async (t) => {
    const resolved = [];
    const s1 = redundantSeed();
    t.after(() => fs.rmSync(s1.root, { recursive: true, force: true }));
    await run(s1, fakes(), { dryRun: true, resolve: (k) => resolved.push(k) });
    const s2 = redundantSeed();
    t.after(() => fs.rmSync(s2.root, { recursive: true, force: true }));
    const f2 = fakes();
    f2.deps.budget = { exceeded: () => true, minutes: 0 };
    await run(s2, f2, { resolve: (k) => resolved.push(k) });
    const s3 = seed();
    t.after(() => fs.rmSync(s3.root, { recursive: true, force: true }));
    const f3 = fakes({ fetchImpl: () => { throw new Error('blocked'); } });
    const r3 = await run(s3, f3, { resolve: (k) => resolved.push(k) });
    assert.equal(r3.unrecoverable, 1);
    assert.deepEqual(resolved, []);
  });
});
