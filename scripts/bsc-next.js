#!/usr/bin/env node
/**
 * bsc-next — open a new Cmux workspace already running Claude Code on your top
 * prioritized task, seeded with its full Notion context.
 *
 * Kills the "open a session → remember which P1 → find it in Notion → paste the
 * context" ritual. The task queue is the shared list that notion-tasks-sync
 * mirrors from your Notion backlog (~/.claude/tasks/<list-id>/), so "top task"
 * is already priority-ordered.
 *
 *   bsc-next                 launch a Cmux workspace on the top actionable task
 *   bsc-next --pick 3        launch on the 3rd task in the actionable list
 *   bsc-next --id 12         launch on task #12 specifically
 *   bsc-next --list          show the top actionable tasks, launch nothing
 *   bsc-next --dry-run       print the chosen task + seed prompt, launch nothing
 *   bsc-next --exec          run `claude` in THIS terminal instead of a Cmux workspace
 *
 * "Actionable" = pending first, then in_progress; completed tasks are skipped.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const REPO = '/Users/tompryor/Broadwayscore';
const cmuxws = require('./lib/cmux-workspaces.js');
const { launchCmuxSession } = require('./lib/cmux-launch.js');
const { hasHelpFlag } = require('./lib/cli-help.js');
const LIST_ID = process.env.CLAUDE_CODE_TASK_LIST_ID || 'broadwayscore';
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', LIST_ID);

const USAGE = `bsc-next — open a new Cmux workspace already running Claude Code on your top
prioritized task, seeded with its full Notion context.

Usage:
  bsc-next                 launch a Cmux workspace on the top actionable task
  bsc-next --pick 3        launch on the 3rd task in the actionable list
  bsc-next --id 12         launch on task #12 specifically
  bsc-next --list          show the top actionable tasks, launch nothing
  bsc-next --dry-run       print the chosen task + seed prompt, launch nothing
  bsc-next --exec          run \`claude\` in THIS terminal instead of a Cmux workspace
  bsc-next --headless      run as a supervised background job (bsc-runner) — no tab;
                           watch with bsc-status, kill switch BSC_RUNNER_DISABLED=1
  bsc-next --model <m>     override the resolved model for this dispatch
  bsc-next --force         bypass the completed-task / duplicate-workspace guards
  bsc-next --allow-unverifiable  dispatch a card with no runnable verify command
                           (recorded in the dispatch ledger; recheck lists it as unverifiable)
  bsc-next --allow-human-gated   dispatch --headless even when the card needs a human
                           to finish it (owner visual-qa approval, an owner decision,
                           a long external wait). Refused by default — see task #1004.
  bsc-next --id N --succession --handoff <path>
                           context-limit succession: relaunch task N's IN-FLIGHT
                           work with a fresh context window, seeded from a
                           checkpoint brief at <path> instead of the card. Skips
                           the duplicate/dead/parked guards (the predecessor
                           workspace is expected to still be open). Depth is
                           derived from the dispatch ledger and hard-capped —
                           see SUCCESSION_DEPTH_CAP in scripts/lib/dispatch-ledger.js.
  bsc-next --help, -h      show this message, do nothing else
`;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) a[k] = true;
      else { a[k] = n; i++; }
    } else a._.push(t);
  }
  return a;
}

// Card #854: completed tasks >48h old are moved to a sibling archive/ dir
// (scripts/archive-completed-tasks.js) so the harness's injected task-list
// reminder — one line per file in this directory — stops scaling with the
// full history of every task ever completed. loadTasks() deliberately stays
// live-dir-only (ship-check finding 2026-08-02: an eager archive/ merge here
// meant every `--list`/actionable() call re-read the entire archive — 400+
// files and growing — even though actionable() immediately filters archived
// tasks out, since they're always status:'completed'). pickTask()'s --id
// branch does a cheap point lookup into archive/ instead, only on a live
// miss — the one call site that actually needs to reach an archived task
// (completedLaunchGuard's --dry-run inspection path).
const { readArchivedTask, mergeWithArchive } = require('./lib/task-store-archive.js');

// ── pure logic (exported for tests) ────────────────────────────────────────
function loadTasks(dir) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  return files
    .filter(f => /^\d+\.json$/.test(f))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((x, y) => parseInt(x.id, 10) - parseInt(y.id, 10)); // id order == mirror/priority order
}

// Notion priority is mirrored into the task description's first line
// ("[notion:<id>] P0 Now · In progress · Marketing"). Rank it so "top" means
// highest priority, not just lowest task id. Unknown/absent → lowest.
function priorityRank(task) {
  const m = /\]\s*(P\d)\b/.exec(task.description || '');
  return m ? parseInt(m[1].slice(1), 10) : 9;
}

// Human-territory filtering (Marketing/Partnerships categories + short
// human-action imperatives like "Email volunteers") lives in the canonical
// eligibility module shared with the autonomous nightly loop. History: on
// 2026-07-12 bsc-next default-picked "Scope the TodayTix partnership" and the
// session started drafting business strategy — hence the category exclusion.
// Excluded cards can still be selected explicitly via --id / --pick.
const { EXCLUDED_CATEGORIES, categoryOf, isExcludedCategory } = require('./lib/autonomous-eligibility.js');

// Model resolution (task #151): explicit --model > card hint > the loop's own
// pickModel() by triage size > sonnet floor. See scripts/lib/bsc-next-model.js
// for the full resolution order and why it reuses (not duplicates) the
// nightly loop's model policy.
const { resolveModel } = require('./lib/bsc-next-model.js');

// Cmux workspace naming (owner scope-add, card #168, 2026-07-14): auto-
// dispatched workspaces get "🤖 <Project>·<subject>" so the sidebar is
// scannable without opening every tab. See scripts/lib/workspace-naming.js.
const { projectOf, buildAutoTitle, modelGlyph } = require('./lib/workspace-naming.js');
// The triage queue is a single canonical instance on the main checkout (like
// notion-brain.js above) — anchor to REPO, not __dirname, so a dispatch
// launched from inside a worktree still reads the real queue, not an empty
// worktree-local copy (the file is gitignored, so worktrees never have it).
const QUEUE_PATH = path.join(REPO, 'data', 'audit', 'autonomous-queue.json');

// Dispatch-attempt ledger (task #334): task #297 accumulated 3 dead cmux
// workspaces because nothing recorded that repeated dispatches all landed on
// the same task, and a session killed at the #289 >30min timeout never runs
// the Stop hook's ✅ self-mark. Every verified launch is journaled here;
// bsc-prune.js journals the matching 'dead' breadcrumb once a launch's
// workspace turns up idle-and-unmarked. See scripts/lib/dispatch-ledger.js.
const dispatchLedger = require('./lib/dispatch-ledger.js');
const { evaluateVerifiability } = require('./lib/verify-gate.js');
const { classifyHeadlessDispatchability, BLOCKERS: HEADLESS_BLOCKERS } = require('./lib/headless-dispatchability.js');

// CI-red claim auto-invocation (task #598): the ledger built by task #584
// (evaluateCiRedClaim, enforced at the push-gate hook) stayed empty in
// practice because nothing ever called appendClaim() outside a human running
// scripts/claim-ci-red.js by hand. bsc-next.js is every CI-red fix task's
// single dispatch chokepoint (cmux, --headless, --exec all route through
// main()), so it records the claim itself instead of relying on the
// dispatched session to remember the CLI exists.
const { extractCiRedTarget } = require('./lib/ci-red-dispatch-heuristic.js');
const { appendClaim } = require('./lib/ci-red-claims.js');
const { findOverlappingCards } = require('./lib/dispatch-overlap-check.js');

// Actionable list, best-first: by Notion priority, then pending before
// in_progress (fresh work first), then task id. Completed dropped;
// Marketing/Partnerships dropped unless includeExcluded (used by --list to show
// them greyed rather than hide them).
function actionable(tasks, includeExcluded = false) {
  return tasks
    .filter(t => t.status === 'pending' || t.status === 'in_progress')
    .filter(t => includeExcluded || !isExcludedCategory(t))
    .sort((a, b) =>
      priorityRank(a) - priorityRank(b) ||
      (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) ||
      parseInt(a.id, 10) - parseInt(b.id, 10));
}

// `dir`, when passed, is used only as a fallback for a `--id` miss against
// the live tasks array — see loadTasks()'s docstring above for why this is
// a point lookup rather than a merge. Omitting it (as the existing pure
// unit tests do) just means an archived --id isn't found, matching pickTask's
// pre-#854 behavior.
function pickTask(tasks, opts, dir) {
  if (opts.id) {
    const live = tasks.find(t => String(t.id) === String(opts.id));
    if (live) return live;
    return dir ? readArchivedTask(dir, String(opts.id)) : null;
  }
  const list = actionable(tasks);
  // `--pick` with no value (=== true) or non-numeric → default to the top task.
  const parsed = parseInt(opts.pick, 10);
  const idx = Number.isInteger(parsed) ? parsed - 1 : 0;
  return list[idx] || null;
}

// --id deliberately reaches completed tasks (pickTask keeps that reach for
// inspection via --dry-run), but LAUNCHING on one is almost always a typo'd
// task # relaunching finished work. Require --force to actually launch.
function completedLaunchGuard(task, opts) {
  if (task.status !== 'completed' || opts.force || opts['dry-run'] || opts['print-prompt']) return null;
  return `task #${task.id} is already completed (${task.subject}). ` +
    `If you really want to relaunch it, re-run with --force.`;
}

// Duplicate-dispatch guard: a live (non-✅) workspace whose title matches this
// task's launch title means a session is already on it — launching another
// splits the work (near-miss 2026-07-13: task #46 dispatched while
// workspace:37 was still open on it). Titles get activity-glyph prefixes in
// list output and may be truncated, so compare glyph-stripped prefixes.
function findLiveWorkspaceForTask(task, workspaces, isDone) {
  // titleMatchesSubject (dispatch-ledger.js) strips cmux's own activity-glyph
  // prefix (spinner/✳/etc — also eats the 🤖 auto-dispatch emoji, since it
  // isn't a letter/digit), THEN strips the "<Project>·" naming prefix (scope
  // add, card #168), so a live auto-dispatched workspace still matches its
  // raw task subject. Shared with the park-guard's renumber rematch (task
  // #883) so both guards agree on the same >=20-char bar — a drift between
  // them would make one see a match the other doesn't.
  return workspaces.find(w => !isDone(w.title) && dispatchLedger.titleMatchesSubject(w.title, task.subject)) || null;
}

// Refuse a blind re-dispatch once a task has died DEAD_ATTEMPT_LIMIT times
// without ever being verified alive again (task #334: task #297 got a 3rd
// dead cmux workspace opened onto it with zero visibility into the 2 that
// already died). --force / --dry-run / --print-prompt bypass it, matching
// completedLaunchGuard's carve-outs.
function deadDispatchGuard(task, ledgerEntries, opts) {
  if (opts.force || opts['dry-run'] || opts['print-prompt']) return null;
  const dead = dispatchLedger.deadAttemptsForTask(task.id, ledgerEntries);
  if (dead.length < dispatchLedger.DEAD_ATTEMPT_LIMIT) return null;
  const refs = dead.map(d => d.workspaceRef).filter(Boolean).join(', ') || 'unknown refs';
  return `task #${task.id} has died ${dead.length}x already without finishing (dead workspaces: ${refs}). ` +
    `Blind re-dispatch won't fix a task that keeps dying — investigate first: shrink the scope, escalate with ` +
    `--model opus, or route it through the Notion Action "Fix" pipeline (has its own capped-retry timeout ` +
    `handling — see task #289). Re-run with --force to dispatch anyway.`;
}

// Owner-close park (task #578). The duplicate-dispatch guard only fires while
// a matching workspace is STILL LISTED, so closing a tab used to hand the card
// straight back to the dispatcher — 17 launches in one day, 187 launch refs
// against 26 live workspaces (owner report 2026-08-02). bsc-prune records a
// 'vanished' breadcrumb for a tab that left the listing; this refuses to
// reopen it. Same signature/shape as deadDispatchGuard above: pure, returns a
// refusal string or null, and main() owns the exit.
//
// --force IS the unpark (its launch entry clears the park — see
// dispatchLedger.parkedTasks), so this can never become a state whose only
// escape is a flag nobody remembers.
function parkedGuard(task, ledgerEntries, opts) {
  if (opts.force || opts['dry-run'] || opts['print-prompt']) return null;
  const parked = dispatchLedger.parkedTasks(ledgerEntries).get(String(task.id));
  if (!parked) return null;
  return `[bsc-next] task #${task.id} is parked: its workspace (${parked.workspaceRef}) was closed on ` +
    `${String(parked.ts || '').slice(0, 10)} without being marked done. Closing a tab means "stop working ` +
    `this card", so nothing re-dispatches it on its own.\n` +
    `  To resume it: node scripts/bsc-next.js --id ${task.id} --force`;
}

// Pure composition of the self-heal + refusal check (no I/O — main() does the
// actual ledger append and process.exit). Split out so the burst scenario
// that motivated task #334 is directly unit-testable: waiting for a 'dead'
// breadcrumb that only bsc-prune.js writes (typically once/day) would let a
// same-SESSION burst of redispatches sail through, since no sweep runs
// between dispatch #2 dying and dispatch #3 launching (ship-check adversarial
// finding, 2026-07-22). Here bsc-next.js computes idle-and-unmarked itself,
// from the live cmux list, using the SAME predicate bsc-prune.js uses —
// dispatch #3 then sees dispatch #1 and #2's now-idle workspaces as fresh
// 'dead' breadcrumbs without needing a sweep in between.
//
// Card #564: claudeAliveInFn alone is the same single-signal trust that #559
// proved has a real false-negative mode (verified live, 2026-07-26: a
// workspace had claudeAliveIn() === false while visibly still running with an
// active Claude Code session). A false "idle" verdict here means a still-live
// workspace gets treated as a dead breadcrumb, self-healing deadDispatchGuard
// into green-lighting a SECOND dispatch onto a task someone is already
// working on. Same fix shape as #559's pruneDone: require the independent
// terminal-surface signal (surfaceAliveFn) to ALSO say not-alive before a
// workspace counts as idle-and-dead.
function checkDeadDispatch(task, workspaces, ledgerEntries, isDoneTitleFn, claudeAliveInFn, surfaceAliveFn, opts) {
  const idle = workspaces.filter(w => !isDoneTitleFn(w.title) && cmuxws.checkLiveness(w.ref, claudeAliveInFn, surfaceAliveFn).dead);
  const freshDead = dispatchLedger.deadBreadcrumbs(idle, ledgerEntries);
  const refusal = deadDispatchGuard(task, ledgerEntries.concat(freshDead), opts);
  return { freshDead, refusal };
}

function notionIdOf(task) {
  const m = /\[notion:([a-f0-9-]+)\]/i.exec(task.description || '');
  return m ? m[1] : null;
}

function buildSeed(task, card, project, model) {
  const url = (card && card.url) || ((task.description || '').match(/https?:\/\/\S+/) || [''])[0];
  const notes = (card && card.notes) || task.description || '(no description)';
  const meta = [
    card && card.priority ? `Priority: ${card.priority}` : null,
    card && card.keyFiles ? `Key files: ${card.keyFiles}` : null,
  ].filter(Boolean).join(' · ');
  return [
    // First line = card identity: /resume lists sessions by opening prompt,
    // so this line is the session's visible name (scope add 2, task #48).
    // No native programmatic session-rename exists in Claude Code 2.1.207
    // (checked: only --remote-control-session-name-prefix).
    `[#${task.id}] ${task.subject} —`,
    ``,
    `Work on this card as this session's focus. First claim its task in the shared task list (mark task #${task.id} in_progress via TaskUpdate), then implement it per CLAUDE.md rules — worktree before any code edit, /ship-check before you claim it's done.`,
    ``,
    `CARD: ${task.subject}`,
    url ? `Notion: ${url}` : null,
    meta || null,
    ``,
    notes,
    ``,
    // Owner scope-add (card #168, 2026-07-14): "I can't see Sprint 3 anywhere"
    // — a multi-phase card's workspace title should always show the CURRENT
    // phase, not just its launch-time subject. --workspace defaults to the
    // current pane, so no ref lookup is needed.
    //
    // IMPORTANT (ship-check P1 catch, 2026-07-14): the ✅ auto-mark hook and
    // the duplicate-dispatch guard both key off this EXACT title as a
    // prefix — a rename that drops the subject entirely (e.g. renaming to
    // just "🤖 Infra·Sprint 3 wiring") makes both silently stop matching,
    // so the workspace never gets ✅-marked/pruned and a second dispatch onto
    // the same task goes undetected. The instruction below therefore tells
    // the session to APPEND phase text after the unchanged launch title,
    // never to replace it.
    project ? `This workspace is named "${buildAutoTitle({ subject: task.subject, project, model })}" — the 🤖 marks it as auto-dispatched (safe to ignore; it reports via cards+email), the model glyph shows which model runs it, "${project}" is its project bucket. If this card has multiple phases/sprints, you may APPEND the current phase after this exact title (never replace or shorten it — the ✅ auto-mark hook and duplicate-dispatch guard match on this title as a prefix): \`cmux workspace-action --action rename --title "${buildAutoTitle({ subject: task.subject, project, model })} — <current phase>"\`.` : null,
    ``,
    // Standing anti-stale-seed instruction (chain break #1, 2026-07-12): a
    // launched session's seed is a snapshot — directives added to the card
    // after launch (e.g. "dispatch the next sprint yourself") are invisible
    // unless the session re-reads the card before wrapping up.
    `Before wrap-up, RE-READ this card via notion-brain get — directives may have been added since launch. If the card instructs chaining, dispatch the next workspace yourself; never end by telling the user to paste a prompt.`,
    ``,
    // Cheap human-in-loop escalation (task #151): sizing happens before any
    // code is read, so a mis-sized card should say so rather than silently
    // grinding on an under-powered model.
    `If this task proves substantially harder than its size suggests (architecture, multi-file refactor, adversarial debugging), say so and recommend redispatch at --model opus.`,
    ``,
    `Start by confirming your understanding and a short plan, then proceed.`,
  ].filter(v => v !== null).join('\n');
}

// Context-limit succession (card #856, Session-system overhaul S3): a session
// nearing its context limit checkpoints its in-flight work to a handoff file
// and self-dispatches a successor onto the SAME task via
// `bsc-next.js --id N --succession --handoff <path>` (context-budget-nudge.sh
// is what tells it to do this, at prompt time, once it crosses 80% context).
// Runaway guard from the S3 pre-mortem (P0): depth is derived from the ledger
// itself (see dispatch-ledger.js's successionDepthForTask — never trusted
// from a caller-supplied number) and hard-capped so a task that never
// actually finishes can't chain successors forever. Pure decision, extracted
// for tests (CLAUDE.md rule 15).
function successionRefusal(taskId, ledgerEntries, opts = {}) {
  const priorDepth = dispatchLedger.successionDepthForTask(taskId, ledgerEntries);
  const newDepth = priorDepth + 1;
  if (newDepth > dispatchLedger.SUCCESSION_DEPTH_CAP && !opts.force) {
    return {
      newDepth,
      refusal: `task #${taskId} has already chained ${priorDepth} succession dispatch(es) — hard cap is ${dispatchLedger.SUCCESSION_DEPTH_CAP}. A chain this deep usually means the task keeps re-filling context without finishing: investigate scope/approach before continuing. Re-run with --force only once you understand why (or dispatch a normal, non-succession --force relaunch to start a fresh chain).`,
    };
  }
  return { newDepth, refusal: null };
}

// Seed for a succession launch is the checkpoint brief, not the card — the
// successor is continuing work already in progress, not starting fresh.
// Keeps the SAME workspace-title convention as buildSeed() (buildAutoTitle
// off task.subject/project/model) so the ✅ auto-mark hook and the
// duplicate-dispatch guard, which both match on that exact title prefix,
// keep working across the handoff.
function buildSuccessionSeed(task, project, model, depth, cap, handoffText) {
  return [
    `[#${task.id}] ${task.subject} — succession (depth ${depth}/${cap}) —`,
    ``,
    `You are the successor in a context-limit handoff chain on this card. Your predecessor checkpointed and self-dispatched you because IT was running out of context — not because the work is done. Read the full handoff brief below and continue exactly where it left off: don't re-derive facts it already established, don't re-litigate decisions it already made, and don't silently drop any pending user decision or in-flight verification it flags.`,
    ``,
    `CARD: ${task.subject}`,
    `Succession depth: ${depth} of a hard cap of ${cap}. bsc-next.js refuses (and pages the owner) past the cap — if you hit heavy context pressure again within just a few turns, that's a signal to shrink scope and keep working here, not to chain another successor.`,
    project ? `This workspace is named "${buildAutoTitle({ subject: task.subject, project, model })}" — matches the auto-mark hook's title prefix, so ✅-marking and duplicate-dispatch detection keep working across the handoff. Append phase text after this exact title if you rename it, never replace it.` : null,
    ``,
    `HANDOFF BRIEF FROM YOUR PREDECESSOR:`,
    '='.repeat(72),
    handoffText.trim(),
    '='.repeat(72),
    ``,
    `Before wrap-up, RE-READ this card via notion-brain get — directives may have been added since the original launch.`,
    ``,
    `Start by confirming you've absorbed the handoff (what's done, what's next, what still needs independent verification), then proceed.`,
  ].filter(v => v !== null).join('\n');
}

// Best-effort digest page when a succession chain hits the depth cap (card
// #856 P0 guard) — never lets an alerting failure mask the refusal already
// printed to the caller. See cmux-launch.js's pageAuthPreflightFailure for
// why an un-awaited routeAlert(disposition:'digest') call is safe here: its
// fs write runs synchronously before any `await` in its body.
function pageSuccessionCapExceeded(task, attemptedDepth) {
  try {
    const { routeAlert } = require('./lib/owner-alert-router.js');
    routeAlert({
      conditionKey: `bsc-next:succession-cap:${task.id}`,
      title: `Succession depth cap hit — task #${task.id} "${task.subject}"`,
      description: `A successor session tried to hand off task #${task.id} again (attempted depth ${attemptedDepth}, hard cap ${dispatchLedger.SUCCESSION_DEPTH_CAP}). The task keeps re-filling context without finishing — investigate before re-dispatching with --force.`,
      severity: 'error',
      disposition: 'digest',
      cooldownHours: 6,
    }).catch(() => {});
  } catch { /* alerting must never block the refusal already reported */ }
}

// Per-task succession lock (ship-check adversarial finding, 2026-08-03): a
// lone process reading the ledger, deciding "depth OK", and only appending
// its own launch entry AFTER the cmux launch completes leaves a real TOCTOU
// window — two concurrent succession dispatches for the SAME task (e.g. two
// stale successors both crossing 80% and both self-dispatching before
// either's ledger entry lands) could both read the same priorDepth, both
// pass the cap check, and both launch, silently doubling the effective
// chain past SUCCESSION_DEPTH_CAP. Mirrors bsc-prune.js's acquireRunLock —
// same atomic-mkdir-EEXIST pattern, own lock dir so an unrelated real prune
// sweep is never blocked by a succession dispatch or vice versa. Held for
// the full check-launch-append sequence (not just the read), so staleMs
// must clear a genuinely slow launch: cmux-launch.js's slowBootCapSec caps
// at 360s, so 8 minutes leaves headroom before a crashed holder's lock is
// stolen.
const SUCCESSION_LOCK_DIR = path.join(REPO, 'data', 'audit', 'succession-locks');
const SUCCESSION_LOCK_STALE_MS = 8 * 60 * 1000;

function acquireSuccessionLock(taskId, lockDir = SUCCESSION_LOCK_DIR, staleMs = SUCCESSION_LOCK_STALE_MS) {
  try { fs.mkdirSync(lockDir, { recursive: true }); } catch { /* best-effort — mkdirSync below still fails informatively */ }
  const p = path.join(lockDir, `${taskId}.lock`);
  try {
    fs.mkdirSync(p); // atomic: fails EEXIST iff another holder already has it
    fs.writeFileSync(path.join(p, 'meta.json'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') return 'error';
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(p, 'meta.json'), 'utf8'));
      if (Date.now() - meta.ts < staleMs) return false; // fresh — genuinely held elsewhere
      fs.writeFileSync(path.join(p, 'meta.json'), JSON.stringify({ pid: process.pid, ts: Date.now() })); // stale — take over
      return true;
    } catch { return 'error'; } // unreadable meta — fail closed (refuse), never guess it's free
  }
}

function releaseSuccessionLock(taskId, lockDir = SUCCESSION_LOCK_DIR) {
  try { fs.rmSync(path.join(lockDir, `${taskId}.lock`), { recursive: true, force: true }); } catch { /* next attempt's staleness check recovers */ }
}

// Side-effecting succession dispatch, split out of main() so the CI-red-
// claim/verify-gate/duplicate-workspace machinery built for FRESH dispatches
// never runs against a succession launch — it's continuing the same
// in-progress task under a new context window, not a new decision to work it.
function runSuccessionDispatch(task, args, deps) {
  const {
    launchCmux: launchCmuxFn, readLedgerEntries: readLedgerEntriesFn, appendLedgerEntry: appendLedgerEntryFn, fetchCard: fetchCardFn,
    acquireSuccessionLock: acquireLockFn = acquireSuccessionLock, releaseSuccessionLock: releaseLockFn = releaseSuccessionLock,
    // Injectable (ship-check catch, 2026-08-03): the end-to-end succession
    // test drives the REAL refusal path (proving the depth cap actually
    // stops a chain), and without this seam that test's every run would
    // write a real entry into the shared, git-tracked digest queue the
    // owner's actual morning digest reads — exactly what happened before
    // this was made injectable. Production callers get the real pager.
    pageSuccessionCapExceeded: pageCapExceededFn = pageSuccessionCapExceeded,
  } = deps;

  if (typeof args.handoff !== 'string' || !args.handoff) {
    console.error('[bsc-next] --succession requires --handoff <path-to-checkpoint-brief>');
    process.exit(1);
  }
  let handoffText;
  try { handoffText = fs.readFileSync(args.handoff, 'utf8'); }
  catch (e) { console.error(`[bsc-next] cannot read --handoff file "${args.handoff}": ${e.message}`); process.exit(1); }
  if (!handoffText.trim()) {
    console.error(`[bsc-next] --handoff file "${args.handoff}" is empty — write the checkpoint brief before dispatching a successor`);
    process.exit(1);
  }

  // dry-run/print-prompt never touch the lock — they launch nothing, so
  // there's nothing to race (and --dry-run must stay side-effect-free).
  if (!(args['dry-run'] || args['print-prompt'])) {
    const acquired = acquireLockFn(task.id);
    if (acquired === false) {
      console.error(`[bsc-next] REFUSING succession dispatch: another succession dispatch for task #${task.id} is already in flight (lock held, not stale). Wait for it to finish or fail before retrying — dispatching concurrently would let two successors both pass the depth cap.`);
      process.exit(1);
    }
    if (acquired === 'error') {
      console.error(`[bsc-next] REFUSING succession dispatch: could not acquire the per-task succession lock for #${task.id} (lock dir unreadable/corrupt) — failing closed rather than risk a concurrent double-dispatch.`);
      process.exit(1);
    }
  }
  try {
    runSuccessionDispatchLocked(task, args, { launchCmuxFn, readLedgerEntriesFn, appendLedgerEntryFn, fetchCardFn, pageCapExceededFn });
  } finally {
    if (!(args['dry-run'] || args['print-prompt'])) releaseLockFn(task.id);
  }
}

function runSuccessionDispatchLocked(task, args, { launchCmuxFn, readLedgerEntriesFn, appendLedgerEntryFn, fetchCardFn, pageCapExceededFn }) {
  const handoffText = fs.readFileSync(args.handoff, 'utf8');
  const entries = readLedgerEntriesFn();
  const { newDepth, refusal } = successionRefusal(task.id, entries, args);
  if (refusal) {
    console.error(`[bsc-next] REFUSING succession dispatch: ${refusal}`);
    pageCapExceededFn(task, newDepth);
    process.exit(1);
  }

  const pid = notionIdOf(task);
  const card = pid ? fetchCardFn(pid) : null;
  const project = projectOf({ tags: card && card.tags, category: (card && card.category) || categoryOf(task), subject: task.subject });
  const explicitModel = typeof args.model === 'string' ? args.model : null;
  const model = resolveModel({ explicitFlag: explicitModel, task, card, notionId: pid, queuePath: QUEUE_PATH });
  const seed = buildSuccessionSeed(task, project, model, newDepth, dispatchLedger.SUCCESSION_DEPTH_CAP, handoffText);

  if (args['dry-run'] || args['print-prompt']) {
    console.log(`# would launch SUCCESSION (depth ${newDepth}/${dispatchLedger.SUCCESSION_DEPTH_CAP}) on: #${task.id} [${task.status}] ${task.subject}\n`);
    console.log(seed);
    return;
  }

  // Carry forward the verify command captured at this task's most recent
  // launch — succession continues the existing acceptance contract, it
  // doesn't re-derive it (the card text bsc-next would otherwise re-gate on
  // may not even be in hand here, since fetchCard degrades to null silently).
  const priorLaunch = entries.filter(e => e.event === 'launch' && String(e.taskId) === String(task.id)).slice(-1)[0] || {};

  const res = launchCmuxFn(task, seed, undefined, model, project);
  if (res.ok) {
    const tabTitle = buildAutoTitle({ subject: task.subject, project, model });
    console.log(`[bsc-next] opened SUCCESSION Cmux tab "${tabTitle}" (${res.ref}) on #${task.id}, depth ${newDepth}/${dispatchLedger.SUCCESSION_DEPTH_CAP} (claude verified running${res.adoptedLate ? ', adopted after a late start' : ''})`);
    try {
      appendLedgerEntryFn({
        event: 'launch', taskId: String(task.id), subject: task.subject, workspaceRef: res.ref, model,
        verifyCmd: priorLaunch.verifyCmd || null, verifyReason: priorLaunch.verifyReason || null,
        notionId: pid || null, adoptedLate: res.adoptedLate || null,
        // `succession: true` is the load-bearing flag successionDepthForTask()
        // keys on (ship-check P0 catch, 2026-08-03): `--succession-of <ref>`
        // is optional caller-supplied provenance ONLY — the real dispatch
        // path (context-budget-nudge.sh's instructions) never passes it, so
        // relying on successionOf alone left the depth cap permanently
        // disarmed (every real succession entry read back as depth 1,
        // forever). This flag is set unconditionally by virtue of reaching
        // this code path at all — there is no other way to append a launch
        // entry from runSuccessionDispatchLocked.
        succession: true,
        successionOf: (typeof args['succession-of'] === 'string' && args['succession-of']) || null,
        successionDepth: newDepth,
      });
    } catch (e) { console.error(`[bsc-next] WARN dispatch-ledger write failed (non-fatal): ${e.message}`); }
  } else {
    console.error(`[bsc-next] SUCCESSION LAUNCH NOT VERIFIED (${res.reason}).`);
    console.error(`  command that should have run:`);
    console.error(`  ${res.command}`);
    process.exit(1);
  }
}

// ── side-effecting helpers ─────────────────────────────────────────────────
function fetchCard(pageId) {
  try {
    const raw = execFileSync('node', [path.join(REPO, 'scripts', 'notion-brain.js'), 'get', pageId],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(raw);
  } catch { return null; }
}

// Launch mechanics live in scripts/lib/cmux-launch.js (extracted 2026-07-24 so
// non-task callers — the opening-night monitor launcher — share the verified
// path). This wrapper only composes the task-derived title and delegates;
// seedKey = task.id keeps the temp-file paths byte-identical to before.
function launchCmux(task, seed, commandOverride, model = 'sonnet', project = null) {
  // Auto-dispatch naming (scope add, card #168): "🤖<model-glyph> <Project>·<subject>"
  // so the cmux sidebar shows the MODEL before the tab is ever opened (owner
  // request 2026-07-20 — hard work accidentally given to Sonnet sessions).
  // project is only null in the --exec test seam / callers that bypass
  // main()'s inference — falls back to the subject slice with just the model
  // glyph (leading emoji are stripped by both title matchers, so this stays
  // match-compatible with the pre-existing bare-subject convention).
  const title = project
    ? buildAutoTitle({ subject: task.subject, project, model })
    : `${modelGlyph(model) ? modelGlyph(model) + ' ' : ''}${task.subject.slice(0, 50)}`;
  // --model sonnet: dispatched sessions default to Sonnet, not the user's
  // interactive default (Fable) — 9 Fable workspaces in one night, 2026-07-13.
  // Override per-dispatch with --model opus for genuinely hard cards.
  // commandOverride is a test seam (kill test, scope add 3) — never set in real use.
  return launchCmuxSession({
    title, seed, seedKey: task.id, cwd: REPO, model,
    focus: true, autoColor: !!project, commandOverride,
    // Task #503: the 30s default declared 10 healthy launches dead on
    // 2026-07-26 — claude registers its process well past 30s once the Mac
    // is carrying a dozen sessions and the session-start hooks run. Every
    // false failure left an untracked live shell (no ledger entry, so no
    // dead breadcrumb was possible) AND invited a duplicate dispatch onto
    // the same task. Same window + late-adopt grace the opening-night
    // monitor launcher has used since its own 2026-07-24 false CRITICAL.
    verifyTimeoutSec: 90, lateAdoptSec: 60,
    // Card #705: 90s is the window for the TYPED COMMAND to start, not for
    // claude to be up. Once this launch's wrapper process exists, the session
    // is booting and gets 6 minutes — the 2026-07-31 repro measured 4-5 min
    // under load, and relaunching into that boot is what produced three
    // identical crowned sessions in half an hour.
    slowBootCapSec: 360,
  });
}

// ── main ───────────────────────────────────────────────────────────────────
// argv + deps are test seams (defaults are the real argv + real side-effecting
// calls). --help/-h is checked BEFORE loadTasks/fetchCard/launchCmux/cmux ever
// run (2026-07-14 incident class: `node scripts/bsc-next.js --help` used to
// fall through parseArgs as an unrecognized flag and launch a real Cmux
// workspace on the top task). deps are injectable (not just argv) so a test
// can prove zero side-effecting calls happen for --help by making every dep
// throw, rather than trusting the guard is still correctly placed.
function main(argv = process.argv.slice(2), deps = {}) {
  const {
    loadTasks: loadTasksFn = loadTasks,
    fetchCard: fetchCardFn = fetchCard,
    launchCmux: launchCmuxFn = launchCmux,
    cmuxAvailable: cmuxAvailableFn = cmuxws.cmuxAvailable,
    listWorkspaces: listWorkspacesFn = cmuxws.listWorkspaces,
    isDoneTitle: isDoneTitleFn = cmuxws.isDoneTitle,
    claudeAliveIn: claudeAliveInFn = cmuxws.claudeAliveIn,
    terminalSurfaceAliveIn: surfaceAliveInFn = cmuxws.terminalSurfaceAliveIn,
    readLedgerEntries: readLedgerEntriesFn = dispatchLedger.readEntries,
    appendLedgerEntry: appendLedgerEntryFn = dispatchLedger.appendEntry,
    appendCiRedClaim: appendCiRedClaimFn = appendClaim,
  } = deps;

  if (hasHelpFlag(argv)) { console.log(USAGE); return; }

  const args = parseArgs(argv);
  const tasks = loadTasksFn(TASKS_DIR);
  if (!tasks.length) {
    console.error(`[bsc-next] shared task list '${LIST_ID}' is empty (${TASKS_DIR}).`);
    console.error(`Run 'node scripts/notion-tasks-sync.js pull' to mirror your Notion backlog first.`);
    process.exit(1);
  }

  // Explicit --model flag always wins (layer 1 of resolveModel); everything
  // else is resolved per-task once the task (and its Notion id) is known.
  const explicitModel = typeof args.model === 'string' ? args.model : null;

  if (args.list) {
    const list = actionable(tasks);
    console.log(`Top workable tasks in '${LIST_ID}' (launch with --pick N):`);
    // [uncategorized] = unknown category (no fmt-2 bridge line, or Notion
    // category left empty) — these pass the filter only because their subject
    // isn't a human-action verb (fail-closed check, no word bound).
    const unknownCat = t => { const c = categoryOf(t); return c === null || c === 'no-category'; };
    // List mode resolves the model from the task-mirror description only (no
    // per-task Notion fetch — that would be 10 API calls just to print a
    // list). The mirror truncates notes to 400 chars (notion-tasks-sync.js),
    // so a hint placed later in a long card can show sonnet here but resolve
    // to its real hint at actual dispatch time (which DOES fetch the full
    // card) — a display-only gap, since dispatch always uses the full card.
    list.slice(0, 10).forEach((t, i) => {
      const model = resolveModel({ explicitFlag: explicitModel, task: t, card: null, notionId: notionIdOf(t), queuePath: QUEUE_PATH });
      console.log(`  ${i + 1}. #${t.id} [${t.status}] [${model}]${unknownCat(t) ? ' [uncategorized]' : ''} ${t.subject}`);
    });
    // A P0/P1 must never be invisible just because 10 other tasks outrank it
    // in mirror order (2026-07-24: a freshly-synced P1 sat below the cutoff,
    // the session's grep of this output found nothing, and the card went
    // undispatched until the owner asked why). Pending high-priority tasks
    // below the cutoff get an explicit tail so "grep the --list output" is
    // always sufficient.
    const hiddenHighPri = list.slice(10).filter(t => t.status === 'pending' && priorityRank(t) <= 1);
    if (hiddenHighPri.length) {
      // Newest-first, capped: a freshly-created card always has the highest
      // task id, so it is always visible here — without printing the whole
      // 70+ card P1 backlog on every --list (calibration fix, same day).
      const TAIL_CAP = 10;
      const newest = [...hiddenHighPri].sort((a, b) => parseInt(b.id, 10) - parseInt(a.id, 10));
      console.log(`\n  …plus ${hiddenHighPri.length} pending P0/P1 below the top-10 cutoff (dispatch with --id); ${Math.min(TAIL_CAP, newest.length)} newest:`);
      newest.slice(0, TAIL_CAP).forEach(t => console.log(`     #${t.id} [P${priorityRank(t)}] ${t.subject}`));
    }
    const excluded = actionable(tasks, true).filter(isExcludedCategory);
    if (excluded.length) {
      console.log(`\nHuman-territory (${excluded.length} — never auto-picked; use --id N deliberately):`);
      excluded.slice(0, 6).forEach(t => console.log(`     #${t.id} [${categoryOf(t) || 'uncategorized'}] ${t.subject}`));
    }
    return;
  }

  const task = pickTask(tasks, args, TASKS_DIR);
  if (!task) { console.error('[bsc-next] no matching actionable task.'); process.exit(1); }
  const guardErr = completedLaunchGuard(task, args);
  if (guardErr) { console.error(`[bsc-next] ${guardErr}`); process.exit(1); }

  // Context-limit succession (card #856) is a continuation of THIS task, not
  // a fresh dispatch decision — it skips the overlap/verify-gate/duplicate-
  // workspace machinery below entirely (see runSuccessionDispatch's header
  // comment). --id is required (never picks a task automatically — a
  // successor must land on the exact task it's continuing).
  if (args.succession) {
    if (!args.id) { console.error('[bsc-next] --succession requires --id <taskId> (never auto-picks a task).'); process.exit(1); }
    runSuccessionDispatch(task, args, { launchCmux: launchCmuxFn, readLedgerEntries: readLedgerEntriesFn, appendLedgerEntry: appendLedgerEntryFn, fetchCard: fetchCardFn });
    return;
  }

  // Cross-task overlap check (task #917): findLiveWorkspaceForTask below only
  // catches a SECOND dispatch of THIS SAME task id. It has no way to catch
  // two DIFFERENT task ids whose notes describe the same underlying work —
  // confirmed twice in one session's task list: #893/#902 both independently
  // fixed the identical bug in scripts/audit-show-review-gap.js (found only
  // at merge time via a git conflict), and #897/#911 are literally
  // duplicate-titled cards dispatched separately. Runs before the dry-run
  // bail below (so --dry-run previews it too) and against the task-mirror
  // description only (no Notion fetch dependency — same truncated text every
  // in_progress candidate is compared with). Non-blocking first cut — a
  // shared scripts/ path or near-identical title is suggestive, not proof
  // (two cards can legitimately touch the same file for unrelated reasons).
  //
  // Card #955: task-store-archive.js now also archives in_progress tasks
  // untouched >7d — including ones whose dispatching session is still
  // genuinely alive but just hasn't written to the task file (long batch
  // work is normal here per CLAUDE.md). Reading `tasks` (live-dir-only, see
  // loadTasks()'s docstring) alone would make those invisible to exactly the
  // overlap check this comment describes, defeating its purpose for the
  // longest-running work — the cases most likely to collide with a fresh
  // dispatch. Merging in archive/ here (not in loadTasks()'s hot `--list`
  // path, which returns above this line) is safe: this block only runs once
  // per actual dispatch attempt, not on every list/actionable() call.
  try {
    const inProgressCards = mergeWithArchive(TASKS_DIR, tasks)
      .filter(t => t.status === 'in_progress' && String(t.id) !== String(task.id))
      .map(t => ({ id: t.id, subject: t.subject, notes: t.description }));
    const overlaps = findOverlappingCards({ id: task.id, subject: task.subject, notes: task.description }, inProgressCards);
    overlaps.forEach(o => {
      const why = o.reason === 'shared-file-path' ? `shares file(s) ${o.sharedPaths.join(', ')}` : 'has a near-identical title';
      console.error(`[bsc-next] WARNING: task #${task.id} ${why} with in_progress task #${o.card.id} ("${o.card.subject}") — check it isn't already being worked before dispatching a duplicate.`);
    });
  } catch (e) { console.error(`[bsc-next] WARN overlap check failed (continuing): ${e.message}`); }

  const pid = notionIdOf(task);
  const card = pid ? fetchCardFn(pid) : null;
  // Project bucket for auto-dispatch naming/coloring (scope add, card #168):
  // prefer the full card's tags/category (richer than the task-mirror line),
  // fall back to the mirror's categoryOf() for native/bridge-less tasks.
  const project = projectOf({
    tags: card && card.tags,
    category: (card && card.category) || categoryOf(task),
    subject: task.subject,
  });
  // Dispatched sessions never inherit the user's interactive default (Fable —
  // 9 Fable workspaces in one night, 2026-07-13): explicit --model wins,
  // otherwise a card hint or the loop's own pickModel()-by-triage-size picks
  // Opus for genuinely hard cards, floor is Sonnet. See resolveModel().
  // Resolved BEFORE the seed: the seed quotes the workspace title, which now
  // carries the model glyph.
  const model = resolveModel({ explicitFlag: explicitModel, task, card, notionId: pid, queuePath: QUEUE_PATH });
  const seed = buildSeed(task, card, project, model);

  if (args['dry-run'] || args['print-prompt']) {
    console.log(`# would launch on: #${task.id} [${task.status}] ${task.subject}\n`);
    console.log(seed);
    return;
  }

  // Verification-chain gate (owner escalation 2026-07-26): every launch in the
  // dispatch ledger to date carried verifyCmd: null — prose acceptance
  // criteria dispatch UNARMED, the nightly acceptance recheck has nothing to
  // re-run, and "Done" stays a self-reported claim forever. Refuse to launch
  // unarmed. A card whose outcome genuinely cannot be machine-checked declares
  // it with "VERIFY: owner-judgment" in its notes; --allow-unverifiable is the
  // explicit, ledger-visible per-dispatch override.
  const gateNotes = (card && card.notes) || task.description || '';
  const gate = evaluateVerifiability(gateNotes);
  const verifyGate = { cmd: gate.cmd, reason: gate.reason };
  const ownerJudgmentCard = gate.ownerJudgment;
  // Refuse ONLY when the full card is in hand. When the Notion fetch degraded
  // (fetchCard swallows every error → null) or the task is native (no card),
  // gateNotes is the task-mirror description, which notion-tasks-sync
  // truncates to 400 chars — the Acceptance criteria section is almost always
  // past the cut, so refusing here would fail-closed on armed cards over an
  // API blip, and would refuse native tasks 100% of the time (Opus QA P1,
  // 2026-07-26). Those dispatch unarmed with the reason recorded, as before.
  const fullCardInHand = !!(card && card.notes);
  if (!verifyGate.cmd && !ownerJudgmentCard && !args['allow-unverifiable']) {
    if (fullCardInHand) {
      console.error(`[bsc-next] REFUSING to dispatch #${task.id}: no runnable verify command (${verifyGate.reason}).`);
      console.error(`  The nightly acceptance recheck can only verify Done work by re-running a command captured at dispatch.`);
      console.error(`  Fix one of:`);
      console.error(`    1. Add a backticked safe-form command to the card's "## Acceptance criteria":`);
      console.error(`       node --test <file>.test.mjs | npx tsc --noEmit | npx next lint | test -f <path>`);
      console.error(`       (criteria written only in the Notion page body are invisible here — put them in the card Notes via notion-brain update)`);
      console.error(`    2. Add "VERIFY: owner-judgment" to the card if this outcome cannot be machine-checked.`);
      console.error(`    3. Re-run with --allow-unverifiable to dispatch anyway (recorded in the ledger).`);
      process.exit(1);
    }
    console.error(`[bsc-next] WARN dispatching #${task.id} unarmed: full card unavailable (${pid ? 'Notion fetch failed' : 'native task, no card'}) — gate not enforceable on the truncated mirror.`);
  }

  // CI-red claim auto-invocation (task #598): record a claim so another
  // in_progress task's pre-push-review-gate.sh check (task #584) sees it —
  // closes the gap where nothing ever called claim-ci-red.js automatically.
  // Recorded at each branch's own confirmed-dispatch point (ship-check catch:
  // an earlier version wrote the claim before the duplicate/dead-dispatch/
  // launch-failure guards below could still refuse — a refused dispatch would
  // leave a phantom 2h lock on the ledger blocking unrelated sessions from the
  // same symbol). Non-fatal: a ledger write failure must never block an
  // otherwise-good dispatch.
  const ciRedTarget = extractCiRedTarget(task, card);
  function recordCiRedClaim() {
    if (!ciRedTarget) return;
    try {
      const claim = appendCiRedClaimFn({ taskId: task.id, symbol: ciRedTarget.symbol, runId: ciRedTarget.runId });
      console.log(`[bsc-next] recorded CI-red claim for #${task.id}: ${JSON.stringify(claim)}`);
    } catch (e) {
      console.error(`[bsc-next] WARN CI-red claim write failed (non-fatal): ${e.message}`);
    }
  }

  if (args.exec) {
    // No guard sits between here and the spawn below — exec has no
    // duplicate-dispatch check of its own — so this is already the
    // confirmed-dispatch point.
    recordCiRedClaim();
    // Run an interactive claude on the seed in this terminal (no Cmux).
    const r = spawnSync('claude', ['--model', model, '--dangerously-skip-permissions', seed], { stdio: 'inherit', cwd: REPO });
    if (r.error) { console.error(`[bsc-next] failed to launch claude: ${r.error.message}`); process.exit(1); }
    process.exit(r.status == null ? 1 : r.status); // null = killed by signal → non-zero
  }

  // --headless (Autopilot v5 R4, task #459): run the task as a supervised
  // background job via bsc-runner instead of a cmux tab. Opt-in for now —
  // interactive cmux stays the default until the runner has a quiet week
  // (plan-review sequencing finding). The runner brings its own per-task
  // lease, so the cmux duplicate/dead-dispatch guards below don't apply.
  if (argv.includes('--headless')) {
    if (process.env.BSC_RUNNER_DISABLED === '1') {
      console.error('[bsc-next] BSC_RUNNER_DISABLED=1 — headless runner is switched off; rerun without --headless for a cmux tab.');
      process.exit(1);
    }
    // Human-gate refusal (task #1004). The verify gate above asks "can this
    // card's outcome be CHECKED by a machine?"; this asks the other half,
    // "can an unattended session FINISH it?" On 2026-08-04 two headless jobs
    // did all the work and then stopped dead at gates only the owner can
    // clear (pre-push visual-qa approval; a workflow run that outlived the
    // session) — $14.74 charged, two verified commits stranded in worktrees.
    // Refusing here costs nothing and leaves the card for an attended tab.
    if (!args['allow-human-gated']) {
      const gateText = (card && card.notes) || task.description || '';
      const hg = classifyHeadlessDispatchability({ subject: task.subject, notes: gateText }, { verifyCmd: verifyGate.cmd });
      if (!hg.dispatchable && hg.blockers.some(b => b.code !== HEADLESS_BLOCKERS.NO_VERIFY_CMD)) {
        console.error(`[bsc-next] REFUSING headless dispatch of #${task.id}: an unattended session cannot finish this card.`);
        for (const b of hg.blockers) console.error(`    ${b.code}: ${b.detail}`);
        console.error(`  Dispatch it to a cmux tab instead (drop --headless), where the owner is present to clear the gate,`);
        console.error(`  or re-run with --allow-human-gated if you know the gate does not apply.`);
        process.exit(1);
      }
    }
    // The runner's lease only sees other HEADLESS jobs — a live cmux tab on
    // the same task is invisible to it. Keep the cross-dispatcher duplicate
    // guard here (ship-check Codex blocker): refuse if an un-✅ tab matches.
    if (!args.force && cmuxAvailableFn()) {
      try {
        const dupTab = findLiveWorkspaceForTask(task, listWorkspacesFn(), isDoneTitleFn);
        if (dupTab) {
          console.error(`[bsc-next] a live cmux workspace already matches task #${task.id}: ${dupTab.ref} "${dupTab.title}". Refusing headless duplicate (--force to override).`);
          process.exit(1);
        }
      } catch (e) { console.error(`[bsc-next] tab duplicate check failed (continuing): ${e.message}`); }
    }
    recordCiRedClaim();
    const { runJob } = require('./lib/bsc-runner.js');
    console.log(`[bsc-next] headless job starting on #${task.id}: ${task.subject} (model ${model})`);
    const verifyH = verifyGate; // extracted once at the dispatch gate above
    // Same 'launch' journal entry as the cmux path (Opus ship-check P1): the
    // acceptance recheck keys on event==='launch' && notionId, and the
    // verifyCmd must be captured while the card text is in hand — otherwise
    // headless work silently escapes the days-later re-verification.
    try { appendLedgerEntryFn({ event: 'launch', taskId: String(task.id), subject: task.subject, workspaceRef: `headless:${task.id}`, model, verifyCmd: verifyH.cmd, verifyReason: verifyH.reason, allowUnverifiable: (!verifyH.cmd && args['allow-unverifiable']) || null, notionId: pid || null }); }
    catch (e) { console.error(`[bsc-next] WARN dispatch-ledger launch write failed (non-fatal): ${e.message}`); }
    runJob({ taskId: String(task.id), subject: task.subject, prompt: seed, model, isolate: true })
      .then(r => {
        if (r.stage === 'lease-held') {
          console.error(`[bsc-next] task #${task.id} already has a live headless job (${r.holder?.jobId || 'unknown'}). Use bsc-status to inspect.`);
          process.exitCode = 1;
          return;
        }
        console.log(`[bsc-next] headless job ${r.jobId} ${r.ok ? 'DONE' : `FAILED (${r.stage})`}`);
        console.log(`  log: ${r.logFile}`);
        if (r.sessionId) console.log(`  resume: (cd ${r.cwd} && claude --resume ${r.sessionId})`);
        if (r.keptWorktree) console.log(`  worktree kept (has work): ${r.cwd}`);
        if (verifyH.cmd) console.log(`  verify: ${verifyH.cmd}`);
        if (!r.ok) process.exitCode = 1;
      })
      .catch(e => { console.error(`[bsc-next] headless job crashed: ${e.message}`); process.exitCode = 1; });
    return; // job settles asynchronously; node exits when the promise resolves
  }

  // NO auto-prune at dispatch (owner rule 2026-07-15, third closed-tab incident
  // that day): ✅-marked workspaces stay open until the OWNER closes them —
  // bsc-prune / the Cmux UI. The mark is mechanical (Stop hook flips it when
  // the claimed task completes) and says nothing about whether the owner is
  // still reading or typing in the tab, so dispatch-time sweeps closed tabs
  // out from under the owner mid-keystroke. ✅ workspaces don't block
  // re-dispatch either way — findLiveWorkspaceForTask() skips isDoneTitle().
  if (cmuxAvailableFn()) {
    let workspaces = null;
    try { workspaces = listWorkspacesFn(); } catch (e) { console.error(`[bsc-next] workspace list failed (continuing): ${e.message}`); }

    if (workspaces) {
      // Dead-dispatch self-heal (task #334 ship-check follow-up): journaling
      // freshDead here is a local jsonl append only, never a cmux mutation —
      // it does NOT reintroduce the dispatch-time auto-prune/close behavior
      // the owner removed 2026-07-15 (feedback_never_close_unmarked_cmux_workspaces.md).
      // See checkDeadDispatch's header comment for why this can't just wait
      // for bsc-prune.js's own (typically once/day) sweep to write the
      // breadcrumb.
      try {
        const { freshDead, refusal } = checkDeadDispatch(task, workspaces, readLedgerEntriesFn(), isDoneTitleFn, claudeAliveInFn, surfaceAliveInFn, args);
        freshDead.forEach(b => { try { appendLedgerEntryFn(b); } catch (e) { console.error(`[bsc-next] WARN dispatch-ledger self-heal write failed for ${b.workspaceRef}: ${e.message}`); } });
        if (refusal) { console.error(`[bsc-next] ${refusal}`); process.exit(1); }
      } catch (e) { console.error(`[bsc-next] dead-dispatch check failed (continuing): ${e.message}`); }
    }

    // Owner-close park (task #578). The duplicate-dispatch guard below only
    // fires while a matching workspace is STILL LISTED, so closing a tab used
    // to hand the card straight back to the dispatcher. bsc-prune records a
    // 'vanished' breadcrumb for a closed tab; this refuses to reopen it.
    // --force IS the unpark: the launch entry clears the park (see
    // dispatch-ledger.parkedTasks), so the state is self-healing.
    try {
      const refusal = parkedGuard(task, readLedgerEntriesFn(), args);
      if (refusal) { console.error(refusal); process.exit(1); }
    } catch (e) { console.error(`[bsc-next] park check failed (continuing): ${e.message}`); }

    // Duplicate-dispatch guard (✅-marked twins never count as live).
    if (!args.force) {
      try {
        const dup = findLiveWorkspaceForTask(task, workspaces || listWorkspacesFn(), isDoneTitleFn);
        if (dup) {
          console.error(`[bsc-next] a live workspace already matches task #${task.id}: ${dup.ref}  "${dup.title}".`);
          console.error(`  Another session may be on this task. Check it (cmux read-screen --workspace ${dup.ref}),`);
          console.error(`  or re-run with --force to launch a second workspace anyway.`);
          process.exit(1);
        }
      } catch (e) { console.error(`[bsc-next] duplicate check failed (continuing): ${e.message}`); }
    }
  }

  const res = launchCmuxFn(task, seed, undefined, model, project);
  if (res.ok) {
    // Report the TAB TITLE, not the workspace number — the owner's cmux
    // sidebar shows titles only, so "workspace:165" is unfindable for them
    // (owner feedback 2026-07-30, repeat complaint across sessions).
    const tabTitle = buildAutoTitle({ subject: task.subject, project, model });
    console.log(`[bsc-next] opened Cmux tab "${tabTitle}" (${res.ref}) on #${task.id} (claude verified running${res.adoptedLate ? ', adopted after a late start' : ''})`);
    recordCiRedClaim();
    // Journal the launch (task #334) so a later bsc-prune sweep can attribute
    // a dead shell back to this task, and a future dispatch can see how many
    // times this task has already died before blindly opening another one.
    // verifyCmd (Sprint 3, S3-T1): capture the card's OWN acceptance-criteria
    // command now, while the card text is in hand. The nightly acceptance
    // recheck (scripts/autonomous-acceptance-recheck.js) re-runs it against a
    // fresh main days later to turn "someone marked this Done" into a fact.
    // null is a legitimate, recorded answer — a card whose criteria is prose
    // is listed as "not machine-verifiable", never guessed at.
    const verify = verifyGate; // extracted once at the dispatch gate above
    if (verify.reason) console.error(`[bsc-next] no verify command recorded for #${task.id}: ${verify.reason}`);
    if (verify.cmd) console.log(`  verify armed: ${verify.cmd}`);
    try { appendLedgerEntryFn({ event: 'launch', taskId: String(task.id), subject: task.subject, workspaceRef: res.ref, model, verifyCmd: verify.cmd, verifyReason: verify.reason, allowUnverifiable: (!verify.cmd && args['allow-unverifiable']) || null, notionId: pid || null, adoptedLate: res.adoptedLate || null }); }
    catch (e) { console.error(`[bsc-next] WARN dispatch-ledger write failed (non-fatal): ${e.message}`); }
  } else {
    // Card #705: report WHICH failure this is. "LAUNCH NOT VERIFIED" for a
    // session that is merely booting slowly is what taught the owner (and
    // every session reading these logs) that "cmux is dead at least once a
    // day" — and what made callers relaunch onto a live workspace.
    const stillBooting = res.deadConfirmed === false;
    console.error(stillBooting
      ? `[bsc-next] LAUNCH UNCONFIRMED — STILL BOOTING (${res.reason}). Do NOT re-dispatch #${task.id}: its command is running.`
      : `[bsc-next] LAUNCH NOT VERIFIED (${res.reason}).`);
    // Journal the failed attempt (task #503) — see failedLaunchEntries' header
    // for why writing nothing here disarmed BOTH the dead-shell breadcrumb and
    // the dead-attempt guard.
    const failedEntries = dispatchLedger.failedLaunchEntries({
      taskId: task.id, subject: task.subject, workspaceRef: res.workspaceRef, model,
      verifyCmd: verifyGate.cmd, verifyReason: verifyGate.reason, notionId: pid || null,
      failureReason: res.reason,
      // Card #705: a slow-boot timeout leaves a RUNNING wrapper process — the
      // workspace is booting, not dead. deadConfirmed=false suppresses the
      // 'dead' breadcrumb so a live session is neither counted toward the
      // 2-death dispatch guard nor treated as a corpse by the pruner.
      deadConfirmed: res.deadConfirmed !== false,
    });
    if (failedEntries.length) {
      try {
        failedEntries.forEach(e => appendLedgerEntryFn(e));
        console.error(`  journaled ${stillBooting ? 'unverified (not dead)' : 'dead'} dispatch for #${task.id} → ${res.workspaceRef} (dispatch-ledger.jsonl)`);
      } catch (e) { console.error(`[bsc-next] WARN dispatch-ledger dead write failed (non-fatal): ${e.message}`); }
      // Cross-task outage check (card #900): a single dead launch is this
      // task's problem; the SAME injection-never-ran signature across
      // several DIFFERENT tasks in a short window is cmux's problem, and
      // until now nothing ever looked across tasks to say so — each one
      // silently ate a dead-attempt and the pattern only surfaced days
      // later from ledger forensics. Best-effort: an outage-check failure
      // must never block reporting the launch failure itself.
      try {
        const outage = dispatchLedger.detectLauncherOutage(readLedgerEntriesFn(), { now: Date.now() });
        if (outage.outage) {
          console.error(`[bsc-next] \u{1F534} CMUX LAUNCHER OUTAGE — ${outage.count} launch(es) across ${outage.taskIds.length} different tasks (#${outage.taskIds.join(', #')}) failed with 'injection never ran' since ${outage.sinceTs}. This is not specific to #${task.id} — cmux itself is not accepting new-workspace commands. Bring cmux to the foreground (or restart it) before dispatching anything else.`);
        }
      } catch (e) { console.error(`[bsc-next] WARN launcher-outage check failed (non-fatal): ${e.message}`); }
    }
    if (res.workspaceRef) {
      console.error(stillBooting
        ? `  ${res.workspaceRef}: wrapper process STILL RUNNING — check the tab in a minute before doing anything to it`
        : `  dead workspace: ${res.workspaceRef} (left open for inspection)`);
    }
    // Always print the command — an operator diagnosing EITHER failure needs
    // it, and hiding it on the still-booting path would make a wrong verdict
    // from the state machine harder to recover from (ship-check finding).
    console.error(stillBooting ? `  command that IS running there:` : `  command that should have run:`);
    console.error(`  ${res.command}`);
    if (!stillBooting) console.error(`  Run it yourself in a workspace, or retry: claude "$(cat ${res.seedFile})"`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parseArgs, loadTasks, TASKS_DIR, actionable, pickTask, completedLaunchGuard, deadDispatchGuard, checkDeadDispatch, findLiveWorkspaceForTask, notionIdOf, buildSeed, launchCmux, parkedGuard, categoryOf, isExcludedCategory, EXCLUDED_CATEGORIES, main, USAGE, successionRefusal, buildSuccessionSeed, runSuccessionDispatch, acquireSuccessionLock, releaseSuccessionLock };
