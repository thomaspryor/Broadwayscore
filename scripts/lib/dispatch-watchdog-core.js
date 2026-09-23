/**
 * dispatch-watchdog-core — pure decision functions for the dispatch ownership
 * watchdog (owner escalation 2026-08-06, card 3b4637c5-416f-810a: sessions
 * dispatch children, declare CLOSE ME, and nobody verifies the children land;
 * four appointed supervisor SESSIONS — #696/#706/#708/#877 — all rotted,
 * because a session cannot own something that outlives it).
 *
 * Division of authority (plan-review 2026-08-06, closes three of its P0s):
 *   - bsc-prune.js is the ONLY writer of death facts ('dead'/'vanished'/
 *     'prune-closed'), with its restart/epoch circuit breakers. This module
 *     never infers death from a cmux listing — an empty or partial listing
 *     therefore cannot mass-classify the fleet abandoned here.
 *   - autonomous-acceptance-recheck.js is the ONLY verifyCmd runner. This
 *     module surfaces its recent failures; it never re-runs commands itself.
 *   - This module decides: which ledger-confirmed-dead dispatches to RETRY,
 *     which to PARK, which pending P0/P1 cards nobody dispatched to DISPATCH,
 *     and what the crowned OWNER tab should say. The CLI shell
 *     (scripts/dispatch-watchdog.js) does all I/O.
 *
 * All watchdog actions are journaled to the shared dispatch ledger (one
 * ledger, one guard — same doctrine as JOB_EVENTS there) as:
 *   'watchdog-redispatch' {taskId}  claimed BEFORE the child bsc-next spawn,
 *                                   so budgets survive a crash mid-dispatch
 *   'watchdog-park'       {taskId}  retries exhausted; needs the owner. Also
 *                                   written on the FIRST attempt when the
 *                                   child's own dispatch guard refuses in a
 *                                   way structuralGuardRefusal recognizes as
 *                                   permanent (BRO-3481) — retrying a guard
 *                                   that will refuse identically every time
 *                                   only burns day-budget claims, so this
 *                                   case skips straight to parked rather than
 *                                   waiting for retries to exhaust.
 *   'watchdog-resurrect'  {taskId:'watchdog', workspaceRef, gapMs}  the
 *                                   crowned tab was recreated after a gap
 * All are excluded from bsc-prune/bsc-next semantics (unknown events are
 * ignored by every existing fold).
 */
'use strict';

const {
  TERMINAL_LAUNCH_EVENTS, TERMINAL_JOB_EVENTS, foldJobs, JOB_EVENTS,
  openTaskWorkspaceLaunches, dispatchCapDecision, parkedTasks,
  detectLauncherOutage, detectLauncherFailureRate, FAILURE_RATE_LOOKBACK_MS,
  newestRowForTask,
} = require('./dispatch-ledger.js');
const { isExcludedCategory } = require('./autonomous-eligibility.js');
const { isLiveBoardTaskId } = require('./task-id-namespace.js');
// R5 (BRO-3924): the repo's ONE spend circuit breaker (already reused by
// scripts/linear-drain-parked.js and scripts/lib/digest-autofix.js for their
// own, much smaller-scale drains) — never a private watchdog-only dollar sum.
const { computeSpendCircuitBreaker, DEFAULT_SPEND_THRESHOLD_USD, DEFAULT_CONCURRENCY_CAP } = require('./backlog-drain.js');
// Precise per-claim → per-job correlation (same mechanics linear-drain-
// parked.js's reconcileOutcomes and digest-autofix.js already reuse for the
// identical "did MY dispatch turn into a job, and what did IT cost" question
// — BRO-2542's shared reconcile loop, not a fourth hand-rolled fold).
const dispatchReconcile = require('./dispatch-reconcile.js');

const WATCHDOG_EVENTS = Object.freeze({
  REDISPATCH: 'watchdog-redispatch',
  PARK: 'watchdog-park',
});

// BRO-3481: a curated allow-list, NOT a general parser of dispatcher stderr.
// A first draft of this scanned any "REFUSING ...:" line — second-opinion
// review caught that this matches 25+ call sites across linear-next.js and
// bsc-next.js, several of which are transient/self-resolving (a succession
// lock held but not stale, a dispatch-claim race, "a claude process is
// STILL ALIVE" — all of which should keep retrying, not park forever on
// their first occurrence). These two phrases are the only ones this ticket
// is actually about: a genuinely PERMANENT refusal that will read the same
// way on every future retry until either the underlying state changes or
// someone passes --force. Both are literal substrings of messages a test
// already pins byte-for-byte (linear-next.js's idempotency guard message at
// ~849, checkTerminalStateGuard's own return string in linear-dispatch.js) —
// a wording change to either breaks its own test before it can silently
// break this.
const STRUCTURAL_REFUSAL_PHRASES = [
  'it already looks dispatched',
  'is already in a terminal state',
];

// Codex adversarial review (BRO-3481): "it already looks dispatched" is
// printed by the SAME line (linear-next.js:849) whether the refusal came
// from a stale historical comment (the permanent case this ticket is about)
// OR from hasLiveLedgerEntry finding a genuinely LIVE concurrent dispatch
// (linear-next.js:842-858's own two-branch detail print) — which is NOT
// permanent, it resolves on its own once that live dispatch finishes.
// Parking the live-dispatch case would be actively harmful: nothing but a
// NEW launch clears a watchdog-park row (watchdogParkedIds below), so
// legitimate future work on that task would stay suppressed even after the
// concurrent dispatch completes. Only the ledger detail line below is
// printed on the live-ledger branch — its absence is how this tells the two
// apart, failing toward "not structural" (keep retrying) when ambiguous.
const LIVE_LEDGER_DETAIL_MARKER = 'Local dispatch ledger has a live';

// Extracts the guard's own refusal LINE (not the whole multi-line stderr
// blob some of these guards print extra detail under) from a dispatch
// child's captured output, or null if nothing in the curated list matched.
function structuralGuardRefusal(output) {
  const text = String(output || '');
  for (const phrase of STRUCTURAL_REFUSAL_PHRASES) {
    const idx = text.indexOf(phrase);
    if (idx === -1) continue;
    if (phrase === 'it already looks dispatched' && text.slice(idx, idx + 500).includes(LIVE_LEDGER_DETAIL_MARKER)) continue;
    const lineStart = text.lastIndexOf('\n', idx) + 1;
    const lineEnd = text.indexOf('\n', idx);
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
    return (line || phrase).slice(0, 300);
  }
  return null;
}

// BRO-2318: the fixed lead-in of the failureRate hold string below, exported
// so send-morning-digest.js's localDispatchWatchdogLeakMessage() can match
// against the SAME literal instead of a second regex copy that silently
// drifts if this wording ever changes.
const LAUNCHER_LEAK_HOLD_PREFIX = 'cmux launcher leaking';

// How long the dispatch-watchdog-off kill switch can sit engaged before
// --health pages the owner ("is this still intentional?") — distinct from
// the stale-HEARTBEAT page in health(), which only fires while the watchdog
// is enabled. Sibling pattern: scripts/lib/monitor-lock-staleness.js (same
// mtime/injectable-now/exported-threshold shape, one file earlier). Picked
// at the midpoint of the card's suggested 6-24h range: long enough that a
// deliberate short maintenance window doesn't false-page, short enough to
// catch a forgotten switch well inside the ~66h the 2026-08-14 incident ran.
const KILL_SWITCH_STALE_MS = 24 * 3600 * 1000;

// Pure: the CLI shell (dispatch-watchdog.js) stats the kill-switch file and
// passes its mtime in. offFileMtimeMs is null when there's nothing to check
// (e.g. disabled via the DISPATCH_WATCHDOG_DISABLED env var, which has no
// backing file) — never stale in that case, since there's no "how long has
// this sat here" to measure.
function killSwitchStaleness(offFileMtimeMs, now) {
  if (offFileMtimeMs == null || !Number.isFinite(offFileMtimeMs)) return { stale: false, ageMs: null };
  const ageMs = now - offFileMtimeMs;
  return { stale: ageMs > KILL_SWITCH_STALE_MS, ageMs };
}

// Spend caps (plan-review consensus): small per-sweep step, bounded day
// budget, bounded watchdog-origin concurrency, and a global ceiling on
// auto-dispatched tabs so the watchdog can never be the thing that floods
// the owner's sidebar. All surfaced in every sweep result — never silent.
//
// BRO-3390 — two changes, both driven by the owner's 2026-09-15 mandate
// ("six at a time; whenever one is done another should start"):
//
//   watchdogConcurrent 3 -> 6. This is the owner's literal "six at a time".
//   It is SPEND-NEUTRAL: perDay counts claims and remains the binding term,
//   so the same bounded number of jobs simply runs six-wide instead of
//   three-wide and clears sooner. What it does cost is RAM — six concurrent
//   headless sessions rather than three. Measured on this Mac 2026-09-15:
//   44 live claude processes totalling 6.9GB (mean 162MB), swap 85% used.
//   The marginal ~0.5GB of three extra headless jobs is small next to the
//   tab count, and headless needs no cmux terminal runtime, so it also
//   sidesteps the BRO-2709 ceiling that the cmux lane hits.
//
//   perHour is NEW, and it is what actually makes the drain continuous.
//   perSweep=2 on a 90-second --dashboard loop drains the ENTIRE perDay
//   budget in about nine minutes, after which the watchdog idles for 23+
//   hours. That is a once-a-day burst wearing a continuous drain's clothes,
//   and it is a large part of why the owner perceives no progress: whatever
//   the drain does, it does at 4am in one clump. Pacing the same budget
//   across the day turns it into the visible trickle that was actually
//   asked for. Derived from perDay rather than set independently so the
//   owner keeps ONE money dial: raising perDay widens the hourly allowance
//   proportionally, and the two can never contradict each other.
// 24 -> 400 on the owner's explicit instruction, 2026-09-15 ("Get all the P1s
// and P0s dispatched now"), with 135 eligible P0/P1 cards in the queue.
//
// 400 is deliberately ABOVE anything the drain can physically reach, which
// makes watchdogConcurrent (6) the real governor instead of an artificial day
// cap: at a median job of 22 minutes, six slots produce roughly 16/hour, so
// the day budget stops binding and the queue drains continuously until it is
// empty. That is what "dispatch them all now" means on a machine that cannot
// run 135 sessions at once (measured at the time: swap 94.5%, 681MB physical
// free, 44 live claude processes at 7.9GB — 135 concurrent would OOM the box,
// not drain the backlog).
//
// perDay is STILL the money dial and still bounds a runaway: a crash loop
// cannot exceed 400 claims/day. Lower it back to ~24 once the backlog is
// drained; the drain self-tapers anyway, because an empty queue dispatches
// nothing (toDispatch slices an empty p01Queue).
//
// Previous note, kept because the arithmetic still applies:
// 12 -> 24 on the owner's explicit approval, 2026-09-15 ("24/day sounds good"),
// after being shown the arithmetic: mean $7.47/job (median $6.16, p90 $16.92)
// across 382 completed jobs since 2026-08-16, so ~$180/day against ~$90/day.
// The old 12 was sized for a 3-wide cmux lane; with watchdogConcurrent now 6
// and a median job of 22 minutes, 12/day left the six slots empty most of the
// day and perDay — not concurrency — was the thing actually throttling the
// drain. THIS IS THE MONEY DIAL: it bounds claims per local day and nothing
// else does. Lower it first if spend needs to come down.
const PER_DAY_DEFAULT = 400;
const PACING_HOURS = 8;              // spread the day budget over a working day, not 24h of dribble
const CAPS = Object.freeze({
  perSweep: 2,
  watchdogConcurrent: 6,
  perDay: PER_DAY_DEFAULT,
  perHour: Math.max(1, Math.ceil(PER_DAY_DEFAULT / PACING_HOURS)),
  globalAutoTabs: 12,
});

function round2(n) { return Math.round(n * 100) / 100; }

// Subagent review (BRO-3924): a single corrupted/negative costUSD ledger row
// would otherwise pass straight into spentUSD's sum and OFFSET legitimate
// positive spend from other rows — a money guard silently suppressing its
// own halt is the one direction it must never fail toward.
function positiveUSD(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function median(nums) {
  if (!nums || !nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// R5 (BRO-3924): DEFAULT_SPEND_THRESHOLD_USD ($12) is sized for backlog-
// drain.js's own DEFAULT_CONCURRENCY_CAP (2). Reused UNSCALED here it would
// trip on ordinary steady state, not just genuine failure: at
// CAPS.watchdogConcurrent (6) and a real trailing-median job cost, the
// in-flight reservation alone (see watchdogSpendBreaker below) crosses $12
// with as few as two concurrent claims — nowhere near "six at a time,
// whenever one is done another starts" (CAPS's own header, BRO-3390).
// Scaled by the SAME ratio of two already-existing constants rather than a
// new invented number — the ticket forbids a new CAPS.usdPerDay field, and
// this is not one: it is a derived read of the one shared default.
const WATCHDOG_SPEND_THRESHOLD_USD = round2(DEFAULT_SPEND_THRESHOLD_USD * (CAPS.watchdogConcurrent / DEFAULT_CONCURRENCY_CAP));

const SPEND_MEDIAN_WINDOW_MS = 7 * 24 * 3600 * 1000;
// Cold-start fallback (no job-done row with a positive costUSD in the
// trailing window — a quiet week, a fresh ledger, or a run of pure
// failures): median() would return 0, which would zero out the in-flight
// reservation below exactly when history can least rule out a crash loop —
// the one case this guard exists for. Same $6.16 median this file's own
// CAPS comment already cites (382 completed jobs since 2026-08-16), not a
// new figure.
const FALLBACK_JOB_COST_USD = 6.16;

// Fleet-wide (every job-done row, not just watchdog-claimed ones): the
// watchdog dispatches through the exact same bsc-next.js/linear-next.js
// machinery as every other drain, so recent fleet-wide cost is the best
// available estimate of what an in-flight watchdog claim will cost before
// its OWN job-done lands — and watchdog-only job-done history is far
// sparser, making a median over few points noisy. (Known imprecision, not
// fixed here: this blends the cmux/Notion lane's cost distribution with the
// headless/Linear lane's, which BRO-3404's header already notes differ in
// reliability; the Notion lane is largely frozen so the skew is small.)
function medianJobCostUSD(entries, now) {
  const cutoff = now - SPEND_MEDIAN_WINDOW_MS;
  const costs = [];
  for (const job of foldJobs(entries).values()) {
    // Codex/subagent review (BRO-3924): DONE-only sampling is backwards for
    // the exact scenario this guard exists to catch — a crash loop produces
    // job-failed rows (bsc-runner.js still records their real costUSD) and
    // NO job-done rows, so a DONE-only median would fall back to the
    // cold-start figure for the very claims that are actively spending,
    // understating the reservation right when it matters most. Any
    // TERMINAL_JOB_EVENTS outcome with a real cost counts.
    if (!job || !TERMINAL_JOB_EVENTS.has(job.event)) continue;
    const ts = Date.parse(job.ts || '');
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const usd = Number(job.costUSD);
    if (Number.isFinite(usd) && usd > 0) costs.push(usd);
  }
  const m = median(costs);
  return m > 0 ? m : FALLBACK_JOB_COST_USD;
}

// Generous grace window for classifyDispatches' orphan/retry-timeout
// detection below — well past DISPATCH_TIMEOUT_MS (dispatch-watchdog.js's
// 15-minute hard kill of a wedged child) plus its own verify overhead. This
// is a STATELESS read (see watchdogSpendRows — nothing is ever written
// back), so an over-generous window only means a genuinely-orphaned claim
// takes longer to stop being re-evaluated as "might still spawn"; it can
// never misclassify a still-legitimately-running job, because that case is
// caught separately (TERMINAL_JOB_EVENTS check inside classifyDispatches).
const SPEND_ORPHAN_TIMEOUT_H = 1;

// R5: reconcile this watchdog's OWN claims (WATCHDOG_EVENTS.REDISPATCH rows)
// into backlog-drain.js's spend vocabulary ({ts, event:'card-pass'|
// 'card-fail', usd}) — the same fold scripts/linear-drain-parked.js's
// reconcileOutcomes (linear-drain-parked.js:339-403) already does for its
// own drain, reusing dispatch-reconcile.js's classifyDispatches instead of a
// hand-rolled "any taskId this watchdog ever claimed" fold: the naive
// version would attribute a LATER manual `--force` re-dispatch's cost to the
// watchdog (or a stale historical claim's job to a wrong later one) purely
// because the same taskId appears twice in ledger history. classifyDispatches
// correlates each SPECIFIC claim to the SPECIFIC job spawned after it
// (findMyJob's ts-ordered lookup + claimedJobIds' one-job-one-claim guard),
// which is the correlation precision computeConcurrency's own docstring
// already demands ("never counts a manually-run job someone else started").
//
// Deliberately STATELESS: `resolvingEvents` is an empty Set, so nothing is
// ever treated as "already resolved" and every claim in history is
// re-classified fresh on every call. This never writes anything back to the
// ledger (no new event, no Linear comment, no state change — R3's same
// constraint) at the cost of O(all-time claims) per call, which is already
// this file's existing performance shape (watchdogClaimPending,
// dispatchCapDecision and friends all walk the full entries array too).
// Codex adversarial review (BRO-3924): classifyDispatches' findMyJob has NO
// upper time bound — it takes the EARLIEST spawn at or after the claim's ts,
// however far in the future. That is safe for linear-drain-parked.js's own
// reconcileOutcomes because a resolved dispatch stops being re-offered to
// findMyJob at all (isDispatchResolved checks its own PERSISTED
// resolvingEvents). This reconciliation is deliberately stateless — nothing
// is ever written back — so without a bound, a truly-abandoned watchdog
// claim from weeks ago would be re-evaluated on every call forever and could
// silently acquire a much-later, UNRELATED manual dispatch's job: its cost,
// or worse, a spurious 'card-pass' that clears the "zero completions" halt
// on a claim the watchdog itself never actually landed. Bounding the CLAIM
// set to a recent window closes this without touching the shared helper:
// only spend within the last local day can ever matter to today's breaker
// (watchdogSpendBreaker filters to today below), so a claim outside this
// window is simply never offered to classifyDispatches at all — not "found
// and misattributed", just never considered. Wider than one day for margin
// around the local-day boundary and SPEND_ORPHAN_TIMEOUT_H's own grace.
const SPEND_CLAIM_LOOKBACK_MS = 48 * 3600 * 1000;

function watchdogSpendRows(entries, now) {
  const cutoff = now - SPEND_CLAIM_LOOKBACK_MS;
  const isRecentClaim = e => e && e.event === WATCHDOG_EVENTS.REDISPATCH &&
    Number.isFinite(Date.parse(e.ts || '')) && Date.parse(e.ts) >= cutoff;
  const hasClaims = (entries || []).some(isRecentClaim);
  if (!hasClaims) return [];
  const decisions = dispatchReconcile.classifyDispatches({
    ledgerEntries: entries,
    dispatchLedgerEntries: entries,
    isDispatchRow: isRecentClaim,
    resolvingEvents: new Set(),
    orphanTimeoutH: SPEND_ORPHAN_TIMEOUT_H,
    cardIdOf: d => String(d.taskId),
    taskIdOf: d => String(d.taskId),
    now: new Date(now),
  });
  const rows = [];
  for (const { cardId, job, kind } of decisions) {
    // Orphan: no job ever spawned at all — no cost was incurred, same
    // treatment linear-drain-parked.js's own ORPHAN branch gives it.
    if (kind === dispatchReconcile.DECISION_KINDS.ORPHAN) continue;
    if (kind === dispatchReconcile.DECISION_KINDS.RETRY_TIMEOUT) {
      // Codex adversarial review: the resumed chain's own job may already
      // have incurred real cost before it stalled — dropping this silently
      // UNDERSTATED spend exactly where the money guard needs it most. Same
      // field linear-drain-parked.js's own RETRY_TIMEOUT branch records.
      rows.push({ ts: job.ts || null, taskId: cardId, event: 'card-fail', usd: positiveUSD(job.costUSD) });
      continue;
    }
    rows.push({
      ts: job.ts || null,
      taskId: cardId,
      event: job.event === JOB_EVENTS.DONE ? 'card-pass' : 'card-fail',
      usd: positiveUSD(job.costUSD),
    });
  }
  return rows;
}

// R5: the breaker itself. LOCAL calendar day boundary (localDay(), same
// convention watchdogClaimsToday already uses for the day-budget cap) rather
// than computeSpendCircuitBreaker's own rolling 24h windowH — one day
// boundary definition across every cap in this file.
//
// IN-FLIGHT RESERVATION: costUSD only ever lands on a job's TERMINAL event
// (job-done/job-failed), so a claim whose job is still running is invisible
// to spentUSD by construction — a burst of CAPS.watchdogConcurrent (6)
// claims that are all still running commits real, uncounted dollars with
// zero completions ever recorded until the first one finishes. One synthetic
// row, sized at (open watchdog-claimed launches) × (trailing fleet median
// job cost), makes that committed-but-unconfirmed spend visible immediately.
// It is a 'card-fail' row: spendCircuitBreakerStatus sums `usd` across EVERY
// row regardless of event, but only counts 'card-pass'/'auto-approve' toward
// `completions` — so the reservation contributes to spentUSD without ever
// being mistaken for a completion that would wrongly clear the "zero
// completions" halt condition.
function watchdogSpendBreaker(entries, now, opts = {}) {
  const today = localDay(now);
  const terminalRows = watchdogSpendRows(entries, now).filter(r => r.ts && localDay(r.ts) === today);
  const liveNow = watchdogLiveCount(entries);
  const perJobUSD = medianJobCostUSD(entries, now);
  const reservedUSD = liveNow > 0 ? round2(liveNow * perJobUSD) : 0;
  const rows = reservedUSD > 0
    ? [...terminalRows, { ts: new Date(now).toISOString(), taskId: 'watchdog-reservation', event: 'card-fail', usd: reservedUSD }]
    : terminalRows;
  const thresholdUSD = Number.isFinite(opts.thresholdUSD) ? opts.thresholdUSD : WATCHDOG_SPEND_THRESHOLD_USD;
  const breaker = computeSpendCircuitBreaker(rows, { thresholdUSD, now });
  return { ...breaker, liveNow, perJobUSD, reservedUSD };
}

// Tolerate cmux's activity-glyph prefix (braille spinners ⠂/✳ prepended in
// list output — see cmux-workspaces.isDoneTitle) before the marker glyph;
// anchoring on ^\s* alone undercounted 🤖 tabs and made the global ceiling
// leaky (ship-check silent-wrongness finding).
const AUTO_TAB_RE = /^[^\p{L}\p{N}]*🤖/u;
const CROWN_TAB_RE = /^[^\p{L}\p{N}]*👑/u;
// The watchdog's own tab is distinguished from crowned SESSION tabs (the
// context-budget-nudge successor pattern) by this fixed prefix.
const WATCHDOG_TAB_PREFIX = '👑 OWNER';
const WATCHDOG_TAB_MARKER = 'watchdog';

// Priority parse from the task-mirror description's first line, which
// notion-tasks-sync writes as "[notion:<id>] P1 Now · In progress · <cat>".
// Subject fallback catches native tasks titled "P1: ...".
//
// BRO-3390: the source tag is now (notion|linear). scripts/lib/
// linear-watchdog-source.js's mapIssueToTask deliberately emits the SAME
// first-line shape with a "[linear:BRO-N]" tag, so pointing the watchdog at
// the live Linear board costs one widened alternation here rather than a
// second parallel code path. Everything downstream of this function already
// treats taskId as an opaque string.
function taskPriority(task) {
  const desc = String((task && task.description) || '');
  const firstLine = desc.split('\n', 1)[0];
  let m = /^\[(?:notion|linear):[^\]]*\]\s*(P[0-3])\b/.exec(firstLine);
  if (m) return m[1];
  m = /^(P[0-3])\b/.exec(String((task && task.subject) || ''));
  return m ? m[1] : null;
}

// Stable FIFO ordering across BOTH id namespaces (BRO-3390).
//
// The three queues below used to sort with `parseInt(a.taskId, 10) -
// parseInt(b.taskId, 10)`. That is correct for Notion's bare numeric ids and
// silently WRONG for "linear:BRO-3373": parseInt returns NaN, every NaN
// comparison is false, so the comparator reports "equal" for every pair and
// the queue degrades to arbitrary input order — no crash, no warning, just a
// FIFO that stops being a FIFO. Sort on the trailing integer (the part that
// actually increases monotonically in both namespaces) and fall back to a
// string compare so the comparator is always total.
function taskSortKey(taskId) {
  const s = String(taskId == null ? '' : taskId);
  const m = /(\d+)\s*$/.exec(s);
  return { n: m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER, s };
}

// Source rank: Linear before Notion, ALWAYS (BRO-3390 follow-up).
//
// Found by watching production, not by reading: after the first three Linear
// cards drained (BRO-219/931/995, all low-numbered), the next four claims went
// straight back to the Notion mirror (1849, 1904, 1932, 1962). Sorting on the
// trailing integer alone silently ranks Notion's 1800s-1900s ids AHEAD of
// Linear's BRO-2000+, so the drain works the RETIRED board until it exhausts
// four weeks of stale cards. The pre-implementation review flagged this class
// and my own measurement appeared to falsify it — it didn't, it was just
// masked by a handful of low-numbered Linear ids at the head of the queue.
//
// Linear is the live board (CLAUDE.md section 6: "Linear is the source of
// truth — do NOT create Notion cards"). A frozen mirror must never outrank it.
// Within a source the trailing-integer FIFO still applies.
function taskSourceRank(taskId) {
  return /^linear:/.test(String(taskId == null ? '' : taskId)) ? 0 : 1;
}

function compareTaskIds(a, b) {
  const ra = taskSourceRank(a);
  const rb = taskSourceRank(b);
  if (ra !== rb) return ra - rb;
  const ka = taskSortKey(a);
  const kb = taskSortKey(b);
  if (ka.n !== kb.n) return ka.n - kb.n;
  return ka.s < kb.s ? -1 : ka.s > kb.s ? 1 : 0;
}

// Open work in EITHER lane (BRO-3390, ship-check P0).
//
// openTaskWorkspaceLaunches only sees the cmux lane: it requires
// isWorkspaceRef(e.workspaceRef), and dispatch-ledger.js's WORKSPACE_REF_RE is
// /^workspace:\d+$/. A headless dispatch writes workspaceRef
// "headless:linear:BRO-N", which that regex rejects — measured on the real
// ledger, 391 of 618 linear: launch rows are headless. So before this, EVERY
// headless job was invisible here, with two consequences, both silent:
//
//   1. watchdogLiveCount returned 0 for the entire Linear lane, so
//      CAPS.watchdogConcurrent was inert on it — raising 3->6 would have
//      bought nothing because there was no ceiling being enforced at all.
//   2. planSweep's `open` set never contained a running headless task, so a
//      card whose ~22-minute job was still going re-entered the P0/P1 queue
//      and got claimed again. The day budget counts claims, so a single card
//      could eat the day re-dispatching itself.
//
// The headless lane journals its lifecycle by jobId (job-spawned/job-done/...)
// rather than by workspaceRef, so fold THAT and treat a job whose latest event
// is non-terminal as open. Same fold backlog-drain.js's computeConcurrency
// already uses, on the same single ledger.
function openHeadlessJobTasks(entries) {
  const open = new Map();
  for (const job of foldJobs(entries || []).values()) {
    if (!job || job.taskId == null) continue;
    if (TERMINAL_JOB_EVENTS.has(job.event)) continue;
    open.set(String(job.taskId), { workspaceRef: job.workspaceRef || null, subject: job.subject || null, ts: job.ts });
  }
  return open;
}

// Union of both lanes. cmux entries win on collision: their launch row carries
// the workspaceRef the narrative prints.
function openTasksAnyLane(entries) {
  const merged = openHeadlessJobTasks(entries);
  for (const [taskId, launch] of openTaskWorkspaceLaunches(entries || [])) merged.set(taskId, launch);
  return merged;
}

function notionIdOf(task) {
  const m = /^\[notion:([^\]]+)\]/.exec(String((task && task.description) || ''));
  return m ? m[1] : null;
}

// LOCAL calendar day (not UTC — a UTC bucket resets the owner's "12/day"
// cap at ~8pm ET; ship-check P1). Ledger ts values are UTC ISO strings, so
// both sides convert through Date to the machine's local day.
function localDay(tsOrMs) {
  const d = new Date(tsOrMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Watchdog-origin bookkeeping: an entry claims a dispatch attempt; the day
// budget counts claims (not successes) so a crash loop can't spend forever.
// (A claim whose spawn crashes is retryable next sweep by design — the day
// budget is what bounds that retry loop.)
function watchdogClaimsToday(entries, now) {
  const today = localDay(now);
  return entries.filter(e => e && e.event === WATCHDOG_EVENTS.REDISPATCH &&
    e.ts && localDay(e.ts) === today);
}

// Rolling-hour sibling of watchdogClaimsToday (BRO-3390). Deliberately a
// ROLLING 60-minute window rather than a clock-hour bucket: a clock bucket
// lets the drain spend its whole hourly allowance at :59 and the next one at
// :01, which reproduces the burst this pacing exists to remove.
const PACING_WINDOW_MS = 3600 * 1000;
// excludeFuture (2026-09-21): a future-dated row (clock skew, corrupt write)
// satisfies `t >= cutoff` forever. Its two consumers want OPPOSITE safe
// directions, so this is an explicit knob rather than a fixed rule:
//   - hourly pacing (the default, excludeFuture=false) deliberately keeps
//     counting it — over-count => spend less — the same conservative
//     direction watchdogClaimsToday takes, and never the direction that
//     hands back allowance (see the BRO-395-shape test in
//     scripts/tests/dispatch-watchdog-core.test.mjs).
//   - dispatch-flow-health's stall check (excludeFuture=true) must NOT count
//     it: one skewed row would read as "claimed recently" on every tick,
//     for good, and a real stall would never page — the same BRO-395 hazard
//     dispatch-ledger.js's countRecentLaunches already clamps against.
function watchdogClaimsInWindow(entries, now, windowMs = PACING_WINDOW_MS, { excludeFuture = false } = {}) {
  const nowMs = new Date(now).getTime();
  const cutoff = nowMs - windowMs;
  return (entries || []).filter((e) => {
    if (!e || e.event !== WATCHDOG_EVENTS.REDISPATCH || !e.ts) return false;
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t) || t < cutoff) return false;
    return excludeFuture ? t <= nowMs : true;
  });
}

// 2026-09-22 (ship-check): the depth the stall detector's claims path reads.
// Normally plan.toDispatch.length — the work the sweep would claim this
// instant, 0 under every genuine policy pause because budget is 0 there.
// Two global holds zero the budget WITHOUT being innocent, and reading
// toDispatch under them would let the wedge silence its own detector:
//   - claimOutage: a detected failure. By the time it trips, the wedged sweep
//     has usually claimed the whole queue (claimPending drops those cards
//     from p01Queue for 24h), so lane-eligible work alone reads 0 (Codex +
//     reviewer, reproduced through the real planSweep). The stuck claims ARE
//     the unfinished work, so they count.
//   - the concurrency cap, when its oldest live slot is older than
//     staleSlotMs: slots held by launches that never closed (16-19 Sep: five
//     tasks held 5 of 6 slots from 09-16 launches for days) are not pacing.
// Any policy hold alongside them (kill switch, day budget, hourly pacing, the
// spend circuit breaker on REAL spend, a concurrency cap held by FRESH slots, or any global
// hold this function has no flag for) still returns toDispatch, i.e. 0.
// Known gap: a zombie slot something relaunches gets a fresh ts and reads as
// not stale (none of the 16-19 Sep zombies was relaunched).
function stallDetectionDepth(plan, { now, staleSlotMs } = {}) {
  const b = (plan && plan.budgets) || {};
  const f = b.globalHoldFlags || {};
  const toDispatch = (plan && plan.toDispatch) ? plan.toDispatch.length : 0;
  const nowMs = new Date(now == null ? Date.now() : now).getTime();
  // Slots open longer than the claims window. Counted per slot (not "is the
  // oldest stale") so the spend check below can subtract exactly their
  // reservation, and independent of the concurrency cap: five stale slots
  // under a cap of six can still trip the spend breaker (Codex P1).
  const staleSlots = Number.isFinite(staleSlotMs)
    ? (b.liveSlotTimes || []).filter(t => Number.isFinite(t) && nowMs - t >= staleSlotMs).length : 0;
  const staleConcurrency = !!f.concurrency && staleSlots > 0;
  // A global hold this function does not know about (added to planSweep
  // without a flag here) must read as a policy pause, never as a failure:
  // an unknown hold can cost a missed page, never a false one.
  const knownHolds = ['killSwitch', 'dayBudget', 'hourly', 'concurrency', 'claimOutage', 'spendHalt'].filter(k => f[k]).length;
  const unknownHold = Array.isArray(b.globalHolds) && b.globalHolds.length > knownHolds;
  // The spend breaker (BRO-3924 R5) reserves liveNow x median job cost for
  // open slots, so the same never-closed slots that make the concurrency cap
  // stale can trip it on their own (6 zombies x ~$6 > the $36 bar) — and it
  // never releases, because they never close. When the spend WITHOUT that
  // reservation is under the bar and the slots are stale, the halt is the
  // wedge's symptom, not a spend decision. Real spend over the bar stays a
  // policy pause.
  const sp = b.spend || {};
  const spendFromStaleSlots = !!f.spendHalt && staleSlots > 0 &&
    Number.isFinite(sp.spentUSD) && Number.isFinite(sp.perJobUSD) && Number.isFinite(sp.thresholdUSD) &&
    sp.spentUSD - staleSlots * sp.perJobUSD < sp.thresholdUSD;
  const policyBlocking = !!(unknownHold || f.killSwitch || f.dayBudget || f.hourly ||
    (f.spendHalt && !spendFromStaleSlots) || (f.concurrency && !staleConcurrency));
  if (policyBlocking) return toDispatch;
  // Claims that never produced a launch are unfinished work the queue no
  // longer shows (claimPending hides them for 24h). The claims path only
  // reads this when there were ZERO claims in the window, so any still
  // counted here are >= 6h old — the wedge itself, even when unrelated
  // retries keep launching and claimOutage (which needs fleet-wide launch
  // silence) never trips (Codex P1). A healthy sweep parks them after
  // CLAIM_LABEL_GRACE_MS (noLaunchPark), so they do not linger when it runs.
  const stuckClaims = b.awaitingClaimCount || 0;
  if (f.claimOutage || staleConcurrency || spendFromStaleSlots) return stuckClaims + (b.laneEligible || 0);
  return toDispatch + stuckClaims;
}

// Oldest open launch among the slots watchdogLiveCount counts (same claimed-set
// + openTasksAnyLane fold), as epoch ms, or null when there are none.
// Unparseable timestamps are skipped: one NaN would poison the min and read
// every slot as fresh.
function watchdogLiveSlotTimes(entries) {
  const claimed = new Set((entries || [])
    .filter(e => e && e.event === WATCHDOG_EVENTS.REDISPATCH)
    .map(e => String(e.taskId)));
  const times = [];
  if (!claimed.size) return times;
  for (const [taskId, launch] of openTasksAnyLane(entries)) {
    if (!claimed.has(taskId)) continue;
    const t = Date.parse(launch && launch.ts);
    if (Number.isFinite(t)) times.push(t);
  }
  return times.sort((a, b) => a - b);
}

function watchdogLiveOldestTs(entries) {
  const times = watchdogLiveSlotTimes(entries);
  return times.length ? times[0] : null;
}

// Watchdog-origin live concurrency: tasks the watchdog claimed whose latest
// launch is still open (no terminal event) — the cmux-launch analogue of
// backlog-drain's computeConcurrency job fold, on the same single ledger.
function watchdogLiveCount(entries) {
  const claimed = new Set(entries
    .filter(e => e && e.event === WATCHDOG_EVENTS.REDISPATCH)
    .map(e => String(e.taskId)));
  if (!claimed.size) return 0;
  let n = 0;
  for (const [taskId] of openTasksAnyLane(entries)) {
    if (claimed.has(taskId)) n++;
  }
  return n;
}

// How long an unlanded dispatch claim keeps its task out of the sweep before
// the task re-arms on its own. Deliberately a DAY, not the ~90s sweep period:
// the refusals this suppresses are deterministic guard verdicts (a Notion card
// that is closed, PARKED, or REOPEN-SUSPECT), and those only change when a
// human edits the card — a daily-scale event. Long enough that a permanently
// refused card costs one claim a day instead of the whole budget; short enough
// that a genuinely transient failure (wedged cmux, spawn crash, the 15-minute
// DISPATCH_TIMEOUT_MS kill) retries by itself rather than being suppressed for
// good. Sibling constant: bsc-reconcile.js's STALL_COOLDOWN_MS.
const REDISPATCH_REARM_MS = 24 * 3600 * 1000;

// Tasks the watchdog has already claimed a dispatch for whose claim never
// produced a launch — i.e. the child `bsc-next --id N` refused it (a guard
// verdict) or died before it could launch anything.
//
// The whole 2026-07-26/08-19 dispatcher regression (card #1564) lives here.
// executeSweep() journals its REDISPATCH claim BEFORE spawning the child, but
// a refused child journals nothing at all, and planSweep never read its own
// claims back — so the same task was re-selected on every ~90s sweep forever.
// Live evidence: 2026-08-19 14:02-14:09Z, twelve consecutive claims across
// only #1759 and #586 (both REOPEN-SUSPECT per `node scripts/predispatch-
// check.js --id N`, which is what made bsc-next exit 1 in about a second) spent
// the ENTIRE perDay budget in eight minutes and produced zero launches,
// starving every genuinely dispatchable P0/P1 for the rest of the day. Same
// shape 08-18 05:00-05:06Z (9 claims) and 08-17 04:17-04:26Z (7); historically
// task 383 reached 56 claims.
//
// This is exactly the doctrine bsc-reconcile.js's stall sweep already follows
// — it stamps STALL_EVENT before its own spawn precisely so that "whether
// bsc-next accepts or refuses (parked card, card-gate rejection), the outcome
// is recorded once ... a refusal must not re-fire every tick"
// (bsc-reconcile.js:428-431). The watchdog was already stamping the identical
// marker; it simply never consulted it. No new ledger event is needed.
//
// A later 'launch' re-arms the task — the same self-healing rule
// watchdogParkedIds() and parkedTasks() use — which is also why this doubles
// as a boot-window duplicate guard: a claim whose child is still booting (a
// launch legitimately takes minutes) no longer gets re-picked by the next
// sweep before its 'launch' row lands. That boot-window re-pick is the
// duplicate-workspace-pair generator card #1564 reported.
// Compared by MAX parsed timestamp, deliberately not by last-row-in-file
// (the convention openTaskWorkspaceLaunches uses). Nothing serialises writes
// to this ledger across processes — the sweep, bsc-reconcile and bsc-prune
// all append concurrently — so a process can stamp its ts, be preempted, and
// land its row after newer ones. Taking the last row in FILE order would then
// read an older ts as "latest" and could either re-arm a fresh claim early or
// suppress a card whose launch already landed (adversarial-review catch).
// Rows with an unparseable ts are ignored rather than coerced to epoch 0.
function watchdogClaimPending(entries, now) {
  const lastClaim = new Map();
  const lastLaunch = new Map();
  const keepMax = (map, id, ms) => {
    const prev = map.get(id);
    if (prev == null || ms > prev) map.set(id, ms);
  };
  for (const e of entries || []) {
    if (!e || e.taskId == null || !e.ts) continue;
    const id = String(e.taskId);
    if (id === WATCHDOG_TAB_MARKER) continue;      // 'watchdog-resurrect' rows are not a task
    const ms = Date.parse(e.ts);
    if (!Number.isFinite(ms)) continue;
    if (e.event === WATCHDOG_EVENTS.REDISPATCH) keepMax(lastClaim, id, ms);
    else if (e.event === 'launch') keepMax(lastLaunch, id, ms);
  }
  // A Map, not a Set: callers need the claim's AGE as well as its identity
  // (the boot-window grace below, and any future backoff).
  const pending = new Map();
  for (const [id, claimMs] of lastClaim) {
    const launchMs = lastLaunch.get(id);
    if (launchMs != null && launchMs >= claimMs) continue;      // the claim landed
    // BRO-395: a future-dated claimMs must never read as "just claimed" —
    // `now - claimMs < REDISPATCH_REARM_MS` alone is satisfied forever by a
    // future timestamp (now-claimMs negative, always < a positive window),
    // which would wedge this task claim-pending permanently and silently
    // block every downstream consumer (dispatchCapDecision, the
    // awaitingClaim label below) from ever seeing it as stale.
    if (claimMs > now) continue;
    if (now - claimMs < REDISPATCH_REARM_MS) pending.set(id, claimMs);
  }
  return pending;
}

// A dispatch legitimately takes minutes to produce its 'launch' row, and the
// sweep runs every ~92s — so a perfectly healthy dispatch is claim-pending for
// a while. Suppression applies immediately (that IS the boot-window duplicate
// guard), but the owner-facing "I tried and could not start" LABEL waits this
// long, or every successful dispatch would be announced as a failure first
// (ship-check P1). Comfortably past cmux-launch's own verify windows.
const CLAIM_LABEL_GRACE_MS = 15 * 60 * 1000;

// The suppression above is per-card and deliberately quiet. But there is one
// failure shape where quiet is dangerous: cmux-launch returns { ok:false }
// with NO workspaceRef when the cmux CLI is missing, the auth preflight
// fails, or `cmux new-workspace` exits non-zero — and failedLaunchEntries()
// returns [] for a ref-less failure (dispatch-ledger.js:403), so those write
// NO ledger row at all. Every claim then looks exactly like a guard refusal,
// and detectLauncherOutage() cannot see it either (it keys on 'dead' rows
// carrying "injection never ran"). Without this check a wedged launcher would
// silently stall the whole fleet for a day instead of storming the budget
// (ship-check P0).
//
// The discriminator is fleet-wide, not per-card: several cards claimed and
// NOTHING launched anywhere. A run of genuinely refused cards is common (the
// top of the P0/P1 queue can hold several REOPEN-SUSPECT cards) — but during
// one, other dispatches still land, so lastLaunchAnyMs stays fresh. Zero
// launches from ANY source across the window is the launcher itself.
const CLAIM_OUTAGE_MIN = 3;                       // > CAPS.perSweep: not one bad sweep
const CLAIM_OUTAGE_WINDOW_MS = 2 * 3600 * 1000;

function lastLaunchAnywhereMs(entries) {
  let latest = null;
  for (const e of entries || []) {
    if (!e || e.event !== 'launch' || !e.ts) continue;
    const ms = Date.parse(e.ts);
    if (Number.isFinite(ms) && (latest == null || ms > latest)) latest = ms;
  }
  return latest;
}

// Has this task already been watchdog-parked since its most recent launch?
// (pre-mortem P0: without this memory, a parked card is re-parked and
// re-alerted every 90s forever). A newer 'launch' clears the park — same
// self-healing rule parkedTasks() uses for 'vanished'.
function watchdogParkedIds(entries) {
  const parked = new Set();
  for (const e of entries || []) {
    if (!e || e.taskId == null) continue;
    const id = String(e.taskId);
    if (e.event === WATCHDOG_EVENTS.PARK) parked.add(id);
    else if (e.event === 'launch') parked.delete(id);
  }
  return parked;
}

// A task's latest launch ended in a ledger-confirmed retryable death: last
// launch has a 'dead' AT/after it as its most recent terminal event.
// 'vanished' (owner closed the tab — an owner SIGNAL, never retried here),
// 'prune-closed' (finished) and 'remapped' (superseded ref) are all
// non-retryable by construction (plan-review P0: terminal reason matters).
function lastTerminalEventForTask(taskId, entries) {
  const id = String(taskId);
  let lastLaunchTs = null;
  for (const e of entries) {
    if (e && e.event === 'launch' && String(e.taskId) === id) lastLaunchTs = e.ts || lastLaunchTs;
  }
  if (!lastLaunchTs) return null;
  let term = null;
  for (const e of entries) {
    if (e && String(e.taskId) === id && TERMINAL_LAUNCH_EVENTS.has(e.event) &&
        e.ts && e.ts >= lastLaunchTs) term = e;
  }
  return term;
}

function isTaskOpen(task) {
  return !!task && (task.status === 'pending' || task.status === 'in_progress');
}

// BRO-4076: ledger events meaning a task's newest dispatch attempt already
// reached a terminal, nothing-left-to-do outcome, so the p01-backlog sweep
// must not re-select it even though the task mirror still reads 'pending'
// (ack-landed.js's landed-acked row is a Linear COMMENT, not a state change —
// same blind spot for any future writer that lands a job-done row without
// moving the issue). NOT a claim that the work is verified-landed on
// origin/main — job-done alone is exactly what BRO-3424's separate
// unlandedDone/unlandedJobDone check above exists to re-verify by git
// ancestry; this only says "the watchdog itself has nothing further to
// dispatch," the same judgment ack-landed-core.js's NOTHING_TO_ACK_EVENTS
// already makes for its own idempotency guard.
const NO_FURTHER_DISPATCH_EVENTS = new Set([
  JOB_EVENTS.DONE, JOB_EVENTS.LANDED_ACKED, JOB_EVENTS.LANDED_BEFORE_DISPATCH,
]);

function hasNoFurtherDispatchWork(taskId, entries) {
  const newest = newestRowForTask(taskId, entries);
  return !!(newest && NO_FURTHER_DISPATCH_EVENTS.has(newest.event));
}

/**
 * The sweep decision. Everything the CLI needs to act, plus everything the
 * dashboard needs to render, from pure inputs:
 *
 * @param {object[]} entries   full dispatch-ledger rows
 * @param {Map<string,object>} tasks  task mirror incl. archive (id -> task)
 * @param {object} opts
 *   - now (ms epoch, required — Date.now is banned in some callers)
 *   - liveTitles: Map<ref,title> from a SUCCESSFUL cmux listing, or null when
 *     cmux was unobservable (degraded mode: report-only, never dispatch)
 *   - recheckFailures: [{taskSubject, notionId, ts}] recent verifyCmd
 *     failures from the nightly acceptance-recheck ledger (surfaced, not run)
 *   - alreadyPasses: [{id, name, verifyCmd, detail}] BRO-3551's open-backlog
 *     sweep report — Linear cards whose OWN acceptance command already
 *     passes on main (BRO-3924, R3). Surfaced under needsYou/renderNarrative
 *     only; the exclusion from the dispatch queue itself already happened
 *     upstream, in linear-watchdog-source.js's ineligibleReason.
 *   - dispatchEnabled: false = visibility only (kill-switch file)
 *   - unlandedJobDone: [{taskId, jobId, cwd, sha}] from
 *     headless-unlanded-detection.js's findUnlandedJobDoneEntries() — jobs
 *     the ledger already marked job-done whose commits never reached
 *     origin/main (BRO-3424). Computed by the CLI (git ancestry checks —
 *     I/O), same injection pattern as liveTitles, so this stays pure.
 */
function planSweep(entries, tasks, opts) {
  const { now, liveTitles = null, recheckFailures = [], alreadyPasses = [], dispatchEnabled = true, unlandedJobDone = [] } = opts || {};
  if (!Number.isFinite(now)) throw new Error('planSweep requires now (ms epoch)');
  const cmuxObserved = liveTitles instanceof Map && liveTitles.size > 0;

  // ── classify open launches ──
  const open = openTasksAnyLane(entries);
  const inFlight = [];
  for (const [taskId, launch] of open) {
    const task = tasks.get(taskId);
    if (task && task.status === 'completed') continue; // landed
    inFlight.push({
      taskId,
      workspaceRef: launch.workspaceRef,
      subject: launch.subject || (task && task.subject) || null,
      launchedAt: launch.ts || null,
      listed: cmuxObserved ? liveTitles.has(launch.workspaceRef) : null,
    });
  }

  // ── retry candidates: ledger-confirmed dead, still-open task ──
  const ownerParked = parkedTasks(entries);        // 'vanished' = owner signal
  const wdParked = watchdogParkedIds(entries);
  const claimPending = watchdogClaimPending(entries, now);   // #1564
  const outage = detectLauncherOutage(entries, { now });
  // BRO-2318: independent of `outage` above — a launcher that drops roughly
  // 1-in-3 dispatches, with a verified success always following the next
  // death within minutes, reports outage.recovered=true forever (every
  // window's newest event is a success). This is a separate signal that
  // does not require the newest event to be a failure to alarm.
  const failureRate = detectLauncherFailureRate(entries, { now });

  // ── headless jobs that ended THIS SESSION: CLOSE ME|IDLE — BLOCKED: (BRO-3442) ──
  // Computed HERE (before retryable/p01Queue below) so both can exclude a
  // task this sweep is about to park — without that, the SAME sweep both
  // parks a task (with "not retried automatically" in the reason/comment)
  // and dispatches it via the P0/P1 backlog queue, since planSweep computes
  // toDispatch independently of jobBlocked (adversarial review catch).
  //
  // Grouped by LATEST job per task (by ts), not "any folded job with a
  // BLOCKED event": foldJobs() is keyed by jobId, and a task can accumulate
  // several jobIds over time (retries/resumes). Filtering on "any job ever
  // BLOCKED" would re-park a task whose blocker was already resolved and
  // superseded by a later, successful jobId (adversarial review catch) —
  // only the task's most recent job's own verdict is the current one.
  const latestJobByTask = new Map();
  for (const job of foldJobs(entries).values()) {
    if (!job || job.taskId == null) continue;
    const id = String(job.taskId);
    const ts = Date.parse(job.ts || '') || 0;
    const cur = latestJobByTask.get(id);
    if (!cur || ts >= cur.ts) latestJobByTask.set(id, { ...job, ts });
  }
  const jobBlocked = [];
  for (const [id, job] of latestJobByTask) {
    if (job.event !== JOB_EVENTS.BLOCKED) continue;
    const task = tasks.get(id);
    if (!isTaskOpen(task)) continue;          // card already closed
    if (open.has(id)) continue;               // a newer launch superseded this
    if (ownerParked.has(id) || wdParked.has(id)) continue;
    // BRO-3437: a job dispatched against the retired Notion mirror (any
    // bare-numeric id) has no live card the owner can act on — parking it
    // writes a watchdog-park ledger row for work nobody is tracking.
    // board-targeting-audit.js measured this writer at 100% retired-board
    // ids over 7 days, most recently <1h old. retryable/toPark (the 'dead'
    // loop above) and p01Queue already carry this same gate; this loop was
    // the gap — jobBlocked folds every job-lifecycle ledger row regardless
    // of which board originally dispatched it.
    if (!isLiveBoardTaskId(id)) continue;
    jobBlocked.push({ taskId: id, subject: task.subject, jobId: job.jobId, reason: job.reason || null });
  }
  jobBlocked.sort((a, b) => compareTaskIds(a.taskId, b.taskId));
  const blockedTaskIds = new Set(jobBlocked.map((j) => j.taskId));

  const retryable = [];
  const toPark = [];
  const seen = new Set();
  for (const e of entries) {
    if (!e || e.event !== 'dead' || e.taskId == null) continue;
    const id = String(e.taskId);
    if (seen.has(id)) continue;
    seen.add(id);
    const task = tasks.get(id);
    if (!isTaskOpen(task)) continue;
    // BRO-3633: same policy as the p01Queue guard below — a task that has
    // since aged into archive/ was deliberately taken out of active
    // circulation, so a dead dispatch against it should not be auto-retried
    // either. (The measured 89% board-targeting failure was the p01Queue
    // path specifically; this is the same policy applied consistently to
    // dead-retry, not itself separately measured.)
    if (task && task.fromArchive) continue;
    // BRO-3878 (Codex ship-check catch): the p01Queue exclusion above only
    // stops FRESH claims against the frozen Notion mirror — a mirror task
    // that already died once still reached this retry loop and generated a
    // NEW watchdog-redispatch claim every time it re-died, which is exactly
    // the claim traffic the ticket's acceptance criterion rules out ("no
    // claims against ~/.claude/tasks/broadwayscore ids"). Retryable and
    // toPark are the same candidate pool split only by dispatchCapDecision
    // below, so excluding here closes both at once — a dead mirror card now
    // neither auto-retries nor generates a fresh park; it was already frozen
    // board work the owner was told to migrate, not track here.
    if (!isLiveBoardTaskId(id)) continue;
    if (open.has(id)) continue;                    // a newer launch is running
    if (ownerParked.has(id) || wdParked.has(id)) continue;
    if (blockedTaskIds.has(id)) continue;          // BRO-3442: about to be parked this sweep
    if (claimPending.has(id)) continue;            // #1564: claimed, never landed — don't re-claim every sweep
    // Human-territory cards are excluded here too, not just in the P0/P1
    // backlog sweep below (ship-check catch on task #1154). Retry only needs a
    // PRIOR dead launch to fire, so without this a card that was dispatched
    // once — before the marker existed, or by an explicit owner --id — gets
    // re-launched unattended forever by dead-session recovery. That is exactly
    // the Sarah check-in shape: launched 2026-07-25, then re-dispatched twice
    // more by the watchdog. Retry goes through `bsc-next --id`, which skips
    // actionable()'s filter entirely, so this is the only place to stop it.
    if (isExcludedCategory(task)) continue;
    const term = lastTerminalEventForTask(id, entries);
    if (!term || term.event !== 'dead') continue;  // vanished/prune-closed/remapped: not ours
    // Card #1233: substantive deaths only count toward the park threshold —
    // cmux's terminal-surface-never-rendered failures are free retries here
    // too, bounded instead by dispatchCapDecision's own infra ceiling.
    // `reason` rides along on the item so every downstream consumer (the
    // digest line below, and the owner-paged message in dispatch-watchdog.js)
    // can tell an infra park apart from a substantive one — `deaths` alone
    // would read as "parked after 0 dead dispatch attempts" for a task
    // parked purely on the infra ceiling, since cap.substantive.length is 0
    // in that case (ship-check catch).
    const cap = dispatchCapDecision(id, entries);
    const item = {
      taskId: id, subject: task.subject,
      deaths: cap.reason === 'infra' ? cap.infra.length : cap.substantive.length,
      reason: cap.reason,
    };
    if (cap.blocked) toPark.push(item);
    else retryable.push(item);
  }
  retryable.sort((a, b) => compareTaskIds(a.taskId, b.taskId));

  // ── job-done tasks whose work never reached origin/main (BRO-3424) ──
  // Report-only, deliberately NOT added to toDispatch: dispatchCapDecision/
  // REDISPATCH_REARM_MS bound the DEAD-launch retry loop above, but nothing
  // yet bounds an UNLANDED-retry loop — a redispatch whose new session hits
  // the exact same "reported done, never landed" pattern would spin forever
  // with no existing counter to catch it (a job-done job is, by definition,
  // not `isDeadlikeEvent`). Auto-redispatch-with-a-cap is a follow-up; this
  // surfaces the problem to the owner instead, same treatment `toPark` and
  // `awaitingClaim` already get.
  const unlandedDone = [];
  for (const item of unlandedJobDone) {
    if (!item || item.taskId == null) continue;
    const id = String(item.taskId);
    const task = tasks.get(id);
    if (!isTaskOpen(task)) continue;          // card already closed — reconcile-landed-but-open's territory, not ours
    if (open.has(id)) continue;               // a newer launch is already running — its own outcome will resolve this
    if (ownerParked.has(id) || wdParked.has(id)) continue;
    unlandedDone.push({ taskId: id, subject: task.subject, jobId: item.jobId, cwd: item.cwd, sha: item.sha });
  }
  unlandedDone.sort((a, b) => compareTaskIds(a.taskId, b.taskId));

  // ── undispatched P0/P1 backlog (standing owner rule 2026-07-24) ──
  const p01Queue = [];
  for (const task of tasks.values()) {
    if (!task || task.status !== 'pending') continue;
    // BRO-3633: an archived task was deliberately taken out of active
    // circulation (task-store-archive.js's pending-task archival — status
    // stays 'pending' in the archive copy by design, see that file's
    // docstring; it is a noise-reduction move, not a completion signal).
    // loadTasksUnioned() surfaces it anyway because ITS job is
    // outcome-auditing, not eligibility, so without this guard p01Queue
    // resurrected shelved work every sweep — measured 89% of retired-board
    // watchdog-redispatch rows in the 7d window were exactly this (kind:
    // p01-backlog against cards untouched for 2+ months), which is what
    // trips board-targeting-audit.js's "Dispatch: board targeting" check.
    // (BRO-3878: fromArchive is only ever set on Notion-mirror tasks today,
    // so this guard is redundant with the isLiveBoardTaskId() exclusion
    // below for that source — left in as cheap insurance in case a future
    // board's loader ever sets fromArchive too.)
    if (task.fromArchive) continue;
    const pri = taskPriority(task);
    if (pri !== 'P0' && pri !== 'P1') continue;
    if (isExcludedCategory(task)) continue;        // human-territory cards
    const id = String(task.id);
    // BRO-3878: the Notion mirror froze 2026-08-20 (CLAUDE.md §6 — Linear is
    // the only board that gets created on) but its pending P0/P1 "ghost"
    // cards never resolve, so without this they re-entered this queue every
    // sweep — measured 26/30 watchdog-redispatch claims in a 24h sample
    // targeted the frozen mirror, inflating the owner-facing "N P0/P1 queued"
    // count ~3x over the genuinely dispatchable Linear backlog. The live
    // board is the only source fresh backlog may be drawn from now; a mirror
    // card that still matters gets migrated to Linear, not drained in place.
    if (!isLiveBoardTaskId(id)) continue;
    if (open.has(id) || ownerParked.has(id) || wdParked.has(id)) continue;
    if (hasNoFurtherDispatchWork(id, entries)) continue;   // BRO-4076
    if (blockedTaskIds.has(id)) continue;          // BRO-3442: about to be parked this sweep
    if (claimPending.has(id)) continue;            // #1564: same suppression as the retry path above
    if (dispatchCapDecision(id, entries).blocked) continue;
    p01Queue.push({ taskId: id, subject: task.subject, priority: pri });
  }
  p01Queue.sort((a, b) => (a.priority < b.priority ? -1 : a.priority > b.priority ? 1 :
    compareTaskIds(a.taskId, b.taskId)));

  // Surfaced, never silent (ship-check doctrine: a cap that hides what it
  // dropped reads as "covered everything"). Only still-open tasks are worth
  // the owner's attention — a claim whose task later completed is just history.
  const awaitingClaim = [];
  for (const [id, claimMs] of claimPending) {
    const task = tasks.get(id);
    if (!isTaskOpen(task) || open.has(id)) continue;
    // BRO-3633 (ship-check/Codex catch): a claim can already exist in the
    // ledger for an archived task at the moment this guard lands (claimed
    // just before the fix deployed, or mid-flight in another process's
    // in-memory plan). Without this, noLaunchPark below would still park it
    // with a retired-board id — the exact symptom this card exists to stop —
    // even though p01Queue no longer creates NEW claims like it. Silently
    // dropping it here is correct: watchdogClaimPending already self-clears
    // after REDISPATCH_REARM_MS regardless, so this is a bounded no-op, not
    // a lost claim.
    if (task.fromArchive) continue;
    // BRO-3437: a claim against the retired Notion mirror (bare-numeric id)
    // can never be re-armed by the owner through Linear — no card exists
    // there to act on. BRO-3390/3878 already stopped FRESH claims like this
    // from being created (p01Queue/retryable are Linear-only), but a claim
    // already sitting in the ledger from before those fixes still aged past
    // CLAIM_LABEL_GRACE_MS and got promoted to noLaunchPark below, writing a
    // watchdog-park row and paging the owner about a card Linear has never
    // heard of. board-targeting-audit.js measured `watchdog-park` at 100%
    // retired-board ids over 7 days, most recently <1h old — this loop (and
    // jobBlocked above) were the two remaining sources.
    if (!isLiveBoardTaskId(id)) continue;
    // BRO-3429 ship-check: once noLaunchPark (below) has actually parked this
    // id, it belongs to the "Needs you: parked" section, not this one — an id
    // in both would double-count in needsYou and print two contradictory
    // messages ("I'll retry in 24h" next to "parked, won't retry"). A fresh
    // launch clears wdParked (watchdogParkedIds), which re-admits the id here
    // if it ever gets re-claimed and stalls again.
    if (wdParked.has(id)) continue;
    if (now - claimMs < CLAIM_LABEL_GRACE_MS) continue;   // still plausibly booting
    awaitingClaim.push({ taskId: id, subject: task.subject, claimedAt: new Date(claimMs).toISOString() });
  }
  awaitingClaim.sort((a, b) => compareTaskIds(a.taskId, b.taskId));

  // Wedged-launcher check — see CLAIM_OUTAGE_MIN above.
  const lastLaunchAny = lastLaunchAnywhereMs(entries);
  const claimOutage = awaitingClaim.length >= CLAIM_OUTAGE_MIN &&
    (lastLaunchAny == null || now - lastLaunchAny > CLAIM_OUTAGE_WINDOW_MS);

  // BRO-3429: awaitingClaim above is a LABEL only — before this it self-healed
  // silently after REDISPATCH_REARM_MS (24h) and never told the owner. Live
  // evidence: 84 watchdog-redispatch claims over 7 days, 0 launches, 0 parks —
  // every one just sat here and re-armed itself the next day forever.
  // noLaunchPark is the actionable subset dispatch-watchdog.js turns into a
  // real WATCHDOG_EVENTS.PARK row + an owner page: every item already past
  // CLAIM_LABEL_GRACE_MS (same list as awaitingClaim, which already excludes
  // wdParked above, so nothing here re-parks something already parked).
  //
  // Suppressed during a proven fleet-wide launcher outage (outage.outage from
  // detectLauncherOutage, or claimOutage just above): those signals mean the
  // LAUNCHER is wedged, not that these particular cards are bad, and parking
  // N individually-fine cards would misattribute a systemic failure and page
  // the owner N times about the wrong thing. Once the outage clears, the next
  // sweep re-evaluates and parks normally.
  //
  // Two known edge cases this does NOT fully solve (codex adversarial review,
  // BRO-3429): (1) if a suppressed claim stays suppressed for the full
  // REDISPATCH_REARM_MS (24h) — an outage that never clears — watchdogClaimPending
  // drops it and it quietly re-arms as dispatchable instead of ever being
  // parked. Not a regression (pre-fix, EVERY claim behaved this way, always),
  // and the separate outage/failureRate pageOwner calls elsewhere in this file
  // already re-page every few hours for as long as that outage lasts, so the
  // owner is not left uninformed even though this specific card isn't parked.
  // (2) claimOutage requires CLAIM_OUTAGE_MIN (3) claims stuck at once; if
  // claims from the same root cause cross CLAIM_LABEL_GRACE_MS staggered in
  // time rather than together, each can get individually parked before a
  // third accumulates, so the fleet-wide signal never fires and the owner
  // gets N separate "this card failed" pages instead of one "the launcher is
  // down" page. Worse diagnostics, not silence — per-card paging still tells
  // the owner something is wrong, which is the property this ticket exists to
  // restore.
  const noLaunchPark = (outage.outage || claimOutage) ? [] : awaitingClaim;

  // ── budgets ──
  const usedToday = watchdogClaimsToday(entries, now).length;
  const usedThisHour = watchdogClaimsInWindow(entries, now).length;
  const liveNow = watchdogLiveCount(entries);
  const autoTabs = cmuxObserved
    ? [...liveTitles.values()].filter(t => AUTO_TAB_RE.test(String(t))).length : null;
  // Lane-aware holds (BRO-3404, forced live 2026-09-15).
  //
  // Every hold used to be global: budget was computed only when holds was
  // EMPTY, so a cmux problem stopped the headless lane too. That went from
  // theoretical to blocking within an hour of lifting the day budget — the
  // drain halted on `global auto-tab ceiling (15/12)`, a count of cmux TABS,
  // while the work it could not dispatch was headless and creates no tab at
  // all. A ceiling on a resource the lane does not consume must not gate it.
  //
  // cmuxHolds suppress only cmux-lane candidates. globalHolds (kill switch,
  // day budget, hourly pacing, concurrency, and the fleet-wide claim outage,
  // which is a genuine "nothing launches anywhere" wedge) still stop
  // everything. holds stays the union so the narrative and every existing
  // consumer read exactly as before.
  // R5 (BRO-3924): computed here, before the hold list, so its verdict can
  // feed globalHolds/pausedByPolicy exactly like every other cap below.
  const spendBreaker = watchdogSpendBreaker(entries, now);

  const globalHolds = [];
  const cmuxHolds = [];
  if (!dispatchEnabled) globalHolds.push('dispatch kill-switch set');
  if (!cmuxObserved) cmuxHolds.push('cmux unobservable — report-only (cmux lane only; headless still dispatches)');
  if (outage.outage) cmuxHolds.push(`launcher outage detected (${outage.count} injection deaths, tasks ${outage.taskIds.join('/')})`);
  if (failureRate.leaking) cmuxHolds.push(`${LAUNCHER_LEAK_HOLD_PREFIX} (${failureRate.failureCount}/${failureRate.totalLaunches} = ${Math.round(failureRate.rate * 100)}% injection deaths in the last ${Math.round(FAILURE_RATE_LOOKBACK_MS / 3600000)}h, even though the launcher looks "recovered")`);
  if (claimOutage) globalHolds.push(`${awaitingClaim.length} dispatch claims produced no launch and NOTHING has launched fleet-wide in ${Math.round(CLAIM_OUTAGE_WINDOW_MS / 3600000)}h — the launcher itself looks wedged, not the cards`);
  if (usedToday >= CAPS.perDay) globalHolds.push(`day budget spent (${usedToday}/${CAPS.perDay})`);
  // Pacing, not a failure: say so, so the dashboard narrative doesn't read
  // like an outage when the drain is simply spreading its budget out.
  if (usedThisHour >= CAPS.perHour) globalHolds.push(`hourly pacing (${usedThisHour}/${CAPS.perHour} in the last 60m — spreading ${CAPS.perDay}/day instead of bursting)`);
  if (liveNow >= CAPS.watchdogConcurrent) globalHolds.push(`watchdog concurrency at cap (${liveNow}/${CAPS.watchdogConcurrent})`);
  if (autoTabs !== null && autoTabs >= CAPS.globalAutoTabs) cmuxHolds.push(`global auto-tab ceiling (${autoTabs}/${CAPS.globalAutoTabs}) — cmux lane only; headless still dispatches`);
  // R5: the shared breaker's own reason string, verbatim — no watchdog-
  // specific wording invented here.
  if (spendBreaker.halt) globalHolds.push(spendBreaker.reason);
  // Union — a NEW array, never an alias of globalHolds (an alias made every
  // cmux hold a global one again, which is the exact bug this split removes).
  // The narrative and every existing reader see the same list they always did;
  // only the BUDGET GATE below distinguishes the two.
  const holds = [...globalHolds, ...cmuxHolds];

  // BRO-2462: `holds` mixes deliberate/mundane pauses (kill-switch, budget,
  // concurrency, tab ceiling) with failure-DETECTION signals (outage,
  // failure-rate leak, claimOutage) that mean the launcher looks wedged, not
  // paused. A caller that wants to know "does zero launches have an
  // innocent explanation" must not treat an outage as innocent — that's
  // backwards, it's the strongest signal something is actually dead. Keep
  // this narrower flag for that use (see dispatch-watchdog.js health()); the
  // full `holds` array stays as-is for the sweep budget gate above and for
  // narrative display, where "don't dispatch more work right now" correctly
  // covers both categories.
  const pausedByPolicy = !dispatchEnabled ||
    usedToday >= CAPS.perDay ||
    usedThisHour >= CAPS.perHour ||
    liveNow >= CAPS.watchdogConcurrent ||
    (autoTabs !== null && autoTabs >= CAPS.globalAutoTabs) ||
    spendBreaker.halt;

  let budget = 0;
  if (!globalHolds.length) {
    budget = Math.min(
      CAPS.perSweep,
      CAPS.perDay - usedToday,
      CAPS.perHour - usedThisHour,
      CAPS.watchdogConcurrent - liveNow,
    );
  }
  // Retries of already-attempted work outrank fresh P0/P1 dispatches.
  // When only cmux-lane holds are active, headless-capable work still flows —
  // that is the whole point of the split above.
  //
  // BRO-3878: retryable and p01Queue now both require isLiveBoardTaskId(id)
  // before an item reaches here, so this filter — which happens to use the
  // same "is it Linear" test for a different reason (linear: ids dispatch
  // headless, bare-Notion ids dispatched through a cmux tab) — is currently a
  // no-op: every candidate that reaches this point already passes it. Left in
  // place rather than simplified away, because the two filters test the same
  // shape for different reasons (board-liveness vs. dispatch-lane), and a
  // future non-Linear live board or a headless Notion path would each need
  // this filter to keep working without anyone having to remember to re-add it.
  const eligibleForLane = cmuxHolds.length
    ? [...retryable, ...p01Queue].filter(item => taskSourceRank(item.taskId) === 0)
    : [...retryable, ...p01Queue];
  const toDispatch = eligibleForLane.slice(0, Math.max(0, budget));

  // ── needs-you ──
  const deadCrownTabs = [];
  if (cmuxObserved) {
    for (const [ref, title] of liveTitles) {
      if (CROWN_TAB_RE.test(String(title)) && !String(title).includes(WATCHDOG_TAB_MARKER)) {
        deadCrownTabs.push({ ref, title });        // liveness judged by CLI (claudeAliveIn)
      }
    }
  }
  // awaitingClaim counts: these are cards the watchdog tried and could not
  // start, and only the owner can unblock them. Leaving them out made the tab
  // title read "0 need you" while the P0/P1 count silently shrank by the same
  // number — the backlog looked drained (ship-check P1).
  // BRO-3924 (R3): alreadyPasses cards count toward needsYou too — same
  // treatment as recheckFailures, a human decision (close the card) this
  // sweep surfaces but never acts on itself.
  //
  // BRO-3437: wdParked is still the full exclusion set (a legacy bare-id park
  // row must keep suppressing its id), but only live-board parks are owner
  // work — a retired-board park never clears (nothing relaunches those ids),
  // so counting it kept "N need you" inflated by cards no surface can show.
  const wdParkedLive = [...wdParked].filter(isLiveBoardTaskId).length;
  const needsYou = toPark.length + wdParkedLive + recheckFailures.length +
    (outage.outage ? 1 : 0) + (failureRate.leaking ? 1 : 0) + awaitingClaim.length +
    unlandedDone.length + jobBlocked.length + alreadyPasses.length;

  return {
    now, cmuxObserved,
    inFlight, retryable, toPark, p01Queue, toDispatch, awaitingClaim, noLaunchPark,
    unlandedDone, jobBlocked,
    budgets: {
      usedToday, usedThisHour, liveNow, autoTabs, budget, holds, globalHolds, cmuxHolds, pausedByPolicy, caps: CAPS, spend: spendBreaker,
      // stallDetectionDepth inputs (2026-09-22) — same conditions as the globalHolds pushes above.
      globalHoldFlags: {
        killSwitch: !dispatchEnabled,
        dayBudget: usedToday >= CAPS.perDay,
        hourly: usedThisHour >= CAPS.perHour,
        concurrency: liveNow >= CAPS.watchdogConcurrent,
        claimOutage: !!claimOutage,
        spendHalt: !!spendBreaker.halt,
      },
      awaitingClaimCount: awaitingClaim.length,
      laneEligible: eligibleForLane.length,
      liveSlotTimes: watchdogLiveSlotTimes(entries),
      oldestLiveSlotTs: watchdogLiveOldestTs(entries),
    },
    outage,
    failureRate,
    crownSessionTabs: deadCrownTabs,
    recheckFailures,
    alreadyPasses,
    needsYou,
    parkedTotal: wdParkedLive + toPark.length + noLaunchPark.length + jobBlocked.length,
  };
}

// Sidebar-legible title with a freshness cue (user-impact review P1: a frozen
// "0 need you" must not read as current — the clock in the title is the lie
// detector the owner can see without opening the tab).
function tabTitle(plan) {
  const hhmm = new Date(plan.now).toTimeString().slice(0, 5);
  const bits = [
    `${plan.inFlight.length} in flight`,
    `${plan.needsYou} need you`,
  ];
  if (plan.p01Queue.length) bits.push(`${plan.p01Queue.length} P0/P1 queued`);
  if (!plan.cmuxObserved) bits.push('DEGRADED');
  return `${WATCHDOG_TAB_PREFIX} watchdog — ${bits.join(' · ')} · upd ${hhmm}`;
}

// Narrated dashboard body (user-impact review: the owner is non-technical —
// sentences, not a table of refs).
function renderNarrative(plan) {
  const lines = [];
  const when = new Date(plan.now).toLocaleString('en-US', { hour12: false });
  lines.push(`👑 Dispatch watchdog — last sweep ${when}`);
  if (!plan.cmuxObserved) lines.push('⚠️  cmux is not answering — watching the ledger only, taking no actions.');
  lines.push('');
  if (plan.inFlight.length) {
    lines.push(`${plan.inFlight.length} dispatched session(s) still working:`);
    for (const f of plan.inFlight.slice(0, 12)) {
      const age = f.launchedAt ? Math.round((plan.now - Date.parse(f.launchedAt)) / 60000) : null;
      const listedNote = f.listed === false ? ' (tab not visible — bsc-prune will reconcile)' : '';
      lines.push(`  • #${f.taskId} "${(f.subject || '').slice(0, 60)}"${age !== null ? ` — ${age} min in` : ''}${listedNote}`);
    }
  } else {
    lines.push('No dispatched sessions in flight.');
  }
  if (plan.toDispatch.length) {
    lines.push('');
    lines.push(`Dispatching now (${plan.toDispatch.length}):`);
    for (const d of plan.toDispatch) lines.push(`  • #${d.taskId} "${(d.subject || '').slice(0, 60)}"${d.deaths ? ` — retry after ${d.deaths} dead attempt(s)` : ' — undispatched ' + (d.priority || '')}`);
  }
  if (plan.budgets.holds.length) {
    lines.push('');
    lines.push(`Holding dispatches: ${plan.budgets.holds.join('; ')}`);
  }
  // BRO-3429: awaitingClaim items past grace are, on a normal tick, the exact
  // same items as noLaunchPark (which this sweep is about to park) — showing
  // both would print "I'll retry in 24h" right next to "parked, won't retry"
  // for the same card. Only the ones noLaunchPark is NOT acting on this tick
  // (a proven fleet-wide outage suppressed parking — see noLaunchPark above)
  // still get the passive "self-heals" framing here.
  const noLaunchParkIds = new Set(plan.noLaunchPark.map(p => p.taskId));
  const stillAwaitingLabel = plan.awaitingClaim.filter(a => !noLaunchParkIds.has(a.taskId));
  if (stillAwaitingLabel.length) {
    lines.push('');
    lines.push(`${stillAwaitingLabel.length} card(s) I already tried and could not start — I won't try again for 24h from that attempt:`);
    for (const a of stillAwaitingLabel.slice(0, 6)) {
      lines.push(`  • #${a.taskId} "${(a.subject || '').slice(0, 60)}"`);
      lines.push(`      why: node scripts/predispatch-check.js --id ${a.taskId}`);
      lines.push(`      re-arm now (after fixing the card): node scripts/bsc-next.js --id ${a.taskId} --force`);
    }
    if (stillAwaitingLabel.length > 6) lines.push(`  • …and ${stillAwaitingLabel.length - 6} more`);
  }
  if (plan.toPark.length || plan.noLaunchPark.length || plan.recheckFailures.length || plan.crownSessionTabs.length || plan.unlandedDone.length || plan.alreadyPasses.length) {
    lines.push('');
    lines.push('Needs you:');
    for (const p of plan.toPark) lines.push(`  • #${p.taskId} "${(p.subject || '').slice(0, 60)}" — ${p.reason === 'infra' ? `${p.deaths} infra dead-launches in a row (cmux itself looks wedged)` : `${p.deaths} dead attempts`}, parked (won't retry)`);
    for (const p of plan.noLaunchPark) lines.push(`  • #${p.taskId} "${(p.subject || '').slice(0, 60)}" — claimed but never produced a launch, parked (won't retry)`);
    for (const u of plan.unlandedDone) lines.push(`  • #${u.taskId} "${(u.subject || '').slice(0, 60)}" — session reported done but its work never reached origin/main (job ${u.jobId}, ${u.cwd}); check git log there and land it, or bsc-next.js --id ${u.taskId} --force to redispatch`);
    for (const r of plan.recheckFailures.slice(0, 8)) lines.push(`  • acceptance recheck FAILED: "${(r.taskSubject || r.notionId || '').slice(0, 60)}"`);
    for (const c of plan.crownSessionTabs) lines.push(`  • crowned session tab ${c.ref} ("${String(c.title).slice(0, 50)}") — check it's still alive`);
    // BRO-3924 (R3): BRO-3551's sweep already re-ran each card's own
    // acceptance command against main — a human can close these straight
    // from the report, no re-verification needed.
    for (const a of plan.alreadyPasses.slice(0, 8)) lines.push(`  • ${a.id} "${(a.name || '').slice(0, 56)}" — already passes its own acceptance command (\`${a.verifyCmd}\`); see data/audit/open-backlog-acceptance-sweep.json`);
  }
  lines.push('');
  lines.push(`Budget: ${plan.budgets.usedToday}/${plan.budgets.caps.perDay} dispatches today · ${plan.budgets.usedThisHour}/${plan.budgets.caps.perHour} this hour · ${plan.budgets.liveNow}/${plan.budgets.caps.watchdogConcurrent} watchdog sessions live`);
  return lines.join('\n');
}

module.exports = {
  WATCHDOG_EVENTS, structuralGuardRefusal, CAPS, WATCHDOG_TAB_PREFIX, WATCHDOG_TAB_MARKER, LAUNCHER_LEAK_HOLD_PREFIX,
  KILL_SWITCH_STALE_MS, killSwitchStaleness,
  REDISPATCH_REARM_MS, CLAIM_LABEL_GRACE_MS, CLAIM_OUTAGE_MIN, CLAIM_OUTAGE_WINDOW_MS,
  watchdogClaimPending, lastLaunchAnywhereMs,
  taskPriority, notionIdOf, taskSortKey, compareTaskIds, taskSourceRank,
  openHeadlessJobTasks, openTasksAnyLane,
  PACING_WINDOW_MS, PACING_HOURS, watchdogClaimsInWindow, stallDetectionDepth, watchdogLiveOldestTs, watchdogLiveSlotTimes,
  watchdogClaimsToday, watchdogLiveCount, watchdogParkedIds,
  lastTerminalEventForTask, planSweep, tabTitle, renderNarrative,
  // R5 (BRO-3924): exported for direct unit testing, not just through planSweep.
  median, medianJobCostUSD, watchdogSpendRows, watchdogSpendBreaker,
  WATCHDOG_SPEND_THRESHOLD_USD, SPEND_MEDIAN_WINDOW_MS, FALLBACK_JOB_COST_USD,
  // BRO-4076: exported for direct unit testing, not just through planSweep.
  NO_FURTHER_DISPATCH_EVENTS, hasNoFurtherDispatchWork,
};
