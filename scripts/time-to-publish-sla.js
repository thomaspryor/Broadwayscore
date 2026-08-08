#!/usr/bin/env node
'use strict';

/**
 * CLI: node scripts/time-to-publish-sla.js [options]
 *
 * How long does a review take to go from published by the outlet to live on
 * broadwayscorecard.com, and are we hitting the 90%-within-15-minutes target?
 * (Notion card Structural #11, task #388 — 2026-04-15 Fear of 13, BWSC was the
 * LAST aggregator to have the reviews up.)
 *
 * Options
 *   --windows=N        judge the last N opening weekends (default 2, the card's
 *                      acceptance criterion)
 *   --days=N           judge everything first seen in the last N days instead
 *                      of scoping to openings
 *   --show=ID          judge one show only
 *   --discovery-baseline=ID
 *                      one-off baseline for a past opening from review-texts
 *                      (publishDate → textFetchedAt). The only signal that
 *                      survives for openings older than the stage log.
 *   --alert            route a digest line when the SLA is breached
 *   --output=PATH      where to write the report (default
 *                      data/audit/time-to-publish-sla.json)
 *   --quiet            no stdout report
 *
 * Exit code is 0 unless the run itself failed. A missed SLA is reported and
 * (with --alert) routed — it does not fail the job, because a red daily cron
 * that nobody can fix in the moment just trains people to ignore it. The
 * pass/fail logic itself is gated by tests/unit/time-to-publish-sla.test.mjs.
 */

const fs = require('fs');
const path = require('path');

const {
  parsePrecisePublishTime,
  computeReviewLatencies,
  evaluateTimeToPublishSla,
  selectRecentOpeningWindows,
  filterToOpeningWindows,
  MS_MIN,
  DEFAULT_DISCOVERY_WINDOW_MIN,
} = require('./lib/time-to-publish-sla');
// Same normalizer review-file-writer uses to build the reviewKey critic slug.
const { normalizeCritic } = require('./lib/review-normalization');

const ROOT = path.join(__dirname, '..');
const DEFAULT_LOG = path.join(ROOT, 'data/audit/stage-latency.jsonl');
const SHOWS_JSON = path.join(ROOT, 'data/shows.json');
const REVIEW_TEXTS = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data/review-texts');
const DEFAULT_OUTPUT = path.join(ROOT, 'data/audit/time-to-publish-sla.json');

const HELP = /^(--help|-h)$/;

function parseArgs(argv) {
  const args = {
    windows: 2, days: null, show: null, discoveryBaseline: null,
    alert: false, output: null, quiet: false, log: null,
    discoveryWindow: DEFAULT_DISCOVERY_WINDOW_MIN,
  };
  for (const a of argv) {
    const [k, v] = a.replace(/^--/, '').split('=');
    if (k === 'windows') args.windows = Number(v) || 2;
    else if (k === 'discovery-window') args.discoveryWindow = Number(v) || DEFAULT_DISCOVERY_WINDOW_MIN;
    else if (k === 'days') args.days = Number(v) || null;
    else if (k === 'show') args.show = v;
    else if (k === 'discovery-baseline') args.discoveryBaseline = v;
    else if (k === 'alert') args.alert = true;
    else if (k === 'output') args.output = v;
    else if (k === 'quiet') args.quiet = true;
    else if (k === 'log') args.log = v;
  }
  return args;
}

function readJSONL(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function nextDay(isoDay) {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function fmtMinutes(ms) {
  if (ms === null || ms === undefined) return 'n/a';
  const m = ms / MS_MIN;
  return m >= 100 ? `${Math.round(m)}m` : `${Math.round(m * 10) / 10}m`;
}

/**
 * reviewKey → precise ISO publication time, for the reviews that have one.
 *
 * Only 4.8% of review-text files carry a time-of-day; the rest fall back to the
 * poller-bounded upper bound in the lib. review-texts is a separate private
 * clone (CLAUDE.md §11) and is simply absent in some checkouts — that costs
 * precision, not correctness.
 */
function loadPublishTimes(showIds) {
  const out = new Map();
  if (!fs.existsSync(REVIEW_TEXTS)) return out;
  const dirs = showIds && showIds.length
    ? showIds
    : fs.readdirSync(REVIEW_TEXTS).filter(d => !d.startsWith('.'));
  for (const showId of dirs) {
    const dir = path.join(REVIEW_TEXTS, showId);
    let files;
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch { continue; }
    for (const f of files) {
      const j = readJSON(path.join(dir, f), null);
      if (!j || !j.url) continue;
      const precise = parsePrecisePublishTime(j.publishDate);
      if (!precise) continue;
      // The key MUST be built with the same normalizer the writer used
      // (review-file-writer.js:69 → normalizeCritic), not a hand-rolled
      // lowercase+dash. A local slugifier disagreed on 86 of the 2,016
      // precise-time files — "Samuel L. Leiter" → samuel-l.-leiter vs the real
      // samuel-l-leiter, plus alias mappings like "Steve Babyak" →
      // steven-babyak. Every mismatch silently fell through to
      // 'poller-bounded', which is the worst kind of bug here: the measured
      // basis quietly becomes dead code and the number gets worse, not wrong
      // enough to notice.
      const critic = normalizeCritic(j.criticName);
      out.set(`${j.outletId}:${critic}:${j.url}`, precise);
      out.set(`${showId}||${j.outletId}:${critic}:${j.url}`, precise);
    }
  }
  return out;
}

/**
 * Baseline for an opening that predates the stage-latency log's retention.
 * publishDate → textFetchedAt is the discovery half of time-to-publish: how
 * long after an outlet published did we first hold its text. It is a floor on
 * the true number (the review still had to be scored, rebuilt and deployed) and
 * it is only as precise as publishDate, so day-resolution rows are reported
 * separately from the ones with a real clock.
 */
function discoveryBaseline(showId, openingDate = null) {
  const dir = path.join(REVIEW_TEXTS, showId);
  if (!fs.existsSync(dir)) {
    return { showId, error: `no review-texts for ${showId} at ${dir}` };
  }
  // The opening-night cluster: reviews published on the opening day or the
  // morning after. How long OUR collection of that cluster took end to end is
  // the closest thing the surviving data has to "we were last" — the owner's
  // 2026-04-15 complaint was about the spread, not any single review.
  const clusterFetches = [];
  const precise = [];
  const dayResolution = [];
  let noFetchStamp = 0;
  let noPublishDate = 0;
  let excluded = 0;

  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
    const j = readJSON(path.join(dir, f), null);
    if (!j) continue;
    // Reviews we never publish are not part of time-to-publish. Without this,
    // Fear of 13's baseline was dominated by the 2024 Donmar London-run pieces
    // (wrongProduction) — a 633-day "lag" for text we deliberately exclude.
    if (j.wrongProduction || j.wrongShow || j.isNonReview || j.contentTier === 'invalid') { excluded++; continue; }
    if (!j.textFetchedAt) { noFetchStamp++; continue; }
    const exact = parsePrecisePublishTime(j.publishDate);
    if (exact) {
      const ms = new Date(j.textFetchedAt) - new Date(exact.at);
      if (ms >= 0) {
        precise.push({
          file: f, outletId: j.outletId, publishedAt: exact.at,
          assumedZone: exact.assumedZone, fetchedAt: j.textFetchedAt, lagMs: ms,
        });
      }
      continue;
    }
    const day = String(j.publishDate || '').match(/^(\d{4}-\d{2}-\d{2})/);
    if (!day) { noPublishDate++; continue; }
    if (openingDate && (day[1] === openingDate || day[1] === nextDay(openingDate))) {
      clusterFetches.push({ outletId: j.outletId, publishedDay: day[1], fetchedAt: j.textFetchedAt });
    }
    // Day resolution: measure to the END of the publication day so the number
    // is a floor, never an invented head start.
    const dayEnd = new Date(`${day[1]}T23:59:59Z`);
    const ms = new Date(j.textFetchedAt) - dayEnd;
    dayResolution.push({ file: f, outletId: j.outletId, publishedDay: day[1], fetchedAt: j.textFetchedAt, lagMsFromDayEnd: ms });
  }

  const sameDay = dayResolution.filter(r => r.lagMsFromDayEnd <= 0).length;
  const lateDays = dayResolution
    .filter(r => r.lagMsFromDayEnd > 0)
    .map(r => Math.round(r.lagMsFromDayEnd / (24 * 60 * MS_MIN)));
  lateDays.sort((a, b) => a - b);

  clusterFetches.sort((a, b) => (a.fetchedAt < b.fetchedAt ? -1 : 1));
  const openingNightCluster = clusterFetches.length ? {
    openingDate,
    reviews: clusterFetches.length,
    firstFetchedAt: clusterFetches[0].fetchedAt,
    medianFetchedAt: clusterFetches[Math.floor(clusterFetches.length / 2)].fetchedAt,
    lastFetchedAt: clusterFetches[clusterFetches.length - 1].fetchedAt,
    spreadHours: Math.round(
      (new Date(clusterFetches[clusterFetches.length - 1].fetchedAt) - new Date(clusterFetches[0].fetchedAt))
      / (60 * MS_MIN) * 10) / 10,
    outlets: clusterFetches.map(c => `${c.outletId}@${c.fetchedAt}`),
  } : null;

  return {
    showId,
    reviewsWithFetchStamp: precise.length + dayResolution.length,
    excludedFromSite: excluded,
    openingNightCluster,
    noFetchStamp,
    noPublishDate,
    preciseSample: precise.length,
    preciseMedianLagMs: precise.length
      ? precise.map(p => p.lagMs).sort((a, b) => a - b)[Math.floor(precise.length / 2)]
      : null,
    dayResolutionSample: dayResolution.length,
    fetchedSameDayOrEarlier: sameDay,
    fetchedLaterMedianDays: lateDays.length ? lateDays[Math.floor(lateDays.length / 2)] : null,
    fetchedLaterMaxDays: lateDays.length ? lateDays[lateDays.length - 1] : null,
    slowest: [...precise].sort((a, b) => b.lagMs - a.lagMs).slice(0, 5),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.some(a => HELP.test(a))) {
    // --help must never write anything (the #534 unconditional-write class).
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1] + '\n');
    return;
  }
  const args = parseArgs(argv);
  const now = new Date();

  // --- one-off baseline mode -------------------------------------------------
  if (args.discoveryBaseline) {
    const raw = readJSON(SHOWS_JSON, null);
    const list = Array.isArray(raw) ? raw : (raw && raw.shows) || [];
    const show = list.find(s => s && s.id === args.discoveryBaseline);
    const opening = show && typeof show.openingDate === 'string' ? show.openingDate.slice(0, 10) : null;
    if (!opening) console.warn(`[time-to-publish-sla] no openingDate for ${args.discoveryBaseline} — opening-night cluster omitted.`);
    console.log(JSON.stringify(discoveryBaseline(args.discoveryBaseline, opening), null, 2));
    return;
  }

  // --- SLA mode --------------------------------------------------------------
  const logFile = args.log || process.env.STAGE_LATENCY_LOG || DEFAULT_LOG;
  const entries = readJSONL(logFile);
  const showsRaw = readJSON(SHOWS_JSON, null);
  const showList = Array.isArray(showsRaw) ? showsRaw : (showsRaw && showsRaw.shows) || null;

  // shows.json is private core data (CLAUDE.md §11) and is absent from fresh
  // worktrees until ./scripts/setup-local-data.sh runs. Without it the opening
  // windows cannot be resolved — say so loudly and fall back to a 14-day slice
  // (roughly two opening weekends) rather than silently judging every backfill
  // in the log and calling that the opening-night SLA.
  let degraded = null;
  if (!args.days && !showList) {
    degraded = `shows.json unavailable at ${SHOWS_JSON} — cannot resolve opening windows`;
    args.days = 14;
    console.warn(`[time-to-publish-sla] WARNING: ${degraded}; falling back to --days=14.`);
    console.warn('[time-to-publish-sla] Run ./scripts/setup-local-data.sh for opening-scoped results.');
  }

  let windows = [];
  if (args.show) {
    const s = (showList || []).find(x => x && x.id === args.show);
    windows = s ? selectRecentOpeningWindows([s], { now, count: 1 }) : [];
    if (!s) console.warn(`[time-to-publish-sla] WARNING: show ${args.show} not found in shows.json.`);
  } else if (!args.days) {
    windows = selectRecentOpeningWindows(showList, { now, count: args.windows });
  }

  const showIds = windows.map(w => w.showId);
  const publishTimes = loadPublishTimes(showIds);

  let records = computeReviewLatencies(entries, {
    publishTimes,
    // Defaults to the orchestrator's POLL_INTERVAL default (10 min). A window
    // dispatched with a different poll_interval_minutes must pass
    // --discovery-window=N or the bound understates the real worst case.
    discoveryWindowMinutes: args.discoveryWindow,
  });

  let scope;
  if (args.days) {
    const cutoff = new Date(now - args.days * 24 * 60 * MS_MIN).toISOString();
    records = records.filter(r => r.firstSeenAt >= cutoff);
    scope = `last ${args.days} day(s)`;
  } else if (windows.length) {
    records = filterToOpeningWindows(records, windows);
    scope = `${windows.length} opening window(s): ${windows.map(w => `${w.showId} (${w.openingDate})`).join(', ')}`;
  } else {
    scope = 'UNSCOPED — all tracked reviews (no opening window resolved)';
  }
  if (degraded) scope = `${scope} [DEGRADED: ${degraded}]`;

  const verdict = evaluateTimeToPublishSla(records);

  const report = {
    generatedAt: now.toISOString(),
    scope,
    degraded,
    windows,
    logFile,
    logEntryCount: entries.length,
    logOldestEntryAt: entries.length ? entries.reduce((m, e) => (e.at && (!m || e.at < m) ? e.at : m), null) : null,
    publishTimesLoaded: publishTimes.size,
    verdict,
    records: records.map(r => ({
      showId: r.showId,
      outletId: r.outletId,
      reviewKey: r.reviewKey,
      basis: r.basis,
      firstSeenAt: r.firstSeenAt,
      liveAt: r.liveAt,
      pipelineMinutes: r.pipelineMs === null ? null : Math.round(r.pipelineMs / MS_MIN * 10) / 10,
      publishedToLiveMinutes: r.publishedToLiveMs === null ? null : Math.round(r.publishedToLiveMs / MS_MIN * 10) / 10,
      stuckAtStage: r.stuckAtStage,
    })),
  };

  const reportPath = args.output ? path.resolve(args.output) : DEFAULT_OUTPUT;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

  if (!args.quiet) {
    console.log(`Time-to-publish SLA — ${scope}`);
    console.log(`  target      : ${verdict.targetPct}% within ${verdict.targetMinutes} min`);
    console.log(`  verdict     : ${verdict.verdict.toUpperCase()}`);
    console.log(`  evaluated   : ${verdict.evaluated} review(s)${verdict.inFlight ? ` (+${verdict.inFlight} still in flight)` : ''}`);
    console.log(`  compliance  : ${verdict.compliancePct === null ? 'n/a' : `${verdict.compliancePct}%`}`);
    console.log(`  p50 / p90   : ${fmtMinutes(verdict.p50Ms)} / ${fmtMinutes(verdict.p90Ms)}`);
    for (const [basis, s] of Object.entries(verdict.byBasis)) {
      console.log(`  ${basis.padEnd(16)}: ${s.compliant}/${s.evaluated} within target`);
    }
    if (verdict.breaches.length) {
      console.log('  slowest:');
      for (const b of verdict.breaches.slice(0, 5)) {
        console.log(`    ${b.showId} / ${b.outletId} — ${fmtMinutes(b.publishedToLiveMs)} (${b.basis})`);
      }
    }
    if (verdict.verdict === 'insufficient-data') {
      console.log(`  NOTE: fewer than ${verdict.minSample} reviews reached live in scope — reporting insufficient-data, not a pass.`);
      if (report.logOldestEntryAt) console.log(`        Log currently starts at ${report.logOldestEntryAt}.`);
    }
    console.log(`Written: ${reportPath}`);
  }

  if (args.alert) {
    const { routeAlert, resolveCondition } = require('./lib/owner-alert-router');

    if (verdict.verdict === 'fail') {
      const list = verdict.breaches.slice(0, 8)
        .map(b => `• ${b.showId} / ${b.outletId} — ${fmtMinutes(b.publishedToLiveMs)}`).join('\n');
      await routeAlert({
        conditionKey: 'time-to-publish-sla:missed',
        title: `Time-to-publish SLA missed — ${verdict.compliancePct}% within ${verdict.targetMinutes} min (target ${verdict.targetPct}%)`,
        description: `Scope: ${scope}\nEvaluated ${verdict.evaluated} review(s), p90 ${fmtMinutes(verdict.p90Ms)}.\nSlowest:\n${list}`,
        severity: 'warning',
        disposition: 'digest',
      }).catch(e => console.error('[time-to-publish-sla] alert route failed:', e.message));
    } else {
      resolveCondition('time-to-publish-sla:missed');
    }

    // A metric that can see nothing must SAY it can see nothing. Without this,
    // rotation eating the history, a degraded scope, or the stage emits dying
    // all look identical to a healthy quiet day: no alert, no digest line, and
    // an owner who believes the SLA is being watched when it is not. This is
    // the vacuous-monitoring class (#1075/#1094) applied to the monitor itself.
    if (verdict.verdict === 'insufficient-data') {
      await routeAlert({
        conditionKey: 'time-to-publish-sla:unmeasurable',
        title: `Time-to-publish SLA cannot be measured — only ${verdict.evaluated} review(s) in scope (need ${verdict.minSample})`,
        description: [
          `Scope: ${scope}`,
          `${verdict.inFlight} review(s) still in flight.`,
          report.logOldestEntryAt ? `Stage log currently starts at ${report.logOldestEntryAt}.` : 'Stage log is empty.',
          degraded ? `DEGRADED: ${degraded}` : '',
          'This is NOT a pass — the SLA had too little to judge.',
        ].filter(Boolean).join('\n'),
        severity: 'warning',
        disposition: 'digest',
      }).catch(e => console.error('[time-to-publish-sla] unmeasurable route failed:', e.message));
    } else {
      resolveCondition('time-to-publish-sla:unmeasurable');
    }
  }
}

module.exports = { discoveryBaseline, loadPublishTimes };

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
