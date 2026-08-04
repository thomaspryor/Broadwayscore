/**
 * trunk-close-gate.js — decides whether a Notion card may move to Done given
 * the CURRENT state of test.yml on main, and renders the standing trunk line
 * the morning digest carries (task #1003).
 *
 * Why (2026-08-04): cards close when their change MERGES, never when main is
 * green. That day main was red on ~96% of runs from four independent
 * failures, two of them shipped by cards already marked Done:
 *   - #956 shipped scripts/tests/tm-gap-links.test.mjs, red on 20/20 runs
 *   - #990/#993 left scripts/audit-cross-outlet-attributions.test.mjs
 *     orphaned, tripping the "no orphan unit tests" audit
 * Three sessions "fixed test.yml" and it stayed red: each fixed the one
 * failure it happened to look at, pushed, and closed its card with no signal
 * that main was still red from the other three.
 *
 * The gate is deliberately NARROW. It refuses a close only when a file THAT
 * CARD owns (its Key Files, or its branch diff) is named in the failure
 * output currently on main. Blocking every close while trunk is red would
 * deadlock every unrelated card — which is exactly the state the repo was in
 * when this was written. Every ambiguity fails OPEN (no snapshot, stale
 * snapshot, unparseable failure, card with no owned paths): a gate that
 * cannot attribute must not block.
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
    state: 'UNKNOWN', consecutiveFailures: 0, redSince: null, redForHours: null,
    redDurationIsFloor: false, lastSuccessAt: null, latestFailedRunId: null,
    latestFailedRunUrl: null, decidedRuns: 0,
  };
  if (!decided.length) return empty;

  const firstSuccess = decided.find((r) => r.conclusion === 'success');
  const lastSuccessAt = firstSuccess ? firstSuccess.createdAt : null;
  if (!FAILED_CONCLUSIONS.has(String(decided[0].conclusion))) {
    return { ...empty, state: 'GREEN', lastSuccessAt, decidedRuns: decided.length };
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

  for (const entry of lines) {
    const msg = entry.message;
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

    if (inTapFailure || markerCountdown > 0) {
      for (const p of pathsInLine(msg)) record(p, entry, context || msg);
    }
    if (markerCountdown > 0) markerCountdown--;
    if (byPath.size >= maxPaths) break;
  }
  return [...byPath.values()];
}

// ── card ownership ──────────────────────────────────────────────────────────

/** Repo-relative ownable paths named anywhere in a blob of text (Key Files). */
function ownedPathsFromText(text) {
  const out = new Set();
  for (const line of String(text || '').split('\n')) {
    for (const p of pathsInLine(line)) out.add(p);
  }
  return [...out];
}

/**
 * Everything a card is answerable for: its Key Files field plus the files its
 * branch actually changed.
 */
function collectOwnedPaths({ keyFiles = '', changedFiles = [] } = {}) {
  const out = new Set(ownedPathsFromText(keyFiles));
  for (const f of Array.isArray(changedFiles) ? changedFiles : []) {
    const norm = String(f || '').trim().replace(/^\.\//, '');
    if (norm && pathsInLine(` ${norm}`).length) out.add(norm);
  }
  return [...out];
}

// ── the gate ────────────────────────────────────────────────────────────────

const GATE_REASONS = {
  DISABLED: 'gate-disabled',
  NO_SNAPSHOT: 'no-trunk-snapshot',
  STALE_SNAPSHOT: 'stale-trunk-snapshot',
  GREEN: 'trunk-green',
  UNATTRIBUTABLE: 'trunk-red-unattributable',
  NO_OWNED_PATHS: 'card-owns-no-files',
  UNRELATED: 'trunk-red-unrelated',
  OWN_FAILURE: 'own-file-failing-on-main',
};

/**
 * @param {{trunk:object|null, keyFiles?:string, changedFiles?:string[],
 *   now?:number, maxSnapshotAgeH?:number, disabled?:boolean}} o
 * @returns {{allowed:boolean, reason:string, message:string,
 *   blocking:Array<object>, ownedPaths:string[], trunkState:string}}
 */
function evaluateCloseGate({
  trunk = null, keyFiles = '', changedFiles = [], now = Date.now(),
  maxSnapshotAgeH = 6, disabled = false,
} = {}) {
  const ownedPaths = collectOwnedPaths({ keyFiles, changedFiles });
  const allow = (reason, message, trunkState = trunk && trunk.state ? trunk.state : 'UNKNOWN') =>
    ({ allowed: true, reason, message, blocking: [], ownedPaths, trunkState });

  if (disabled) return allow(GATE_REASONS.DISABLED, 'trunk close gate disabled by env');
  if (!trunk || typeof trunk !== 'object') {
    return allow(GATE_REASONS.NO_SNAPSHOT, 'no trunk snapshot — closing without a trunk check', 'UNKNOWN');
  }

  const gen = new Date(trunk.generatedAt).getTime();
  if (Number.isFinite(gen) && (now - gen) / 3600e3 > maxSnapshotAgeH) {
    return allow(
      GATE_REASONS.STALE_SNAPSHOT,
      `trunk snapshot is stale (${((now - gen) / 3600e3).toFixed(1)}h old) — closing without a trunk check`
    );
  }
  if (trunk.state !== 'RED') {
    return allow(GATE_REASONS.GREEN, `trunk is ${trunk.state || 'UNKNOWN'}`);
  }

  const failing = Array.isArray(trunk.failingPaths) ? trunk.failingPaths : [];
  if (!failing.length) {
    return allow(
      GATE_REASONS.UNATTRIBUTABLE,
      'trunk is RED but no failing file could be attributed — not blocking this close'
    );
  }
  if (!ownedPaths.length) {
    return allow(
      GATE_REASONS.NO_OWNED_PATHS,
      'trunk is RED but this card names no files (no Key Files, no branch diff) — not blocking this close'
    );
  }

  const owned = new Set(ownedPaths);
  const blocking = failing.filter((f) => f && owned.has(f.path));
  if (!blocking.length) {
    return allow(
      GATE_REASONS.UNRELATED,
      `trunk is RED (${trunk.consecutiveFailures || 0} consecutive) but none of this card's files are in the failure — closing normally`
    );
  }

  const lines = blocking.map(
    (b) => `  - ${b.path} — failing in "${b.job || 'unknown job'}" / "${b.step || 'unknown step'}"` +
      (b.evidence ? `\n      ${b.evidence}` : '')
  );
  return {
    allowed: false,
    reason: GATE_REASONS.OWN_FAILURE,
    trunkState: 'RED',
    ownedPaths,
    blocking,
    message:
      `This card cannot close: ${blocking.length} file${blocking.length === 1 ? '' : 's'} it owns ` +
      `${blocking.length === 1 ? 'is' : 'are'} currently failing on main.\n` +
      `${lines.join('\n')}\n` +
      `Trunk has been red for ${trunk.consecutiveFailures || 0} consecutive test.yml run${trunk.consecutiveFailures === 1 ? '' : 's'}` +
      `${trunk.latestFailedRunUrl ? ` (${trunk.latestFailedRunUrl})` : ''}.\n` +
      `Fix the failure on main, or hand the card off — do not mark it Done.\n` +
      `Unrelated trunk redness does NOT block a close; this one is yours.`,
  };
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
  DEFAULT_SNAPSHOT_PATH, GATE_REASONS,
  summarizeTrunkRuns, parseFailedLog, extractFailingPaths,
  ownedPathsFromText, collectOwnedPaths, evaluateCloseGate,
  renderTrunkDigestLine, readTrunkSnapshot,
};
