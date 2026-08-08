/**
 * tests/unit/time-to-publish-sla.test.mjs — the SLA validator for Notion card
 * Structural #11 (task #388): BWSC must be FIRST, not last, among competitors.
 *
 * Run: node --test tests/unit/time-to-publish-sla.test.mjs
 *
 * Covers the decision logic in scripts/lib/time-to-publish-sla.js — the target
 * (90% of opening-night reviews live within 15 minutes of outlet publication),
 * the upper-bound basis used when an outlet gives us no publication clock, and
 * the vacuity guard that stops an empty sample from reporting success.
 *
 * CLAUDE.md rule 15: every assertion runs the real exported functions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  parsePrecisePublishTime,
  indexPipelineEvents,
  computeReviewLatencies,
  evaluateTimeToPublishSla,
  selectRecentOpeningWindows,
  filterToOpeningWindows,
  DEFAULT_DISCOVERY_WINDOW_MIN,
} = require('../../scripts/lib/time-to-publish-sla.js');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MS_MIN = 60 * 1000;
const T0 = Date.parse('2026-04-15T22:00:00Z');
const at = mins => new Date(T0 + mins * MS_MIN).toISOString();

/** One review's worth of stage stamps, plus the show/global terminals. */
function reviewEntries(showId, reviewKey, { seen, collected, scored } = {}) {
  const out = [];
  if (seen !== undefined) out.push({ showId, reviewKey, stage: 'review-first-seen', at: at(seen) });
  if (collected !== undefined) out.push({ showId, reviewKey, stage: 'review-text-collected', at: at(collected) });
  if (scored !== undefined) out.push({ showId, reviewKey, stage: 'scored', at: at(scored) });
  return out;
}
const globalRebuild = mins => ({ showId: null, reviewKey: null, stage: 'rebuilt', at: at(mins) });
const showRebuild = (showId, mins) => ({ showId, reviewKey: null, stage: 'rebuilt', at: at(mins) });
const deploy = mins => ({ showId: null, reviewKey: null, stage: 'deployed-live', at: at(mins), metadata: { runId: '1' } });

// ---------------------------------------------------------------------------
// parsePrecisePublishTime — never invent precision we do not have
// ---------------------------------------------------------------------------

test('publish clock — a date-only publishDate is NOT a publication time', () => {
  // 32,667 of 42,131 review-text files are date-only. Reading those as midnight
  // would report a review that went live at 09:00 as nine hours late.
  assert.equal(parsePrecisePublishTime('2026-04-15'), null);
  assert.equal(parsePrecisePublishTime('April 15, 2026'), null);
  assert.equal(parsePrecisePublishTime(null), null);
  assert.equal(parsePrecisePublishTime('null'), null);
  assert.equal(parsePrecisePublishTime('undefined'), null);
  assert.equal(parsePrecisePublishTime(''), null);
  assert.equal(parsePrecisePublishTime(undefined), null);
});

test('publish clock — a timestamp with time-of-day parses, zoneless is read as UTC', () => {
  // Real corpus shape: data/review-texts/*/theater-life--*.json
  assert.equal(parsePrecisePublishTime('2026-04-28T10:37:15'), '2026-04-28T10:37:15.000Z');
  assert.equal(parsePrecisePublishTime('2026-04-28T10:37:15Z'), '2026-04-28T10:37:15.000Z');
  assert.equal(parsePrecisePublishTime('2026-04-28T12:37:15+02:00'), '2026-04-28T10:37:15.000Z');
  assert.equal(parsePrecisePublishTime('garbage 12:00 nonsense'), null);
});

// ---------------------------------------------------------------------------
// indexPipelineEvents — global vs per-show terminals
// ---------------------------------------------------------------------------

test('index — a reviewKey-less rebuilt with no showId is a GLOBAL rebuild', () => {
  // Since 2026-08-08 rebuild-all-reviews emits one global line per run instead
  // of ~1,210 per-show lines; both shapes must still be readable.
  const idx = indexPipelineEvents([
    globalRebuild(10),
    showRebuild('legacy-show', 5),
    deploy(20),
  ]);
  assert.deepEqual(idx.globalRebuilds, [at(10)]);
  assert.deepEqual(idx.showRebuilds.get('legacy-show'), [at(5)]);
  assert.deepEqual(idx.globalDeploys, [at(20)]);
});

test('index — repeated stage stamps keep the EARLIEST, not the latest', () => {
  const idx = indexPipelineEvents([
    { showId: 's', reviewKey: 'nytimes:x:u', stage: 'scored', at: at(30) },
    { showId: 's', reviewKey: 'nytimes:x:u', stage: 'scored', at: at(5) },
  ]);
  assert.equal(idx.perReview.get('s||nytimes:x:u').stages.scored, at(5));
});

// ---------------------------------------------------------------------------
// computeReviewLatencies — the chain
// ---------------------------------------------------------------------------

test('latency — full chain resolves live time through a global rebuild + deploy', () => {
  const entries = [
    ...reviewEntries('fear-of-13', 'nytimes:shaw:https://nyt/x', { seen: 0, collected: 2, scored: 4 }),
    globalRebuild(6),
    deploy(9),
  ];
  const [r] = computeReviewLatencies(entries);
  assert.equal(r.firstSeenAt, at(0));
  assert.equal(r.scoredAt, at(4));
  assert.equal(r.rebuiltAt, at(6));
  assert.equal(r.liveAt, at(9));
  assert.equal(r.pipelineMs, 9 * MS_MIN);
  assert.equal(r.stuckAtStage, null);
  assert.equal(r.outletId, 'nytimes');
});

test('latency — a rebuild BEFORE the review was scored does not count as its terminal', () => {
  // The rebuild at +1 ran before scoring finished at +4, so it cannot have
  // folded this review in. Only the +6 rebuild can.
  const entries = [
    ...reviewEntries('s', 'variety:v:u', { seen: 0, scored: 4 }),
    globalRebuild(1),
    globalRebuild(6),
    deploy(8),
  ];
  const [r] = computeReviewLatencies(entries);
  assert.equal(r.rebuiltAt, at(6));
  assert.equal(r.liveAt, at(8));
});

test('latency — a deploy BEFORE the rebuild does not make the review live', () => {
  const entries = [
    ...reviewEntries('s', 'variety:v:u', { seen: 0, scored: 2 }),
    deploy(3),
    globalRebuild(5),
  ];
  const [r] = computeReviewLatencies(entries);
  assert.equal(r.rebuiltAt, at(5));
  assert.equal(r.liveAt, null, 'no deploy after the rebuild — not live yet');
  assert.equal(r.pipelineMs, null);
  assert.equal(r.stuckAtStage, 'rebuilt');
});

test('latency — unscored review still resolves via first-seen (scoring stamps are incomplete)', () => {
  // Reviews scored at collect-time via the LLM path never emit 'scored'; the
  // opening-night SLA documents the same gap. First-seen must still anchor.
  const entries = [
    ...reviewEntries('s', 'guardian:g:u', { seen: 0, collected: 1 }),
    globalRebuild(3),
    deploy(5),
  ];
  const [r] = computeReviewLatencies(entries);
  assert.equal(r.scoredAt, null);
  assert.equal(r.liveAt, at(5));
  assert.equal(r.pipelineMs, 5 * MS_MIN);
});

test('latency — clock skew never banks a negative (impossible) duration', () => {
  const entries = [
    ...reviewEntries('s', 'nypost:o:u', { seen: 10 }),
    globalRebuild(11),
    { showId: 's', reviewKey: 'nypost:o:u', stage: 'deployed-live', at: at(2) }, // runner clock behind
  ];
  const [r] = computeReviewLatencies(entries);
  assert.equal(r.pipelineMs, null);
  assert.equal(r.publishedToLiveMs, null);
});

test('latency — a stray stage stamp with no first-seen is not a tracked review', () => {
  const records = computeReviewLatencies([
    { showId: 's', reviewKey: 'x:y:z', stage: 'scored', at: at(1) },
    globalRebuild(2),
    deploy(3),
  ]);
  assert.equal(records.length, 0);
});

// ---------------------------------------------------------------------------
// basis — measured vs upper-bounded
// ---------------------------------------------------------------------------

test('basis — a precise outlet timestamp yields a MEASURED published→live time', () => {
  const entries = [
    ...reviewEntries('s', 'theater-life:sl:https://tl/x', { seen: 6, scored: 8 }),
    globalRebuild(9),
    deploy(11),
  ];
  const [r] = computeReviewLatencies(entries, {
    publishTimes: { 'theater-life:sl:https://tl/x': at(3) },
  });
  assert.equal(r.basis, 'published');
  assert.equal(r.publishedToLiveMs, 8 * MS_MIN, 'published +3 → live +11');
});

test('basis — without a publication clock the number is an UPPER BOUND, never optimistic', () => {
  const entries = [
    ...reviewEntries('s', 'nytimes:shaw:u', { seen: 0, scored: 2 }),
    globalRebuild(3),
    deploy(4),
  ];
  const [r] = computeReviewLatencies(entries);
  assert.equal(r.basis, 'poller-bounded');
  assert.equal(r.publishedAt, null);
  // 4 min of pipeline + a full poller interval of worst-case discovery blindness.
  assert.equal(r.publishedToLiveMs, (4 + DEFAULT_DISCOVERY_WINDOW_MIN) * MS_MIN);
  assert.ok(r.publishedToLiveMs >= r.pipelineMs, 'the bound can never beat the pipeline time');
});

test('basis — a faster poller shrinks the bound (the lever the card names)', () => {
  const entries = [
    ...reviewEntries('s', 'nytimes:shaw:u', { seen: 0, scored: 2 }),
    globalRebuild(3),
    deploy(4),
  ];
  const [slow] = computeReviewLatencies(entries, { discoveryWindowMinutes: 15 });
  const [fast] = computeReviewLatencies(entries, { discoveryWindowMinutes: 3 });
  assert.equal(slow.publishedToLiveMs, 19 * MS_MIN);
  assert.equal(fast.publishedToLiveMs, 7 * MS_MIN);
});

// ---------------------------------------------------------------------------
// evaluateTimeToPublishSla — the target, and the vacuity guard
// ---------------------------------------------------------------------------

const rec = (id, mins, basis = 'poller-bounded') => ({
  showId: 'fear-of-13', reviewKey: `o${id}:c:u${id}`, outletId: `o${id}`,
  firstSeenAt: at(0), liveAt: at(mins), pipelineMs: mins * MS_MIN,
  publishedToLiveMs: mins * MS_MIN, basis,
});

test('SLA — 9 of 10 within 15 minutes passes the 90% target', () => {
  const records = [...Array(9)].map((_, i) => rec(i, 10)).concat(rec(9, 40));
  const v = evaluateTimeToPublishSla(records);
  assert.equal(v.verdict, 'pass');
  assert.equal(v.pass, true);
  assert.equal(v.evaluated, 10);
  assert.equal(v.compliant, 9);
  assert.equal(v.compliancePct, 90);
  assert.equal(v.breaches.length, 1);
  assert.equal(v.breaches[0].outletId, 'o9');
});

test('SLA — 8 of 10 fails: 80% is under the 90% target', () => {
  const records = [...Array(8)].map((_, i) => rec(i, 10)).concat([rec(8, 40), rec(9, 22)]);
  const v = evaluateTimeToPublishSla(records);
  assert.equal(v.verdict, 'fail');
  assert.equal(v.pass, false);
  assert.equal(v.compliancePct, 80);
  assert.equal(v.breaches[0].publishedToLiveMs, 40 * MS_MIN, 'worst breach first');
});

test('SLA — exactly 15 minutes is inside the target, 15m+1ms is not', () => {
  const onTime = { ...rec(1, 15), publishedToLiveMs: 15 * MS_MIN };
  const late = { ...rec(2, 15), publishedToLiveMs: 15 * MS_MIN + 1 };
  assert.equal(evaluateTimeToPublishSla([onTime], { minSample: 1 }).compliant, 1);
  assert.equal(evaluateTimeToPublishSla([late], { minSample: 1 }).compliant, 0);
});

test('SLA — an empty sample reports insufficient-data, NOT a pass (vacuity guard)', () => {
  // The failure class behind cards #1075/#1094: a gate that observes nothing
  // and calls it success. A validator with no reviews must never say pass.
  const v = evaluateTimeToPublishSla([]);
  assert.equal(v.verdict, 'insufficient-data');
  assert.equal(v.pass, false);
  assert.equal(v.evaluated, 0);
  assert.equal(v.compliancePct, null);
});

test('SLA — a perfect but too-small sample is still insufficient-data', () => {
  const v = evaluateTimeToPublishSla([rec(1, 1), rec(2, 1), rec(3, 1)]);
  assert.equal(v.evaluated, 3);
  assert.equal(v.compliancePct, 100);
  assert.equal(v.verdict, 'insufficient-data');
  assert.equal(v.pass, false, '100% of three reviews does not prove a 90% SLA');
});

test('SLA — in-flight reviews are counted, not scored as breaches', () => {
  // A stuck review is opening-night-sla.js\'s page at 60 min. Failing it here
  // too would double-alert the same incident.
  const stuck = { showId: 's', reviewKey: 'x:y:z', outletId: 'x', firstSeenAt: at(0), liveAt: null, pipelineMs: null, publishedToLiveMs: null, basis: null };
  const v = evaluateTimeToPublishSla([...[...Array(5)].map((_, i) => rec(i, 5)), stuck]);
  assert.equal(v.evaluated, 5);
  assert.equal(v.inFlight, 1);
  assert.equal(v.breaches.length, 0);
  assert.equal(v.verdict, 'pass');
});

test('SLA — compliance is reported per basis so measured and bounded stay distinguishable', () => {
  const records = [
    ...[...Array(4)].map((_, i) => rec(i, 5, 'published')),
    ...[...Array(4)].map((_, i) => rec(i + 4, 5, 'poller-bounded')),
    rec(8, 90, 'poller-bounded'),
  ];
  const v = evaluateTimeToPublishSla(records);
  assert.deepEqual(v.byBasis.published, { evaluated: 4, compliant: 4 });
  assert.deepEqual(v.byBasis['poller-bounded'], { evaluated: 5, compliant: 4 });
});

test('SLA — p50/p90 come from the evaluated set', () => {
  const records = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100].map((m, i) => rec(i, m));
  const v = evaluateTimeToPublishSla(records);
  assert.equal(v.p50Ms, 5 * MS_MIN);
  assert.equal(v.p90Ms, 9 * MS_MIN);
});

// ---------------------------------------------------------------------------
// opening-window scoping
// ---------------------------------------------------------------------------

test('windows — picks the two most recent past openings, newest first', () => {
  const shows = [
    { id: 'old', openingDate: '2026-01-02' },
    { id: 'recent', openingDate: '2026-04-15' },
    { id: 'middle', openingDate: '2026-03-01' },
    { id: 'future', openingDate: '2026-12-01' },
    { id: 'undated' },
  ];
  const w = selectRecentOpeningWindows(shows, { now: new Date('2026-04-20T00:00:00Z'), count: 2 });
  assert.deepEqual(w.map(x => x.showId), ['recent', 'middle']);
  assert.equal(w[0].from, '2026-04-14T00:00:00.000Z', 'one day early — Talkin\' Broadway publishes ahead');
  assert.equal(w[0].to, '2026-04-19T00:00:00.000Z');
});

test('windows — filtering keeps opening-night traffic and drops backfills', () => {
  const windows = [{ showId: 'fear-of-13', openingDate: '2026-04-15', from: at(-60), to: at(60) }];
  const inWindow = { showId: 'fear-of-13', firstSeenAt: at(10) };
  const backfill = { showId: 'fear-of-13', firstSeenAt: at(5000) };
  const otherShow = { showId: 'hamilton-2015', firstSeenAt: at(10) };
  const kept = filterToOpeningWindows([inWindow, backfill, otherShow], windows);
  assert.deepEqual(kept, [inWindow]);
});

// ---------------------------------------------------------------------------
// real-data contract — the shapes above must match what production writes
// ---------------------------------------------------------------------------

test('real log — production stage-latency rows parse into well-formed records', () => {
  const logFile = path.join(REPO_ROOT, 'data/audit/stage-latency.jsonl');
  if (!fs.existsSync(logFile)) {
    // Fresh clone / CI checkout without the audit log — nothing to contract-test.
    return;
  }
  const entries = fs.readFileSync(logFile, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  if (!entries.length) return;

  const records = computeReviewLatencies(entries);
  const verdict = evaluateTimeToPublishSla(records);

  assert.ok(['pass', 'fail', 'insufficient-data'].includes(verdict.verdict));
  assert.equal(typeof verdict.evaluated, 'number');
  for (const r of records) {
    assert.ok(r.showId, 'every record carries a showId');
    assert.ok(r.firstSeenAt, 'every record is anchored on first-seen');
    assert.ok(r.publishedToLiveMs === null || r.publishedToLiveMs >= 0, 'no negative durations');
    assert.ok(r.basis === null || r.basis === 'published' || r.basis === 'poller-bounded');
  }
});
