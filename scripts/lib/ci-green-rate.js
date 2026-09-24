'use strict';
/**
 * ci-green-rate.js — pure logic behind scripts/ci-green-rate.js (the CLI) and
 * health-check.js's "Main: green rate" row.
 *
 * WHY THIS EXISTS. Roughly 45 sessions have each claimed to have fixed "main
 * is always red" after seeing a handful of green runs. The owner has zero
 * trust in such claims, and correctly so: "the last few runs were green" is a
 * sample of convenience, not a measurement. This module turns the question
 * into a machine verdict over a fixed window — PASS or FAIL, always WITH the
 * numbers — and the CLI that wraps it is the ONLY thing that may ever say the
 * state of main. Nothing here says "fixed"; the vocabulary is PASS/FAIL.
 *
 * Sibling of scripts/lib/main-red-streak.js: that one asks "how long has main
 * been red right now" (alarm-shaped); this one asks "what fraction of the
 * last N days' push runs were green" (measurement-shaped). Both take the same
 * runs array shape ({headSha, createdAt, conclusion, status?}, either order).
 *
 * No fs, no process, no network. The CLI does the one-shot `gh api` fetch,
 * reads the nightly ledger, and hands both here. Tested by
 * scripts/lib/ci-green-rate.test.mjs, which require()s these functions
 * (CLAUDE.md rule 15).
 *
 * DEFINITIONS (all over COMPLETED `push` runs of the workflow on main —
 * pull_request / workflow_dispatch / schedule runs are excluded at the query):
 *   rerun      several runs for the same head_sha (a re-run, a re-push of the
 *              same commit) collapse to ONE — the latest attempt wins. A sha
 *              that was red then re-run green is green; one that was green
 *              then re-run red is red.
 *   green      conclusion === 'success'
 *   red        conclusion in {failure, timed_out, startup_failure} — a completed
 *              run that did not pass. timed_out is red on purpose: a suite
 *              that never finished validating did not validate main. NOTE:
 *              this is STRICTER than test.yml's "Detect consecutive main
 *              test failures" step and scripts/lib/main-red-streak.js, which
 *              count only `failure` — so this rate can read lower than the
 *              streak detectors on a day with timeouts. Deliberate: a rate
 *              meant to end "it's fixed" claims must not launder timeouts.
 *   hung       conclusion === 'cancelled' AND the run lasted >= HUNG_CANCEL_MIN
 *              minutes → RED. On main a cancel is never a supersede (test.yml's
 *              concurrency group is per-sha with cancel-in-progress off since
 *              2026-07-12), so a long cancel is a job hitting timeout-minutes,
 *              which Actions reports as `cancelled`, not `timed_out`. Counting
 *              it neutral hid a hung fixture for 36 h (2026-09-23..24: 27 runs
 *              cancelled at ~20 min, rate + streak frozen, no alert).
 *              Reported separately as res.hungCancelled. Duration is
 *              run_started_at → updated_at. Applied ONLY to test.yml on main
 *              (the per-sha group); other --workflow/--branch readings keep
 *              every cancel neutral, since there a late supersede is normal.
 *   cancelled  conclusion === 'cancelled' and shorter than that — NOT green, excluded from the
 *              denominator, but counted and reported. Cancels say nothing
 *              about the code (scripts/ci-health-check.sh measures the mid-
 *              setup-cancel rate separately) — BUT a cancel STORM (more
 *              cancelled than scored runs) makes the rate non-authoritative
 *              and is a FAIL in its own right, so 1 green + 99 cancelled can
 *              never read as "100% PASS" (Codex review finding).
 *   other      anything else (skipped, neutral, action_required, stale, null)
 *              — counted, excluded from the rate.
 *   rate       green / (green + red), as a percentage.
 *   PASS       requires ALL of: >= MIN_SCORED_RUNS scored runs (a 2-run
 *              "100%" is not a measurement), no cancel storm, a complete
 *              window (a page-cap-truncated fetch is FAIL, never PASS), and
 *              rate >= min. NO DATA IS NEVER A PASS.
 *   streaks    computed over the chronological sequence of green/red runs
 *              only (cancelled/other are transparent to streaks).
 *   red→green latency  for each red EPISODE (a maximal run of consecutive red
 *              runs), the time from the episode's FIRST red run to the next
 *              green run — i.e. how long main stayed red before it drained.
 *              Median over all closed episodes; null when no episode has
 *              closed (no red→green transition in the window).
 *   trend      from the nightly ledger (data/audit/ci-green-rate.jsonl, one
 *              row per health-check run): "7d trend from Y%" is the latest
 *              reading at least `days` days old; "day D of 14 at ≥M%" is the
 *              count of consecutive calendar days (UTC, ending today) whose
 *              latest reading was a PASS — 0 whenever today is not.
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
  streakTargetDays: 14,
});

// Fewer scored runs than this is "not enough data", not a rate. main sees
// ~40 push runs/day, so a 7-day window that can't clear this is itself a
// signal (nobody pushed, or every run was cancelled/other).
const MIN_SCORED_RUNS = 10;

const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);

// A cancelled run that lasted at least this long hit a job timeout (hung) —
// see "hung" in the header. A mid-setup cancel lasts a minute or two.
const HUNG_CANCEL_MIN = 15;

/**
 * @param {string|null|undefined} conclusion
 * @param {number|null} [durationMs]  createdAt → updatedAt, when known
 * @returns {'green'|'red'|'cancelled'|'other'}
 */
function classifyConclusion(conclusion, durationMs = null) {
  if (conclusion === 'success') return 'green';
  if (RED_CONCLUSIONS.has(conclusion)) return 'red';
  if (conclusion === 'cancelled') {
    return Number.isFinite(durationMs) && durationMs >= HUNG_CANCEL_MIN * 60000 ? 'red' : 'cancelled';
  }
  return 'other';
}

/**
 * Accepts raw Actions REST rows ({id, head_sha, created_at, conclusion,
 * status}) OR the repo's gh-runs-query.sh / ghRunsQuery() / assessMainRedStreak
 * shape ({databaseId?, headSha, createdAt, conclusion, status?}), in any
 * order. Drops non-completed runs and rows whose createdAt cannot be parsed
 * (a run with no place on the timeline cannot be in a streak).
 *
 * De-duplicates by run id — pagination is not a snapshot, and a run
 * completing between two page requests shifts the boundary so the same row
 * can arrive twice (Codex review finding) — then collapses reruns by
 * head_sha (latest createdAt wins; ties by higher id). Rows without a sha
 * are kept as-is. Returns a NEW array sorted oldest-first, plus the number
 * of rows the sha collapse removed.
 *
 * @param {Array<object>} rows
 * @param {{hungRule?: boolean}} [o]  count long cancels as red — only valid
 *   where a cancel can't be a supersede (test.yml on main; see "hung" above)
 * @returns {{runs: Array<{id, headSha, conclusion, createdAt, t, color, hung}>, rerunsCollapsed: number}}
 */
function normalizeRunsDetailed(rows, { hungRule = false } = {}) {
  const out = [];
  const seenIds = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue;
    if (r.status && r.status !== 'completed') continue;
    const created = r.createdAt ?? r.created_at ?? null;
    const t = Date.parse(created);
    if (!Number.isFinite(t)) continue;
    const id = r.databaseId ?? r.id ?? null;
    if (id !== null) {
      const key = String(id);
      if (seenIds.has(key)) continue;
      seenIds.add(key);
    }
    const conclusion = r.conclusion ?? null;
    const headSha = r.headSha ?? r.head_sha ?? null;
    // Duration from the attempt's START (run_started_at, not created_at) so
    // runner-queue time and a days-later re-run attempt don't read as a hang.
    const tStart = Date.parse(r.runStartedAt ?? r.run_started_at ?? null);
    const tEnd = Date.parse(r.updatedAt ?? r.updated_at ?? null);
    const durationMs = hungRule && Number.isFinite(tStart) && Number.isFinite(tEnd) ? tEnd - tStart : null;
    const color = classifyConclusion(conclusion, durationMs);
    const hung = conclusion === 'cancelled' && color === 'red';
    out.push({ id, headSha, conclusion, createdAt: new Date(t).toISOString(), t, color, hung });
  }
  out.sort((a, b) => a.t - b.t || String(a.id).localeCompare(String(b.id)));

  // Latest attempt per sha wins: walking oldest-first, a later row for the
  // same sha replaces the earlier one.
  const bySha = new Map();
  const keep = [];
  let rerunsCollapsed = 0;
  for (const r of out) {
    if (!r.headSha) { keep.push(r); continue; }
    if (bySha.has(r.headSha)) {
      rerunsCollapsed++;
      const prevIdx = bySha.get(r.headSha);
      keep[prevIdx] = null;
    }
    bySha.set(r.headSha, keep.length);
    keep.push(r);
  }
  return { runs: keep.filter(Boolean), rerunsCollapsed };
}

/** Convenience: just the runs. */
function normalizeRuns(rows) {
  return normalizeRunsDetailed(rows).runs;
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
 * `owner/repo` from a git remote URL (ssh or https, with or without .git),
 * or null. The CLI resolves the repo from `origin` and passes it EXPLICITLY
 * rather than trusting gh's `{owner}/{repo}` placeholder, which a stray
 * GH_REPO in the environment silently redirects to another repository
 * (scripts/lib/gh-runs-query.sh documents this; Codex review finding).
 */
function parseRepoFromRemote(url) {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?\s*$/.exec(String(url || ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Actions REST path for one page of runs. `created=>=DATE` is percent-encoded
 * here (gh-runs-query.sh documents that values are NOT encoded by the helper).
 * event=push + branch=main + status=completed are fixed at the query so
 * pull_request / workflow_dispatch / schedule runs never enter the sample.
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

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Trend from the nightly ledger. Pure.
 *
 * @param {Array<{ts:string, rate:number|null, verdict:string}>} ledgerRows - one row per recorded reading (any order)
 * @param {{now:number, current:{rate:number|null, verdict:string}, days?:number, target?:number}} o
 * @returns {{fromRate:number|null, fromDate:string|null, streakDays:number, target:number}}
 */
function assessTrend(ledgerRows, { now, current, days = DEFAULTS.days, target = DEFAULTS.streakTargetDays }) {
  // Latest reading per UTC day; today's is always the CURRENT reading so a
  // stale row from an earlier run today never outranks what was just measured.
  const byDay = new Map();
  for (const row of Array.isArray(ledgerRows) ? ledgerRows : []) {
    if (!row || typeof row !== 'object') continue;
    const t = Date.parse(row.ts);
    if (!Number.isFinite(t) || t > now) continue;
    const day = utcDay(t);
    const prev = byDay.get(day);
    if (!prev || t >= prev.t) byDay.set(day, { t, rate: Number.isFinite(row.rate) ? row.rate : null, pass: row.verdict === 'PASS' });
  }
  const today = utcDay(now);
  byDay.set(today, { t: now, rate: current.rate, pass: current.verdict === 'PASS' });

  // "7d trend from Y%": the latest reading at least `days` days old.
  const cutoff = now - days * DAY_MS;
  let from = null;
  for (const [day, r] of byDay) {
    if (r.t <= cutoff && (!from || r.t > from.t)) from = { ...r, day };
  }

  // "day D of 14": consecutive calendar days ending today whose reading passed.
  let streakDays = 0;
  for (let d = now; ; d -= DAY_MS) {
    const r = byDay.get(utcDay(d));
    if (!r || !r.pass) break;
    streakDays++;
  }
  return { fromRate: from ? from.rate : null, fromDate: from ? from.day : null, streakDays, target };
}

/**
 * The measurement. Pure.
 *
 * @param {Array<object>} rows - raw or normalized runs (see normalizeRunsDetailed)
 * @param {{days?:number, min?:number, now?:number, workflow?:string, branch?:string, repo?:string, truncated?:boolean, ledgerRows?:Array<object>}} [opts]
 * @returns {object} result — see the fields below; verdict is 'PASS'|'FAIL'
 */
function computeGreenRate(rows, opts = {}) {
  const days = Number.isFinite(opts.days) && opts.days > 0 ? opts.days : DEFAULTS.days;
  const min = Number.isFinite(opts.min) ? opts.min : DEFAULTS.min;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const truncated = !!opts.truncated;
  const sinceMs = now - days * DAY_MS;

  const hungRule = (opts.workflow || DEFAULTS.workflow) === DEFAULTS.workflow && (opts.branch || DEFAULTS.branch) === DEFAULTS.branch;
  const normalized = normalizeRunsDetailed(rows, { hungRule });
  const runs = normalized.runs.filter((r) => r.t >= sinceMs && r.t <= now);

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

  // Verdict. Every guard below is a FAIL reason that cannot be argued around
  // by choosing a convenient window; the rate comparison comes LAST.
  let verdict = 'FAIL';
  let reason = null;
  if (scored === 0) {
    reason = `no completed green/red ${DEFAULTS.event} runs in the last ${days}d — no data is never a PASS`;
  } else if (scored < MIN_SCORED_RUNS) {
    reason = `only ${scored} scored run${scored === 1 ? '' : 's'} in the last ${days}d, floor is ${MIN_SCORED_RUNS} — not enough data for a PASS`;
  } else if (counts.cancelled > scored) {
    reason = `cancel storm: ${counts.cancelled} cancelled vs ${scored} scored — rate not authoritative (see scripts/ci-health-check.sh)`;
  } else if (truncated) {
    reason = 'window incomplete: page cap hit — an incomplete window is never a PASS';
  } else if (counts.green * 100 >= min * scored) {
    // Integer comparison, so an exact-threshold sample (8 green / 2 red at
    // min 80) is PASS without float rounding deciding it.
    verdict = 'PASS';
  }

  const trend = assessTrend(opts.ledgerRows || [], { now, current: { rate, verdict }, days });

  return {
    repo: opts.repo || null,
    workflow: opts.workflow || DEFAULTS.workflow,
    branch: opts.branch || DEFAULTS.branch,
    event: DEFAULTS.event,
    days,
    min,
    minScoredRuns: MIN_SCORED_RUNS,
    windowStart: new Date(sinceMs).toISOString(),
    windowEnd: new Date(now).toISOString(),
    truncated,
    rerunsCollapsed: normalized.rerunsCollapsed,
    counts,
    hungCancelled: runs.filter((r) => r.hung).length,
    rate,
    longestGreenStreak: longestGreen,
    longestRedStreak: longestRed,
    currentStreak: cur ? { color: cur.color, length: cur.length } : null,
    redEpisodes,
    redToGreenMedianMin: medMs === null ? null : Math.round(medMs / 6000) / 10,
    redToGreenSamples: latenciesMs.length,
    openRedEpisodeMin,
    perDay,
    trend,
    verdict,
    reason,
  };
}

/** The row `--record` appends to data/audit/ci-green-rate.jsonl. */
function ledgerRow(res) {
  return {
    ts: res.windowEnd,
    days: res.days,
    min: res.min,
    rate: res.rate,
    green: res.counts.green,
    red: res.counts.red,
    cancelled: res.counts.cancelled,
    total: res.counts.total,
    verdict: res.verdict,
  };
}

/**
 * The one line other tools grep for — never a bare PASS/FAIL, always with the
 * numbers and the trend. Format is fixed:
 *   CI-GREEN-RATE: rate X% (green G / red R, N runs[, C cancelled]),
 *     7d trend from Y%, day D of 14 at ≥M% → PASS|FAIL [(reason)]
 * A FAIL forced by a guard (no data, sample floor, cancel storm, truncated
 * window) appends its reason in parentheses; nothing else varies.
 */
function verdictLine(res) {
  const pct = (v) => (v === null || v === undefined ? 'n/a' : `${v}%`);
  const c = res.counts;
  const runs = `green ${c.green} / red ${c.red}, ${c.total} run${c.total === 1 ? '' : 's'}${c.cancelled ? `, ${c.cancelled} cancelled` : ''}${res.hungCancelled ? `, ${res.hungCancelled} hung (cancelled >= ${HUNG_CANCEL_MIN} min, counted red)` : ''}`;
  const tr = res.trend || { fromRate: null, streakDays: 0, target: DEFAULTS.streakTargetDays };
  const base = `CI-GREEN-RATE: rate ${pct(res.rate)} (${runs}), ${res.days}d trend from ${pct(tr.fromRate)}, day ${tr.streakDays} of ${tr.target} at ≥${res.min}% → ${res.verdict}`;
  return res.reason ? `${base} (${res.reason})` : base;
}

function formatReport(res) {
  const cur = res.currentStreak ? `${res.currentStreak.color} x${res.currentStreak.length}` : 'none';
  const lat = res.redToGreenMedianMin === null
    ? 'n/a (no red→green transition in window)'
    : `${res.redToGreenMedianMin} min (${res.redToGreenSamples} sample${res.redToGreenSamples === 1 ? '' : 's'})`;
  const lines = [
    `CI green rate — ${res.repo ? `${res.repo} ` : ''}${res.workflow} on ${res.branch}, ${res.event} runs, last ${res.days}d (${res.windowStart.slice(0, 16)}Z → ${res.windowEnd.slice(0, 16)}Z)${res.truncated ? ' [TRUNCATED: page cap hit]' : ''}`,
    `  completed ${res.counts.total} | green ${res.counts.green} | red ${res.counts.red} | cancelled ${res.counts.cancelled} | other ${res.counts.other} | reruns collapsed ${res.rerunsCollapsed || 0}`,
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
  const o = { days: DEFAULTS.days, min: DEFAULTS.min, json: false, record: false, help: false, workflow: DEFAULTS.workflow, branch: DEFAULTS.branch, maxPages: DEFAULTS.maxPages };
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
    if (key === '--record') { o.record = true; continue; }
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

/**
 * health-check.js row for a CLI --json result. 'pass' on PASS, 'warn' on FAIL
 * (the actionable alarm — "main has been red for Nh, first red commit X" —
 * is checkMainRedStreak's job and already routes an alert; this row is the
 * measurement, so it must never be a second alert on the same incident).
 */
function healthRow(res, name = 'Main: green rate') {
  return {
    name,
    status: res && res.verdict === 'PASS' ? 'pass' : 'warn',
    message: res ? verdictLine(res).replace(/^CI-GREEN-RATE: /, '') : 'no result',
  };
}

module.exports = {
  DEFAULTS,
  DAY_MS,
  MIN_SCORED_RUNS,
  HUNG_CANCEL_MIN,
  classifyConclusion,
  normalizeRuns,
  normalizeRunsDetailed,
  windowStartDate,
  parseRepoFromRemote,
  buildRunsApiPath,
  assessTrend,
  computeGreenRate,
  ledgerRow,
  verdictLine,
  formatReport,
  healthRow,
  parseCliArgs,
};
