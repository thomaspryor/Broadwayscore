// BRO-5201: the lane's shadow mode. The real runLaneNight and inline scoring run with fake network ports through the
// shadow publish ports; nothing here touches a lease store, a scraper, a scorer or a repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shadow = require('../../scripts/lib/opening-night-lane-shadow.js');
const { runLaneNight } = require('../../scripts/lib/opening-night-lane/lane-runner.js');
const inline = require('../../scripts/lib/opening-night-lane/inline-score.js');
const rehearsal = require('../../scripts/lib/opening-night-lane/rehearsal.js');

const NIGHT = '2026-10-22';
const SHOW = { id: 'test-show-2026', title: 'Test Show', openingDate: NIGHT };
const TEXT = 'The performances and staging make this production a delight. '.repeat(20);
const T0 = Date.parse(`${NIGHT}T23:00:00Z`);

function night(dir, { urls, liveRv = [], scores = [] }) {
  let clock = T0;
  const now = () => clock;
  const rows = [];
  const scoring = inline.createInlineScoring({
    show: SHOW, night: NIGHT, ledgerDir: path.join(dir, 'ledger'), now,
    fetchPage: async () => ({ content: TEXT }), extractArticle: (html) => html,
    extractMeta: () => ({ criticName: 'Test Critic', publishDate: NIGHT }),
    scoreText: async () => ({ score: scores.shift() ?? 80, extra: {} }),
  });
  const live = shadow.createLiveRecorder({ fetchLiveShow: async () => ({ rv: liveRv }), showId: SHOW.id, now, logFile: path.join(dir, 'live-first-seen.jsonl') });
  const run = runLaneNight({
    show: SHOW, night: NIGHT, openingDate: NIGHT, ledgerDir: path.join(dir, 'ledger'), dryRun: true, maxPasses: 1,
    adapters: [{ name: 'roundup', kind: 'aggregator', phase: 'main', discover: async () => urls.map((u) => ({ url: u.url, outletId: u.outletId, source: 'aggregator', aggregatorCited: true })) }],
    fetchText: async () => '', fetchReview: scoring.fetchReview, scoreReview: scoring.scoreReview,
    publishPorts: shadow.createShadowPublishPorts({ onRows: (applied, at) => { for (const row of applied) rows.push({ row, at }); }, now }),
    now, wait: async (ms) => { clock += ms; },
  });
  return { run, rows, live, advance: (ms) => { clock += ms; }, now };
}

test('shadow ports run the real merge but report nothing applied, so no live wait and no publish events', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5201-shadow-'));
  try {
    const url = 'https://www.theguardian.com/stage/2026/oct/22/test-show-review';
    const n = night(dir, { urls: [{ url, outletId: 'guardian' }] });
    const res = await n.run;
    assert.deepEqual(res.errors, []);
    assert.equal(n.rows.length, 1, 'the scored row reaches onRows');
    assert.equal(n.rows[0].row.assignedScore, 80);
    assert.deepEqual(res.unpublished, [], 'nothing is re-queued');
    const stages = fs.readdirSync(path.join(dir, 'ledger')).flatMap((f) => fs.readFileSync(path.join(dir, 'ledger', f), 'utf8').split('\n'))
      .filter(Boolean).map((l) => { try { return JSON.parse(l).stage; } catch { return null; } });
    assert.ok(stages.includes('scored'));
    for (const s of ['rebuilt', 'deployed', 'verified-live']) assert.ok(!stages.includes(s), `no ${s} event for a publish that did not happen`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the shadow ports still refuse a row the real publish would refuse', async () => {
  const ports = shadow.createShadowPublishPorts({ onRows: () => {} });
  const { mergeShowRows } = require('../../scripts/lib/opening-night-lane/publish.js');
  await assert.rejects(ports.updateReviews((doc) => mergeShowRows(doc, SHOW.id, [{ showId: SHOW.id, url: 'https://x.com/a', assignedScore: 70 }])), /not a lane review/);
});

test('the report joins lane timings to first live appearance: lead, lane-only, site-only and score gap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5201-report-'));
  try {
    const a = 'https://www.theguardian.com/stage/2026/oct/22/test-show-review';
    const b = 'https://variety.com/2026/legit/reviews/test-show-1236/';
    const c = 'https://www.nytimes.com/2026/10/22/theater/test-show-review.html';
    const n = night(dir, { urls: [{ url: a, outletId: 'guardian' }, { url: b, outletId: 'variety' }], scores: [80, 60],
      liveRv: [{ u: `${a}?utm_source=x`, s: 84, o: 'The Guardian' }, { u: c, s: 90, o: 'The New York Times' }] });
    const res = await n.run;
    n.advance(30 * 60 * 1000); // the site shows them 30+ minutes after the lane scored them
    await n.live.poll();
    const rep = shadow.buildShadowReport({ show: SHOW, night: NIGHT, ledgerDir: path.join(dir, 'ledger'), rows: n.rows, live: n.live.snapshot(), startedAt: T0, endedAt: n.now(), result: res });
    const by = Object.fromEntries(rep.reviews.map((r) => [r.side === 'site-only' ? 'c' : r.laneScore === 80 ? 'a' : 'b', r]));
    assert.equal(by.a.side, 'both');
    assert.ok(by.a.scoredLeadMin >= 30, `lane earlier by ${by.a.scoredLeadMin} min`);
    assert.equal(by.a.siteScore, 84);
    assert.equal(by.b.side, 'lane-only');
    assert.equal(by.c.side, 'site-only');
    assert.deepEqual(rep.totals, { laneScored: 2, siteLive: 2, both: 1, laneOnly: 1, siteOnly: 1 });
    assert.equal(rep.meanAbsScoreDiff, 4);
    assert.equal(fs.readFileSync(path.join(dir, 'live-first-seen.jsonl'), 'utf8').trim().split('\n').length, 2, 'each first sighting is on disk as it happens');
    const md = shadow.writeShadowReport(dir, rep);
    assert.match(md, /Lane scored 2 reviews; the site showed 2/);
    assert.ok(fs.existsSync(path.join(dir, 'shadow-report.json')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scores are recorded at scoring time, so a merge that refuses its batch cannot hide them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5201-scores-'));
  try {
    const log = path.join(dir, 'lane-scores.jsonl');
    const rec = shadow.createScoreRecorder({ logFile: log, now: () => 5 });
    const wrapped = rec.wrapScore(async () => ({ score: 77, extra: {} }));
    const row = { url: 'https://variety.com/2026/legit/reviews/x/', outletId: 'variety', outlet: 'Variety', criticName: 'Frank Rizzo' };
    assert.deepEqual(await wrapped(row, {}), { score: 77, extra: {} }, 'the scorer result passes through untouched');
    rec.onRow({ ...row, assignedScore: 99 });
    assert.equal(rec.snapshot().length, 1, 'first score wins; onRow does not double count');
    assert.equal(rec.snapshot()[0].score, 77);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'appended as it happens');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a lane review and a site review with different URLs pair up when they are the only two of their outlet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5201-join-'));
  try {
    const t0 = Date.parse(`${NIGHT}T23:00:00Z`);
    const scores = [
      { key: 'https://variety.com/2026/legit/reviews/test-show-review-1236', score: 70, outletId: 'variety', outlet: 'Variety', at: t0 + 60000 },
      { key: 'https://www.theguardian.com/stage/2026/oct/22/a', score: 60, outletId: 'guardian', outlet: 'The Guardian', at: t0 + 60000 },
      { key: 'https://www.theguardian.com/stage/2026/oct/22/b', score: 65, outletId: 'guardian', outlet: 'The Guardian', at: t0 + 60000 },
    ];
    const firstLive = new Map([
      ['https://variety.com/2026/legit/reviews/test-show-1236', { at: t0 + 21 * 60000, score: 72, outlet: 'Variety', url: 'https://variety.com/2026/legit/reviews/test-show-1236/' }],
      ['https://www.theguardian.com/stage/2026/oct/22/c', { at: t0 + 21 * 60000, score: 61, outlet: 'The Guardian', url: 'https://www.theguardian.com/stage/2026/oct/22/c' }],
    ]);
    const rep = shadow.buildShadowReport({ show: SHOW, night: NIGHT, ledgerDir: dir, scores, live: { polls: 1, failures: 0, firstLive }, startedAt: t0, endedAt: t0 + 3600000, result: null });
    const variety = rep.reviews.find((r) => r.outlet === 'Variety');
    assert.equal(variety.side, 'both');
    assert.equal(variety.joinedBy, 'outlet');
    assert.equal(variety.scoredLeadMin, 20);
    assert.equal(rep.reviews.filter((r) => r.joinedBy === 'outlet').length, 1, 'two Guardian lane reviews are ambiguous: no outlet pairing');
    assert.equal(rep.medianScoredLeadMin, 20);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reviews already live at the start are flagged and left out of the median lead', () => {
  const t0 = Date.parse(`${NIGHT}T23:00:00Z`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5201-start-'));
  try {
    const k = 'https://variety.com/2026/legit/reviews/x';
    const rep = shadow.buildShadowReport({ show: SHOW, night: NIGHT, ledgerDir: dir, scores: [{ key: k, score: 70, at: t0 + 5 * 60000 }],
      live: { polls: 1, failures: 0, firstLive: new Map([[k, { at: t0, score: 70, url: k }]]) }, startedAt: t0, endedAt: t0 + 1, result: null });
    assert.equal(rep.reviews[0].liveAtStart, true);
    assert.equal(rep.medianScoredLeadMin, null);
    assert.match(shadow.reportMarkdown(rep), /already live when the shadow started/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed live poll is counted, not thrown', async () => {
  const live = shadow.createLiveRecorder({ fetchLiveShow: async () => { throw new Error('503'); }, showId: SHOW.id });
  assert.equal(await live.poll(), null);
  assert.equal(live.snapshot().failures, 1);
});

test('shadow code is outside the lane arm hash, so it cannot disarm the production lane', () => {
  const files = rehearsal.laneCodeFiles().map((f) => path.basename(f));
  assert.ok(!files.includes('opening-night-lane-shadow.js'));
});

test('BRO-6066: each lane score records the length and tier of the text it was scored from', async () => {
  const rec = shadow.createScoreRecorder({ now: () => T0 });
  const full = rec.wrapScore(async () => 70);
  await full({ url: 'https://www.nytimes.com/2026/10/22/theater/a-review.html', fullText: TEXT, outletId: 'nytimes' }, { contentTier: 'truncated' });
  const excerpt = rec.wrapScore(async () => ({ score: 45, extra: { fullText: '', contentTier: 'excerpt' } }));
  await excerpt({ url: 'https://www.wsj.com/articles/a-review-ab12', fullText: 'teaser '.repeat(200), outletId: 'wsj' }, {});
  const [a, b] = rec.snapshot();
  assert.deepEqual([a.textChars, a.contentTier], [TEXT.length, 'truncated']);
  assert.deepEqual([b.textChars, b.contentTier], [0, 'excerpt'], 'an excerpt score kept no page text');
});
