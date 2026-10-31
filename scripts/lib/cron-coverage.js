'use strict';

/**
 * Pure helpers for the scheduled-workflow coverage gate in
 * audit-cron-health-coverage.js.
 *
 * Every scheduled (cron) workflow must be EITHER monitored in check-cron-health.yml's
 * CRITICAL_CRONS (real-time paging) OR listed in .cron-health-exempt.txt (digest-only /
 * low-stakes). A scheduled workflow in NEITHER has zero monitoring and can die silently —
 * the gap that hid process-feedback.yml being disabled for 15 days (2026-06-11..26).
 */

// Does a workflow YAML body declare a scheduled (cron) trigger?
// Strips comment-only lines first so a commented `# - cron: ...` under a live `schedule:`
// key isn't mistaken for a trigger. Matches a list-item cron with ANY value (quoted OR
// unquoted) — an unquoted-but-valid cron (`cron: 30 5 1,15 * *`) must NOT evade the gate.
function isScheduledWorkflow(yamlText) {
  if (!yamlText) return false;
  const body = String(yamlText)
    .split('\n')
    .filter(line => !line.trim().startsWith('#'))
    .join('\n');
  return /^\s*schedule:/m.test(body) && /-\s*cron:\s*\S/.test(body);
}

// Parse a .cron-health-exempt.txt body into a Set of workflow filenames.
// One filename per line; `#` comments (whole-line or inline `file.yml  # why`) and blank
// lines ignored. Inline reasons were rare until BRO-4941 gave every entry one; reading
// the reason as part of the filename made every such entry look unlisted.
function parseExemptList(text) {
  const out = new Set();
  for (const raw of (text || '').split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (line) out.add(line);
  }
  return out;
}

/**
 * Scheduled workflows covered by neither CRITICAL_CRONS nor the exempt list.
 * @param {string[]} scheduled - filenames of workflows with a cron trigger
 * @param {Set<string>} covered - filenames present in CRITICAL_CRONS
 * @param {Set<string>} exempt  - filenames present in the exempt list
 * @returns {string[]} sorted uncovered filenames
 */
function findUncoveredScheduled(scheduled, covered, exempt) {
  return scheduled
    .filter(f => !covered.has(f) && !exempt.has(f))
    .sort();
}

/**
 * Exempt entries that are stale — listed but no longer a scheduled workflow (deleted
 * or de-scheduled), or also in CRITICAL_CRONS (double-listed). Keeps the allowlist honest.
 * @returns {{ notScheduled: string[], alsoCovered: string[] }}
 */
function findStaleExempt(exempt, scheduledSet, covered) {
  const notScheduled = [], alsoCovered = [];
  for (const f of exempt) {
    if (!scheduledSet.has(f)) notScheduled.push(f);
    else if (covered.has(f)) alsoCovered.push(f);
  }
  return { notScheduled: notScheduled.sort(), alsoCovered: alsoCovered.sort() };
}

/**
 * Parse .cron-health-exempt.txt keeping each entry's justification (BRO-2818).
 * The list was seeded 2026-06-28 with every then-uncovered workflow, so a bare
 * filename says nothing about WHY it is unmonitored. An entry's justification is
 * either an inline `file.yml  # reason` or the `#` comment block directly above it
 * (consumed by the next filename only; a blank line discards it).
 * A justification containing the token `[digest]` CLAIMS stale-run coverage by the
 * daily digest (health-check.js), which findFalseDigestClaims() verifies.
 * @returns {Map<string, { reason: string, claimsDigest: boolean }>}
 */
function parseExemptEntries(text) {
  const out = new Map();
  let block = [];
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line) { block = []; continue; }
    if (line.startsWith('#')) { block.push(line.replace(/^#\s?/, '')); continue; }
    const hash = line.indexOf('#');
    const file = (hash === -1 ? line : line.slice(0, hash)).trim();
    const inline = hash === -1 ? '' : line.slice(hash + 1).trim();
    if (!file) continue;
    const reason = [...block, inline].filter(Boolean).join(' ').trim();
    out.set(file, {
      reason,
      claimsDigest: /\[digest\]/i.test(reason),
      // BRO-3492: `[no-liveness: why]` opts an entry out of the default liveness sweep.
      noLiveness: /\[no-liveness\s*:\s*[^\]]+\]/i.test(reason),
    });
    block = [];
  }
  return out;
}

/** Exempt entries with no justification at all (sorted). */
function findUnjustifiedExempt(entries) {
  return [...entries].filter(([, v]) => !v.reason).map(([f]) => f).sort();
}

/** Entries that claim `[digest]` coverage but are absent from the digest list (sorted). */
function findFalseDigestClaims(entries, digestWorkflows) {
  const digest = new Set(digestWorkflows);
  return [...entries].filter(([f, v]) => v.claimsDigest && !digest.has(f)).map(([f]) => f).sort();
}

/**
 * Drift between the daily-digest cron list and the real-time paging list.
 * Every digest entry must be in the paging list with the same maxHours, unless
 * it is a documented digest-only entry. The two lists carried the comment "keep in
 * sync" with 30 entries of drift and no test (BRO-2818).
 * @param {{workflow:string,maxHours:number}[]} digest
 * @param {Map<string, number>} paging workflow -> maxHours from CRITICAL_CRONS
 * @param {Object<string,string>} digestOnly workflow -> reason
 * @returns {{ missingFromPaging: string[], hoursMismatch: string[], staleDigestOnly: string[] }}
 */
function findDigestDrift(digest, paging, digestOnly) {
  const missingFromPaging = [], hoursMismatch = [], staleDigestOnly = [];
  const inDigest = new Set(digest.map(d => d.workflow));
  for (const { workflow, maxHours } of digest) {
    if (!paging.has(workflow)) {
      if (!digestOnly[workflow]) missingFromPaging.push(workflow);
    } else if (paging.get(workflow) !== maxHours) {
      hoursMismatch.push(`${workflow} (digest ${maxHours}h vs paging ${paging.get(workflow)}h)`);
    }
  }
  for (const wf of Object.keys(digestOnly)) {
    if (!inDigest.has(wf)) staleDigestOnly.push(wf);
  }
  return { missingFromPaging: missingFromPaging.sort(), hoursMismatch: hoursMismatch.sort(), staleDigestOnly: staleDigestOnly.sort() };
}

// ── Cron cadence helpers (moved from audit-cron-health-coverage.js so health-check.js
// can share them for the default liveness sweep, BRO-3492) ──

function parseField(field, min, max) {
  if (field === '*') return null; // wildcard
  const out = new Set();
  for (const part of field.split(',')) {
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10);
      for (let v = min; v <= max; v += step) out.add(v);
    } else if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      for (let v = a; v <= b; v++) out.add(v);
    } else {
      out.add(parseInt(part, 10));
    }
  }
  return out;
}

/**
 * Worst-case gap (hours) between fires across a 60-day window from Mon 2026-01-05,
 * treating multiple crons as a union. Returns null when fewer than two fires land in
 * the window: a seasonal or month-restricted cron (e.g. `0 9 * 4-6 *`) has no
 * computable cadence here, and callers skip it rather than guess.
 */
function worstGapHours(cronExprs) {
  const matchers = cronExprs.map(expr => {
    const [m, h, dom, mon, dow] = expr.split(/\s+/);
    return {
      m: parseField(m, 0, 59),
      h: parseField(h, 0, 23),
      dom: parseField(dom, 1, 31),
      mon: parseField(mon, 1, 12),
      dow: parseField(dow, 0, 6),
    };
  });

  const fires = [];
  const start = new Date(Date.UTC(2026, 0, 5, 0, 0, 0)); // Mon 2026-01-05, neutral start
  const WINDOW_MIN = 60 * 24 * 60; // 60 days

  for (let i = 0; i < WINDOW_MIN; i++) {
    const t = new Date(start.getTime() + i * 60_000);
    const tm = t.getUTCMinutes(), th = t.getUTCHours();
    const tdom = t.getUTCDate(), tmon = t.getUTCMonth() + 1, tdow = t.getUTCDay();
    for (const c of matchers) {
      if (c.m && !c.m.has(tm)) continue;
      if (c.h && !c.h.has(th)) continue;
      if (c.mon && !c.mon.has(tmon)) continue;
      // cron oddity: when dom and dow are both set, they're an OR
      const domOk = !c.dom || c.dom.has(tdom);
      const dowOk = !c.dow || c.dow.has(tdow);
      if (c.dom && c.dow) {
        if (!domOk && !dowOk) continue;
      } else {
        if (!domOk || !dowOk) continue;
      }
      fires.push(t.getTime());
      break;
    }
  }

  if (fires.length < 2) return null;

  let maxGap = 0;
  for (let i = 1; i < fires.length; i++) {
    maxGap = Math.max(maxGap, fires[i] - fires[i - 1]);
  }
  return Math.round(maxGap / 3_600_000);
}

/**
 * Cron expressions from a workflow YAML body. Quoted or unquoted (the old quoted-only
 * regex let `cron: 30 5 1,15 * *` read as "no cron"), comment lines and trailing
 * `# comments` ignored.
 */
function extractCrons(yamlText) {
  const out = [];
  for (const line of String(yamlText || '').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*-?\s*cron:\s*(['"]?)([^'"#]+?)\1\s*(?:#.*)?$/);
    if (m) out.push(m[2].trim());
  }
  return out;
}

// ── Alert paths and the default liveness sweep (BRO-3492) ──

/**
 * How each scheduled workflow is watched for "stopped running":
 *  'paged'    in CRITICAL_CRONS (check-cron-health.yml, real-time)
 *  'digest'   in health-check.js DIGEST_CRONS (daily digest staleness row)
 *  'liveness' exempt, watched by the default liveness sweep in health-check.js
 *  'none'     opted out with `[no-liveness: why]`
 * Failures (red runs) are a separate path: notify-failure + repeat-failure digest rows.
 * @param {string[]} scheduled
 * @param {Set<string>} paging
 * @param {Iterable<string>} digestWorkflows
 * @param {Map<string,{noLiveness?:boolean}>} exemptEntries
 * @returns {Map<string,'paged'|'digest'|'liveness'|'none'>}
 */
function classifyAlertPaths(scheduled, paging, digestWorkflows, exemptEntries) {
  const digest = new Set(digestWorkflows);
  const out = new Map();
  for (const f of [...scheduled].sort()) {
    if (paging.has(f)) out.set(f, 'paged');
    else if (digest.has(f)) out.set(f, 'digest');
    else if (exemptEntries.get(f)?.noLiveness) out.set(f, 'none');
    else out.set(f, 'liveness');
  }
  return out;
}

const NOT_A_START = new Set(['cancelled', 'startup_failure', 'skipped']);
const LIVENESS_SLACK_HOURS = 24;
// worstGapHours samples a 60-day window that holds only February's month gap
// (672h); a day-of-month cron's real gap reaches 744h in a 31-day month.
const MONTH_LENGTH_SLACK_HOURS = 72;

/**
 * Did a scheduled workflow actually start recently? Alive = the newest scheduled run that
 * got past startup (any conclusion but cancelled/startup_failure/skipped, so a red run
 * still counts: failures have their own alert path) is within worstGap + 24h of `now`.
 * No scheduled run at all is 'unknown' (BRO-5675: a brand-new cron was flagged before its
 * first fire; never-ran workflows have neverRunWorkflowResults). Pass the workflow's
 * `createdAt` to still call it stale once it has existed longer than the limit.
 * @param {{crons:string[], runs:{conclusion?:string, created_at:string}[], now?:number, createdAt?:string}} p
 * @returns {{status:'alive'|'stale'|'unknown', limitHours:number|null, ageHours:number|null}}
 */
function livenessVerdict({ crons, runs, now = Date.now(), createdAt }) {
  const gap = crons && crons.length ? worstGapHours(crons) : null;
  if (gap == null) return { status: 'unknown', limitHours: null, ageHours: null };
  const domRestricted = crons.some(c => { const f = String(c).trim().split(/\s+/); return f[2] && f[2] !== '*'; });
  const limitHours = gap + LIVENESS_SLACK_HOURS + (domRestricted ? MONTH_LENGTH_SLACK_HOURS : 0);
  const started = (runs || [])
    .filter(r => r && r.created_at && !NOT_A_START.has(r.conclusion))
    .map(r => Date.parse(r.created_at))
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
  if (!(runs || []).length) {
    const createdMs = Date.parse(createdAt);
    const old = Number.isFinite(createdMs) && (now - createdMs) / 3_600_000 > limitHours;
    return { status: old ? 'stale' : 'unknown', limitHours, ageHours: null };
  }
  if (!started.length) return { status: 'stale', limitHours, ageHours: null };
  const ageHours = Math.round((now - started[0]) / 3_600_000);
  return { status: ageHours > limitHours ? 'stale' : 'alive', limitHours, ageHours };
}

/**
 * BRO-5962: is a scheduled workflow red on every run? True when the newest `n` scheduled
 * runs that actually finished all concluded `failure` (or `timed_out`). In-flight and
 * cancelled/skipped runs are ignored, so a superseded run neither starts nor breaks a streak;
 * fewer than `n` finished runs is never a streak. Success-keyed alerts (CRITICAL_CRONS,
 * digest rows) cannot see this for a weekly job inside its staleness window.
 * @param {{conclusion?:string, created_at?:string, createdAt?:string}[]} runs any order
 * @param {number} [n]
 * @returns {{failing:boolean, streak:number, lastFailureAt:string|null}}
 */
function consecutiveFailureVerdict(runs, n = 3) {
  const at = r => Date.parse(r.created_at || r.createdAt);
  const done = (runs || [])
    .filter(r => r && r.conclusion && !['cancelled', 'skipped', 'startup_failure'].includes(r.conclusion))
    .sort((a, b) => (at(b) || 0) - (at(a) || 0));
  let streak = 0;
  while (streak < done.length && ['failure', 'timed_out'].includes(done[streak].conclusion)) streak++;
  return { failing: streak >= n, streak, lastFailureAt: streak ? (done[0].created_at || done[0].createdAt || null) : null };
}

module.exports = {
  consecutiveFailureVerdict,
  isScheduledWorkflow, parseExemptList, findUncoveredScheduled, findStaleExempt,
  parseExemptEntries, findUnjustifiedExempt, findFalseDigestClaims, findDigestDrift,
  parseField, worstGapHours, extractCrons, classifyAlertPaths, livenessVerdict,
};
