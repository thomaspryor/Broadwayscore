#!/usr/bin/env node
// venue-write-guard-ok: venue is only read into an in-memory classifier context (BRO-6804), never persisted
'use strict';
/**
 * slow-market-grade.js (BRO-6687): grade review discovery for one or more
 * openings from the committed hourly gap audit. Read-only; needs no private repos.
 *
 * PASS = every review a source cited (aggregator roundup, WE reference source) is
 * live or legitimately excluded; FAIL = cited reviews still not live, or an
 * automated exclusion a current round-up lists. SERP-census hits are shown for
 * information only: they are unverified search results, not citations.
 *
 * STALE (main() only; gradeShow stays PASS/FAIL for the RECHECK test): a PASS
 * whose audit row is older than --max-age-hours (default 24) proves nothing about
 * reviews published since. A FAIL stays FAIL with "(stale)" appended.
 *
 * OVERDUE (BRO-6751, information only, never changes the grade or --check):
 * the show's last gap-audit checkpoint is older than the scheduler's own
 * freshness promise for it (freshnessMsFor) plus OVERDUE_GRACE_HOURS. STALE
 * asks "does this PASS still prove anything?"; OVERDUE asks "is the scheduler
 * keeping up?". Meant for the slow tiers: the 12h grace hides lag in the
 * opening-week tiers (55-min / 3h promises). A closed last-year show is promised a 30-day recheck, so it
 * can be STALE (>24h) without being OVERDUE; a rising OVERDUE count means the
 * audit workflow is getting too few runs.
 *
 * Frequent outlets missing (BRO-6687): outlets that reviewed >= 60% of the
 * market's openings over the trailing seasons (audit-standing-coverage's own
 * measurement, per category) with no live review, no audit-row URL and no
 * aggregator citation for this show. Information only: an outlet can skip a show.
 *
 * Usage:
 *   node scripts/slow-market-grade.js --show=a,b,c          # print grades
 *   node scripts/slow-market-grade.js --show=a,b --check    # exit 1 on any FAIL / STALE / missing row
 *   node scripts/slow-market-grade.js --show=a --max-age-hours=48
 *   node scripts/slow-market-grade.js --json                # machine-readable
 *   node scripts/slow-market-grade.js --last-year --max-stale-pct=5
 *       # BRO-6751: the scheduler's last-year shows (gap-audit-freshness inLastYear);
 *       # exit 1 when stale (any grade) or never-audited rows are >= 5% of them
 */
const fs = require('fs');
const path = require('path');
const { slowMarketListedGap } = require('./lib/slow-market-gap');
const { currentRunOnly } = require('./lib/prior-production-citations');
const { censusExclusionReason } = require('./lib/gap-census-noise');
const { titleTokens } = require('./lib/show-title-tokens');
const { computeSeasonWindows, measureOutletCoverage } = require('./audit-standing-coverage');

const FREQUENT_OUTLET_RATE = 0.6;
const DEFAULT_MAX_AGE_HOURS = 24;
// One measured max gap between real audit runs (12.1h, BRO-3867) on top of the promise.
const OVERDUE_GRACE_HOURS = 12;
// The scheduled grind's --window (audit-aggregator-gap.yml INPUT_WINDOW_DAYS default).
const GRIND_WINDOW_DAYS = 1095;

const ROOT = path.join(__dirname, '..');

function gradeShow(row, liveCount) {
  if (!row) return { grade: 'NO-AUDIT', live: liveCount, notLive: [], census: 0, hiddenAsNonReview: 0 };
  const g = slowMarketListedGap(row);
  return {
    grade: g.residual === 0 ? 'PASS' : 'FAIL',
    live: liveCount,
    notLive: g.rows.map((m) => m.url),
    cited: g.rows.length - g.flaggedOut,
    capped: g.capped,
    reverify: g.flaggedOut,
    // Census rows that are noise (syndication copies, other-title URLs) are not owed (BRO-6804).
    census: currentRunOnly(row.missing).filter((m) => m && m.serpCensus
      && !censusExclusionReason(m, 'missing', { show: { title: row.title, category: row.category, venue: row.venue, market: row.market, openingDate: row.openingDate, previewsStartDate: row.previewsStartDate, priorRuns: row.priorRuns }, tokensOf: titleTokens })).length,
    hiddenAsNonReview: currentRunOnly(row.flaggedMisses).filter((m) => m && m.confirmedNonReview).length,
    auditedAt: row.computedAt || null,
  };
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

/** Pure: outlets that reviewed >= rate of `category` openings, from audit-standing-coverage's season windows. */
function frequentOutletsFor(category, shows, reviews, nowMs, rate = FREQUENT_OUTLET_RATE) {
  const w = computeSeasonWindows(shows, reviews, nowMs, { category });
  const ids = new Set();
  for (const id of w.allShows) for (const o of w.outletsByShow.get(id)) ids.add(o);
  return [...ids]
    .map((o) => ({ outletId: o, ...measureOutletCoverage(o, w.scored, w.allShows, w.outletsByShow) }))
    .filter((m) => m.hasEvidence && m.overall >= rate)
    .sort((a, b) => b.overall - a.overall)
    .map((m) => ({ outletId: m.outletId, rate: Math.round(m.overall * 100) / 100 }));
}

/** Pure: the frequent outlets with nothing at all for this show (no live review, no audit-row URL). */
function frequentMissing(frequent, liveOutletIds, row, outletDomains = {}) {
  const hosts = new Set();
  const ids = new Set(liveOutletIds);
  for (const list of [row?.missing, row?.flaggedMisses, row?.dirOnly]) {
    for (const m of list || []) {
      if (m?.knownOutletId) ids.add(m.knownOutletId);
      if (m?.outletId) ids.add(m.outletId);
      const h = m?.host || hostOf(m?.url);
      if (h) hosts.add(h.replace(/^www\./, ''));
    }
  }
  for (const u of row?.aggregatorListedUrls || []) { const h = hostOf(u); if (h) hosts.add(h); }
  return frequent.filter((f) => {
    if (ids.has(f.outletId)) return false;
    const d = (outletDomains[f.outletId] || '').replace(/^www\./, '').toLowerCase();
    return !(d && [...hosts].some((h) => h === d || h.endsWith('.' + d)));
  });
}

/** Grade shown to people: PASS older than maxAgeHours becomes STALE. */
function displayGrade(g, nowMs, maxAgeHours = DEFAULT_MAX_AGE_HOURS) {
  const t = Date.parse(g.auditedAt);
  const ageHours = Number.isFinite(t) ? (nowMs - t) / 3600000 : null;
  const stale = g.grade !== 'NO-AUDIT' && (ageHours === null || ageHours > maxAgeHours);
  return { grade: stale && g.grade === 'PASS' ? 'STALE' : g.grade, stale, ageHours };
}

/**
 * Is the scheduler behind on this show? `entry` is the show's entry from
 * schedulingCheckpoint() (the same view the scheduler sorts by); no entry =
 * never audited = overdue. Same freshness call and default the audit uses.
 */
function isOverdue(show, entry, nowMs, { freshnessMsFor, checkpointTs }, graceHours = OVERDUE_GRACE_HOURS, scopeDays = GRIND_WINDOW_DAYS) {
  if (!show) return null;
  if (!entry) {
    // Never audited: overdue only if the grind's window covers it; otherwise nothing was promised.
    const opened = Date.parse(show.openingDate || show.previewsStartDate || '');
    return Number.isFinite(opened) && nowMs - opened <= scopeDays * 86400000 ? true : null;
  }
  const age = nowMs - checkpointTs(entry);
  return age > freshnessMsFor(show, entry, { freshnessHours: 12, now: nowMs }) + graceHours * 3600000;
}

/** Pure (BRO-6751): the scheduler's own last-year set (gap-audit-freshness inLastYear), so the grade and the audit agree. */
function lastYearIds(shows, nowMs) {
  const { inLastYear } = require('./lib/gap-audit-freshness');
  return shows.filter((s) => inLastYear(s, nowMs)).map((s) => s.id);
}

/**
 * Pure (BRO-6751): true when rows with nothing fresh to show (any stale grade,
 * FAIL (stale) included, or never audited) reach `maxPct` percent of `out`.
 * Empty = breach: nothing graded proves nothing.
 */
function staleBreach(out, maxPct) {
  if (!out.length) return true;
  return (100 * out.filter(notFresh).length) / out.length >= maxPct;
}
function notFresh(s) { return s.stale || s.grade === 'NO-AUDIT'; }

function main(argv = process.argv.slice(2)) {
  const showArg = argv.find((a) => a.startsWith('--show='));
  let ids = showArg ? showArg.split('=')[1].split(',').filter(Boolean) : [];
  const lastYear = argv.includes('--last-year');
  if (!ids.length && !lastYear) {
    console.error('usage: node scripts/slow-market-grade.js --show=<id[,id...]> | --last-year [--check] [--max-stale-pct=N] [--json]');
    return 2;
  }
  const maxStaleArg = argv.find((a) => a.startsWith('--max-stale-pct='));
  const maxStalePct = maxStaleArg ? Number(maxStaleArg.split('=')[1]) : null;
  if (maxStaleArg && !(Number.isFinite(maxStalePct) && maxStalePct > 0)) {
    console.error(`--max-stale-pct must be a positive number (got ${maxStaleArg})`);
    return 2;
  }
  const maxAgeArg = argv.find((a) => a.startsWith('--max-age-hours='));
  const maxAgeHours = maxAgeArg ? Number(maxAgeArg.split('=')[1]) : DEFAULT_MAX_AGE_HOURS;
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    console.error(`--max-age-hours must be a positive number (got ${maxAgeArg})`);
    return 2;
  }
  const nowMs = Date.now();
  const audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'audit', 'show-review-gap.json'), 'utf8'));
  const reviews = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reviews.json'), 'utf8')).reviews || [];
  const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || []);
  const showById = new Map(shows.map((s) => [s.id, s]));
  if (lastYear) ids = [...new Set([...ids, ...lastYearIds(shows, nowMs)])];
  let outletDomains = {};
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'outlet-registry.json'), 'utf8'));
    for (const [id, o] of Object.entries(reg.outlets || reg)) if (o && o.domain) outletDomains[id] = o.domain;
  } catch { /* no registry: match on outlet id only */ }
  const live = new Map();
  const liveOutlets = new Map();
  for (const r of reviews) {
    live.set(r.showId, (live.get(r.showId) || 0) + 1);
    if (!liveOutlets.has(r.showId)) liveOutlets.set(r.showId, new Set());
    liveOutlets.get(r.showId).add(r.outletId);
  }
  // BRO-6751: scheduler view for OVERDUE. Missing checkpoint file -> overdue unknown (null).
  let sched = null;
  let freshness = null;
  const cpPath = path.join(ROOT, 'data', 'audit', 'gap-audit-checkpoint.json');
  if (fs.existsSync(cpPath)) {
    freshness = require('./lib/gap-audit-freshness');
    sched = freshness.schedulingCheckpoint(JSON.parse(fs.readFileSync(cpPath, 'utf8')), freshness.gapRowShowIds(audit), nowMs);
  }
  const frequentByCategory = new Map();
  const byId = new Map((audit.results || []).map((r) => [r.showId, r]));
  const out = ids.map((id) => {
    const row = byId.get(id);
    const g = gradeShow(row, live.get(id) || 0);
    const d = displayGrade(g, nowMs, maxAgeHours);
    const category = showById.get(id)?.category;
    if (category && !frequentByCategory.has(category)) frequentByCategory.set(category, frequentOutletsFor(category, shows, reviews, nowMs));
    const freq = row ? frequentMissing(frequentByCategory.get(category) || [], liveOutlets.get(id) || [], row, outletDomains) : [];
    return {
      showId: id, ...g, grade: d.grade, auditGrade: g.grade, stale: d.stale,
      auditAgeHours: d.ageHours === null ? null : Math.round(d.ageHours * 10) / 10,
      quarantined: !!(row?.quarantine || row?.quarantined), // rows store `quarantine` (BRO-3002)
      frequentMissing: freq.map((f) => f.outletId),
      overdue: sched ? isOverdue(showById.get(id), sched[id], nowMs, freshness) : null,
    };
  });
  const overdueCount = out.filter((s) => s.overdue === true).length;
  if (argv.includes('--json')) console.log(JSON.stringify({ auditGeneratedAt: audit.generatedAt, overdueCount, shows: out }, null, 2));
  else {
    console.log(`gap audit generated ${audit.generatedAt}`);
    for (const s of out) {
      const staleNote = s.stale ? ` (stale: ${s.auditAgeHours === null ? 'no audit time' : `${s.auditAgeHours}h old`}${s.quarantined ? ', row quarantined so its time is frozen' : ''})` : '';
      console.log(`${s.grade.padEnd(8)} ${s.showId}: ${s.live} live, ${s.cited || 0} cited not live${s.capped ? ` (${s.capped} behind the ingest cap)` : ''}${s.reverify ? `, ${s.reverify} automated exclusion(s) to re-verify` : ''}; info: ${s.census} census candidate(s), ${s.hiddenAsNonReview} exclusion(s) confirmed correct${s.auditedAt ? `; audited ${s.auditedAt}` : ''}${staleNote}`);
      for (const u of s.notLive) console.log(`         - ${u}`);
      if (s.frequentMissing.length) console.log(`         frequent outlets with nothing for this show: ${s.frequentMissing.join(', ')}`);
    }
    const count = (g) => out.filter((s) => s.grade === g).length;
    console.log(`summary: ${out.length} show(s): PASS ${count('PASS')}, STALE ${count('STALE')}, FAIL ${count('FAIL')}, NO-AUDIT ${count('NO-AUDIT')}; OVERDUE vs the scheduler's own recheck promise: ${sched ? overdueCount : 'unknown (no checkpoint)'}`);
  }
  if (maxStalePct !== null) {
    const stale = out.filter(notFresh).length;
    const pct = out.length ? Math.round((1000 * stale) / out.length) / 10 : 0;
    const breach = staleBreach(out, maxStalePct);
    console.error(`stale-pct: ${stale}/${out.length} = ${pct}% stale or never audited (limit < ${maxStalePct}%) ${breach ? 'FAIL' : 'OK'}`);
    if (breach) return 1;
  }
  return argv.includes('--check') && out.some((s) => s.grade !== 'PASS') ? 1 : 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { gradeShow, main, lastYearIds, staleBreach, displayGrade, isOverdue, OVERDUE_GRACE_HOURS, GRIND_WINDOW_DAYS, frequentOutletsFor, frequentMissing, FREQUENT_OUTLET_RATE, DEFAULT_MAX_AGE_HOURS };
