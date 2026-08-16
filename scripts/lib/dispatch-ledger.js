/**
 * dispatch-ledger — append-only record of cmux auto-dispatch attempts, so
 * bsc-next / bsc-prune can tell "this task has already died here" from "this
 * is a fresh dispatch" instead of blind re-dispatching forever.
 *
 * Task #334 (2026-07-22): task #297 accumulated THREE dead cmux workspaces
 * (workspace:227/229/234, "Terminal surface not found") because nothing
 * recorded that all three launches were onto the same task, and a session
 * killed at the #289 >30min timeout never runs the Stop hook's ✅ self-mark
 * (that mark only exists on the SUCCESS path — see #154). bsc-next.js
 * appends a 'launch' entry on every verified dispatch; bsc-prune.js appends
 * a 'dead' entry the first time its idle-unmarked sweep finds a launched
 * workspace with no live claude process and no ✅ (the missing failure
 * breadcrumb). bsc-next.js then refuses a further blind dispatch once a
 * task has DEAD_ATTEMPT_LIMIT dead entries, instead of opening a 3rd/4th/5th
 * dead shell on the same task.
 *
 * Ledger: data/audit/dispatch-ledger.jsonl (gitignored, Mac-local — same
 * append-only-jsonl pattern as autonomous-ledger.jsonl). Never rewritten.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { foldAttempts, PAIR_WINDOW_MS } = require('./dispatch-attempts.js');

// Hardcoded (not path.join(__dirname, '..', '..')) on purpose: both callers
// of this module (bsc-next.js, bsc-prune.js) are interactive tools an owner
// routinely runs from inside a worktree (this session included) — a
// __dirname-relative REPO would resolve to that worktree's own
// scripts/lib/, splitting the ledger into a worktree-local copy instead of
// the single canonical file every dispatch/sweep needs to share. Same fix
// bsc-next.js already applies to its own REPO/QUEUE_PATH, with the same
// rationale in its header comment. (autonomous-ledger.js gets away with the
// relative pattern because autonomous-run.js only ever runs from the
// canonical checkout via launchd — never from a worktree.)
const REPO = '/Users/tompryor/Broadwayscore';
const LEDGER_PATH = path.join(REPO, 'data', 'audit', 'dispatch-ledger.jsonl');
const { stripAutoPrefix } = require('./workspace-naming.js');

// A task with this many recorded 'dead' entries blocks further blind
// dispatch (bsc-next's deadDispatchGuard) until the owner investigates or
// passes --force. 2 = the 3rd dispatch attempt is the one that gets refused,
// matching the real incident (2 dead shells already existed when the 3rd
// was opened).
const DEAD_ATTEMPT_LIMIT = 2;

function appendEntry(entry, ledgerPath = LEDGER_PATH) {
  if (!entry || typeof entry.event !== 'string' || !entry.event || !entry.taskId) {
    throw new Error('dispatch-ledger entry requires an event string and a taskId');
  }
  const line = { ts: new Date().toISOString(), ...entry };
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, JSON.stringify(line) + '\n');
  return line;
}

// Corrupt lines (partial write from a crash) are skipped, never fatal — the
// ledger must stay readable after any crash, same invariant as
// autonomous-ledger.js's readEntries.
function readEntries(ledgerPath = LEDGER_PATH) {
  let raw;
  try { raw = fs.readFileSync(ledgerPath, 'utf8'); }
  catch { return []; }
  const entries = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { entries.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return entries;
}

// Session-system overhaul S3 (card #856): context-limit succession chains a
// task through multiple relaunches without ever finishing it — a session at
// 80% context checkpoints and self-dispatches a successor onto the SAME
// task via `bsc-next.js --id N --succession`. Runaway guard from the S3
// pre-mortem (P0): a task that never actually makes progress could chain
// successors forever, burning a launch every few minutes. Depth is derived
// from the ledger itself (never trusted from a CLI arg the caller could get
// wrong or spoof): count 'launch' entries for this task, walking forward in
// time, resetting to 1 on any launch that is NOT a succession (a fresh
// dispatch — --force redispatch, or the task's original launch — starts a
// new chain) and incrementing on every launch that IS (successionOf set).
// The returned value is the depth of the LAST launch already in the ledger;
// the succession about to be dispatched would be depth+1.
const SUCCESSION_DEPTH_CAP = 5;

function successionDepthForTask(taskId, entries) {
  const launches = entries
    .filter(e => e.event === 'launch' && String(e.taskId) === String(taskId))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  let depth = 0;
  for (const e of launches) depth = e.successionOf || e.succession ? depth + 1 : 1;
  return depth;
}

// Shared "did this one event, by itself, fail to do the work" predicate —
// deadAttemptsForTask, isLatestDispatchDead (card #1144) and anything else
// this ledger grows must all agree on what DEAD means, or a task can pass one
// check and fail the other for the same underlying state. JOB_EVENTS is
// declared later in this file (below), but that's fine — this function body
// only reads JOB_EVENTS.* when CALLED, by which point the whole module has
// finished loading (same lazy-reference shape the original inline Set here
// already relied on).
function isDeadlikeEvent(event) {
  return event === 'dead' || event === JOB_EVENTS.FAILED || event === JOB_EVENTS.ORPHANED;
}

function deadAttemptsForTask(taskId, entries) {
  // Failed/orphaned headless jobs count as dead attempts too — this is the
  // "one ledger, one guard" promise: a task cannot burn unlimited headless
  // jobs just because its deaths use the job-* vocabulary (Opus ship-check P1).
  return entries.filter(e => isDeadlikeEvent(e.event) && String(e.taskId) === String(taskId));
}

// ── INFRA vs SUBSTANTIVE dead attempts (card #1233) ─────────────────────────
// deadAttemptsForTask above (and DEAD_ATTEMPT_LIMIT below) treat every dead
// attempt as equal evidence about the TASK. dispatch-health.js's own
// measurement (card #1199) put the true cmux dead-launch rate at ~21% —
// almost entirely "the terminal surface never rendered, so the injected
// command never ran" (INFRA, nothing about the task) rather than "the
// session booted and then died" (SUBSTANTIVE, a real signal). At a 21%
// per-attempt infra rate, a perfectly healthy task draws two infra deaths in
// a row ~4.5% of the time and was getting permanently parked by
// deadDispatchGuard with advice ("shrink the scope") that has nothing to do
// with why it died.
//
// dispatch-attempts.js's foldAttempts (moved out of dispatch-health.js for
// exactly this — see that file's header) already computes the INFRA/
// SUBSTANTIVE split per launch attempt: a folded attempt with dead:true and
// unverified:true is the shape-1 pair (dead row + its own unverified launch
// row, written ~1-2ms apart — the wrapper process never appeared); dead:true
// with unverified:false is a shape-2 breadcrumb (a verified launch, found
// dead later by a sweep — the session ran before dying/going idle).
// classifyDeadAttemptsForTask reuses THAT classification rather than
// re-deriving the pairing window itself, matching this file's own
// "isDeadlikeEvent ... must all agree on what DEAD means" doctrine above.
//
// Grouped by (taskId, workspaceRef) rather than matched by raw dead-row
// timestamp: foldAttempts already does the hard part (claiming each dead row
// against exactly one attempt, handling recycled-ref ambiguity with its own
// last-match-at-or-before rule and excluding remap-superseded attempts) —
// re-deriving that matching a second time here previously risked
// mismatching a dead row against an unrelated attempt on a reused ref
// (caught in this card's own plan review). Scoping candidates to this task's
// own workspaceRef collapses that ambiguity to "exactly one candidate" in
// every real case; if a ref is somehow reused twice for the SAME task with
// two different outcomes (candidates.length !== 1), or the dead row can't be
// matched to any folded attempt at all (e.g. a rotated/truncated ledger),
// this fails CLOSED to SUBSTANTIVE — never silently drops a death, and never
// risks misreading an unclassifiable one as a free infra retry.
function classifyDeadAttemptsForTask(taskId, entries) {
  const all = deadAttemptsForTask(taskId, entries);
  if (!all.length) return { substantive: [], infra: [] };
  // job-*-class deaths (job-failed/job-orphaned) have no workspaceRef and
  // only ever fire after job-spawned already ran — the wrapper unambiguously
  // executed, so these are always substantive.
  const jobDeaths = all.filter(e => e.event !== 'dead');
  const workspaceDeaths = all.filter(e => e.event === 'dead');
  if (!workspaceDeaths.length) return { substantive: jobDeaths, infra: [] };

  const { attempts } = foldAttempts(entries);
  const candidatesByRef = new Map();
  for (const a of attempts) {
    if (!a.dead || !a.workspaceRef || String(a.taskId) !== String(taskId)) continue;
    if (!candidatesByRef.has(a.workspaceRef)) candidatesByRef.set(a.workspaceRef, []);
    candidatesByRef.get(a.workspaceRef).push(a);
  }

  const substantive = [...jobDeaths];
  const infra = [];
  for (const e of workspaceDeaths) {
    const matches = candidatesByRef.get(e.workspaceRef) || [];
    if (matches.length !== 1) { substantive.push(e); continue; } // fail closed
    const match = matches[0];
    // unverified:true alone is not sufficient: foldAttempts also marks a
    // shape-3 launch (#705 slow-boot — wrapper was STILL RUNNING at write
    // time, so unverified but no immediate dead pair) as dead+unverified if
    // an UNRELATED sweep later finds it idle and attaches a breadcrumb via
    // its shape-2 last-match-at-or-before fallback — that breadcrumb can
    // land minutes, hours, or days later. That is not "the terminal surface
    // never rendered"; the wrapper was observed running, so it belongs in
    // SUBSTANTIVE. Verified against the real ledger (2026-08-11): 2 of 56
    // dead+unverified attempts have a >PAIR_WINDOW_MS gap to their dead row
    // (up to ~9 days) — without this second check those wrongly read as free
    // infra retries. Require the SAME proximity foldAttempts itself uses to
    // call something a genuine shape-1 pair.
    const deadTs = Date.parse(e.ts || '');
    const isInfra = match.unverified && Number.isFinite(deadTs) && Math.abs(match.ts - deadTs) <= PAIR_WINDOW_MS;
    (isInfra ? infra : substantive).push(e);
  }
  return { substantive, infra };
}

function substantiveDeadAttemptsForTask(taskId, entries) {
  return classifyDeadAttemptsForTask(taskId, entries).substantive;
}

// A genuinely wedged host (cmux itself broken, not any one task) must still
// stop retrying eventually instead of hammering a dead launcher forever, even
// though infra deaths no longer count toward DEAD_ATTEMPT_LIMIT. At the
// measured ~21% true infra rate, INFRA_DEAD_ATTEMPT_LIMIT consecutive infra
// deaths with zero successes in between is astronomically unlikely
// (0.21^10 ≈ 1.7e-7) for a task that isn't actually wedged — this is a
// circuit breaker, not a normal-operation ceiling.
const INFRA_DEAD_ATTEMPT_LIMIT = 10;

// The single decision every DEAD_ATTEMPT_LIMIT enforcement site in this
// codebase should compute from, so the substantive/infra split (and the
// infra ceiling) can't drift between bsc-next.js, bsc-prune.js,
// bsc-reconcile.js and dispatch-watchdog-core.js. Callers own their own
// message wording; this owns only the counts and the blocked/reason verdict.
function dispatchCapDecision(taskId, entries) {
  const { substantive, infra } = classifyDeadAttemptsForTask(taskId, entries);
  if (substantive.length >= DEAD_ATTEMPT_LIMIT) return { blocked: true, reason: 'substantive', substantive, infra };
  if (infra.length >= INFRA_DEAD_ATTEMPT_LIMIT) return { blocked: true, reason: 'infra', substantive, infra };
  return { blocked: false, reason: null, substantive, infra };
}

// Events that represent one dispatch ATTEMPT for a task, across both the
// cmux-tab path (bsc-next.js's 'launch'/'dead') and the --headless path
// (bsc-runner.js's job-* vocabulary). Other ledger events ('prune',
// 'vanish-epoch', 'vanished', 'prune-closed', 'remapped', 'restart-hold')
// describe what happened to a WORKSPACE/CARD after a launch, not a fresh
// attempt, and are deliberately excluded from this set.
function isAttemptEvent(event) {
  return event === 'launch' || isDeadlikeEvent(event)
    || event === JOB_EVENTS.SPAWNED || event === JOB_EVENTS.DONE || event === JOB_EVENTS.RETRIED;
}

// The most recent dispatch-attempt entry for a task, or null if it was never
// dispatched through bsc-next/bsc-runner (manual/owner-typed work this has no
// opinion on). Walks entries in FILE ORDER and lets the last match win —
// appendEntry always appends, so the ledger is already chronological — rather
// than re-sorting by `ts` the way a first draft of this did: readEntries()
// already tolerates corrupt/partial lines, and a ts-sort trusts a field that
// can be missing or malformed on exactly those lines. Matches this file's own
// lastByRef/foldJobs/openTaskWorkspaceLaunches convention (last-in-array
// wins), not a new one (Opus second-opinion review, card #1144).
function latestAttemptForTask(taskId, entries) {
  let latest = null;
  for (const e of entries || []) {
    if (!e || typeof e !== 'object') continue;
    if (String(e.taskId) !== String(taskId)) continue;
    if (!isAttemptEvent(e.event)) continue;
    latest = e;
  }
  return latest;
}

// True when the task's MOST RECENT dispatch attempt never actually ran.
// Card #1144: bsc-next's failedLaunchEntries() writes a 'dead' entry
// immediately followed by an unverified:true 'launch' entry for the SAME
// failed attempt (see that function's header) — the 'launch' entry lands
// last in file order, so it (not 'dead') is what latestAttemptForTask
// returns; the unverified:true check below is what still recognizes it as
// dead. A plain verified 'launch' (no unverified flag), or a live/finished
// job event (job-spawned/job-done/job-retried), as the latest attempt is NOT
// dead — a later successful redispatch always supersedes earlier deaths, so
// a task that died once and was then legitimately redispatched is never
// blocked forever. No attempt recorded at all → NOT dead.
function isLatestDispatchDead(taskId, entries) {
  const latest = latestAttemptForTask(taskId, entries);
  if (!latest) return false;
  if (isDeadlikeEvent(latest.event)) return true;
  if (latest.event === 'launch' && latest.unverified === true) return true;
  return false;
}

// LAST-MATCH, not first (card #960: cmux recycles workspaceRef across
// restarts/renumberings — a ref last launched onto task A months ago can be
// re-issued onto task B today. First-match would attribute every consumer
// (deadBreadcrumbs, pruneClosedEntry, bsc-status display, the no-payload
// reaper, sweepVanished's remap) to the wrong, long-dead task, most
// damagingly poisoning deadAttemptsForTask counts: a healthy task inherits a
// stranger's death count while the actually-dying task's count stays clean.
function launchByRef(workspaceRef, entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.event === 'launch' && e.workspaceRef === workspaceRef) return e;
  }
  return null;
}

// Cross-reference bsc-prune's idle (no live claude, un-✅-marked) workspaces
// against the ledger's launch records, and return the NEW 'dead' breadcrumbs
// to append — one per idle workspace that (a) was actually launched by
// bsc-next.js and (b) doesn't already have a recorded death. Idempotent
// across repeated bsc-prune runs: a workspace only ever contributes one dead
// breadcrumb, however many times the sweep re-scans it.
//
// Idempotency is scoped to the CURRENT launch, not the ref (card #960): a
// ref-only alreadyDead set would let one stale 'dead' entry from an EARLIER,
// recycled occupant of this ref permanently suppress every future breadcrumb
// for it — the opposite failure from first-match, but just as poisonous,
// since a genuinely dying later task would then never trip
// deadAttemptsForTask at all.
function deadBreadcrumbs(idleWorkspaces, entries) {
  const out = [];
  for (const w of idleWorkspaces) {
    const launch = launchByRef(w.ref, entries);
    if (!launch) continue; // not a bsc-next auto-dispatch — not ours to journal
    const alreadyDead = entries.some(e =>
      e.event === 'dead' && e.workspaceRef === w.ref && (!e.ts || !launch.ts || e.ts >= launch.ts)
    );
    if (alreadyDead) continue;
    out.push({ event: 'dead', taskId: launch.taskId, subject: launch.subject, workspaceRef: w.ref, title: w.title });
  }
  return out;
}

// Entries to append when a dispatch launch FAILED verification (task #503).
// Before this, an unverified launch wrote nothing at all: the shell cmux left
// behind had no 'launch' record, so deadBreadcrumbs() skipped it ("not a
// bsc-next auto-dispatch — not ours to journal") and deadAttemptsForTask()
// counted zero deaths however many times the task was blind-redispatched.
// That is how #334's guard shipped armed and still let 10 orphan auto-shells
// and 4 duplicate dispatches accumulate on 2026-07-26.
//
// Two entries, on purpose:
//   'dead'   — makes the attempt COUNT right now, without waiting for a sweep.
//   'launch' — makes the leftover shell ATTRIBUTABLE to this task, so a later
//              bsc-prune sweep can name it instead of listing a mystery tab.
//
// ORDER MATTERS: 'dead' is written FIRST (Opus ship-check blocker, Codex).
// These are two separate appends, so a bsc-prune sweep can interleave between
// them. With 'launch' first, a sweep landing in the gap would see a launch with
// no recorded death, emit its OWN 'dead' breadcrumb, and deadAttemptsForTask()
// would then count TWO deaths for a single failed launch — tripping the
// 2-death guard off one bad dispatch. Writing 'dead' first makes every
// interleaving safe: a sweep in the gap finds no launch record for the ref and
// skips it ("not ours to journal"); any later sweep sees the existing 'dead'
// and skips it as already-recorded. No lock needed.
//
// Returns [] when cmux left no workspace behind (nothing to attribute).
function failedLaunchEntries({ taskId, subject, workspaceRef, model = null, verifyCmd = null, verifyReason = null, notionId = null, failureReason = null, deadConfirmed = true }) {
  if (!workspaceRef) return [];
  const base = { taskId: String(taskId), subject, workspaceRef, failureReason };
  const launch = { event: 'launch', ...base, model, verifyCmd, verifyReason, notionId, unverified: true };
  // deadConfirmed=false is the card #705 slow-boot case: verification gave up
  // while this launch's wrapper process was STILL RUNNING, so the workspace is
  // very likely booting a real session. Recording a 'dead' breadcrumb for it
  // would be a lie with teeth — it feeds the 2-death dispatch guard and marks
  // a LIVE shell as a corpse for the pruner. The unverified launch entry still
  // lands, so the attempt is tracked and attributable.
  return deadConfirmed ? [{ event: 'dead', ...base, title: null }, launch] : [launch];
}

// ── Owner-closed workspaces (task #578) ────────────────────────────────────
// deadBreadcrumbs above can only see workspaces cmux STILL LISTS. When the
// owner closes a tab it leaves the list entirely, so its 'launch' entry was
// orphaned: deadAttemptsForTask() counted zero deaths and the dispatch guard
// re-opened the same card, forever (owner report 2026-08-02 — 17 launches in
// one day, 194 distinct launch refs against 26 live workspaces).
//
// A closed tab is an OWNER SIGNAL ("stop working this card"), not a failure,
// so it deliberately does NOT join the DEADLIKE set — burning one of two
// retries would mean closing a tab twice to make it stop. It parks instead.
//
// Absence is weak evidence (the whole #559/#564/#567 bug family came from
// trusting one liveness signal), so three things fence this in:
//   1. Only workspace-shaped refs. 'headless:N' and ref-less launches are
//      never in a cmux listing and would park instantly — they belong to the
//      headless-liveness half of #578, not here.
//   2. Only launches newer than a recorded epoch. Without this the first
//      sweep parks every historically-closed tab, including ones that closed
//      because they FINISHED.
//   3. Only launches with no terminal entry recorded after them, which is
//      what makes ✅-then-closed workspaces (prune-closed) immune.
const WORKSPACE_REF_RE = /^workspace:\d+$/;

// Events that end a launch's life. Any of these recorded AFTER a launch means
// that launch is already reconciled and needs no vanished breadcrumb.
// 'remapped' (task #883) is terminal for the OLD ref a renumber replaces —
// see remapEntries() below for why leaving it non-terminal reopens the exact
// bug this file's park guard exists to close.
const TERMINAL_LAUNCH_EVENTS = new Set(['dead', 'vanished', 'prune-closed', 'remapped']);

function isWorkspaceRef(ref) {
  return typeof ref === 'string' && WORKSPACE_REF_RE.test(ref);
}

// Last entry per workspaceRef matching `pred`, restricted to workspace:N refs
// (unlike launchByRef, which also matches headless:N and ref-less launches).
// Last-wins, same as launchByRef, because cmux refs are only monotonic until
// someone reinstalls it — after a counter reset, workspace:12 can belong to a
// 2026-07 task and a 2026-09 one, and the recent launch is the one a sweep is
// reconciling.
function lastByRef(entries, pred) {
  const m = new Map();
  for (const e of entries) {
    if (!isWorkspaceRef(e.workspaceRef) || !pred(e)) continue;
    m.set(e.workspaceRef, e);
  }
  return m;
}

// Timestamp this machine started trusting absence-means-closed. Returns null
// when unset, which every caller must treat as "do not sweep" — see
// vanishedBreadcrumbs' fail-closed guard.
function vanishEpoch(entries) {
  const e = entries.find(x => x.event === 'vanish-epoch');
  return e ? e.ts : null;
}

function vanishEpochEntry() {
  return { event: 'vanish-epoch', taskId: 'epoch' };
}

// How long the pre-epoch exclusion below holds. The epoch's job is a ONE-TIME
// guard against the first sweep after rollout mass-parking ~150 historical
// tabs that had already closed normally before #578 existed to record a
// terminal event for them. That job is done the moment the first sweep
// completes. A permanent (unbounded) exclusion instead makes epochTs a dead
// line in the sand: ANY task launched before it can never be parked again,
// however long its tab has been gone — card #801's root cause (health check
// "Stuck work: orphaned in-progress cards" never clearing; #434/#752/#758/#832
// were still "in flight" 6-14 days after their pre-epoch launch, ledger-wise
// immortal). 72h comfortably exceeds a normal session's runtime, so it never
// races a legitimately-long session, while still letting truly-dead pre-epoch
// history rejoin the same re-validate/ratio-guard/renumber protections every
// post-epoch launch already relies on.
const HISTORICAL_EXCLUSION_GRACE_MS = 72 * 60 * 60 * 1000;

// `liveRefs`: Set of workspace refs cmux currently lists. Returns the NEW
// 'vanished' breadcrumbs to append — one per launched-but-absent workspace.
// Idempotent: a ref only ever contributes one breadcrumb, because the
// breadcrumb itself is a terminal event for the next sweep.
//
// `now` (ms epoch) is required, matching this file's own detectLauncherOutage
// and dispatch-watchdog-core.js's planSweep — a silent default would let a
// caller forget it and keep getting the (soon-to-be-legacy) permanent-
// exclusion behavior with no signal, masking exactly the bug class this
// grace window exists to fix.
function vanishedBreadcrumbs(liveRefs, entries, { epochTs = null, now } = {}) {
  if (!(liveRefs instanceof Set)) {
    throw new Error('vanishedBreadcrumbs requires a Set of live workspace refs');
  }
  if (!Number.isFinite(now)) throw new Error('vanishedBreadcrumbs requires now (ms epoch)');
  // Fail closed on both "no epoch recorded" and "cmux listed nothing". An
  // empty listing is indistinguishable from cmux being restarted, crashed, or
  // mid-reinstall — and that is precisely the moment when every ref on the
  // machine looks vanished at once.
  if (!epochTs || liveRefs.size === 0) return [];
  // NaN epochMs (malformed epoch entry) must fail CLOSED — never let a bad
  // timestamp accidentally expire the grace and mass-park pre-epoch history.
  const epochMs = Date.parse(epochTs);
  const graceExpired = Number.isFinite(epochMs) && (now - epochMs) >= HISTORICAL_EXCLUSION_GRACE_MS;

  // Per-task liveness view: if a DIFFERENT, still-open launch for the same
  // taskId is CURRENTLY LIVE (in liveRefs), any other ref for that task is
  // superseded, not vanished — parking it would flip the Notion card to
  // Paused while a newer session is actively working the task under its own
  // ref. vanishedBreadcrumbs iterates per-REF (below), so without this a
  // stale pre-epoch ref surviving the grace above could independently
  // "vanish" even though the task moved on (ship-check catch, card #801).
  //
  // Requiring liveRefs.has() (not just "no terminal event yet") matters: a
  // newer launch that's ALSO absent from liveRefs is exactly as dead as the
  // one being considered — treating its mere existence as "superseding"
  // would suppress the older ref (which may carry the notionId Notion needs
  // to update) while the newer ref becomes its own candidate and, lacking a
  // notionId, parks in the ledger only — silently reproducing the exact
  // "Notion card stuck forever" bug this fix exists to close (Codex
  // adversarial review catch, card #801 ship-check).
  const openByTask = openTaskWorkspaceLaunches(entries);

  const lastTerminal = lastByRef(entries, e => TERMINAL_LAUNCH_EVENTS.has(e.event));
  const out = [];
  for (const [ref, launch] of lastByRef(entries, e => e.event === 'launch')) {
    if (liveRefs.has(ref)) continue;                       // still on screen
    if (!launch.ts) continue;
    if (launch.ts < epochTs && !graceExpired) continue;    // pre-epoch history is not ours to park (yet)
    const openElsewhere = openByTask.get(String(launch.taskId));
    if (openElsewhere && openElsewhere.workspaceRef !== ref && liveRefs.has(openElsewhere.workspaceRef)) continue; // superseded by a newer LIVE launch
    const term = lastTerminal.get(ref);
    if (term && term.ts >= launch.ts) continue;            // already reconciled
    out.push({
      event: 'vanished',
      taskId: launch.taskId,
      subject: launch.subject,
      workspaceRef: ref,
      notionId: launch.notionId || null,
    });
  }
  return out;
}

// Terminal entry for a workspace bsc-prune is about to close because it is
// ✅-marked (i.e. FINISHED). Written BEFORE the close, for the same reason
// failedLaunchEntries writes 'dead' before 'launch': the two writes are
// separate appends and a concurrent sweep can land between them. Written
// after the close, that sweep would see a launched, absent, unreconciled ref
// and park a card whose work is already done.
function pruneClosedEntry(workspace, entries) {
  const launch = launchByRef(workspace.ref, entries);
  if (!launch) return null; // not a bsc-next auto-dispatch — not ours to journal
  // Idempotence for the scheduled auto-prune tick (owner escalation
  // 2026-08-02): a ✅ workspace bsc-prune SKIPS (live claude) used to get a
  // fresh terminal breadcrumb on every sweep — harmless at owner-run cadence,
  // ~288 duplicate lines/day/ref at a 5-min tick. Same already-reconciled
  // rule vanishedBreadcrumbs applies: a terminal entry at or after this
  // launch means the ref is journaled and needs nothing more.
  const term = lastByRef(entries, e => TERMINAL_LAUNCH_EVENTS.has(e.event)).get(workspace.ref);
  if (term && launch.ts && term.ts && term.ts >= launch.ts) return null;
  return {
    event: 'prune-closed',
    taskId: launch.taskId,
    subject: launch.subject,
    workspaceRef: workspace.ref,
    title: workspace.title || null,
  };
}

// Reconciling events for isLedgerAutoDispatched, DELIBERATELY narrower than
// TERMINAL_LAUNCH_EVENTS — excludes 'prune-closed'. Verified live against
// production data (2026-08-03): mainLocked (bsc-prune.js) writes a
// 'prune-closed' entry for EVERY ✅-marked workspace BEFORE pruneDone even
// evaluates it, including ones pruneDone goes on to SKIP (its own header
// comment: "Entries are written for ✅ workspaces pruneDone may go on to
// SKIP... that is the safe direction"). workspace:124 in production had a
// same-tick 'prune-closed' entry for a tab that was still open with its 🤖
// glyph already gone — treating 'prune-closed' as reconciling here would
// have self-defeated this exact function on the FIRST sweep after every
// glyph-loss, since the write always lands in the ledger before this read.
// 'dead' (idle-unmarked bucket), 'vanished' (absent-from-listing sweep), and
// 'remapped' (renumber) are never written for a ref that is CURRENTLY ✅ and
// listed — the only bucket pruneDone calls this for — so none of them share
// prune-closed's same-tick self-defeat risk.
const LEDGER_DISPATCH_RECONCILED_EVENTS = new Set(['dead', 'vanished', 'remapped']);

// The unreconciled launch record for `workspaceRef`, or null. Uses lastByRef
// (same last-match semantics as launchByRef — see card #960/3b1637c5: cmux
// recycles workspace refs across restarts, so first-match can attribute a
// recycled ref to a long-dead task) AND requires the launch to be
// UNRECONCILED against LEDGER_DISPATCH_RECONCILED_EVENTS.
function findLedgerAutoDispatchLaunch(workspaceRef, entries) {
  if (!isWorkspaceRef(workspaceRef)) return null;
  const launch = lastByRef(entries, e => e.event === 'launch').get(workspaceRef);
  if (!launch) return null;
  const term = lastByRef(entries, e => LEDGER_DISPATCH_RECONCILED_EVENTS.has(e.event)).get(workspaceRef);
  if (term && launch.ts && term.ts && term.ts >= launch.ts) return null; // reconciled — not ours anymore
  return launch;
}

// Whether the CURRENT occupant of `workspaceRef` (identified by its LIVE
// title) is a 🤖 auto-dispatch according to the ledger — the fallback
// pruneDone's isAutoDispatched check falls back to when the 🤖 title glyph
// is gone (card #971: a dispatched session that renames its tab mid-work —
// common for status-reflecting renames — drops the glyph, so the title-only
// check misreads it as owner-opened and it never auto-closes, even after it
// ✅-marks and goes idle/dead).
//
// Requires TWO independent signals to agree, not just an unreconciled ledger
// launch (Codex adversarial review, 2026-08-03, P0 catch): 'prune-closed' is
// deliberately excluded from LEDGER_DISPATCH_RECONCILED_EVENTS above (see its
// header comment — it self-defeats on every still-open skip), which means a
// ref that was GENUINELY closed via a real prune-closed close, then recycled
// by cmux to an unrelated owner-opened tab, has no reconciling event left for
// findLedgerAutoDispatchLaunch to see — that stale launch would otherwise
// read as "still open." titleMatchesSubject (used elsewhere in this file for
// exactly this "does the same session still occupy this ref" question, in
// findRenumberedWorkspace) is the second signal: an owner's unrelated tab
// will not share a >=20-char prefix with a launch subject it has never seen,
// while a genuine status-reflecting rename preserves the original title as a
// prefix by convention (dispatch instructions require appending, never
// replacing, the title). Same dual-signal doctrine as checkLiveness in
// cmux-workspaces.js (never trust one registry alone for a close decision).
function isLedgerAutoDispatched(workspaceRef, title, entries) {
  const launch = findLedgerAutoDispatchLaunch(workspaceRef, entries);
  return Boolean(launch) && titleMatchesSubject(title, launch.subject);
}

// ── Restart-vs-close disambiguation (task #883) ────────────────────────────
// A cmux crash/restart renumbers EVERY open workspace ref at once, so a
// naive "ref not in the current listing" read (vanishedBreadcrumbs above)
// cannot tell that apart from the owner closing every one of those tabs by
// hand in the same 5-minute tick — physically implausible. Owner report
// 2026-08-03: task #853 was found dead only by manual audit, and the park
// guard demanded --force because it had already (wrongly) parked it as an
// owner-close. Two independent signals, either one enough to withhold a
// park (matches the card's "match by tab TITLE... OR mass renumbering"):
//   1. titleMatchesSubject / findRenumberedWorkspace — the SAME session is
//      still listed, just under a new ref. Remap, don't park.
//   2. looksLikeRestart — even without a title hit (a rename, a still-
//      rendering surface at the exact sweep moment), a large fraction of
//      currently-tracked launches vanishing in one sweep is never a batch of
//      individual owner closes.

// Prefix-compares a workspace title against a launch subject, ignoring
// cmux's activity-glyph prefix and the auto-dispatch "<Project>·" prefix.
// Same >=20-char rule bsc-next.js's findLiveWorkspaceForTask uses for the
// duplicate-dispatch guard (scope add, card #168) — a short match is
// coincidence, not evidence, so both guards agree on the bar.
function titleMatchesSubject(title, subject) {
  const launchTitle = String(subject || '').slice(0, 50);
  const t = stripAutoPrefix(String(title || '').replace(/^[^\p{L}\p{N}[]+/u, ''));
  const n = Math.min(t.length, launchTitle.length);
  return n >= 20 && t.slice(0, n) === launchTitle.slice(0, n);
}

// Find a currently-live workspace (from a fresh listWorkspaces() call) whose
// title still matches this vanished-candidate launch's subject — i.e. the
// same session under a NEW ref after a renumbering. `excludeRefs` stops two
// candidates in the same sweep from both claiming the one still-alive match.
function findRenumberedWorkspace(launch, liveWorkspaces, excludeRefs = new Set()) {
  return (liveWorkspaces || []).find(w =>
    !excludeRefs.has(w.ref) && titleMatchesSubject(w.title, launch.subject)) || null;
}

// Two-entry write for a renumber remap (ship-check P0 catch, 2026-08-03): a
// bare new 'launch' for the new ref with nothing terminal for the OLD one
// left the old ref permanently "open" — vanishedBreadcrumbs re-flagged it as
// a fresh candidate on every following sweep, and findRenumberedWorkspace
// re-matched the SAME live workspace again, so one restart produced a
// remap line every 5 minutes forever (the exact spam pruneClosedEntry's
// before-the-close ordering already exists to prevent for the ✅ path).
// 'remapped' is written FIRST for the old ref (a sweep landing between the
// two appends sees it already terminal and skips re-detecting it — same
// ordering rationale as failedLaunchEntries' 'dead'-before-'launch' above).
// model/verifyCmd/verifyReason are carried forward from the ORIGINAL launch
// so the nightly acceptance recheck (which reads the latest launch per
// notionId) doesn't silently downgrade a remapped card to "unverifiable".
function remapEntries({ taskId, subject, oldRef, newRef, notionId = null, model = null, verifyCmd = null, verifyReason = null }) {
  const id = String(taskId);
  return [
    { event: 'remapped', taskId: id, subject, workspaceRef: oldRef, newRef },
    { event: 'launch', taskId: id, subject, workspaceRef: newRef, notionId, model, verifyCmd, verifyReason, remapped: true, previousRef: oldRef },
  ];
}

// Denominator for looksLikeRestart: how many workspace-shaped launches the
// ledger currently believes are still open (post-epoch, no terminal event
// yet) — regardless of whether cmux's live listing still contains them.
// `now` (ms epoch) must apply the SAME pre-epoch grace as vanishedBreadcrumbs
// — this count is the denominator looksLikeRestart() compares candidates
// against (bsc-prune.js), so counting a different population than
// vanishedBreadcrumbs' candidates (e.g. still excluding pre-epoch launches
// here while they've become eligible candidates there) would distort the
// mass-restart ratio (ship-check catch, card #801: Codex adversarial
// review flagged the two functions drifting out of sync).
function openWorkspaceLaunchCount(entries, { epochTs, now } = {}) {
  if (!epochTs) return 0;
  if (!Number.isFinite(now)) throw new Error('openWorkspaceLaunchCount requires now (ms epoch)');
  const epochMs = Date.parse(epochTs);
  const graceExpired = Number.isFinite(epochMs) && (now - epochMs) >= HISTORICAL_EXCLUSION_GRACE_MS;
  const lastTerminal = lastByRef(entries, e => TERMINAL_LAUNCH_EVENTS.has(e.event));
  let n = 0;
  for (const [ref, launch] of lastByRef(entries, e => e.event === 'launch')) {
    if (!launch.ts) continue;
    if (launch.ts < epochTs && !graceExpired) continue;
    const term = lastTerminal.get(ref);
    if (term && term.ts >= launch.ts) continue;
    n++;
  }
  return n;
}

// Conservative on purpose (owner escalation 2026-08-03 is the incident this
// exists to prevent): a false "looks like restart" only costs one extra
// sweep before parking resumes; a false "not a restart" wrongly parks live
// work and demands the owner notice and --force it back. RESTART_MIN_COUNT
// keeps a single ordinary tab-close (the overwhelmingly common case) from
// ever tripping this — that always parks normally.
const RESTART_MIN_COUNT = 3;
const RESTART_FRACTION = 0.5;
function looksLikeRestart(candidateCount, totalOpenCount) {
  return candidateCount >= RESTART_MIN_COUNT && totalOpenCount > 0 &&
    (candidateCount / totalOpenCount) >= RESTART_FRACTION;
}

// Bounded hold for the restart circuit breaker (ship-check P0 catch,
// 2026-08-03): without a decay, a GENUINE mass-close (owner closes 3+ tabs
// in one cleanup pass, none of them renumbered — no title match ever
// arrives) trips looksLikeRestart forever, since the candidate set never
// shrinks on its own. That silently regresses #578 (parking a closed tab
// stops it from being re-dispatched) for exactly the cards this feature
// must not break. A real restart's remap resolves within a tick or two once
// cmux stabilizes; capping the hold at RESTART_HOLD_MAX_MS means a genuine
// mass-close is merely delayed (one extra reconcile cycle), never stuck.
const RESTART_HOLD_MAX_MS = 15 * 60 * 1000; // 3 ticks at the 5-min ledger cadence

function restartHoldEntry(refs) {
  return { event: 'restart-hold', taskId: 'sweep', refs };
}

// Most recent restart-hold entry (last-wins — an expired hold from a prior,
// already-resolved incident must never suppress a later, unrelated one).
function lastRestartHold(entries) {
  let hold = null;
  for (const e of entries) if (e.event === 'restart-hold') hold = e;
  return hold;
}

// ── Reconciler input (task #883) ────────────────────────────────────────
// Latest workspace-shaped launch per task that has no terminal event after
// it yet — i.e. what the ledger currently believes is a live cmux session
// for that task. This is the reconciler's worklist: cross-reference against
// the shared task list's in_progress tasks and cmux's actual live listing to
// find sessions that died silently (the #853 "found dead manually" gap).
// Headless jobs are deliberately excluded (isWorkspaceRef) — bsc-reconcile's
// existing lease/PID orphan sweep already covers those; this must not
// duplicate or race that detector.
function openTaskWorkspaceLaunches(entries) {
  const byTask = new Map();
  for (const e of entries) {
    if (e.event !== 'launch' || !isWorkspaceRef(e.workspaceRef) || e.taskId == null) continue;
    byTask.set(String(e.taskId), e); // last launch per task wins (file order)
  }
  const lastTerminal = lastByRef(entries, e => TERMINAL_LAUNCH_EVENTS.has(e.event));
  const open = new Map();
  for (const [taskId, launch] of byTask) {
    const term = lastTerminal.get(launch.workspaceRef);
    if (term && launch.ts && term.ts && term.ts >= launch.ts) continue; // reconciled
    open.set(taskId, launch);
  }
  return open;
}

// ── Cross-task launcher outage detector (card #900, 2026-08-03) ────────────
// The 8/3 cmux restart produced six dead cmux-launch attempts across FIVE
// distinct tasks (897/855x2/857/902/901) in under two hours, every one of
// them "command injection never ran (no wrapper process appeared)" — the
// wake fix (#849) already covers a single stuck launch, but nothing had ever
// looked ACROSS tasks to notice that a run of these in a short window is not
// "this task is unlucky," it's "cmux itself is not accepting new-workspace
// injections right now." Each task silently ate its own dead-attempt count
// and fell back to headless (or gave up) with no signal that the common
// cause was the launcher, not the task. Pure + ledger-shaped like
// looksLikeRestart above, but a distinct signal: that one detects EXISTING
// workspaces vanishing from cmux's listing; this one detects NEW launches
// failing to ever start.
const OUTAGE_MIN_DISTINCT_TASKS = 3;
const OUTAGE_LOOKBACK_MS = 30 * 60 * 1000; // matches the observed 8/3 cluster width with room to spare
// 'wrapper exited' deliberately EXCLUDED (Codex adversarial review, 2026-08-03):
// that state means the typed command DID run and then the process died — a
// per-task crash/bad-command signature, proof injection is working, not the
// launcher failing to inject. Conflating it here would raise a confident,
// false "cmux is not accepting commands" alarm off three unrelated task
// bugs, exactly the kind of silent-wrongness this detector exists to avoid.
const OUTAGE_REASON_RE = /injection never ran/;

// entries: full ledger (readEntries()). now: ms epoch (test seam — Date.now()
// is unavailable in workflow scripts, callers pass it explicitly).
function detectLauncherOutage(entries, { now, lookbackMs = OUTAGE_LOOKBACK_MS, minDistinctTasks = OUTAGE_MIN_DISTINCT_TASKS } = {}) {
  if (!Number.isFinite(now)) throw new Error('detectLauncherOutage requires now (ms epoch)');
  const cutoff = now - lookbackMs;
  const deaths = entries.filter(e => e.event === 'dead' && isWorkspaceRef(e.workspaceRef) &&
    OUTAGE_REASON_RE.test(String(e.failureReason || '')) && e.ts && Date.parse(e.ts) >= cutoff);
  if (!deaths.length) return { outage: false, count: 0, taskIds: [] };

  // Newest death, not oldest (Codex adversarial review, 2026-08-03 — P0):
  // comparing against the OLDEST death let failure→success→3-more-failures
  // read as "recovered" the instant that one success landed, even though the
  // launcher broke again right after it. Only a verified success AFTER every
  // death currently in the window is real evidence the launcher is healthy
  // right now.
  const newestDeathTs = deaths.reduce((max, e) => e.ts > max ? e.ts : max, deaths[0].ts);
  const recovered = entries.some(e => e.event === 'launch' && !e.unverified && e.ts && e.ts > newestDeathTs);
  if (recovered) return { outage: false, count: deaths.length, taskIds: [...new Set(deaths.map(e => String(e.taskId)))], recovered: true };

  const taskIds = [...new Set(deaths.map(e => String(e.taskId)))];
  const oldestDeathTs = deaths.reduce((min, e) => e.ts < min ? e.ts : min, deaths[0].ts);
  return {
    outage: taskIds.length >= minDistinctTasks,
    count: deaths.length,
    taskIds,
    sinceTs: oldestDeathTs,
  };
}

// Tasks currently parked by an owner tab-close. A later 'launch' clears the
// park on purpose: dispatching anyway (bsc-next --force) IS the unpark, so the
// state is self-healing rather than a trap only a remembered flag escapes.
// 'unpark' exists for clearing without dispatching.
function parkedTasks(entries) {
  const parked = new Map();
  for (const e of entries) {
    if (e.taskId == null) continue;
    const id = String(e.taskId);
    if (e.event === 'vanished') parked.set(id, e);
    else if (e.event === 'unpark' || e.event === 'launch') parked.delete(id);
  }
  return parked;
}

function unparkEntry({ taskId, reason = null }) {
  return { event: 'unpark', taskId: String(taskId), reason };
}

// Newest-parked-first, capped shape for a single digest line (card #777).
// Extracted as a pure function (CLAUDE.md §15) so autonomous-email.js and
// bsc-status.js share one tested selection instead of each re-deriving it —
// an unbounded historical replay in one email footer line becomes
// unwieldy/clipped over months and buries the card the owner most needs to
// see (ship-check finding, Codex adversarial review).
function selectParkedCardsForDigest(parked, maxShown = 10) {
  const sorted = [...parked.values()].sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  const shown = sorted.slice(0, maxShown).map(e => ({ taskId: e.taskId, subject: e.subject, workspaceRef: e.workspaceRef }));
  return { shown, moreCount: Math.max(0, sorted.length - maxShown) };
}

// ── Headless-job events (Autopilot v5, task #459) ──────────────────────────
// bsc-runner.js appends these; bsc-reconcile.js and bsc-status.js fold them.
// One ledger for tabs AND jobs on purpose: the dead-attempt guard must see
// every prior attempt on a task in ONE file (plan-review design finding P1-6 —
// a second ledger recreates "counts only recorded deaths" in a new shape).
// Lines stay SMALL (ids + paths, never prompt/result text) so appendFileSync
// stays within the atomic-append window; big text lives in the per-job log.
const JOB_EVENTS = Object.freeze({
  SPAWNED: 'job-spawned',   // + pid, sessionId(null until envelope), cwd, logFile, model
  DONE: 'job-done',         // + sessionId, costUSD
  FAILED: 'job-failed',     // + stage (claude-cli STAGES / autonomous-run-core vocabulary)
  ORPHANED: 'job-orphaned', // appended by bsc-reconcile when pid is dead with no terminal event
  RETRIED: 'job-retried',   // reconciler-initiated resume attempt (capped)
  // Card #1454: a headless `launch` row (workspaceRef `headless:N`/`linear:N`) can
  // reach runJob() and still never spawn a job — acquireLease() finds the task's
  // lease already held (a duplicate-dispatch race), or something throws before the
  // spawn (e.g. LEASE_ROOT mkdir failure). Before this event existed, that launch
  // got NO jobId-bearing row at all: foldJobs()/openJobs() are jobId-keyed, so it
  // was invisible to every job-outcome read, forever. Written ONLY by
  // bsc-runner.runJob() itself (the jobId is already minted before the lease check,
  // so it's always available). Deliberately NOT in isDeadlikeEvent below: a
  // lease-held abandon means a DIFFERENT job for this task is healthy right now —
  // feeding it into the substantive-dead-attempt count would let two benign
  // concurrent-dispatch races permanently park a task that never actually failed.
  ABANDONED: 'job-abandoned',
});

// RETRIED is terminal for the OLD jobId: a retry supersedes it with a brand-new
// job (its own spawned→done/failed chain). Leaving it open made the old id a
// permanent ghost that every tick re-orphaned (ship-check Codex blocker).
// ABANDONED joins the set for the same reason (card #1454): without it, a
// lease-held/pre-spawn-abandoned "job" reads as perpetually open to every
// TERMINAL_JOB_EVENTS consumer (bsc-status.js, backlog-drain.js,
// dispatch-card-drift.js, digest-autofix.js, autofix-canary.js).
const TERMINAL_JOB_EVENTS = new Set([JOB_EVENTS.DONE, JOB_EVENTS.FAILED, JOB_EVENTS.ORPHANED, JOB_EVENTS.RETRIED, JOB_EVENTS.ABANDONED]);

// Latest job state per jobId: fold events, last one wins. Returns
// Map<jobId, {jobId, taskId, event, ...lastEntryFields}>.
function foldJobs(entries) {
  const jobs = new Map();
  for (const e of entries) {
    if (!e.jobId || !String(e.event || '').startsWith('job-')) continue;
    jobs.set(e.jobId, { ...(jobs.get(e.jobId) || {}), ...e });
  }
  return jobs;
}

function openJobs(entries) {
  return [...foldJobs(entries).values()].filter(j => !TERMINAL_JOB_EVENTS.has(j.event));
}

// Task #1184 S1: a timed-out job the reconciler resumes ends 'job-retried'
// (terminal for the OLD jobId) while a SUCCESSOR job continues the same card.
// Every reader that scores a dispatch by its job's terminal event must follow
// the chain, or a live/successful resume reads as a failure (ship-check Codex
// finding: digest-autofix and backlog-drain each scored resumed jobs
// card-fail). ONE shared implementation here so the two readers cannot drift.
//
// Attribution is CAUSAL when possible: bsc-runner stamps the successor's
// job-spawned entry with resumeOfSession (the session id it continued),
// matched against the RETRIED entry's own sessionId — a manual `bsc-next
// --headless` job spawned in the gap can never be credited as the resume
// (Codex finding: time-ordering alone is not causal). Fallback for entries
// predating the stamp: earliest spawn AFTER the retry that is itself marked
// `resumed`. A chain ending at RETRIED (successor not spawned yet, or resume
// child died pre-spawn) is returned as-is — callers treat it as in-flight
// within their own orphan bound.
function followRetryChain(entries, taskId, firstJobId) {
  const taskEntries = (entries || []).filter(e => e && String(e.taskId) === String(taskId));
  const jobs = foldJobs(taskEntries);
  const spawns = taskEntries.filter(e => e.event === JOB_EVENTS.SPAWNED)
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  let job = jobs.get(firstJobId) || null;
  const visited = new Set();
  while (job && job.event === JOB_EVENTS.RETRIED && !visited.has(job.jobId)) {
    visited.add(job.jobId);
    const causal = spawns.find(s => !visited.has(s.jobId) && s.jobId !== job.jobId
      && s.resumeOfSession && job.sessionId && s.resumeOfSession === job.sessionId);
    const retriedMs = Date.parse(job.ts || '') || 0;
    const next = causal || spawns.find(s => !visited.has(s.jobId) && s.jobId !== job.jobId
      && s.resumed === true && (Date.parse(s.ts || '') || 0) >= retriedMs - 5000);
    if (!next) break;
    job = jobs.get(next.jobId) || null;
  }
  return job;
}

module.exports = {
  LEDGER_PATH, DEAD_ATTEMPT_LIMIT, INFRA_DEAD_ATTEMPT_LIMIT, JOB_EVENTS, TERMINAL_JOB_EVENTS,
  TERMINAL_LAUNCH_EVENTS, SUCCESSION_DEPTH_CAP, successionDepthForTask,
  appendEntry, readEntries, deadAttemptsForTask, launchByRef, deadBreadcrumbs,
  failedLaunchEntries, foldJobs, openJobs,
  // isInfraDeadEntry/deadDispatchCapStatus were card #1233's v1 API. The v2
  // implementation (ba2a4f22d3f) replaced both with classifyDeadAttemptsForTask
  // + dispatchCapDecision and deleted their definitions, but two racing
  // sessions on the same card left the v1 names in this list: require() then
  // threw ReferenceError and EVERY consumer (backlog-drain, bsc-runner,
  // bsc-next, dispatch-watchdog, the S6 canary) died on load. Do not re-add
  // them when resolving a merge from an older branch.
  classifyDeadAttemptsForTask, substantiveDeadAttemptsForTask, dispatchCapDecision,
  isDeadlikeEvent, isAttemptEvent, latestAttemptForTask, isLatestDispatchDead, followRetryChain,
  isWorkspaceRef, vanishEpoch, vanishEpochEntry, vanishedBreadcrumbs,
  pruneClosedEntry, isLedgerAutoDispatched, findLedgerAutoDispatchLaunch, parkedTasks, unparkEntry, selectParkedCardsForDigest,
  titleMatchesSubject, findRenumberedWorkspace, openWorkspaceLaunchCount,
  looksLikeRestart, RESTART_MIN_COUNT, RESTART_FRACTION,
  RESTART_HOLD_MAX_MS, restartHoldEntry, lastRestartHold,
  remapEntries,
  openTaskWorkspaceLaunches,
  detectLauncherOutage, OUTAGE_MIN_DISTINCT_TASKS, OUTAGE_LOOKBACK_MS,
};
