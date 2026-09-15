/**
 * board-targeting-audit.js — the standing check that the fleet's always-on
 * automation is pointed at the LIVE tracker board (BRO-3423).
 *
 * WHAT WENT WRONG, AND WHY A ONE-OFF FIX DOES NOT COVER IT. The crowned
 * dispatch-watchdog dashboard — the fleet's only continuous top-up dispatcher
 * — spent every day from 2026-09-01 re-dispatching work off the RETIRED Notion
 * mirror. Measured 2026-09-15: 420 of 423 all-time `watchdog-redispatch` rows
 * carry a bare-numeric Notion id and 3 carry a `linear:` id; in the 7 days to
 * 2026-09-15 the split was 84 Notion / 2 Linear, exactly 12 per day, i.e. the
 * whole day budget. Meanwhile 122 of the 137 armed, dispatchable issues on the
 * live Linear board had NEVER appeared in the dispatch ledger at all. This ran
 * unnoticed for two weeks after the migration and was found only because a
 * session hand-grepped raw ledger data and cross-referenced id namespaces.
 *
 * BRO-3390 repaired that one dispatcher. This module is the thing that would
 * have caught it in a day, and that catches the NEXT one: an assumption ("X is
 * retired", "the migration is done") gets stated once, nothing re-verifies it
 * against the running system, and it calcifies. Ten-plus sessions separately
 * declared the Linear migration done; each checked a real but narrow
 * deliverable, none checked whether the fleet's automation actually worked the
 * live board.
 *
 * ── TWO INDEPENDENT ARMS, DELIBERATELY ─────────────────────────────────────
 *
 *   1. WRITER ARM (auditWriterBoards) — ledger-only, no network. For each
 *      ledger event, what share of the board ids it writes point at a retired
 *      board? This is the arm that actually caught the live bug, and it is
 *      independent of any notion of "eligibility", so a bug in the dispatcher's
 *      own queue-building cannot launder it into a PASS.
 *
 *   2. COVERAGE ARM (auditLiveBoardCoverage) — how much of the live board has
 *      EVER been touched by automation? The writer arm goes quiet if a
 *      dispatcher simply stops; this arm notices that the live backlog is
 *      going undrained regardless of why.
 *
 * Both arms report even when they pass, because a check whose healthy output
 * is silence is a check nobody can tell is still running.
 *
 * ── WHY A DENY-LIST, NOT AN ALLOW-LIST ─────────────────────────────────────
 *
 * The first draft of this module audited an allow-list of four "dispatch
 * events" (launch, watchdog-redispatch, drain-dispatch, job-spawned). The
 * second-opinion review killed it, correctly: the ledger carries 28 distinct
 * event names, and `stall-sweep-attempted` (189 rows, 100% retired ids),
 * `amend` (20, 100%), and `watchdog-park` (12, 100%) are all dispatcher
 * activity that the allow-list would have been blind to. An allow-list makes
 * the NEXT dispatcher — which will write a NEXT new event name — invisible by
 * default, which is the exact failure class this card exists to end.
 *
 * So: every event is audited unless explicitly exempted below, and a brand-new
 * event name is audited from its first row with no edit here.
 *
 * ── WHY FAILING NEEDS A RECENT RETIRED ROW ─────────────────────────────────
 *
 * The mix is computed over a multi-day window so the ratio is stable, but a
 * verdict keyed on the window alone keeps screaming for a full window after a
 * genuine fix lands (on 2026-09-15 the 7-day window was ~98% pre-fix rows).
 * A writer therefore only FAILS while it is CURRENTLY mis-targeted: the mix
 * must be bad AND it must have written a retired-board row within
 * recencyHours. A real fix self-clears in two days; a drain that is still
 * running writes retired rows daily and never clears.
 *
 * Pure module — no fs, no network, no process, no clock of its own (`now` is
 * always passed in). CLAUDE.md §15: the tests require() these functions rather
 * than restating them, so changing a threshold here fails the test.
 */
'use strict';

const {
  LIVE_BOARD,
  RETIRED_BOARDS,
  NON_BOARD,
  classifyTaskIdBoard,
} = require('./task-id-namespace.js');

// ── tunables (measured baselines in the comments — do not change blind) ─────

// Mix window. Long enough that a slow writer accumulates a readable ratio,
// short enough to describe current behaviour.
const DEFAULT_WINDOW_DAYS = 7;

// A writer must have written at least this many BOARD ids in the window before
// its ratio means anything. Measured 2026-09-15: at a bar of 5 over a 14-day
// window, `launch-refused` (5 board rows, 3 retired) tripped on what is really
// a handful of refusals of legacy ids. 8 clears that and still admits the real
// offender by a wide margin (86 board rows in 7 days).
const DEFAULT_MIN_BOARD_ROWS = 8;

// Retired share that counts as mis-targeted. Measured 2026-09-15 over 7 days:
// the broken writer sat at 98%, and EVERY healthy writer sat at exactly 0%
// (launch 0/99, job-spawned 0/45, job-done 0/40). There is no observed middle
// ground, so 0.5 is a wide margin either side rather than a fitted number.
const DEFAULT_RETIRED_FRACTION_THRESHOLD = 0.5;

// How recently a writer must have emitted a retired-board id to still count as
// mis-targeted. See the header: this is what makes a real fix self-clear.
const DEFAULT_RECENCY_HOURS = 48;

// Coverage arm. Below this many armed issues the fraction is noise.
const DEFAULT_MIN_ELIGIBLE = 20;

// Share of armed live-board issues that have NEVER been touched by automation.
// Measured 2026-09-15 while broken: 122/137 = 89%. Note this is deliberately
// "never in the ledger", NOT "not touched in the last N days" — dispatching an
// issue moves it out of the armed pool, so a windowed intersection of
// still-armed against recently-touched is structurally near-empty even in a
// perfectly healthy fleet (measured: 3/137) and would fire constantly.
const DEFAULT_NEVER_TOUCHED_THRESHOLD = 0.75;

/**
 * Events exempt from the writer arm: reconciliation, cleanup and bookkeeping
 * that legitimately reach back over historical rows, and therefore legitimately
 * name retired-board ids long after the migration.
 *
 * Keep this list SHORT and justified. Every name added here is a place a future
 * mis-targeted dispatcher could hide, which is the whole failure mode. The
 * colocated test asserts the full real-ledger event inventory is either exempt
 * here or audited, so an addition has to be argued for in review.
 */
const EXEMPT_EVENTS = Object.freeze({
  // Sweep/prune bookkeeping over the entire ledger history, including rows
  // written before the migration. Measured 7% retired — historical, not new.
  'prune': 'sweep bookkeeping over full ledger history',
  'prune-closed': 'closes out historical rows, including pre-migration ones',
  'dead': 'marks historical dispatches dead; reaches back over old ids',
  'vanished': 'reconciles workspaces that disappeared, including old ones',
  'vanish-epoch': 'epoch marker for the vanish reconciler, not a dispatch',
  'remapped': 'id remapping IS the migration path; retired ids are the input',
  'restart-hold': 'process-level hold marker, not board work',
});

function hoursBetween(laterMs, earlierMs) {
  return (laterMs - earlierMs) / 3600e3;
}

/**
 * PURE. Per-event board-targeting mix over a window.
 *
 * @param {object} opts
 * @param {Array<{ts:string,event:string,taskId:*}>} opts.rows  ledger rows (any ledgers, concatenated)
 * @param {number} opts.now                                      ms epoch
 * @returns {{windowDays:number, writers:Array, failing:Array, auditedEvents:number, exemptEvents:Array}}
 */
function auditWriterBoards(opts) {
  const {
    rows = [],
    now = Date.now(),
    windowDays = DEFAULT_WINDOW_DAYS,
    minBoardRows = DEFAULT_MIN_BOARD_ROWS,
    retiredFractionThreshold = DEFAULT_RETIRED_FRACTION_THRESHOLD,
    recencyHours = DEFAULT_RECENCY_HOURS,
  } = opts || {};

  const cutoff = now - windowDays * 864e5;
  const byEvent = new Map();
  const exemptSeen = new Set();

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const ts = Date.parse(row.ts);
    // A row with an unparseable or future timestamp is a producer bug, not
    // evidence — the same call readSnapshot() makes about future generatedAt.
    if (!Number.isFinite(ts) || ts < cutoff || ts > now) continue;

    const event = String(row.event || 'unknown');
    // A ledger row can name its task under either key depending on the writer.
    const board = classifyTaskIdBoard(row.taskId != null ? row.taskId : row.id);
    if (board === NON_BOARD) continue;

    if (Object.prototype.hasOwnProperty.call(EXEMPT_EVENTS, event)) {
      exemptSeen.add(event);
      continue;
    }

    let acc = byEvent.get(event);
    if (!acc) {
      acc = { event, live: 0, retired: 0, lastRetiredTs: null, lastRowTs: null };
      byEvent.set(event, acc);
    }
    if (board === LIVE_BOARD) acc.live += 1;
    else if (RETIRED_BOARDS.includes(board)) {
      acc.retired += 1;
      if (!acc.lastRetiredTs || ts > Date.parse(acc.lastRetiredTs)) acc.lastRetiredTs = row.ts;
    }
    if (!acc.lastRowTs || ts > Date.parse(acc.lastRowTs)) acc.lastRowTs = row.ts;
  }

  const writers = [...byEvent.values()].map((acc) => {
    const boardRows = acc.live + acc.retired;
    const retiredFraction = boardRows ? acc.retired / boardRows : 0;
    const retiredAgeHours = acc.lastRetiredTs
      ? hoursBetween(now, Date.parse(acc.lastRetiredTs))
      : null;
    const currentlyEmitting = retiredAgeHours !== null && retiredAgeHours <= recencyHours;

    let verdict = 'ok';
    let reason = null;
    if (boardRows < minBoardRows) {
      verdict = 'insufficient-data';
      reason = `only ${boardRows} board row(s) in ${windowDays}d (need ${minBoardRows})`;
    } else if (retiredFraction >= retiredFractionThreshold && currentlyEmitting) {
      verdict = 'fail';
      reason = `${Math.round(retiredFraction * 100)}% of its ${boardRows} board ids are on a retired board, most recently ${retiredAgeHours < 1 ? '<1' : Math.round(retiredAgeHours)}h ago`;
    } else if (retiredFraction >= retiredFractionThreshold) {
      // Bad ratio, but nothing recent: a fix has landed and the window is
      // still full of pre-fix rows. Visible, not alarming.
      verdict = 'clearing';
      reason = `${Math.round(retiredFraction * 100)}% retired over ${windowDays}d but nothing newer than ${Math.round(retiredAgeHours)}h — looks fixed, window still draining`;
    }

    return {
      ...acc,
      boardRows,
      retiredFraction,
      retiredAgeHours,
      verdict,
      reason,
    };
  }).sort((a, b) => b.boardRows - a.boardRows);

  return {
    windowDays,
    writers,
    failing: writers.filter((w) => w.verdict === 'fail'),
    auditedEvents: writers.length,
    exemptEvents: [...exemptSeen].sort(),
  };
}

/**
 * PURE. How much of the live board has automation EVER touched?
 *
 * `openIssueCount` is reported alongside `eligibleCount` on purpose. The
 * eligible set comes from the dispatcher's own eligibility rules, so a bug that
 * collapses eligibility to a handful would shrink the denominator and silently
 * exonerate the fleet (second-opinion review finding). Surfacing both means an
 * eligibility collapse shows up as a number a human can see rather than as a
 * PASS.
 */
function auditLiveBoardCoverage(opts) {
  const {
    eligibleIds = [],
    everTouchedIds = new Set(),
    openIssueCount = null,
    ok = true,
    reason = null,
    minEligible = DEFAULT_MIN_ELIGIBLE,
    neverTouchedThreshold = DEFAULT_NEVER_TOUCHED_THRESHOLD,
  } = opts || {};

  // The live-board fetch reports ok:false both for a genuine outage AND for
  // hitting its page cap on a large backlog. Either way the eligible set is
  // unusable, and treating an unusable set as "nothing eligible" would read as
  // a clean bill of health — the precise way a drain quietly idles.
  if (!ok) {
    return { verdict: 'unknown', reason: reason || 'live-board fetch failed', eligibleCount: null, neverTouched: null, neverTouchedFraction: null, openIssueCount };
  }

  const eligible = [...new Set(Array.isArray(eligibleIds) ? eligibleIds : [])];
  const touched = everTouchedIds instanceof Set ? everTouchedIds : new Set(everTouchedIds || []);
  const neverTouchedIds = eligible.filter((id) => !touched.has(id));
  const eligibleCount = eligible.length;
  const neverTouched = neverTouchedIds.length;
  const neverTouchedFraction = eligibleCount ? neverTouched / eligibleCount : 0;

  let verdict = 'ok';
  let why = null;
  if (eligibleCount < minEligible) {
    verdict = 'insufficient-data';
    why = `only ${eligibleCount} armed issue(s) on the live board (need ${minEligible})`;
  } else if (neverTouchedFraction >= neverTouchedThreshold) {
    verdict = 'fail';
    why = `${neverTouched} of ${eligibleCount} armed live-board issues (${Math.round(neverTouchedFraction * 100)}%) have never appeared in the dispatch ledger`;
  }

  return {
    verdict,
    reason: why,
    eligibleCount,
    openIssueCount,
    neverTouched,
    neverTouchedFraction,
    neverTouchedSample: neverTouchedIds.slice(0, 8),
  };
}

// The health-row name. renderHealthScoreboard() derives the digest's category
// column from the prefix before ':' (autonomous-email-render.js:269), so a
// bare 'board-targeting' would invent a one-off category of its own instead of
// grouping with the fleet's other dispatch rows. Verified by rendering a real
// digest preview, not by reading the renderer.
const HEALTH_ROW_NAME = 'Dispatch: board targeting';

/**
 * PURE. Fold both arms into the row shape send-morning-digest.js pushes into
 * `sections.health.errors` — {status, name, message, hint} — which is the one
 * place every downstream consumer (subject line, top verdict, autofix
 * planning) already reads from.
 *
 * Status is 'error' only when something is CURRENTLY wrong. 'ok' still carries
 * a message so an on-demand run says what it checked.
 */
function summarizeBoardTargeting(opts) {
  const { writerAudit, coverage, now = Date.now(), blind = false, primaryLedger = null } = opts || {};

  // A blind audit is reported as blind. The first run of this check, from a
  // worktree where the gitignored Mac-local ledger does not exist, read zero
  // dispatch rows and printed "OK — all writers targeting the live board".
  // Reporting health on absent evidence is the precise failure this module was
  // written to catch, so it is a distinct status that can never be mistaken
  // for a pass — and it is an error, because a watchdog that cannot see is a
  // watchdog that is not running.
  if (blind) {
    return {
      status: 'error',
      name: HEALTH_ROW_NAME,
      message: `Board-targeting check could not read ${primaryLedger || 'the dispatch ledger'} — it is blind, not clean. No verdict was produced.`,
      hint: 'Run it on the Mac that owns the ledger: node scripts/audit-board-targeting.js',
      generatedAt: new Date(now).toISOString(),
      details: { blind: true, primaryLedger, writers: [], exemptEvents: [], coverage: coverage || null },
    };
  }

  const failing = (writerAudit && writerAudit.failing) || [];
  const parts = [];
  const hints = [];

  for (const w of failing) {
    parts.push(`"${w.event}" ${w.reason}`);
    hints.push(`node scripts/audit-board-targeting.js --json   # inspect "${w.event}"`);
  }

  if (coverage && coverage.verdict === 'fail') {
    parts.push(coverage.reason);
    hints.push('node scripts/linear-next.js --list   # the live board the fleet should be draining');
  }

  const status = parts.length ? 'error' : 'ok';
  const name = HEALTH_ROW_NAME;

  let message;
  if (status === 'error') {
    message = `Fleet automation is not working the live ${LIVE_BOARD} board: ${parts.join('; ')}.`;
  } else {
    const audited = writerAudit ? writerAudit.auditedEvents : 0;
    const clearing = ((writerAudit && writerAudit.writers) || []).filter((w) => w.verdict === 'clearing');
    const cov = coverage && coverage.verdict !== 'unknown' && coverage.eligibleCount != null
      ? `, ${coverage.eligibleCount} armed live-board issue(s) with ${coverage.neverTouched} never dispatched`
      : (coverage && coverage.verdict === 'unknown' ? `, live-board coverage UNKNOWN (${coverage.reason})` : '');
    message = `All ${audited} audited dispatch writer(s) are targeting the live ${LIVE_BOARD} board${cov}.`;
    if (clearing.length) {
      message += ` ${clearing.length} writer(s) still draining a pre-fix window: ${clearing.map((w) => `"${w.event}"`).join(', ')}.`;
    }
  }

  return {
    status,
    name,
    message,
    hint: hints.length ? hints[0] : null,
    generatedAt: new Date(now).toISOString(),
    details: {
      windowDays: writerAudit ? writerAudit.windowDays : null,
      writers: (writerAudit && writerAudit.writers) || [],
      exemptEvents: (writerAudit && writerAudit.exemptEvents) || [],
      coverage: coverage || null,
    },
  };
}

module.exports = {
  HEALTH_ROW_NAME,
  DEFAULT_WINDOW_DAYS,
  DEFAULT_MIN_BOARD_ROWS,
  DEFAULT_RETIRED_FRACTION_THRESHOLD,
  DEFAULT_RECENCY_HOURS,
  DEFAULT_MIN_ELIGIBLE,
  DEFAULT_NEVER_TOUCHED_THRESHOLD,
  EXEMPT_EVENTS,
  auditWriterBoards,
  auditLiveBoardCoverage,
  summarizeBoardTargeting,
};
