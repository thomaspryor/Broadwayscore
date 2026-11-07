#!/usr/bin/env node
/**
 * replay-slow-market-openings.js (BRO-6687)
 *
 * Offline replay of recent off-Broadway / West End / off-West End openings:
 * for every review we know of (review-text file, or a URL the gap audit's
 * census found), did it go discovery -> guard -> live with no human step?
 *
 * Zero network, zero LLM. Reads only files already on disk:
 *   data/shows.json, data/reviews.json            (live = in reviews.json)
 *   data/audit/show-review-gap.json               (census: listed / missing)
 *   data/audit/press-night/<show>-<date>.json     (measured firstLiveAt, OB only)
 *   <review texts>/<show>/*.json                  (REVIEW_TEXTS_DIR, default data/review-texts)
 * Guard decisions are the rebuild's own: review-guards.explainExclusion().
 *
 * Writes data/audit/slow-market-replay.json (never lane-rehearsal-recorded.json).
 *
 * Usage:
 *   node scripts/replay-slow-market-openings.js                 # default 4 openings
 *   node scripts/replay-slow-market-openings.js --show=a,b
 *   node scripts/replay-slow-market-openings.js --check         # writes nothing; exit 0 ok,
 *                                                               # 1 unclassified/inconsistent, 78 inputs absent
 *
 * What it cannot know (stated in the output's `limits`):
 *  - publishDate is a date, so hours-to-live are +-24h.
 *  - Live time is measured only where a press-night record exists (the
 *    off-Broadway lane). Elsewhere it is ESTIMATED as the time the file was
 *    first scoreable (scoredAt / scoreRecoveredAt / firstSeenAt); the review
 *    goes live at the next rebuild after that.
 *  - A submit-review-form file written before BRO-6588 has no ingestSource,
 *    so whether a person or a pipeline asked for it is unknown. Those are
 *    counted as `caller-unknown`, never as automatic.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = path.join(__dirname, '..');
const DEFAULT_SHOWS = [
  'the-heart-off-broadway-2026',
  'in-the-heights-off-broadway-2026',
  'martin-guerre-west-end-2026',
  'some-woman-west-end-2026',
];
const OUT_FILE = path.join(ROOT, 'data', 'audit', 'slow-market-replay.json');
const WINDOWS_H = [24, 48, 72];

// Hand/auto vocabulary is shared with the opening grade (BRO-7082).
const { handSteps, discoveryMode } = require('./lib/review-provenance');

const ms = (s) => { const t = Date.parse(s || ''); return Number.isFinite(t) ? t : null; };
const hoursBetween = (a, b) => (a == null || b == null ? null : Math.round(((b - a) / 36e5) * 10) / 10);

/**
 * Outcome for one review-text file.
 *   auto-live | live-by-hand | live-caller-unknown
 *   excluded (guard said no; reason given)
 *   found-not-live (no guard reason; unscored or awaiting a rebuild)
 */
function classifyFile({ file, live, guardReason, scoreable }) {
  const disc = discoveryMode(file);
  const hand = handSteps(file);
  if (live) {
    if (disc.mode === 'hand' || hand.gating.length) return { outcome: 'live-by-hand', disc, hand };
    if (disc.mode === 'caller-unknown') return { outcome: 'live-caller-unknown', disc, hand };
    return { outcome: 'auto-live', disc, hand };
  }
  if (guardReason) return { outcome: 'excluded', reason: guardReason, disc, hand };
  return { outcome: 'found-not-live', reason: scoreable ? 'awaiting-rebuild' : 'unscored', disc, hand };
}

/** Earliest time the file was ready to go live, and how we know. */
function readyAt(file, measuredLiveAt) {
  if (measuredLiveAt) return { at: measuredLiveAt, precision: 'measured' };
  const cands = [file.llmMetadata?.scoredAt, file.scoreRecoveredAt].map(ms).filter((t) => t != null);
  const seen = ms(file.firstSeenAt) ?? ms(file.textFetchedAt);
  if (!cands.length && seen == null) return { at: null, precision: 'unknown' };
  const scored = cands.length ? Math.min(...cands) : seen;
  const at = Math.max(scored, seen ?? scored);
  return { at: new Date(at).toISOString(), precision: 'estimated-scored' };
}

/** Clock start for a review: its publish date, never before the opening date (UTC midnight). */
function anchorMs(publishDate, openingDate) {
  const p = ms(publishDate && String(publishDate).slice(0, 10));
  const o = ms(openingDate && String(openingDate).slice(0, 10));
  if (p == null) return o;
  if (o == null) return p;
  return Math.max(p, o);
}

/** Per-opening grade from classified rows. */
function gradeOpening(rows, windows = WINDOWS_H) {
  const g = { total: rows.length, outcomes: {}, liveWithin: {}, liveHoursKnown: 0, measured: 0, neededHand: 0, callerUnknown: 0, notIngested: 0, foundNotLive: 0 };
  for (const w of windows) g.liveWithin[`${w}h`] = 0;
  for (const r of rows) {
    g.outcomes[r.outcome] = (g.outcomes[r.outcome] || 0) + 1;
    if (r.outcome === 'live-by-hand') g.neededHand++;
    if (r.outcome === 'live-caller-unknown') g.callerUnknown++;
    if (r.outcome === 'not-ingested') g.notIngested++;
    if (r.outcome === 'found-not-live') g.foundNotLive++;
    if (r.outcome.startsWith('live') || r.outcome === 'auto-live') {
      if (r.hoursToLive != null) {
        g.liveHoursKnown++;
        if (r.livePrecision === 'measured') g.measured++;
        for (const w of windows) if (r.hoursToLive <= w) g.liveWithin[`${w}h`]++;
      }
    }
  }
  const live = (g.outcomes['auto-live'] || 0) + g.neededHand + g.callerUnknown;
  g.live = live;
  g.autoLiveShare = live ? Math.round(((g.outcomes['auto-live'] || 0) / live) * 100) / 100 : null;
  return g;
}

/**
 * Which files are the source of a live reviews.json row. Each row is claimed
 * once: first by URL identity (non-duplicate files first), then by
 * outletId+critic for rows no URL claimed. A second file for the same review
 * is not live; the guard says why (usually a duplicate).
 */
function matchLive(loaded, liveRows, identity) {
  const out = new Set();
  const byId = new Map();
  const unclaimed = new Set(liveRows.map((_, i) => i));
  liveRows.forEach((r, i) => { if (r.url) { const k = identity(r.url); if (!byId.has(k)) byId.set(k, []); byId.get(k).push(i); } });
  const order = [...loaded].sort((a, b) => Number(!!a.file.duplicateOf) - Number(!!b.file.duplicateOf));
  for (const { name, file } of order) {
    const slots = file.url ? (byId.get(identity(file.url)) || []) : [];
    const i = slots.find((j) => unclaimed.has(j));
    if (i != null) { unclaimed.delete(i); out.add(name); }
  }
  const oc = (o, c) => `${o}|${String(c || '').toLowerCase()}`;
  for (const { name, file } of order) {
    if (out.has(name) || file.duplicateOf) continue;
    const i = [...unclaimed].find((j) => oc(liveRows[j].outletId, liveRows[j].criticName) === oc(file.outletId, file.criticName));
    if (i != null) { unclaimed.delete(i); out.add(name); }
  }
  return out;
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function pressNightFor(showId, dir) {
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).filter((n) => n.startsWith(`${showId}-`) && n.endsWith('.json')).sort().pop();
  return f ? { file: f, data: readJson(path.join(dir, f)) } : null;
}

function replayShow(show, ctx) {
  const { gapUrlIdentity } = ctx;
  const { explainExclusion, hasValidScore } = ctx.guards;
  const dir = path.join(ctx.textsDir, show.id);
  const liveRows = ctx.reviews.filter((r) => r.showId === show.id);
  const pn = pressNightFor(show.id, ctx.pressNightDir);
  const pnLive = new Map();
  for (const pr of (pn?.data?.perReview || [])) if (pr.firstLiveAt) pnLive.set(String(pr.key || '').toLowerCase(), pr.firstLiveAt);

  const rows = [];
  const seenIds = new Set();
  const loaded = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('_')).sort()) {
    try { loaded.push({ name, file: readJson(path.join(dir, name)) }); } catch { rows.push({ file: name, outcome: 'unreadable' }); }
  }
  const liveFiles = matchLive(loaded, liveRows, gapUrlIdentity);
  for (const { name, file } of loaded) {
    const fp = path.join(dir, name);
    const id = file.url ? gapUrlIdentity(file.url) : null;
    if (id) seenIds.add(id);
    const live = liveFiles.has(name);
    let guardReason = null;
    try { guardReason = explainExclusion(file, show, fp); } catch (e) { guardReason = `guard-threw:${e.message.slice(0, 60)}`; }
    const c = classifyFile({ file, live, guardReason, scoreable: hasValidScore(file) });
    const pnKey = `${String(file.outlet || '').toLowerCase()}|${String(file.criticName || '').toLowerCase()}`;
    const ready = live ? readyAt(file, pnLive.get(pnKey)) : { at: null, precision: null };
    const anchor = anchorMs(file.publishDate, show.openingDate);
    const hoursToDiscovery = hoursBetween(anchor, ms(file.firstSeenAt));
    rows.push({
      file: name, url: file.url || null, outletId: file.outletId || null,
      outcome: c.outcome, reason: c.reason || null,
      discovery: c.disc.mode, sources: c.disc.sources,
      handSteps: c.hand.gating, cosmeticHandSteps: c.hand.cosmetic,
      publishDate: file.publishDate || null, firstSeenAt: file.firstSeenAt || null,
      hoursToDiscovery,
      liveAt: ready.at, livePrecision: ready.precision,
      hoursToLive: live ? hoursBetween(anchor, ms(ready.at)) : null,
    });
  }
  // Census URLs the audit found that have no file: never ingested.
  const gapRow = ctx.gapRows.find((r) => r.showId === show.id) || null;
  for (const m of (gapRow?.missing || [])) {
    const id = gapUrlIdentity(m.url);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    rows.push({
      file: null, url: m.url, outletId: m.knownOutletId || null, outcome: 'not-ingested',
      reason: (m.sources || []).map((s) => s.source).join('+') || (m.serpCensus ? 'serp-census' : 'census'),
      discovery: 'auto', sources: (m.sources || []).map((s) => s.source), handSteps: [], cosmeticHandSteps: [],
      publishDate: null, firstSeenAt: null, hoursToDiscovery: null, liveAt: null, livePrecision: null, hoursToLive: null,
    });
  }
  return {
    showId: show.id, category: show.category, status: show.status, openingDate: show.openingDate || null,
    pressNightRecord: pn ? pn.file : null, gapAuditAt: gapRow?.computedAt || null,
    liveInReviewsJson: liveRows.length,
    grade: gradeOpening(rows),
    reviews: rows,
  };
}

/** Consistency checks for --check: every row classified, every live claim real. */
function checkReplay(result) {
  const problems = [];
  const KNOWN = new Set(['auto-live', 'live-by-hand', 'live-caller-unknown', 'excluded', 'found-not-live', 'not-ingested']);
  for (const s of result.openings) {
    for (const r of s.reviews) {
      if (!KNOWN.has(r.outcome)) problems.push(`${s.showId}: ${r.file || r.url} outcome ${r.outcome}`);
      if ((r.outcome === 'excluded' || r.outcome === 'found-not-live') && !r.reason) problems.push(`${s.showId}: ${r.file} not live with no reason`);
    }
    const g = s.grade;
    if (g.live > s.liveInReviewsJson) problems.push(`${s.showId}: ${g.live} live rows > ${s.liveInReviewsJson} in reviews.json`);
  }
  return problems;
}

function arg(name) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('Usage: REVIEW_TEXTS_DIR=<review-texts> node scripts/replay-slow-market-openings.js [--check] [--show=id,id]\n'
      + 'Offline replay of slow-market openings (BRO-6687). Writes data/audit/slow-market-replay.json; --check exits 1 on an unclassified row, 78 when review texts are absent.');
    return;
  }
  const check = process.argv.includes('--check');
  const textsDir = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts');
  const ids = (arg('show') || DEFAULT_SHOWS.join(',')).split(',').filter(Boolean);
  const showsRaw = readJson(path.join(ROOT, 'data', 'shows.json'));
  const shows = showsRaw.shows || showsRaw;
  const absent = [];
  for (const id of ids) {
    if (!shows.find((s) => s.id === id)) absent.push(`shows.json lacks ${id}`);
    if (!fs.existsSync(path.join(textsDir, id))) absent.push(`review texts lack ${path.join(textsDir, id)}`);
  }
  if (absent.length) {
    console.error(`replay-slow-market-openings: inputs absent (set REVIEW_TEXTS_DIR to a fresh clone):\n  ${absent.join('\n  ')}`);
    process.exit(78);
  }
  const rj = readJson(path.join(ROOT, 'data', 'reviews.json'));
  const gap = readJson(path.join(ROOT, 'data', 'audit', 'show-review-gap.json'));
  const { gapUrlIdentity } = require('./audit-show-review-gap.js');
  const ctx = {
    textsDir, gapUrlIdentity,
    guards: require('./lib/review-guards.js'),
    reviews: rj.reviews || rj,
    gapRows: Array.isArray(gap.results) ? gap.results : [],
    pressNightDir: path.join(ROOT, 'data', 'audit', 'press-night'),
  };
  const openings = ids.map((id) => replayShow(shows.find((s) => s.id === id), ctx));
  const result = {
    generatedAt: new Date().toISOString(),
    inputs: { reviewTextsDir: textsDir, reviewsJsonMeta: rj._meta?.generatedAt || rj._meta?.lastUpdated || null, gapAuditGeneratedAt: gap.generatedAt || null },
    limits: [
      'publishDate is date-only: hours are +-24h, clock starts at the later of publishDate and openingDate (UTC midnight)',
      'live time is measured only from a press-night record (off-Broadway lane); otherwise estimated as first-scoreable time, live at the next rebuild',
      'submit-review-form files without ingestSource (pre-BRO-6588) are caller-unknown, not counted as automatic',
      'the aggregator archive is not read: a review no aggregator or audit census ever surfaced is invisible here',
    ],
    openings,
  };
  const problems = checkReplay(result);
  for (const s of openings) {
    const g = s.grade;
    console.log(`${s.showId} [${s.category}] files+census=${g.total} live=${g.live} (reviews.json ${s.liveInReviewsJson}) auto=${g.outcomes['auto-live'] || 0} hand=${g.neededHand} caller-unknown=${g.callerUnknown} excluded=${g.outcomes.excluded || 0} found-not-live=${g.foundNotLive} not-ingested=${g.notIngested} | live<=24h ${g.liveWithin['24h']} <=48h ${g.liveWithin['48h']} <=72h ${g.liveWithin['72h']} of ${g.liveHoursKnown} timed (${g.measured} measured) | press-night=${s.pressNightRecord ? 'yes' : 'no'}`);
  }
  if (problems.length) { console.error(`PROBLEMS:\n  ${problems.join('\n  ')}`); }
  if (check) process.exit(problems.length ? 1 : 0);
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, OUT_FILE)}`);
  process.exit(problems.length ? 1 : 0);
}

module.exports = { handSteps, discoveryMode, classifyFile, readyAt, anchorMs, gradeOpening, checkReplay, matchLive, DEFAULT_SHOWS };

if (require.main === module) main();
