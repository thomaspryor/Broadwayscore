#!/usr/bin/env node
/**
 * audit-run-contamination.js — read-only, corpus-wide report of the "a review of
 * another run / production / date counted toward this show" classes (BRO-4998,
 * BRO-5000). One class per section, each with a count and the worst offenders.
 *
 *   1 inherited      rows carried onto a returning show from its earlier entry
 *                    (prior-run-sibling.js), and whether a per-run decision
 *                    (priorRuns[].inheritReviews) is recorded
 *   2 pre-window     included rows dated before the show's earliest date by more
 *                    than 1 day, split by what explains them
 *   3 republished    page text says "This review is from 2025" / "Originally
 *                    published ..." with a year before the show existed
 *   4 flag-vs-clear  wrongProduction=true beside a wrongProductionManualClear /
 *                    wrongProductionOverride (the clear wins; a later human flag loses)
 *   5 duplicates     one URL counted on 2+ shows; url-less rows beside a url row
 *   6 show-dates     opening date later than the first reviews / open show with
 *                    no reviews at all
 *   7 stars          star ratings with no star evidence anywhere in the text
 *
 * Usage:
 *   node scripts/audit-run-contamination.js            # human report + baseline line
 *   node scripts/audit-run-contamination.js --json     # machine-readable
 *   node scripts/audit-run-contamination.js --class=2,3
 *   node scripts/audit-run-contamination.js --out=path.json
 *
 * Exit 0 unless --max-actionable=N is given (1 above the ceiling, 2 when no gated class
 * ran); exit 3 when the corpus cannot be read.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { earliestShowDate } = require('./lib/date-guard');
const { isScriptWrongProductionClear } = require('./lib/review-write-guard');
const { isWithinPriorRun, isWithinOptOutPriorRun, isWithinTourLeg } = require('./lib/wrong-production-autoclear');
const {
  republishMarker, evaluateRepublishedReview, wrongProductionFlagVsClear,
} = require('./lib/run-contamination');

const { RERUN_SEPARATE_MIN_OUTLETS } = require('./lib/prior-run-sibling');
const { foldDiacritics } = require('./lib/title-match.js');
const { exitOnHelp } = require('./lib/cli-help.js');
exitOnHelp(module);

const ROOT = path.join(__dirname, '..');
const ARGV = process.argv.slice(2);
const argVal = (n) => { const a = ARGV.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const JSON_OUT = ARGV.includes('--json');
const DETAIL = ARGV.includes('--detail'); // full class-5 url groups for triage (BRO-5239)
const ONLY = argVal('class') ? new Set(argVal('class').split(',').map(Number)) : null;
const TODAY = argVal('today') || new Date().toISOString().slice(0, 10);
const RECENT_SINCE = '2026-06-01';
const DAY = 86400000;
// Class 5 shared-article window: a review lands at most ~a month before the first preview of the run
// it covers (press previews, out-of-town notices) and a late notice up to ~6 months after it closes.
const SHARED_PRE_RUN_DAYS = 45;
const SHARED_POST_RUN_DAYS = 180;

const want = (n) => !ONLY || ONLY.has(n);
const norm = (s) => foldDiacritics(String(s || '')).toLowerCase().replace(/[^a-z0-9]/g, '');
const critKey = (c) => { const n = norm(c); return n === 'unknown' ? '' : n; };
const canon = (u) => {
  // Keep the query string except tracking params: londontheatrereviews.co.uk/post.cfm?id=N
  // and similar CMS URLs are distinct articles that differ only in the query.
  let x = String(u || '').trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/#.*$/, '');
  const [base, q] = x.split('?');
  const keep = (q || '').split('&').filter((kv) => kv && !/^(utm_[a-z]+|fbclid|gclid|mc_[a-z]+|ref|source)=/.test(kv)).sort().join('&');
  return base.replace(/\/+$/, '') + (keep ? `?${keep}` : '');
};
const daysBetween = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / DAY);

function loadCorpus() {
  const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8'));
  const shows = showsRaw.shows || showsRaw;
  const revRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reviews.json'), 'utf8'));
  const rows = Array.isArray(revRaw) ? revRaw : revRaw.reviews;
  const dir = path.join(ROOT, 'data/review-texts');
  if (!fs.existsSync(dir)) throw new Error('data/review-texts missing');
  return { shows, rows, dir };
}

// Light per-file record: the fields the classes need, no fullText kept.
function indexFiles(shows, dir, needText) {
  const byShow = new Map();
  for (const s of shows) {
    const d = path.join(dir, s.id);
    let names;
    try { names = fs.readdirSync(d).filter((f) => f.endsWith('.json')); } catch { continue; }
    const list = [];
    for (const f of names) {
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { continue; }
      const text = typeof r.fullText === 'string' ? r.fullText : '';
      const rec = {
        file: f, showId: s.id, outletId: r.outletId, criticName: r.criticName, url: r.url,
        publishDate: r.publishDate, dateSource: r.dateSource,
        wrongProduction: r.wrongProduction === true,
        wrongProductionManualClear: r.wrongProductionManualClear === true,
        wrongProductionOverride: r.wrongProductionOverride === true,
        overrideSetBy: r.wrongProductionOverrideSetBy || null,
        allowEarlyDate: r.allowEarlyDate === true, routedFromShowId: r.routedFromShowId || null,
        humanReviewedWrongProduction: r.humanReviewedWrongProduction,
        flagVsClear: wrongProductionFlagVsClear(r),
        originalScore: r.originalScore, originalScoreSource: r.originalScoreSource,
        humanReviewScore: r.humanReviewScore,
      };
      if (needText.republish) rec.republish = evaluateRepublishedReview({ fullText: text, show: s, publishDate: r.publishDate });
      if (needText.stars) rec.hasStarEvidence = /\b[0-5](?:\.5)?\s*(?:\/|out of|-)\s*5\b|\bstars?\b|★|☆|five-star|four-star|three-star/i.test(text);
      list.push(rec);
    }
    byShow.set(s.id, list);
  }
  return byShow;
}

function matchFile(row, files) {
  if (!files) return null;
  const cu = canon(row.url);
  const ck = critKey(row.criticName);
  return (cu && files.find((f) => canon(f.url) === cu))
    || files.find((f) => f.outletId === row.outletId && critKey(f.criticName) === ck)
    || null;
}

function top(map, n = 8) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} (${v})`);
}

function class1(ctx) {
  const { shows, rows } = ctx;
  const byId = new Map(shows.map((s) => [s.id, s]));
  const pairs = new Map();
  for (const r of rows) {
    if (!r.inheritedFromShowId) continue;
    const k = `${r.showId}<-${r.inheritedFromShowId}`;
    pairs.set(k, (pairs.get(k) || 0) + 1);
  }
  const list = [...pairs.entries()].map(([k, count]) => {
    const [newerId, olderId] = k.split('<-');
    const newer = byId.get(newerId) || {};
    const link = (newer.priorRuns || []).find((p) => p && typeof p === 'object' && (p.id === olderId || p.showId === olderId || p.productionId === olderId))
      || (newer.priorRuns || []).find((p) => p && typeof p === 'object' && !p.id && p.openingDate);
    const decision = link && typeof link.inheritReviews === 'boolean' ? (link.inheritReviews ? 'carry (recorded)' : 'no-carry (recorded)') : `auto (carry until ${RERUN_SEPARATE_MIN_OUTLETS} outlets re-review)`;
    return { newerId, olderId, count, decision };
  }).sort((a, b) => b.count - a.count);
  return {
    count: list.reduce((n, p) => n + p.count, 0),
    shows: list.length,
    undecided: list.filter((p) => p.decision.startsWith('auto')).length,
    pairs: list,
  };
}

function class2(ctx) {
  const { shows, rows, files } = ctx;
  const byId = new Map(shows.map((s) => [s.id, s]));
  const out = [];
  for (const r of rows) {
    if (r.inheritedFromShowId || !r.publishDate) continue;
    const s = byId.get(r.showId);
    if (!s) continue;
    const earliest = earliestShowDate(s);
    if (!earliest) continue;
    // A month-only date ("2026-09") has no day, so it reads as the 1st: it is pre-window
    // only when the whole month precedes the show's earliest date (BRO-5239).
    if (/^\d{4}-\d{2}$/.test(String(r.publishDate)) && String(r.publishDate) >= earliest.slice(0, 7)) continue;
    const days = daysBetween(earliest, r.publishDate);
    if (days <= 1) continue;
    const f = matchFile(r, files.get(r.showId));
    const runs = (s.priorRuns || []).filter((p) => p && typeof p === 'object');
    // A prior run marked inheritReviews:false is a run whose reviews are NOT this entry's
    // (BRO-5285), so its window explains nothing: those rows are contamination (BRO-5261).
    const optOutRun = !!isWithinOptOutPriorRun(r.publishDate, runs);
    const priorRun = !optOutRun && !!isWithinPriorRun(r.publishDate, runs);
    const tourLeg = !!isWithinTourLeg(r.publishDate, (s.tourLegs || []).filter((p) => p && typeof p === 'object'));
    let why = 'undeclared';
    if (optOutRun) why = 'opt-out-prior-run';
    else if (priorRun) why = 'declared-prior-run';
    else if (tourLeg) why = 'declared-tour-leg';
    else if (f && (f.allowEarlyDate || f.humanReviewedWrongProduction === true)) why = 'human-allow';
    else if (f && (f.wrongProductionManualClear || f.wrongProductionOverride)) why = 'cleared-flag';
    else if (f && f.dateSource === 'llm-scoring') why = 'llm-guessed-date';
    out.push({
      showId: r.showId, outletId: r.outletId, pub: r.publishDate, earliest, days, why,
      bucket: days <= 14 ? '2-14d' : days <= 60 ? '15-60d' : '>60d',
      category: s.category, recent: r.publishDate >= RECENT_SINCE,
    });
  }
  const tally = (key) => out.reduce((m, o) => { m[o[key]] = (m[o[key]] || 0) + 1; return m; }, {});
  const unexplained = out.filter((o) => o.why === 'undeclared' || o.why === 'llm-guessed-date' || o.why === 'opt-out-prior-run');
  const perShow = new Map();
  for (const o of unexplained) perShow.set(o.showId, (perShow.get(o.showId) || 0) + 1);
  return {
    count: out.length,
    byBucket: tally('bucket'),
    byWhy: tally('why'),
    unexplained: unexplained.length,
    unexplainedShows: perShow.size,
    recentUnexplained: unexplained.filter((o) => o.recent).length,
    recentUnexplainedShows: new Set(unexplained.filter((o) => o.recent).map((o) => o.showId)).size,
    worst: top(perShow),
    rows: out,
  };
}

function class3(ctx) {
  const { rows, files } = ctx;
  const hits = [];
  const seen = new Set();
  for (const r of rows) {
    const f = matchFile(r, files.get(r.showId));
    if (!f || seen.has(`${r.showId}/${f.file}`)) continue;
    seen.add(`${r.showId}/${f.file}`);
    // A human clear (ManualClear without a script setBy) is a recorded verdict, not a miss.
    // Same rule as the write guard (BRO-5261: the bare /\.js$/ test called the guard's known script
    // labels, e.g. clear-own-venue-tour-fps-2026-10, human verdicts and hid their republished hits).
    const humanCleared = f.wrongProductionManualClear
      && !isScriptWrongProductionClear({ wrongProductionManualClear: true, wrongProductionOverrideSetBy: f.overrideSetBy });
    if (f.republish && f.republish.exclude && !humanCleared) {
      hits.push({ showId: r.showId, file: f.file, outletId: r.outletId, markerYear: f.republish.markerYear, snippet: f.republish.snippet, pub: r.publishDate, inherited: !!r.inheritedFromShowId });
    }
  }
  const perShow = new Map();
  for (const h of hits) perShow.set(h.showId, (perShow.get(h.showId) || 0) + 1);
  return { count: hits.length, shows: perShow.size, worst: top(perShow), rows: hits };
}

function class4(ctx) {
  const { files } = ctx;
  const hits = [];
  for (const [showId, list] of files) {
    for (const f of list) {
      if (f.flagVsClear.conflict) hits.push({ showId, file: f.file, clearedBy: f.flagVsClear.clearedBy, flagLater: f.flagVsClear.flagLater });
    }
  }
  const later = hits.filter((h) => h.flagLater);
  return { count: hits.length, flaggedAfterClear: later.length, rows: hits };
}

function class5(ctx) {
  const { shows, rows } = ctx;
  const byId = new Map(shows.map((s) => [s.id, s]));
  const linked = (a, b) => {
    const sa = byId.get(a) || {}; const sb = byId.get(b) || {};
    const has = (s, id) => (s.priorRuns || []).some((p) => p === id || (p && typeof p === 'object' && (p.id === id || p.showId === id || p.productionId === id)));
    return has(sa, b) || has(sb, a);
  };
  const byUrl = new Map();
  const dateOf = new Map();
  for (const r of rows) {
    // manualEntry rows are the curated roll-up entries of a tour umbrella (the Paranormal Activity
    // national tour, Gun and Powder regional): the same review is meant to sit on the umbrella and
    // on the stop's own show (BRO-5239).
    if (!r.url || r.inheritedFromShowId || r.manualEntry === true) continue;
    const c = canon(r.url);
    if (!c) continue;
    if (!byUrl.has(c)) byUrl.set(c, new Set());
    byUrl.get(c).add(r.showId);
    // Keep the first day-level date: a second month-only row for the same url must not erase it.
    const day = r.publishDate && String(r.publishDate).length >= 10 ? String(r.publishDate) : null;
    if (!dateOf.get(`${c}|${r.showId}`)) dateOf.set(`${c}|${r.showId}`, day);
  }
  const linkedMulti = [...byUrl.entries()].filter(([, set]) => {
    const ids = [...set];
    if (ids.length < 2) return false;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (!linked(ids[i], ids[j])) return true;
    return false;
  });
  // One article that reviews several shows (a double bill, a "critic's notebook") legitimately counts
  // on each of them. Its rows then carry dates within two weeks of each other, or no day-level date to
  // compare. A copy on the wrong run carries the same article date too, so the date must also sit in
  // every show's own run (BRO-5261: a 2020 Leopoldstadt review copied onto the 2021 run read as shared).
  const outsideRun = (id, d) => {
    const s = byId.get(id);
    if (!s || !d) return false;
    const first = earliestShowDate(s);
    if (first && daysBetween(first, d) > SHARED_PRE_RUN_DAYS) return true;
    return !!(s.closingDate && daysBetween(d, s.closingDate) > SHARED_POST_RUN_DAYS);
  };
  const isSharedArticle = ([u, set]) => {
    const ids = [...set];
    const ds = ids.map((id) => dateOf.get(`${u}|${id}`)).filter(Boolean).sort();
    // An undated row takes the article's date from its dated twin.
    if (ids.some((id) => outsideRun(id, dateOf.get(`${u}|${id}`) || ds[0]))) return false;
    return ds.length < 2 || daysBetween(ds[ds.length - 1], ds[0]) <= 14;
  };
  const multi = linkedMulti.filter((e) => !isSharedArticle(e));
  const sharedArticles = linkedMulti.length - multi.length;
  // url-less row beside a url row for the same outlet on the same show
  const perShow = new Map();
  for (const r of rows) {
    if (r.inheritedFromShowId) continue;
    if (!perShow.has(r.showId)) perShow.set(r.showId, []);
    perShow.get(r.showId).push(r);
  }
  const urlless = [];
  for (const [showId, list] of perShow) {
    for (const r of list) {
      if (r.url) continue;
      const ck = critKey(r.criticName);
      const twin = list.find((o) => o !== r && o.url && o.outletId === r.outletId && (!ck || !critKey(o.criticName) || critKey(o.criticName) === ck));
      if (twin) urlless.push({ showId, outletId: r.outletId, criticName: r.criticName, twinUrl: twin.url });
    }
  }
  const urllessShows = new Set(urlless.map((u) => u.showId));
  return {
    sameUrlTwoShows: multi.length,
    sharedArticles,
    sameUrlSample: multi.slice(0, 8).map(([u, set]) => `${u.slice(0, 70)} -> ${[...set].join(' | ')}`),
    ...(DETAIL ? { sameUrlAll: multi.map(([u, set]) => ({ url: u, shows: [...set].sort(), rows: rows.filter((r) => r.url && canon(r.url) === u && !r.inheritedFromShowId).map((r) => ({ showId: r.showId, outletId: r.outletId, criticName: r.criticName, publishDate: r.publishDate })) })) } : {}),
    urllessBesideUrl: urlless.length,
    urllessShows: urllessShows.size,
    urllessRows: urlless,
  };
}

function class6(ctx) {
  const { shows, rows } = ctx;
  const PLAYBILL = /playbill/i;
  const perShow = new Map();
  for (const r of rows) {
    if (r.inheritedFromShowId || !r.publishDate) continue;
    if (!perShow.has(r.showId)) perShow.set(r.showId, []);
    perShow.get(r.showId).push(r);
  }
  const reviewsFirst = [];
  const openNoReviews = [];
  for (const s of shows) {
    if (!s.openingDate || s.status === 'closed' || !s.openingDate) continue;
    const list = perShow.get(s.id) || [];
    const dates = list.map((r) => r.publishDate).sort();
    // Reviews published 1..14 days BEFORE the stored opening from 2+ outlets: the stored date is probably late.
    const before = list.filter((r) => { const d = daysBetween(s.openingDate, r.publishDate); return d >= 1 && d <= 14; });
    const outlets = new Set(before.map((r) => r.outletId));
    const sinceOpen = list.filter((r) => r.publishDate >= s.openingDate).length;
    if (outlets.size >= 2 && before.length >= 2 && sinceOpen < before.length) {
      reviewsFirst.push({ showId: s.id, opening: s.openingDate, source: s.openingDateSource || null, firstReview: dates[0], earlyReviews: before.length, playbill: PLAYBILL.test(String(s.openingDateSource || '')) });
    }
    if (list.length === 0 && s.openingDate <= TODAY && daysBetween(TODAY, s.openingDate) >= 2 && daysBetween(TODAY, s.openingDate) <= 30 && s.status === 'open') {
      openNoReviews.push({ showId: s.id, opening: s.openingDate, source: s.openingDateSource || null, playbill: PLAYBILL.test(String(s.openingDateSource || '')) });
    }
  }
  return {
    reviewsBeforeStoredOpening: reviewsFirst.length,
    reviewsBeforeStoredOpeningPlaybill: reviewsFirst.filter((x) => x.playbill).length,
    openNoReviews: openNoReviews.length,
    openNoReviewsPlaybill: openNoReviews.filter((x) => x.playbill).length,
    rows: { reviewsFirst, openNoReviews },
  };
}

function class7(ctx) {
  const { files, shows } = ctx;
  const hits = [];
  for (const [showId, list] of files) {
    for (const f of list) {
      if (f.originalScoreSource !== 'numeric-stars' || !f.originalScore) continue;
      if (f.hasStarEvidence || f.humanReviewScore) continue;
      if (f.wrongProduction && !f.wrongProductionManualClear && !f.wrongProductionOverride) continue;
      hits.push({ showId, file: f.file, originalScore: f.originalScore });
    }
  }
  const per = new Map();
  for (const h of hits) per.set(h.showId, (per.get(h.showId) || 0) + 1);
  return { count: hits.length, shows: per.size, worst: top(per), rows: hits };
}

function main() {
  let corpus;
  try { corpus = loadCorpus(); } catch (e) { console.error(`[audit-run-contamination] ${e.message}`); process.exit(3); }
  const need = { republish: want(3), stars: want(7) };
  const needFiles = want(2) || want(3) || want(4) || want(7);
  const files = needFiles ? indexFiles(corpus.shows, corpus.dir, need) : new Map();
  const ctx = { ...corpus, files };
  const result = { generatedAt: new Date().toISOString(), today: TODAY, recentSince: RECENT_SINCE, classes: {} };
  if (want(1)) result.classes.inherited = class1(ctx);
  if (want(2)) result.classes.preWindow = class2(ctx);
  if (want(3)) result.classes.republished = class3(ctx);
  if (want(4)) result.classes.flagVsClear = class4(ctx);
  if (want(5)) result.classes.duplicates = class5(ctx);
  if (want(6)) result.classes.showDates = class6(ctx);
  if (want(7)) result.classes.stars = class7(ctx);

  const out = argVal('out');
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  const c = result.classes;
  if (JSON_OUT) { console.log(JSON.stringify(result, null, 2)); applyGate(c, true); return; }

  const L = [];
  if (c.inherited) L.push(`1 inherited: ${c.inherited.count} rows on ${c.inherited.shows} shows; ${c.inherited.undecided} link(s) on the automatic rule (no recorded carry/no-carry) decision`);
  if (c.preWindow) L.push(`2 pre-window: ${c.preWindow.count} rows dated >1d before earliest show date (${JSON.stringify(c.preWindow.byBucket)}); by cause ${JSON.stringify(c.preWindow.byWhy)}; unexplained ${c.preWindow.unexplained} rows on ${c.preWindow.unexplainedShows} shows, since ${RECENT_SINCE}: ${c.preWindow.recentUnexplained} rows on ${c.preWindow.recentUnexplainedShows} shows; worst ${c.preWindow.worst.slice(0, 5).join(', ')}`);
  if (c.republished) L.push(`3 republished-marker: ${c.republished.count} counted rows on ${c.republished.shows} shows name an earlier year; worst ${c.republished.worst.slice(0, 5).join(', ')}`);
  if (c.flagVsClear) L.push(`4 flag-vs-clear: ${c.flagVsClear.count} files carry wrongProduction=true AND a clear marker (${c.flagVsClear.flaggedAfterClear} flagged by a plan AFTER the clear)`);
  if (c.duplicates) L.push(`5 duplicates: ${c.duplicates.sameUrlTwoShows} URLs counted on 2+ unlinked shows with dates >14d apart or outside a show's run (suspect), ${c.duplicates.sharedArticles} more are one article reviewing several shows; ${c.duplicates.urllessBesideUrl} url-less rows beside a url row on ${c.duplicates.urllessShows} shows`);
  if (c.showDates) L.push(`6 show-dates: ${c.showDates.reviewsBeforeStoredOpening} shows with 2+ outlets reviewing 1-14d before the stored opening (${c.showDates.reviewsBeforeStoredOpeningPlaybill} Playbill-derived); ${c.showDates.openNoReviews} open shows 2-30d past opening with zero reviews (${c.showDates.openNoReviewsPlaybill} Playbill-derived)`);
  if (c.stars) L.push(`7 stars: ${c.stars.count} numeric-star ratings on ${c.stars.shows} shows with no star evidence in the text (heuristic candidates)`);
  console.log(L.join('\n'));
  console.log(`BASELINE ${JSON.stringify({
    inherited: c.inherited && c.inherited.count,
    preWindowUnexplained: c.preWindow && c.preWindow.unexplained,
    preWindowRecentUnexplained: c.preWindow && c.preWindow.recentUnexplained,
    republished: c.republished && c.republished.count,
    flagVsClear: c.flagVsClear && c.flagVsClear.flaggedAfterClear,
    sameUrlTwoShows: c.duplicates && c.duplicates.sameUrlTwoShows,
    sharedArticles: c.duplicates && c.duplicates.sharedArticles,
    urllessBesideUrl: c.duplicates && c.duplicates.urllessBesideUrl,
    reviewsBeforeStoredOpening: c.showDates && c.showDates.reviewsBeforeStoredOpening,
    openNoReviews: c.showDates && c.showDates.openNoReviews,
    stars: c.stars && c.stars.count,
  })}`);
  applyGate(c, false);
}

// Advisory gate for check-corpus-drift: new contamination (a recent pre-window row,
// a counted republished page, a human flag beaten by a clear) above the agreed ceiling.
// Sums the classes that ran, so `--class=2 --max-actionable=0` gates class 2 alone (before BRO-5239 it
// needed classes 2, 3 and 4 together and silently passed otherwise). A class selection with none of
// 2, 3, 4 cannot be gated and exits 2 rather than pass silently; --json no longer skips the gate.
function applyGate(c, quiet) {
  const max = argVal('max-actionable');
  if (max === undefined || max === null) return;
  const log = quiet ? console.error : console.log;
  if (!(c.preWindow || c.republished || c.flagVsClear)) {
    console.error('[audit-run-contamination] --max-actionable needs class 2, 3 or 4 in --class');
    process.exitCode = 2;
    return;
  }
  const actionable = (c.preWindow ? c.preWindow.recentUnexplained : 0) + (c.republished ? c.republished.count : 0) + (c.flagVsClear ? c.flagVsClear.flaggedAfterClear : 0);
  log(`ACTIONABLE ${actionable} (ceiling ${max}): recent unexplained pre-window + counted republished + human flag beaten by clear`);
  if (actionable > Number(max)) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { class1, class2, class3, class4, class5, class6, class7, matchFile, canon, critKey };
