'use strict';
/**
 * ci-green-rate-core.js — pure logic behind scripts/ci-green-rate.js.
 *
 * WHY THIS EXISTS. Roughly 45 sessions have each claimed to have fixed "main
 * is always red" after seeing a handful of green runs. The owner has zero
 * trust in such claims, and correctly so: "the last few runs were green" is a
 * sample of convenience, not a measurement. This module turns the question
 * into a machine verdict over a fixed window — PASS or FAIL — and the CLI
 * that wraps it is the ONLY thing that may ever say the state of main.
 * Nothing here says "fixed"; the vocabulary is PASS/FAIL.
 *
 * No fs, no process, no network. The CLI does the one-shot `gh api` fetch and
 * hands the rows here. Tested by scripts/lib/ci-green-rate-core.test.mjs,
 * which require()s these functions (CLAUDE.md rule 15).
 *
 * DEFINITIONS (all over COMPLETED `push` runs of the workflow on main):
 *   green      conclusion === 'success'
 *   red        conclusion in {failure, timed_out, startup_failure} — a completed
 *              run that did not pass. timed_out is red on purpose: a suite
 *              that never finished validating did not validate main.
 *   cancelled  conclusion === 'cancelled' — excluded from the rate. Cancels
 *              say nothing about the code (scripts/ci-health-check.sh measures
 *              the mid-setup-cancel rate separately).
 *   other      anything else (skipped, neutral, action_required, stale, null)
 *              — counted, excluded from the rate.
 *   rate       green / (green + red), as a percentage. NO DATA IS NEVER A PASS:
 *              zero green+red runs in the window is a FAIL with a reason.
 *   streaks    computed over the chronological sequence of green/red runs
 *              only (cancelled/other are transparent to streaks).
 *   red→green latency  for each red EPISODE (a maximal run of consecutive red
 *              runs), the time from the episode's FIRST red run to the next
 *              green run — i.e. how long main stayed red before it drained.
 *              Median over all closed episodes; null when no episode has
 *              closed (no red→green transition in the window).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = Object.freeze({
  days: 7,
  min: 80,
  workflow: 'test.yml',
  branch: 'main',
  event: 'push',
  perPage: 100,
  maxPages: 10,
});

const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);

/**
 * @param {string|null|undefined} conclusion
 * @returns {'green'|'red'|'cancelled'|'other'}
 */
function classifyConclusion(conclusion) {
  if (conclusion === 'success') return 'green';
  if (RED_CONCLUSIONS.has(conclusion)) return 'red';
  if (conclusion === 'cancelled') return 'cancelled';
  return 'other';
}

/**
 * Accepts raw Actions REST rows ({id, created_at, conclusion, status}) OR the
 * repo's gh-runs-query.sh / ghRunsQuery() shape ({databaseId, createdAt,
 * conclusion, status}). Drops non-completed runs and rows whose createdAt
 * cannot be parsed (a run with no place on the timeline cannot be in a
 * streak). Returns a NEW array sorted oldest-first.
 *
 * @param {Array<object>} rows
 * @returns {Array<{id:string|number|null, conclusion:string|null, createdAt:string, t:number, color:string}>}
 */
function normalizeRuns(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue;
    if (r.status && r.status !== 'completed') continue;
    const created = r.createdAt ?? r.created_at ?? null;
    const t = Date.parse(created);
    if (!Number.isFinite(t)) continue;
    const conclusion = r.conclusion ?? null;
    out.push({
      id: r.databaseId ?? r.id ?? null,
      conclusion,
      createdAt: new Date(t).toISOString(),
      t,
      color: classifyConclusion(conclusion),
    });
  }
  out.sort((a, b) => a.t - b.t || String(a.id).localeCompare(String(b.id)));
  return out;
}

/**
 * ISO date (YYYY-MM-DD) to hand the REST `created=>=` filter. One extra day of
 * margin on purpose: the endpoint's date filter is day-granular, and the exact
 * millisecond cutoff is applied client-side by computeGreenRate().
 */
function windowStartDate(days, now = Date.now()) {
  return new Date(now - (days + 1) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Actions REST path for one page of runs. `created=>=DATE` is percent-encoded
 * here (gh-runs-query.sh documents that values are NOT encoded by the helper).
 */
function buildRunsApiPath({ repo = '{owner}/{repo}', workflow = DEFAULTS.workflow, branch = DEFAULTS.branch, event = DEFAULTS.event, perPage = DEFAULTS.perPage, page = 1, sinceDate }) {
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
    throw new Error(`perPage must be an integer 1-100 (REST per_page cap), got ${perPage}`);
  }
  const q = [`per_page=${perPage}`, `page=${page}`, `branch=${branch}`, `event=${event}`, 'status=completed'];
  if (sinceDate) q.push(`created=%3E%3D${sinceDate}`);
  return `repos/${repo}/actions/workflows/${workflow}/runs?${q.join('&')}`;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The measurement. Pure.
 *
 * @param {Array<object>} rows - raw or normalized runs (see normalizeRuns)
 * @param {{days?:number, min?:number, now?:number, workflow?:string, branch?:string}} [opts]
 * @returns {object} result — see the fields below; verdict is 'PASS'|'FAIL'
 */
function computeGreenRate(rows, opts = {}) {
  const days = Number.isFinite(opts.days) && opts.days > 0 ? opts.days : DEFAULTS.days;
  const min = Number.isFinite(opts.min) ? opts.min : DEFAULTS.min;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const sinceMs = now - days * DAY_MS;

  const runs = normalizeRuns(rows).filter((r) => r.t >= sinceMs && r.t <= now);

  const counts = { total: runs.length, green: 0, red: 0, cancelled: 0, other: 0 };
  const perDayMap = new Map();
  for (const r of runs) {
    counts[r.color]++;
    const day = r.createdAt.slice(0, 10);
    if (!perDayMap.has(day)) perDayMap.set(day, { date: day, total: 0, green: 0, red: 0, cancelled: 0, other: 0 });
    const d = perDayMap.get(day);
    d.total++;
    d[r.color]++;
  }
  const perDay = [...perDayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  // Streaks + latency over the green/red sequence only.
  const colored = runs.filter((r) => r.color === 'green' || r.color === 'red');
  let longestGreen = 0;
  let longestRed = 0;
  let cur = null; // { color, length }
  let episodeStart = null; // t of the first red in the open red episode
  const latenciesMs = [];
  let redEpisodes = 0;
  for (const r of colored) {
    if (cur && cur.color === r.color) cur.length++;
    else cur = { color: r.color, length: 1 };
    if (r.color === 'green') longestGreen = Math.max(longestGreen, cur.length);
    else longestRed = Math.max(longestRed, cur.length);

    if (r.color === 'red') {
      if (episodeStart === null) { episodeStart = r.t; redEpisodes++; }
    } else if (episodeStart !== null) {
      latenciesMs.push(r.t - episodeStart);
      episodeStart = null;
    }
  }
  const openRedEpisodeMin = episodeStart === null ? null : Math.round((now - episodeStart) / 60000);
  const medMs = median(latenciesMs);

  const scored = counts.green + counts.red;
  const rate = scored ? Math.round((counts.green / scored) * 1000) / 10 : null;
  let verdict;
  let reason = null;
  if (scored === 0) {
    verdict = 'FAIL';
    reason = `no completed green/red ${DEFAULTS.event} runs in the last ${days}d — no data is never a PASS`;
  } else {
    // Integer comparison, so an exact-threshold sample (4 green / 1 red at
    // min 80) is PASS without float rounding deciding it.
    verdict = counts.green * 100 >= min * scored ? 'PASS' : 'FAIL';
  }

  return {
    workflow: opts.workflow || DEFAULTS.workflow,
    branch: opts.branch || DEFAULTS.branch,
    event: DEFAULTS.event,
    days,
    min,
    windowStart: new Date(sinceMs).toISOString(),
    windowEnd: new Date(now).toISOString(),
    counts,
    rate,
    longestGreenStreak: longestGreen,
    longestRedStreak: longestRed,
    currentStreak: cur ? { color: cur.color, length: cur.length } : null,
    redEpisodes,
    redToGreenMedianMin: medMs === null ? null : Math.round(medMs / 6000) / 10,
    redToGreenSamples: latenciesMs.length,
    openRedEpisodeMin,
    perDay,
    verdict,
    reason,
  };
}

/**
 * The one line other tools grep for. Format is fixed:
 *   CI-GREEN-RATE: <rate>% over <N>d (green G / red R), min <M>% → PASS|FAIL
 * A no-data FAIL appends its reason in parentheses; nothing else varies.
 */
function verdictLine(res) {
  const rate = res.rate === null ? 'n/a' : `${res.rate}%`;
  const base = `CI-GREEN-RATE: ${rate} over ${res.days}d (green ${res.counts.green} / red ${res.counts.red}), min ${res.min}% → ${res.verdict}`;
  return res.reason ? `${base} (${res.reason})` : base;
}

function formatReport(res) {
  const cur = res.currentStreak ? `${res.currentStreak.color} x${res.currentStreak.length}` : 'none';
  const lat = res.redToGreenMedianMin === null
    ? 'n/a (no red→green transition in window)'
    : `${res.redToGreenMedianMin} min (${res.redToGreenSamples} sample${res.redToGreenSamples === 1 ? '' : 's'})`;
  const lines = [
    `CI green rate — ${res.workflow} on ${res.branch}, ${res.event} runs, last ${res.days}d (${res.windowStart.slice(0, 16)}Z → ${res.windowEnd.slice(0, 16)}Z)`,
    `  completed ${res.counts.total} | green ${res.counts.green} | red ${res.counts.red} | cancelled ${res.counts.cancelled} | other ${res.counts.other}`,
    `  longest green streak ${res.longestGreenStreak} | longest red streak ${res.longestRedStreak} | current streak: ${cur}`,
    `  red episodes ${res.redEpisodes} | red→green latency median: ${lat}${res.openRedEpisodeMin === null ? '' : ` | open red episode: ${res.openRedEpisodeMin} min and counting`}`,
  ];
  if (res.perDay.length) {
    lines.push('  date        total green red  canc other');
    for (const d of res.perDay) {
      lines.push(`  ${d.date}  ${String(d.total).padStart(5)} ${String(d.green).padStart(5)} ${String(d.red).padStart(4)} ${String(d.cancelled).padStart(5)} ${String(d.other).padStart(5)}`);
    }
  } else {
    lines.push('  (no completed runs in window)');
  }
  lines.push(verdictLine(res));
  return lines.join('\n');
}

/**
 * CLI argv → options. Accepts `--days 7` and `--days=7`. Returns {error} on a
 * bad value rather than throwing so the CLI can print usage and exit 2.
 */
function parseCliArgs(argv) {
  const o = { days: DEFAULTS.days, min: DEFAULTS.min, json: false, help: false, workflow: DEFAULTS.workflow, branch: DEFAULTS.branch, maxPages: DEFAULTS.maxPages };
  const args = [...argv];
  const takeValue = (i, name) => {
    const a = args[i];
    if (a.includes('=')) return { v: a.slice(a.indexOf('=') + 1), skip: 0 };
    if (i + 1 < args.length) return { v: args[i + 1], skip: 1 };
    return { v: undefined, skip: 0, err: `${name} needs a value` };
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const key = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if (key === '--json') { o.json = true; continue; }
    if (key === '--help' || key === '-h') { o.help = true; continue; }
    if (key === '--days' || key === '--min' || key === '--max-pages' || key === '--workflow' || key === '--branch') {
      const { v, skip, err } = takeValue(i, key);
      if (err) return { error: err };
      i += skip;
      if (key === '--workflow') { o.workflow = String(v); continue; }
      if (key === '--branch') { o.branch = String(v); continue; }
      const n = Number(v);
      if (!Number.isInteger(n) || n < (key === '--min' ? 0 : 1) || (key === '--min' && n > 100) || (key === '--days' && n > 365)) {
        return { error: `${key} must be an integer${key === '--min' ? ' 0-100' : key === '--days' ? ' 1-365' : ' >= 1'}, got '${v}'` };
      }
      if (key === '--days') o.days = n;
      else if (key === '--min') o.min = n;
      else o.maxPages = n;
      continue;
    }
    return { error: `unknown argument: ${a}` };
  }
  return o;
}

module.exports = {
  DEFAULTS,
  DAY_MS,
  classifyConclusion,
  normalizeRuns,
  windowStartDate,
  buildRunsApiPath,
  computeGreenRate,
  verdictLine,
  formatReport,
  parseCliArgs,
};
