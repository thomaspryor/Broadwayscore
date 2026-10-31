#!/usr/bin/env node
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
 */
const fs = require('fs');
const path = require('path');
const { slowMarketListedGap } = require('./lib/slow-market-gap');
const { currentRunOnly } = require('./lib/prior-production-citations');
const { computeSeasonWindows, measureOutletCoverage } = require('./audit-standing-coverage');

const FREQUENT_OUTLET_RATE = 0.6;
const DEFAULT_MAX_AGE_HOURS = 24;

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
    census: currentRunOnly(row.missing).filter((m) => m && m.serpCensus).length,
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

function main(argv = process.argv.slice(2)) {
  const showArg = argv.find((a) => a.startsWith('--show='));
  const ids = showArg ? showArg.split('=')[1].split(',').filter(Boolean) : [];
  if (!ids.length) {
    console.error('usage: node scripts/slow-market-grade.js --show=<id[,id...]> [--check] [--json]');
    return 2;
  }
  const maxAgeArg = argv.find((a) => a.startsWith('--max-age-hours='));
  const maxAgeHours = maxAgeArg ? Number(maxAgeArg.split('=')[1]) : DEFAULT_MAX_AGE_HOURS;
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    console.error(`--max-age-hours must be a positive number (got ${maxAgeArg})`);
    process.exit(2);
  }
  const nowMs = Date.now();
  const audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'audit', 'show-review-gap.json'), 'utf8'));
  const reviews = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reviews.json'), 'utf8')).reviews || [];
  const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || []);
  const showById = new Map(shows.map((s) => [s.id, s]));
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
    };
  });
  if (argv.includes('--json')) console.log(JSON.stringify({ auditGeneratedAt: audit.generatedAt, shows: out }, null, 2));
  else {
    console.log(`gap audit generated ${audit.generatedAt}`);
    for (const s of out) {
      const staleNote = s.stale ? ` (stale: ${s.auditAgeHours === null ? 'no audit time' : `${s.auditAgeHours}h old`}${s.quarantined ? ', row quarantined so its time is frozen' : ''})` : '';
      console.log(`${s.grade.padEnd(8)} ${s.showId}: ${s.live} live, ${s.cited || 0} cited not live${s.capped ? ` (${s.capped} behind the ingest cap)` : ''}${s.reverify ? `, ${s.reverify} automated exclusion(s) to re-verify` : ''}; info: ${s.census} census candidate(s), ${s.hiddenAsNonReview} exclusion(s) confirmed correct${s.auditedAt ? `; audited ${s.auditedAt}` : ''}${staleNote}`);
      for (const u of s.notLive) console.log(`         - ${u}`);
      if (s.frequentMissing.length) console.log(`         frequent outlets with nothing for this show: ${s.frequentMissing.join(', ')}`);
    }
  }
  return argv.includes('--check') && out.some((s) => s.grade !== 'PASS') ? 1 : 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { gradeShow, main, displayGrade, frequentOutletsFor, frequentMissing, FREQUENT_OUTLET_RATE, DEFAULT_MAX_AGE_HOURS };
