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
 *   'watchdog-park'       {taskId}  retries exhausted; needs the owner
 *   'watchdog-resurrect'  {taskId:'watchdog', workspaceRef, gapMs}  the
 *                                   crowned tab was recreated after a gap
 * All are excluded from bsc-prune/bsc-next semantics (unknown events are
 * ignored by every existing fold).
 */
'use strict';

const {
  TERMINAL_LAUNCH_EVENTS,
  openTaskWorkspaceLaunches, dispatchCapDecision, parkedTasks,
  detectLauncherOutage, detectLauncherFailureRate, FAILURE_RATE_LOOKBACK_MS,
} = require('./dispatch-ledger.js');
const { isExcludedCategory } = require('./autonomous-eligibility.js');

const WATCHDOG_EVENTS = Object.freeze({
  REDISPATCH: 'watchdog-redispatch',
  PARK: 'watchdog-park',
});

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
const CAPS = Object.freeze({
  perSweep: 2,
  watchdogConcurrent: 3,
  perDay: 12,
  globalAutoTabs: 12,
});

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
function taskPriority(task) {
  const desc = String((task && task.description) || '');
  const firstLine = desc.split('\n', 1)[0];
  let m = /^\[notion:[^\]]*\]\s*(P[0-3])\b/.exec(firstLine);
  if (m) return m[1];
  m = /^(P[0-3])\b/.exec(String((task && task.subject) || ''));
  return m ? m[1] : null;
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

// Watchdog-origin live concurrency: tasks the watchdog claimed whose latest
// launch is still open (no terminal event) — the cmux-launch analogue of
// backlog-drain's computeConcurrency job fold, on the same single ledger.
function watchdogLiveCount(entries) {
  const claimed = new Set(entries
    .filter(e => e && e.event === WATCHDOG_EVENTS.REDISPATCH)
    .map(e => String(e.taskId)));
  if (!claimed.size) return 0;
  let n = 0;
  for (const [taskId] of openTaskWorkspaceLaunches(entries)) {
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
 *   - dispatchEnabled: false = visibility only (kill-switch file)
 */
function planSweep(entries, tasks, opts) {
  const { now, liveTitles = null, recheckFailures = [], dispatchEnabled = true } = opts || {};
  if (!Number.isFinite(now)) throw new Error('planSweep requires now (ms epoch)');
  const cmuxObserved = liveTitles instanceof Map && liveTitles.size > 0;

  // ── classify open launches ──
  const open = openTaskWorkspaceLaunches(entries);
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
    if (open.has(id)) continue;                    // a newer launch is running
    if (ownerParked.has(id) || wdParked.has(id)) continue;
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
  retryable.sort((a, b) => parseInt(a.taskId, 10) - parseInt(b.taskId, 10));

  // ── undispatched P0/P1 backlog (standing owner rule 2026-07-24) ──
  const p01Queue = [];
  for (const task of tasks.values()) {
    if (!task || task.status !== 'pending') continue;
    const pri = taskPriority(task);
    if (pri !== 'P0' && pri !== 'P1') continue;
    if (isExcludedCategory(task)) continue;        // human-territory cards
    const id = String(task.id);
    if (open.has(id) || ownerParked.has(id) || wdParked.has(id)) continue;
    if (claimPending.has(id)) continue;            // #1564: same suppression as the retry path above
    if (dispatchCapDecision(id, entries).blocked) continue;
    p01Queue.push({ taskId: id, subject: task.subject, priority: pri });
  }
  p01Queue.sort((a, b) => (a.priority < b.priority ? -1 : a.priority > b.priority ? 1 :
    parseInt(a.taskId, 10) - parseInt(b.taskId, 10)));

  // Surfaced, never silent (ship-check doctrine: a cap that hides what it
  // dropped reads as "covered everything"). Only still-open tasks are worth
  // the owner's attention — a claim whose task later completed is just history.
  const awaitingClaim = [];
  for (const [id, claimMs] of claimPending) {
    const task = tasks.get(id);
    if (!isTaskOpen(task) || open.has(id)) continue;
    if (now - claimMs < CLAIM_LABEL_GRACE_MS) continue;   // still plausibly booting
    awaitingClaim.push({ taskId: id, subject: task.subject, claimedAt: new Date(claimMs).toISOString() });
  }
  awaitingClaim.sort((a, b) => parseInt(a.taskId, 10) - parseInt(b.taskId, 10));

  // Wedged-launcher check — see CLAIM_OUTAGE_MIN above.
  const lastLaunchAny = lastLaunchAnywhereMs(entries);
  const claimOutage = awaitingClaim.length >= CLAIM_OUTAGE_MIN &&
    (lastLaunchAny == null || now - lastLaunchAny > CLAIM_OUTAGE_WINDOW_MS);

  // ── budgets ──
  const usedToday = watchdogClaimsToday(entries, now).length;
  const liveNow = watchdogLiveCount(entries);
  const autoTabs = cmuxObserved
    ? [...liveTitles.values()].filter(t => AUTO_TAB_RE.test(String(t))).length : null;
  const holds = [];
  if (!dispatchEnabled) holds.push('dispatch kill-switch set');
  if (!cmuxObserved) holds.push('cmux unobservable — report-only');
  if (outage.outage) holds.push(`launcher outage detected (${outage.count} injection deaths, tasks ${outage.taskIds.join('/')})`);
  if (failureRate.leaking) holds.push(`${LAUNCHER_LEAK_HOLD_PREFIX} (${failureRate.failureCount}/${failureRate.totalLaunches} = ${Math.round(failureRate.rate * 100)}% injection deaths in the last ${Math.round(FAILURE_RATE_LOOKBACK_MS / 3600000)}h, even though the launcher looks "recovered")`);
  if (claimOutage) holds.push(`${awaitingClaim.length} dispatch claims produced no launch and NOTHING has launched fleet-wide in ${Math.round(CLAIM_OUTAGE_WINDOW_MS / 3600000)}h — the launcher itself looks wedged, not the cards`);
  if (usedToday >= CAPS.perDay) holds.push(`day budget spent (${usedToday}/${CAPS.perDay})`);
  if (liveNow >= CAPS.watchdogConcurrent) holds.push(`watchdog concurrency at cap (${liveNow}/${CAPS.watchdogConcurrent})`);
  if (autoTabs !== null && autoTabs >= CAPS.globalAutoTabs) holds.push(`global auto-tab ceiling (${autoTabs}/${CAPS.globalAutoTabs})`);

  let budget = 0;
  if (!holds.length) {
    budget = Math.min(
      CAPS.perSweep,
      CAPS.perDay - usedToday,
      CAPS.watchdogConcurrent - liveNow,
    );
  }
  // Retries of already-attempted work outrank fresh P0/P1 dispatches.
  const toDispatch = [...retryable, ...p01Queue].slice(0, Math.max(0, budget));

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
  const needsYou = toPark.length + wdParked.size + recheckFailures.length +
    (outage.outage ? 1 : 0) + (failureRate.leaking ? 1 : 0) + awaitingClaim.length;

  return {
    now, cmuxObserved,
    inFlight, retryable, toPark, p01Queue, toDispatch, awaitingClaim,
    budgets: { usedToday, liveNow, autoTabs, budget, holds, caps: CAPS },
    outage,
    failureRate,
    crownSessionTabs: deadCrownTabs,
    recheckFailures,
    needsYou,
    parkedTotal: wdParked.size + toPark.length,
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
  if (plan.awaitingClaim && plan.awaitingClaim.length) {
    lines.push('');
    lines.push(`${plan.awaitingClaim.length} card(s) I already tried and could not start — I won't try again for 24h from that attempt:`);
    for (const a of plan.awaitingClaim.slice(0, 6)) {
      lines.push(`  • #${a.taskId} "${(a.subject || '').slice(0, 60)}"`);
      lines.push(`      why: node scripts/predispatch-check.js --id ${a.taskId}`);
      lines.push(`      re-arm now (after fixing the card): node scripts/bsc-next.js --id ${a.taskId} --force`);
    }
    if (plan.awaitingClaim.length > 6) lines.push(`  • …and ${plan.awaitingClaim.length - 6} more`);
  }
  if (plan.toPark.length || plan.recheckFailures.length || plan.crownSessionTabs.length) {
    lines.push('');
    lines.push('Needs you:');
    for (const p of plan.toPark) lines.push(`  • #${p.taskId} "${(p.subject || '').slice(0, 60)}" — ${p.reason === 'infra' ? `${p.deaths} infra dead-launches in a row (cmux itself looks wedged)` : `${p.deaths} dead attempts`}, parked (won't retry)`);
    for (const r of plan.recheckFailures.slice(0, 8)) lines.push(`  • acceptance recheck FAILED: "${(r.taskSubject || r.notionId || '').slice(0, 60)}"`);
    for (const c of plan.crownSessionTabs) lines.push(`  • crowned session tab ${c.ref} ("${String(c.title).slice(0, 50)}") — check it's still alive`);
  }
  lines.push('');
  lines.push(`Budget: ${plan.budgets.usedToday}/${plan.budgets.caps.perDay} dispatches today · ${plan.budgets.liveNow}/${plan.budgets.caps.watchdogConcurrent} watchdog sessions live`);
  return lines.join('\n');
}

module.exports = {
  WATCHDOG_EVENTS, CAPS, WATCHDOG_TAB_PREFIX, WATCHDOG_TAB_MARKER, LAUNCHER_LEAK_HOLD_PREFIX,
  KILL_SWITCH_STALE_MS, killSwitchStaleness,
  REDISPATCH_REARM_MS, CLAIM_LABEL_GRACE_MS, CLAIM_OUTAGE_MIN, CLAIM_OUTAGE_WINDOW_MS,
  watchdogClaimPending, lastLaunchAnywhereMs,
  taskPriority, notionIdOf,
  watchdogClaimsToday, watchdogLiveCount, watchdogParkedIds,
  lastTerminalEventForTask, planSweep, tabTitle, renderNarrative,
};
