// BRO-4784 (epic BRO-4210 phase 2c): inline fetch, extract and score per review, with visible failures and bounded retries.
// Real functions only (CLAUDE.md section 15); fetch and scorer are injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const inl = require('../../scripts/lib/opening-night-lane/inline-score.js');
const lf = require('../../scripts/lib/opening-night-lane/lane-failures.js');
const ledger = require('../../scripts/lib/opening-night-lane/ledger.js');
const discovery = require('../../scripts/lib/opening-night-lane/discovery.js');
const publish = require('../../scripts/lib/opening-night-lane/publish.js');
const { runLaneNight } = require('../../scripts/lib/opening-night-lane/lane-runner.js');
const { buildSyntheticFixture } = require('../../scripts/lib/opening-night-lane/rehearsal-fixture.js');

const NIGHT_START = Date.parse('2026-10-18T22:00:00-04:00');

function sandbox({ failFetch = {}, failScore = {}, scorer, retryMs, aggregatorFor, extractArticle } = {}) {
  const fixture = buildSyntheticFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4784-'));
  let t = NIGHT_START;
  const now = () => t;
  const wait = async (ms) => { t += ms; };
  const byUrl = new Map(fixture.reviews.map((r) => [r.url, r]));
  const byKey = new Map(fixture.reviews.map((r) => [discovery.canonicalUrl(r.url), r]));
  const calls = { fetch: [], score: [] };
  const left = { fetch: { ...failFetch }, score: { ...failScore } };
  const stripKey = (u) => discovery.canonicalUrl(u);
  const fetchPage = async (url) => {
    const k = stripKey(url);
    calls.fetch.push({ k, at: t });
    if (left.fetch[k] > 0) { left.fetch[k] -= 1; throw new Error('503 from outlet'); }
    const e = byKey.get(k);
    if (!e) throw new Error('404');
    return { content: `<html><article>${e.text}</article></html>` };
  };
  const scoreText = scorer || (async (text, ctx) => {
    const k = stripKey(ctx.url);
    calls.score.push({ k, at: t });
    if (left.score[k] > 0) { left.score[k] -= 1; throw new Error('model timeout'); }
    return { score: byKey.get(k).score };
  });
  const scoring = inl.createInlineScoring({
    show: fixture.show, night: fixture.night, ledgerDir: path.join(dir, 'ledger'), now, fetchPage,
    extractArticle: extractArticle || ((html) => (html.match(/<article>([\s\S]*)<\/article>/) || [])[1] || null),
    extractMeta: (html, url) => ({ criticName: byKey.get(stripKey(url)).criticName, outlet: byKey.get(stripKey(url)).outletId, publishDate: '2026-10-19' }),
    aggregatorFor: aggregatorFor || ((c) => (byKey.get(c.key) || {}).aggregator || {}), scoreText, ...(retryMs ? { retryMs } : {}),
  });
  const reviewsFile = path.join(dir, 'reviews.json');
  fs.writeFileSync(reviewsFile, JSON.stringify({ reviews: [] }));
  const publishPorts = { ...publish.createReviewsFilePort(reviewsFile), regenShow: async () => {}, deploy: async () => {}, fetchLiveShow: async () => ({ rv: JSON.parse(fs.readFileSync(reviewsFile, 'utf8')).reviews.map((r) => ({ u: r.url })) }) };
  const run = (extra = {}) => runLaneNight({
    show: fixture.show, night: fixture.night, openingDate: fixture.openingDate, adapters: [discovery.bwwRoundupAdapter()],
    fetchText: async (u) => { if (!(u in fixture.pages)) throw new Error('404'); return fixture.pages[u]; },
    ledgerDir: path.join(dir, 'ledger'), publishPorts, dryRun: true, now, wait, latency: { fetchMs: 3000, scoreMs: 5000 }, windowMs: 40 * 60 * 1000,
    fetchReview: scoring.fetchReview, scoreReview: scoring.scoreReview, ...extra,
  });
  return { fixture, dir, scoring, run, calls, byKey, ledgerDir: path.join(dir, 'ledger'), now, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) };
}

const roundupKeys = (fixture) => fixture.reviews.filter((r) => r.via === 'bww-roundup').slice(0, 19).map((r) => discovery.canonicalUrl(r.url));

test('with injected fetch and scorer, every fixture review reaches scored, each within 5 minutes of being seen', async () => {
  const s = sandbox();
  try {
    const res = await s.run();
    assert.deepEqual(res.failed, []);
    const events = ledger.readLedger(s.ledgerDir, s.fixture.show.id, s.fixture.night).events;
    for (const key of roundupKeys(s.fixture)) {
      const e = ledger.reviewStates(events).find((r) => r.reviewKey === key);
      assert.ok(e && 'scored' in e.firstAt, `${key} reached scored`);
      assert.ok(Date.parse(e.firstAt.scored) - Date.parse(e.firstAt.discovered) < 5 * 60 * 1000, 'URL seen to scored under 5 minutes');
    }
    assert.equal(lf.readFailures(s.ledgerDir, s.fixture.show.id, s.fixture.night).failures.length, 0, 'a clean run writes no failure records');
  } finally { s.cleanup(); }
});

test('a failing fetch leaves a visible record with its reason and next retry time, waits out the backoff, then succeeds', async () => {
  const s = sandbox({ failFetch: {} });
  try {
    const key = roundupKeys(s.fixture)[2];
    const s2 = sandbox({ failFetch: { [key]: 2 } });
    try {
      const res = await s2.run();
      assert.deepEqual(res.failed, []);
      const { failures } = lf.readFailures(s2.ledgerDir, s2.fixture.show.id, s2.fixture.night);
      const mine = failures.filter((f) => f.reviewKey === key);
      assert.equal(mine.length, 2);
      assert.deepEqual(mine.map((f) => f.attempt), [1, 2]);
      assert.ok(mine.every((f) => f.stage === 'fetch' && /503 from outlet/.test(f.reason) && f.terminal === false && f.nextRetryAt));
      assert.ok(Date.parse(mine[0].nextRetryAt) - Date.parse(mine[0].at) === 30 * 1000, 'first retry after the first backoff step');
      const events = ledger.readLedger(s2.ledgerDir, s2.fixture.show.id, s2.fixture.night).events;
      assert.ok('scored' in ledger.reviewStates(events).find((r) => r.reviewKey === key).firstAt, 'it still got scored');
      const fetches = s2.calls.fetch.filter((c) => c.k === key);
      assert.equal(fetches.length, 3, 'two failures then the success; the backoff stopped any extra attempts');
      assert.ok(fetches[1].at - fetches[0].at >= 30 * 1000 && fetches[2].at - fetches[1].at >= 2 * 60 * 1000, 'attempts respect the schedule');
      assert.equal(lf.unresolved(failures, new Set(ledger.reviewStates(events).filter((r) => 'scored' in r.firstAt).map((r) => r.reviewKey))).length, 0, 'nothing left unresolved');
    } finally { s2.cleanup(); }
  } finally { s.cleanup(); }
});

test('a fetch that never recovers ends in a TERMINAL record and a failed entry, never a silent skip', async () => {
  const probe = sandbox();
  const key = roundupKeys(probe.fixture)[4];
  probe.cleanup();
  const s = sandbox({ failFetch: { [key]: 99 } });
  try {
    const res = await s.run();
    assert.equal(res.failed.length, 1);
    assert.equal(res.failed[0].key, key);
    assert.match(res.failed[0].reason, /failed for good after 5 attempt/);
    const { failures } = lf.readFailures(s.ledgerDir, s.fixture.show.id, s.fixture.night);
    const mine = failures.filter((f) => f.reviewKey === key);
    assert.equal(mine.length, 5);
    assert.equal(mine[4].terminal, true);
    assert.equal(mine[4].nextRetryAt, null);
    const events = ledger.readLedger(s.ledgerDir, s.fixture.show.id, s.fixture.night).events;
    assert.ok(!('scored' in ledger.reviewStates(events).find((r) => r.reviewKey === key).firstAt), 'never reaches scored');
    assert.equal(lf.unresolved(failures, new Set()).filter((f) => f.reviewKey === key)[0].terminal, true);
    assert.equal(s.calls.fetch.filter((c) => c.k === key).length, 5, 'bounded: exactly the attempts the schedule allows');
    const others = ledger.reviewStates(events).filter((r) => r.reviewKey !== key && 'scored' in r.firstAt).length;
    assert.equal(others, 18, 'one bad review does not hold up the others');
  } finally { s.cleanup(); }
});

test('score failures retry on their own backoff; a scorer rejection is terminal at once and visible', async () => {
  const probe = sandbox();
  const [a, b] = roundupKeys(probe.fixture).slice(5, 7);
  probe.cleanup();
  const s = sandbox({ failScore: { [a]: 1 }, scorer: undefined });
  try {
    const res = await s.run();
    assert.deepEqual(res.failed, []);
    const f = lf.readFailures(s.ledgerDir, s.fixture.show.id, s.fixture.night).failures.filter((x) => x.reviewKey === a);
    assert.equal(f.length, 1);
    assert.equal(f[0].stage, 'score');
    assert.match(f[0].reason, /model timeout/);
  } finally { s.cleanup(); }
  const rej = sandbox({ scorer: async (t, ctx) => (discovery.canonicalUrl(ctx.url) === b ? { rejected: true, rejection: 'wrong_show' } : { score: 70 }) });
  try {
    const res = await rej.run();
    assert.equal(res.failed.length, 1);
    assert.match(res.failed[0].reason, /rejected the review: wrong_show/);
    const f = lf.readFailures(rej.ledgerDir, rej.fixture.show.id, rej.fixture.night).failures.filter((x) => x.reviewKey === b);
    assert.equal(f.length, 1);
    assert.equal(f[0].terminal, true);
  } finally { rej.cleanup(); }
});

test('a scorer that returns no number, or all models failed, is a failure, never a score of 0 or 50', async () => {
  const s = sandbox({ scorer: async () => ({ allModelsFailed: true, score: 50 }), retryMs: [1000] });
  try {
    const res = await s.run();
    assert.ok(res.failed.length > 0);
    const events = ledger.readLedger(s.ledgerDir, s.fixture.show.id, s.fixture.night).events;
    const withText = s.fixture.reviews.filter((r) => r.via === 'bww-roundup' && r.text).map((r) => discovery.canonicalUrl(r.url));
    for (const k of withText.slice(0, 18)) {
      const st = ledger.reviewStates(events).find((r) => r.reviewKey === k);
      assert.ok(!st || !('scored' in st.firstAt), 'no score was invented');
    }
    const doc = JSON.parse(fs.readFileSync(path.join(s.dir, 'reviews.json'), 'utf8'));
    assert.ok(doc.reviews.every((r) => r.assignedScore !== 50 || r.scoreSource), 'nothing published at a fake 50');
  } finally { s.cleanup(); }
});

test('a paywalled page: aggregator thumb gives the low-confidence fallback; with no aggregator score it is a failure', async () => {
  const fixture = buildSyntheticFixture();
  const nyt = fixture.reviews.find((r) => r.outletId === 'nytimes');
  const key = discovery.canonicalUrl(nyt.url);
  const blank = (html) => null; // the extractor finds nothing, as on a paywall
  const withThumb = sandbox();
  try {
    const res = await withThumb.run();
    // The NYT fixture has an empty text and a thumb: the page carries no article, the aggregator carries the score.
    assert.ok(!res.failed.some((f) => f.key === key), 'a paywalled review with an aggregator thumb is not a failure');
    const doc = JSON.parse(fs.readFileSync(path.join(withThumb.dir, 'reviews.json'), 'utf8'));
    const row = doc.reviews.find((r) => r.outletId === 'nytimes');
    assert.equal(row.scoreSource, 'lane-aggregator-thumb');
    assert.equal(row.needsRecollection, true);
  } finally { withThumb.cleanup(); }
  const noAgg = sandbox({ extractArticle: blank, aggregatorFor: () => ({}), retryMs: [1000] });
  try {
    const res = await noAgg.run();
    assert.ok(res.failed.length > 0, 'no text and no aggregator score: visible failures');
    assert.ok(lf.readFailures(noAgg.ledgerDir, noAgg.fixture.show.id, noAgg.fixture.night).failures.some((f) => /no extractable text/.test(f.reason)));
  } finally { noAgg.cleanup(); }
});

test('createInlineScoring refuses missing dependencies; ensembleScoreText adapts the real scorer shape', async () => {
  assert.throws(() => inl.createInlineScoring({ show: { id: 'x' } }), /is required/);
  const ok = await inl.ensembleScoreText({ scoreReview: async (text, ctx) => ({ score: 77, ctx }) })('text', { outlet: 'Variety', criticName: 'F. Rizzo' });
  assert.equal(ok.score, 77);
  const bad = await inl.ensembleScoreText({ scoreReview: async () => ({ score: 50, allModelsFailed: true }) })('text', {});
  assert.equal(bad.allModelsFailed, true);
  assert.equal(typeof inl.realFetchPorts, 'function');
});

test('lane-failures: strict about its input, tolerant of a torn last line, and unresolved() keeps terminal and unscored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4784f-'));
  try {
    const base = { show: 'show-a', night: '2026-10-18', reviewKey: 'k1', stage: 'fetch', reason: 'boom', attempt: 1 };
    assert.throws(() => lf.appendFailure(dir, { ...base, stage: 'nope' }), /unknown stage/);
    assert.throws(() => lf.appendFailure(dir, { ...base, reviewKey: '' }), /reviewKey/);
    assert.throws(() => lf.appendFailure(dir, { ...base, attempt: 0 }), /attempt/);
    assert.throws(() => lf.appendFailure(dir, { ...base, show: 'Bad Show' }), /bad show/);
    lf.appendFailure(dir, base);
    lf.appendFailure(dir, { ...base, reviewKey: 'k2', attempt: 3, terminal: true });
    fs.appendFileSync(lf.failuresPath(dir, 'show-a', '2026-10-18'), '{"half":');
    const r = lf.readFailures(dir, 'show-a', '2026-10-18');
    assert.equal(r.failures.length, 2);
    assert.equal(r.corrupt, 1);
    assert.deepEqual(lf.unresolved(r.failures, new Set(['k1'])).map((f) => f.reviewKey), ['k2']);
    assert.deepEqual(lf.readFailures(dir, 'show-b', '2026-10-18'), { failures: [], corrupt: 0 });
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});
