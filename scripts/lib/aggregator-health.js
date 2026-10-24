'use strict';

/**
 * Aggregator health (BRO-6098): decides whether each review aggregator is still
 * producing archive pages, from two independent signals.
 *
 *   1. Coverage: share of shows (by opening quarter) with an archived page at
 *      data/aggregator-archive/<source>/<showId>.(html|json), the recent
 *      quarters against that source's own trailing baseline.
 *   2. Workflow liveness: consecutive failures and not-run / not-succeeded in N
 *      days for every workflow that feeds the source.
 *
 * Why it exists: on 2026-10-24 The Stage had failed every weekly run since
 * August (coverage 59% -> 12% -> 0%), Stagedoor's cron had stopped in June,
 * and the paged cron-health check flagged none of it (those workflows are
 * liveness-only, and the generic failing-every-run row is urgency 'low').
 *
 * Pure functions only. scripts/audit-aggregator-health.js does the I/O.
 */

/**
 * Registry. `workflows` map to cadenceDays (expected days between runs).
 * `retired` sources carry the reason and are excluded from every check, but
 * retiredConsistency() fails if a retired source's workflow is still scheduled,
 * and if an active source's workflow has lost its schedule (a quiet removal).
 */
const SOURCES = Object.freeze([
  { id: 'thestage-roundups', label: 'The Stage roundups', market: 'west-end',
    workflows: { 'scrape-thestage-roundups.yml': 7, 'sweep-we-aggregators.yml': 7 } },
  { id: 'stagedoor', label: 'Stagedoor', market: 'west-end',
    workflows: { 'scrape-stagedoor.yml': 7 },
    retired: { on: '2026-06-25', reason: 'stagedoor.com shut down and 302-redirects to londontheatredirect.com; no critic pages exist to scrape' } },
  { id: 'lbo-roundups', label: 'London Box Office roundups', market: 'west-end',
    workflows: { 'scrape-new-aggregators.yml': 1 } },
  { id: 'bww-roundups', label: 'BroadwayWorld roundups (London)', market: 'west-end',
    workflows: { 'scrape-new-aggregators.yml': 1, 'scrape-bww-reviews.yml': 7 } },
  { id: 'westendtheatre', label: 'westendtheatre.com', market: 'west-end',
    workflows: { 'scrape-westendtheatre.yml': 7, 'sweep-we-aggregators.yml': 7 } },
  { id: 'nyc-theatre', label: 'NYC Theatre roundups', market: 'broadway', category: 'broadway',
    workflows: { 'scrape-new-aggregators.yml': 1 } },
  { id: 'playbill-verdict', label: 'Playbill Verdict', market: 'broadway', category: 'broadway',
    workflows: { 'scrape-new-aggregators.yml': 1 } },
]);

const DEFAULTS = Object.freeze({
  minShowsPerQuarter: 8,   // a quarter with fewer shows is too thin to judge
  graceDays: 14,           // shows younger than this have not had time to be archived
  recentQuarters: 2,
  baselineQuarters: 4,
  minBaselinePct: 25,      // a source that never covered much cannot "drop"
  dropPoints: 15,          // recent must be this far below baseline (percentage points)
  dropRatio: 0.7,          // and below baseline * this ratio
  failStreak: 3,
  idleMultiplier: 2,       // not run in cadence * this + idleSlackDays
  idleSlackDays: 2,
  staleSuccessMultiplier: 3,
});

function quarterOf(dateStr) {
  const m = /^(\d{4})-(\d{2})/.exec(dateStr || '');
  if (!m) return null;
  return `${m[1]}Q${Math.floor((Number(m[2]) - 1) / 3) + 1}`;
}

/**
 * @param {Array<{id,openingDate,market,status,provisional}>} shows
 * @param {Set<string>} archivedIds show ids that have an archived page
 * @returns {Array<{quarter,total,covered,pct}>} ascending by quarter
 */
function coverageSeries(shows, archivedIds, { market, category, now = new Date(), graceDays = DEFAULTS.graceDays } = {}) {
  const cutoff = new Date(now.getTime() - graceDays * 86400000).toISOString().slice(0, 10);
  const currentQ = quarterOf(now.toISOString()); // still filling in: never judged
  const byQ = new Map();
  for (const s of shows || []) {
    if (!s || !s.openingDate || s.provisional) continue;
    if (market && s.market !== market) continue;
    if (category && s.category !== category) continue;
    if (s.openingDate > cutoff) continue;
    const q = quarterOf(s.openingDate);
    if (!q || q === currentQ) continue;
    const row = byQ.get(q) || { quarter: q, total: 0, covered: 0 };
    row.total++;
    if (archivedIds.has(s.id)) row.covered++;
    byQ.set(q, row);
  }
  return [...byQ.values()]
    .sort((a, b) => a.quarter.localeCompare(b.quarter))
    .map(r => ({ ...r, pct: r.total ? Math.round((100 * r.covered) / r.total) : 0 }));
}

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Recent quarters against the source's own trailing baseline. Thin quarters
 * (< minShowsPerQuarter) are dropped first so a 3-show quarter cannot swing it.
 * @returns {{flagged:boolean, reason?:string, recent?:number, baseline?:number, recentQuarters?:string[], baselineQuarters?:string[]}}
 */
function coverageVerdict(series, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const usable = (series || []).filter(r => r.total >= o.minShowsPerQuarter);
  if (usable.length < o.recentQuarters + 1) return { flagged: false, reason: 'not enough history' };
  const recent = usable.slice(-o.recentQuarters);
  const baseline = usable.slice(-(o.recentQuarters + o.baselineQuarters), -o.recentQuarters);
  const recentPct = mean(recent.map(r => r.pct));
  const baselinePct = mean(baseline.map(r => r.pct));
  const base = {
    recent: Math.round(recentPct), baseline: Math.round(baselinePct),
    recentQuarters: recent.map(r => r.quarter), baselineQuarters: baseline.map(r => r.quarter),
  };
  if (baselinePct < o.minBaselinePct) return { flagged: false, reason: 'baseline too low to judge', ...base };
  const dropped = baselinePct - recentPct >= o.dropPoints && recentPct < baselinePct * o.dropRatio;
  const deadNow = recent[recent.length - 1].pct === 0;
  if (dropped || deadNow) return { flagged: true, ...base };
  return { flagged: false, ...base };
}

const toMs = r => Date.parse(r.created_at || r.createdAt);

/**
 * Liveness of one workflow from REST run objects ({created_at, conclusion, event}).
 * Manual dispatches are ignored when scheduled runs exist. Cancelled/skipped runs neither extend nor break a streak.
 * @returns {{status:'ok'|'failing'|'idle'|'stale-success'|'no-runs', ...}}
 */
function workflowVerdict(runs, { cadenceDays, now = new Date() } = {}, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const valid = (runs || []).filter(r => r && !Number.isNaN(toMs(r)));
  // A one-off dry-run dispatch must not hide a failing cron (or fake one), so judge the
  // cron's own runs. A workflow that only ever ran by hand keeps its manual runs.
  const unattended = valid.filter(r => r.event !== 'workflow_dispatch');
  const sorted = (unattended.length ? unattended : valid).sort((a, b) => toMs(b) - toMs(a));
  if (!sorted.length) return { status: 'no-runs' };
  const daysAgo = r => (now.getTime() - toMs(r)) / 86400000;
  const done = sorted.filter(r => r.conclusion && !['cancelled', 'skipped'].includes(r.conclusion));
  let streak = 0;
  while (streak < done.length && ['failure', 'timed_out', 'startup_failure'].includes(done[streak].conclusion)) streak++;
  const lastSuccess = done.find(r => r.conclusion === 'success');
  const out = {
    streak,
    daysSinceLastRun: Math.floor(daysAgo(sorted[0])),
    lastSuccessAt: lastSuccess ? (lastSuccess.created_at || lastSuccess.createdAt) : null,
    daysSinceSuccess: lastSuccess ? Math.floor(daysAgo(lastSuccess)) : null,
  };
  if (streak >= o.failStreak) return { status: 'failing', ...out };
  const idleAfter = cadenceDays * o.idleMultiplier + o.idleSlackDays;
  if (out.daysSinceLastRun > idleAfter) return { status: 'idle', idleAfterDays: idleAfter, ...out };
  const staleAfter = cadenceDays * o.staleSuccessMultiplier + o.idleSlackDays;
  if (out.daysSinceSuccess === null ? done.length >= o.failStreak : out.daysSinceSuccess > staleAfter) {
    return { status: 'stale-success', staleAfterDays: staleAfter, ...out };
  }
  return { status: 'ok', ...out };
}

/**
 * Registry vs workflow files. `scheduled` maps workflow file -> boolean
 * (has an active `schedule:` trigger); a missing key means the file is gone.
 * Catches the quiet removal: cron commented out, registry never told.
 */
function retiredConsistency(sources, scheduled) {
  const findings = [];
  for (const s of sources) {
    for (const wf of Object.keys(s.workflows)) {
      if (!(wf in scheduled)) {
        if (s.retired) continue; // deleting a retired source's workflow is the right cleanup
        findings.push({ source: s.id, kind: 'workflow-missing', workflow: wf, message: `${s.label}: workflow ${wf} does not exist` });
      } else if (s.retired && scheduled[wf]) {
        findings.push({ source: s.id, kind: 'retired-but-scheduled', workflow: wf, message: `${s.label} is marked retired (${s.retired.reason}) but ${wf} still has a schedule` });
      } else if (!s.retired && !scheduled[wf]) {
        findings.push({ source: s.id, kind: 'schedule-removed', workflow: wf, message: `${s.label}: ${wf} has no active schedule but the source is not marked retired. Restore the cron or retire the source in scripts/lib/aggregator-health.js with a reason` });
      }
    }
  }
  return findings;
}

/**
 * Assemble findings. Inputs are already-gathered data so this stays pure.
 * @param {object} p
 * @param {Array} p.sources registry entries
 * @param {Array} p.shows shows.json rows
 * @param {Object<string,Set<string>>|null} p.archives source id -> archived show ids (null: no archive available)
 * @param {Object<string,Array>|null} p.runs workflow file -> REST runs (null: run history unavailable)
 * @param {Object<string,boolean>} p.scheduled workflow file -> has active schedule
 */
function assess({ sources = SOURCES, shows, archives, runs, scheduled, now = new Date(), opts = {} }) {
  const findings = [];
  const report = [];
  const seenWf = new Set(); // a workflow shared by several sources is reported once
  findings.push(...retiredConsistency(sources, scheduled || {}));
  for (const s of sources) {
    if (s.retired) { report.push({ source: s.id, retired: s.retired }); continue; }
    const entry = { source: s.id, label: s.label };
    if (archives && archives[s.id]) {
      const series = coverageSeries(shows, archives[s.id], { market: s.market, category: s.category, now, graceDays: opts.graceDays });
      const v = coverageVerdict(series, opts);
      entry.coverage = { series: series.slice(-6), ...v };
      if (v.flagged) {
        findings.push({ source: s.id, kind: 'coverage-drop',
          message: `${s.label}: archive coverage ${v.recent}% in ${v.recentQuarters.join('+')} vs ${v.baseline}% baseline (${v.baselineQuarters.join('+')})` });
      }
    }
    if (runs) {
      entry.workflows = {};
      for (const [wf, cadenceDays] of Object.entries(s.workflows)) {
        if (!runs[wf]) continue;
        const v = workflowVerdict(runs[wf], { cadenceDays, now }, opts);
        entry.workflows[wf] = v;
        if (seenWf.has(wf)) continue;
        seenWf.add(wf);
        if (v.status === 'failing') {
          findings.push({ source: s.id, kind: 'workflow-failing', workflow: wf,
            message: `${s.label}: ${wf} failed its last ${v.streak} runs in a row (last success ${v.lastSuccessAt ? v.lastSuccessAt.slice(0, 10) : 'none in window'})` });
        } else if (v.status === 'idle') {
          findings.push({ source: s.id, kind: 'workflow-idle', workflow: wf,
            message: `${s.label}: ${wf} has not run in ${v.daysSinceLastRun} days (expected every ${cadenceDays})` });
        } else if (v.status === 'stale-success') {
          findings.push({ source: s.id, kind: 'workflow-stale', workflow: wf,
            message: `${s.label}: ${wf} last succeeded ${v.daysSinceSuccess === null ? 'never (in window)' : `${v.daysSinceSuccess} days ago`}` });
        }
      }
    }
    report.push(entry);
  }
  return { findings, report };
}

module.exports = {
  SOURCES, DEFAULTS, quarterOf, coverageSeries, coverageVerdict, workflowVerdict,
  retiredConsistency, assess,
};
