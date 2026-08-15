/**
 * trunk-status.js — is test.yml green on main, and what is failing?
 *
 * Two consumers, neither of which decides anything about a card:
 *   - scripts/produce-trunk-snapshot.js folds `gh run list` + `gh run view
 *     --log-failed` into data/audit/trunk-status-snapshot.json.
 *   - scripts/send-morning-digest.js renders the standing trunk line, which
 *     becomes the email HEADLINE once trunk has been red more than 24h.
 *
 * Why the standing line (2026-08-04): main was red on ~96% of test.yml runs
 * from four independent failures and nobody saw the aggregate — three sessions
 * each fixed the one failure they happened to look at, pushed, and left main
 * red. A number in the daily email is the cheapest thing that makes an
 * aggregate visible.
 *
 * This file used to also decide whether a card could close, by matching the
 * failing paths against the card's Key Files. That design was rejected in
 * plan-review (the attribution question was mis-posed: a card is answerable
 * for its OWN acceptance command, not for whichever file it happens to name)
 * and now lives in scripts/lib/close-time-verify.js, which asks the ledger,
 * not the failure log. Nothing here blocks anything.
 *
 * Pure module — the only I/O is readTrunkSnapshot's single fs read, same
 * contract as scripts/lib/digest-snapshots.js (CLAUDE.md §15: the test
 * require()s these functions, it does not re-implement them).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const DEFAULT_SNAPSHOT_PATH = path.join(REPO, 'data', 'audit', 'trunk-status-snapshot.json');

// Code a card can plausibly OWN. Deliberately excludes .json: data files churn
// on every CI commit, so attributing a failure that merely mentions
// data/shows.json to whichever card last touched it would block unrelated
// closes — the exact over-blocking this gate exists to avoid.
// The trailing lookahead is load-bearing: without it `.js` matches the head of
// `data/shows.json` and `.ts` matches the head of `.tsx`, so a card that
// touched a JSON data file would read as owning a code file it never saw.
const OWNABLE_EXT = '(?:mjs|cjs|jsx|js|tsx|ts|yaml|yml|sh)(?![A-Za-z0-9])';
const PATH_RE = new RegExp(
  `(?:^|[\\s'"\`(\\[/])((?:scripts|src|supabase|tests|\\.github/workflows)/` +
  `[A-Za-z0-9_@.+-]+(?:/[A-Za-z0-9_@.+-]+)*\\.${OWNABLE_EXT})`,
  'g'
);

// Remediation prose names files you should EDIT, not files that failed. The
// orphan-test audit's own output is the live example: its "❌ 1 orphan test
// file(s)" line is followed by the offending path, then
//   "Fix: add the file to the appropriate `node --test ...` line in
//    .github/workflows/test.yml."
//   "Opt-out (known-broken): add to EXEMPT_KNOWN_BROKEN in
//    scripts/audit-orphan-tests.js ..."
// Without this filter every card that touched test.yml or the audit script
// would be refused closure by an orphan report about somebody else's file.
const ADVICE_LINE_RE = /^\s*(?:fix|to fix|opt-out|opt out|hint|see|note|usage|run|try|next|why|→|->)\b/i;

// How far past a ❌/##[error] marker a named path still counts as part of the
// failure. 2 lines covers "marker, then the offending path" (the orphan audit
// prints exactly that, with a blank line after) without swallowing the
// remediation block that follows.
const MARKER_WINDOW = 2;

// ── trunk state ─────────────────────────────────────────────────────────────

// Only decided runs count. `cancelled` is NOT red: ~75% of this repo's main
// runs cancel on data-commit churn (task #80), and counting them would report
// a permanently red trunk that no fix could ever clear.
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);
const DECIDED_CONCLUSIONS = new Set([...FAILED_CONCLUSIONS, 'success']);

/**
 * Fold a `gh run list --json databaseId,conclusion,createdAt,url` array into
 * the trunk verdict.
 * @param {Array<{databaseId?:number|string,conclusion?:string|null,createdAt?:string,url?:string}>} runs
 * @returns {{state:'GREEN'|'RED'|'UNKNOWN', consecutiveFailures:number,
 *   redSince:string|null, redForHours:number|null, lastSuccessAt:string|null,
 *   latestFailedRunId:string|null, latestFailedRunUrl:string|null, decidedRuns:number}}
 */
function summarizeTrunkRuns(runs, { now = Date.now() } = {}) {
  const decided = (Array.isArray(runs) ? runs : [])
    .filter((r) => r && typeof r === 'object' && DECIDED_CONCLUSIONS.has(String(r.conclusion || '')))
    .map((r) => ({ ...r, _t: new Date(r.createdAt).getTime() }))
    .filter((r) => Number.isFinite(r._t))
    .sort((a, b) => b._t - a._t);

  const empty = {
    state: 'UNKNOWN', consecutiveFailures: 0, consecutiveSuccesses: 0,
    greenSince: null, greenForHours: null, greenDurationIsFloor: false,
    redSince: null, redForHours: null,
    redDurationIsFloor: false, lastSuccessAt: null, latestFailedRunId: null,
    latestFailedRunUrl: null, decidedRuns: 0,
  };
  if (!decided.length) return empty;

  const firstSuccess = decided.find((r) => r.conclusion === 'success');
  const lastSuccessAt = firstSuccess ? firstSuccess.createdAt : null;
  if (!FAILED_CONCLUSIONS.has(String(decided[0].conclusion))) {
    // Green streak, the exact mirror of the red one below. Added 2026-08-14:
    // the GREEN branch previously recorded only "the latest run passed", which
    // cannot answer the one question a post-incident hold actually asks —
    // "has main STAYED green?". Without it, an acceptance probe re-run days
    // later (scripts/autonomous-acceptance-recheck.js) would rubber-stamp a
    // trunk that had flapped red and back between snapshots. Purely additive:
    // renderTrunkDigestLine's GREEN branch is unchanged and reads none of it.
    const greenStreak = [];
    for (const r of decided) {
      if (FAILED_CONCLUSIONS.has(String(r.conclusion))) break;
      greenStreak.push(r);
    }
    const oldestGreen = greenStreak[greenStreak.length - 1];
    return {
      ...empty,
      state: 'GREEN',
      consecutiveSuccesses: greenStreak.length,
      greenSince: oldestGreen.createdAt,
      greenForHours: Math.max(0, (now - oldestGreen._t) / 3600e3),
      // Same semantics as redDurationIsFloor: no failure anywhere in the
      // fetched window means the green streak runs off the end of it, so the
      // duration is AT LEAST greenForHours. A consumer asserting "green for
      // 24h" must treat the floor as satisfying the bound, never as capping it.
      greenDurationIsFloor: greenStreak.length === decided.length,
      lastSuccessAt,
      decidedRuns: decided.length,
    };
  }

  const streak = [];
  for (const r of decided) {
    if (!FAILED_CONCLUSIONS.has(String(r.conclusion))) break;
    streak.push(r);
  }
  const oldest = streak[streak.length - 1];
  return {
    state: 'RED',
    consecutiveFailures: streak.length,
    // Explicit, not left undefined: a consumer asserting a green streak must
    // read a real 0 on a red trunk rather than `undefined >= N` (which is
    // false, but silently — and JSON.stringify drops undefined entirely, so
    // the field would vanish from the committed snapshot).
    consecutiveSuccesses: 0,
    greenSince: null,
    greenForHours: null,
    greenDurationIsFloor: false,
    redSince: oldest.createdAt,
    redForHours: Math.max(0, (now - oldest._t) / 3600e3),
    // No success anywhere in the fetched window means the streak runs off the
    // end of it: the real duration is AT LEAST redForHours, not exactly it.
    // Live case 2026-08-04: 23 consecutive failures, zero successes in 25 runs
    // — reporting a flat "8h" there would have understated a multi-day red and
    // kept the digest headline from firing, which is the whole point of the
    // 24h rule.
    redDurationIsFloor: !lastSuccessAt,
    lastSuccessAt,
    latestFailedRunId: decided[0].databaseId != null ? String(decided[0].databaseId) : null,
    latestFailedRunUrl: decided[0].url || null,
    decidedRuns: decided.length,
  };
}

// ── failure attribution ─────────────────────────────────────────────────────

// `gh run view --log-failed` emits "<job>\t<step>\t<timestamp> <message>".
function parseFailedLog(logText) {
  const out = [];
  for (const raw of String(logText || '').split('\n')) {
    const line = raw.replace(/^﻿/, '').replace(/\r$/, '');
    if (!line.trim()) { out.push({ job: null, step: null, message: '' }); continue; }
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const message = parts.slice(2).join('\t').replace(/^\S*Z\s?/, '');
      out.push({ job: parts[0], step: parts[1], message });
    } else {
      out.push({ job: null, step: null, message: line });
    }
  }
  return out;
}

function pathsInLine(message) {
  if (ADVICE_LINE_RE.test(message)) return [];
  const found = [];
  PATH_RE.lastIndex = 0;
  let m;
  while ((m = PATH_RE.exec(message)) !== null) found.push(m[1]);
  return found;
}

const FAILURE_MARKER_RE = /(?:^|\s)(?:❌|✖|✗|##\[error\])/;
const TAP_NOT_OK_RE = /^\s*not ok \d+/;
// A passing assertion, a new subtest header, or the plan line all mean the
// previous `not ok` diagnostic block is over.
// node --test's own diagnostic fields: `location: '/abs/file.mjs:55:1'`,
// `stack: |-` frames (`file:///abs/file.mjs:67:12`), `failureType`, etc.
// Anchored on purpose: an unanchored `file://` alternative also matched any
// assertion payload that happened to contain a repo file URI, which is exactly
// the false attribution this restriction exists to prevent (second review
// pass). `location:` alone names the failing test file, which is what a card
// is answerable for.
const TAP_LOCATION_RE = /^\s*(?:location|stack|at)\b/;
const TAP_BLOCK_END_RE = /^\s*(?:ok \d+|# Subtest:|1\.\.\d+|# (?:tests|pass|fail|duration_ms)\b)/;

/**
 * Pull the repo files implicated by the failures in a `--log-failed` dump.
 * Only failure CONTEXT is scanned (a node --test `not ok` diagnostic block, or
 * the 2 lines following a ❌/##[error] marker) — the same dump also carries
 * thousands of passing-test lines naming unrelated files.
 * @returns {Array<{path:string, job:string|null, step:string|null, evidence:string}>}
 */
function extractFailingPaths(logText, { maxPaths = 40, markerWindow = MARKER_WINDOW } = {}) {
  const lines = parseFailedLog(logText);
  const byPath = new Map();
  let inTapFailure = false;
  let markerCountdown = 0;
  let context = null;

  const record = (p, entry, evidence) => {
    if (byPath.has(p)) return;
    byPath.set(p, {
      path: p,
      job: entry.job,
      step: entry.step,
      evidence: String(evidence || '').trim().slice(0, 200),
    });
  };

  // Whether this dump carries gh's "<job>\t<step>\t<ts> msg" framing at all.
  // When it does, an untabbed line is stray output that belongs to no job, and
  // must not be read under the previous job's failure scope (second review
  // pass: a truncated tabbed block followed by an untabbed `location:` line
  // could otherwise attribute an innocent file). A raw, tab-less log (local
  // `node --test` output piped in by hand) still parses as before.
  const hasJobFraming = lines.some((l) => l.job !== null);
  let prevScope = null;
  for (const entry of lines) {
    const msg = entry.message;
    // A `not ok` block never spans two jobs/steps. Without this reset a
    // truncated diagnostic (log cut mid-block, a step that dies before its
    // closing `...`) leaves inTapFailure latched, and the NEXT job's file
    // mentions get attributed to a failure they had nothing to do with —
    // blocking innocent cards, the one thing this gate must never do
    // (ship-check finding).
    const scope = `${entry.job || ''} ${entry.step || ''}`;
    if (entry.job !== null && scope !== prevScope) {
      inTapFailure = false;
      markerCountdown = 0;
      context = null;
      prevScope = scope;
    }
    if (TAP_NOT_OK_RE.test(msg)) {
      inTapFailure = true;
      context = msg;
    } else if (inTapFailure && TAP_BLOCK_END_RE.test(msg)) {
      inTapFailure = false;
    }
    if (FAILURE_MARKER_RE.test(msg)) {
      markerCountdown = markerWindow + 1;
      context = msg;
    }

    // Inside a `not ok` block, only node's STRUCTURED failure fields name the
    // file that failed. Scanning the whole diagnostic would also pick up paths
    // that merely appear in an assertion's expected/actual payload — an
    // innocent file, refused a close it had nothing to do with (ship-check
    // finding). Marker windows (❌ / ##[error]) stay line-based: those tools
    // print the offending path as prose, not as a field.
    if (inTapFailure) {
      if ((entry.job !== null || !hasJobFraming) && TAP_LOCATION_RE.test(msg)) {
        for (const p of pathsInLine(msg)) record(p, entry, context || msg);
      }
    } else if (markerCountdown > 0 && (entry.job !== null || !hasJobFraming)) {
      for (const p of pathsInLine(msg)) record(p, entry, context || msg);
    }
    if (markerCountdown > 0) markerCountdown--;
    if (byPath.size >= maxPaths) break;
  }
  return [...byPath.values()];
}

// ── digest line ─────────────────────────────────────────────────────────────

/**
 * The standing "is trunk green" line the morning digest carries, so aggregate
 * redness can never again go unnoticed. Escalates to the digest HEADLINE once
 * trunk has been red longer than headlineAfterH.
 * @returns {null|{text:string, level:'ok'|'critical', headline:boolean,
 *   generatedAt:string|null, bannerText:string, items:Array, moreCount:number}}
 */
function renderTrunkDigestLine(trunk, { headlineAfterH = 24, headlineAfterFloorRuns = 10 } = {}) {
  if (!trunk || typeof trunk !== 'object' || !trunk.state || trunk.state === 'UNKNOWN') return null;
  const generatedAt = trunk.generatedAt || null;

  if (trunk.state !== 'RED') {
    return {
      text: 'trunk: GREEN — test.yml is passing on main',
      level: 'ok', headline: false, generatedAt,
      bannerText: 'trunk: GREEN — test.yml is passing on main',
      items: [], moreCount: 0,
    };
  }

  const n = trunk.consecutiveFailures || 0;
  const topJob = trunk.topFailingJob || (Array.isArray(trunk.failingJobs) && trunk.failingJobs[0]
    ? trunk.failingJobs[0].name : null);
  const hours = Number.isFinite(trunk.redForHours) ? trunk.redForHours : null;
  // "+" when the streak ran off the end of the run window: the number is a
  // floor, and saying "8h" flat about a red that may be days old is the kind
  // of understatement that let 2026-08-04 go unnoticed.
  const floor = trunk.redDurationIsFloor ? '+' : '';
  const forPart = hours == null ? ''
    : `, red for ${hours >= 48 ? `${Math.round(hours / 24)} days` : `${Math.round(hours)}h`}${floor}`;
  const text =
    `trunk: RED (${n} consecutive failure${n === 1 ? '' : 's'}${forPart}` +
    `${topJob ? `, top failing job: ${topJob}` : ''})`;

  const failing = Array.isArray(trunk.failingPaths) ? trunk.failingPaths : [];
  return {
    text,
    level: 'critical',
    // Headline past 24h red — or once the streak has run off the end of the
    // window with no green in sight at all, which is the same emergency
    // wearing a shorter clock (2026-08-04: 23 straight failures, no success
    // in the whole window, elapsed time in-window only 8h).
    headline: (hours != null && hours > headlineAfterH)
      || (trunk.redDurationIsFloor === true && n >= headlineAfterFloorRuns),
    generatedAt,
    bannerText: text,
    items: failing.slice(0, 6).map((f) => ({
      title: f.path,
      detail: `failing in ${f.job || 'unknown job'}${f.step ? ` / ${f.step}` : ''}`,
    })),
    moreCount: Math.max(0, failing.length - 6),
  };
}

// ── snapshot io ─────────────────────────────────────────────────────────────

/** Never throws: a missing/corrupt snapshot must fail the gate OPEN. */
function readTrunkSnapshot(snapshotPath = DEFAULT_SNAPSHOT_PATH) {
  try {
    const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return null;
    return snap;
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULT_SNAPSHOT_PATH,
  summarizeTrunkRuns, parseFailedLog, extractFailingPaths,
  renderTrunkDigestLine, readTrunkSnapshot,
};
