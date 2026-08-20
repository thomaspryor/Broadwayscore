#!/usr/bin/env node
/**
 * notion-tasks-sync.js — bridge the Notion "brain" backlog to Claude Code's
 * native shared task list, so parallel Cmux sessions coordinate on one queue.
 *
 *   pull  — mirror prioritized Notion cards (default: P0/P1, In progress or
 *           Not started) into the shared task list. Idempotent: a card already
 *           mirrored is not duplicated; a status change updates the task.
 *   push  — for tasks that were mirrored from a Notion card and are now
 *           `completed`, mark the Notion card Done (once).
 *   status — print the current card→task mapping.
 *
 * The shared task list is the directory Claude Code reads when a session is
 * started with CLAUDE_CODE_TASK_LIST_ID=<id>  (~/.claude/tasks/<id>/).
 * Task files are the documented format: {id,subject,description,activeForm,
 * status,blocks,blockedBy} named "<id>.json", with a ".highwatermark" holding
 * the next id. Identity across runs is tracked in a sidecar ".notion-map.json"
 * keyed by Notion page id — we never guess identity from CC's own files.
 *
 * Notion I/O is delegated to scripts/notion-brain.js (reuses NOTION_API_KEY
 * from the repo .env), so this script needs no Notion credentials of its own.
 *
 * Output: human-readable summary to stderr, machine JSON to stdout on --json.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { hasHelpFlag } = require('./lib/cli-help.js');
const { OWNER_JUDGMENT_RE } = require('./lib/owner-judgment-marker.js');
const { hasNoDispatchMarker } = require('./lib/no-dispatch-marker.js');
const { BSC_DAILY_TITLE_RE } = require('./lib/task-store-archive.js');
const { readLease, pidLooksLikeClaude } = require('./lib/bsc-runner.js');
const { findLiveWorkspaceForTask } = require('./lib/dispatch-guards.js');
const cmuxws = require('./lib/cmux-workspaces.js');
// Reuse task-reclaim.js's constants/helpers rather than re-declaring copies —
// same idle bar (48h) and same "never make an Archived/Cancelled card
// dispatchable again" rule as the archive-trapped case (card #1402) this
// module's own liveness guard mirrors (see planLivenessDowngrade below).
// indexLiveTasks is task #1701's ground-truth live-marker scan (see
// buildLiveMarkerIndex below).
const { indexLiveTasks, TERMINAL_CARD_STATUSES, DEFAULT_IDLE_MS: LIVENESS_IDLE_MS } = require('./lib/task-reclaim.js');
// cmdPush must never overwrite these with Done — Archived/Cancelled is a
// deliberate human decision (unlike Done itself, which Done->Done is a
// harmless idempotent re-confirm, pre-existing behavior, out of scope here).
// Task #1778 considered adding 'Paused' here too (planPendingClosure writes a
// local 'completed' for a pending mirror whose card is Paused) and rejected
// it after adversarial review (gpt-5.4-mini, ship-check): 'Paused' is NOT a
// terminal status like Archived/Cancelled — an entry can legitimately carry
// syncedStatus:'Paused' from planLivenessDowngrade's OWN non-terminal
// liveness downgrade (in_progress -> pending while Notion says Paused, same
// write path sets syncedStatus off card.status) and LATER be genuinely
// completed by a session, independent of this task's reconciliation path.
// Blocking ALL Paused-tagged entries here would silently block that
// legitimate future push too. The narrower, correct fix — stamping
// `pushed:true` only on the specific entries THIS reconciliation closes — is
// in reconcileStaleMirrors's write path below, scoped to exactly the risk it
// creates rather than to every entry that happens to carry 'Paused'.
const NEVER_OVERWRITE_WITH_DONE = new Set([...TERMINAL_CARD_STATUSES].filter((s) => s !== 'Done'));

// Card #1410 what-else follow-up: the pre-BRO-286 "Fix this" digest button
// (scripts/lib/digest-autofix.js's old matchOpenTask, before that module
// repointed to Linear) filed cards titled "Fix: BSC Daily: <name>" — a
// cousin of the plain "BSC Daily:" family, same legacy-and-never-closed
// shape, same self-heal re-minting exposure, just not covered by
// BSC_DAILY_TITLE_RE's anchored prefix. 2 live files in the corpus at the
// time this was found (834.json, 1166.json).
const FIX_BSC_DAILY_TITLE_RE = /^Fix: BSC Daily:/;

// Mirror-description format version. Bump whenever mapCardToTask starts
// emitting something a previously-synced task is missing — planPull uses it to
// force a one-time rewrite of every existing mirror, which is the ONLY way a
// change to the description reaches cards whose Notion status never changes
// again. 2 = category meta segment. 3 = owner-judgment marker survives the
// 400-char truncation (task #1154).
const MIRROR_FMT = 3;

const USAGE = `notion-tasks-sync.js — bridge the Notion "brain" backlog to Claude Code's.

Usage:
  node scripts/notion-tasks-sync.js [options]
  node scripts/notion-tasks-sync.js --help, -h    print this usage and exit
`;
// ── arg parsing ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[key] = true; }
      else { args[key] = next; i++; }
    } else { args._.push(a); }
  }
  return args;
}

// ── pure logic (exported for tests) ────────────────────────────────────────

// Map a Notion status to a native task status.
function mapStatus(notionStatus) {
  switch ((notionStatus || '').toLowerCase()) {
    case 'in progress': return 'in_progress';
    case 'done': return 'completed';
    default: return 'pending'; // Not started, Paused, unknown
  }
}

// Build the native task record for a Notion card. `pageId` is embedded in the
// description too, so a human reading the task can trace it back even if the
// sidecar map is lost.
function mapCardToTask(card, taskId) {
  const fullNotes = (card.notes || '').replace(/\s+/g, ' ').trim();
  const shortNotes = fullNotes.slice(0, 400);
  // Category is the third meta segment — bsc-next's launcher filter keys on it
  // (Marketing/Partnerships are human territory, never default-picked).
  const descLines = [
    `[notion:${card.id}] ${card.priority || 'no-priority'} · ${card.status || 'no-status'} · ${card.category || 'no-category'}`,
    card.url || '',
    shortNotes,
  ].filter(Boolean);
  // The mirror is the ONLY thing isExcludedCategory() sees (task #1154), and
  // enrich-card-acceptance.js appends "VERIFY: owner-judgment" to the END of a
  // card's notes — so on any card with >400 chars of notes the marker falls
  // past the cut and the dispatch-time exclusion silently stops applying.
  // Re-attach it rather than widening the truncation: this is a fixed 22-char
  // line, not an unbounded notes dump.
  if (OWNER_JUDGMENT_RE.test(fullNotes) && !OWNER_JUDGMENT_RE.test(shortNotes)) {
    descLines.push('VERIFY: owner-judgment');
  }
  return {
    id: String(taskId),
    subject: (card.name || 'Untitled card').slice(0, 200),
    description: descLines.join('\n'),
    activeForm: `Working on ${(card.name || 'card').slice(0, 60)}`,
    status: mapStatus(card.status),
    blocks: [],
    blockedBy: [],
  };
}

// Never downgrade a live session's local progress: a session that claimed
// the task (in_progress) or finished it (completed) outranks the mapped
// Notion status, which can lag behind (2026-07-12 ship-check finding — a
// pull could un-claim active work and cause duplicate pickup). This is also
// what protects the autonomous executor's claim: the loop flips the card's
// Status to "In progress" (notion-tasks-sync deliberately ignores the Auto
// property), so a claimed card mirrors as in_progress and a pull must never
// re-offer it as pending. Regression-tested — Sprint-2 carry-forward #1.
function mergeStatus(existingStatus, mappedStatus) {
  if (existingStatus === 'completed') return 'completed';
  if (existingStatus === 'in_progress' && mappedStatus === 'pending') return 'in_progress';
  return mappedStatus;
}

// Task #1691 (P0 supersedes #1402): `pull`'s own fetch filter only ever
// queries Notion cards with Status "In progress" or "Not started" — the
// moment a card flips to Done (or Archived/Cancelled), it drops out of
// every future pull, and mergeStatus() above is never even called for it
// again. A mirrored task that was `in_progress` when the card finished
// stays `in_progress` in the LOCAL mirror forever, a claimed slot
// `bsc-next --list` never re-offers — even though the real work SHIPPED.
// Measured on the live backlog 2026-08-16: of 139 in_progress tasks with no
// live cmux workspace, 99 (71%) were already Done in Notion; this was the
// DOMINANT contributor to the incident this task fixes, not the --no-spawn
// misuse Part 1 covers (only 4 cards).
//
// This is deliberately narrower than a full pull: it only ever asks "does
// mergeStatus(), given the CARD'S CURRENT status, produce something other
// than what the mirror already has" — the exact same decision `cmdPull`'s
// `toUpdate` branch already makes, just fed from a direct per-page fetch
// instead of a status-filtered search. Status "Done" always wins via
// mergeStatus()'s own fallthrough (mapStatus('done') -> 'completed', and
// mergeStatus never refuses in_progress->completed, only in_progress-
// >pending) — no special case needed here. Every OTHER Notion status
// (In progress, Not started, Paused, Archived, Cancelled, or anything
// unrecognised) maps to 'pending' via mapStatus()'s default case, and
// mergeStatus() then refuses the in_progress->pending downgrade on purpose
// (2026-07-12 finding — a live session's card can lag reality). So this
// function only ever unsticks the Done case; Paused/Not-started/Archived/
// Cancelled drift needs a liveness check (cmux/lease) before it's safe to
// override that protection — that is bsc-reconcile.js's job
// (sweepUntrackedInProgress / reconcileStalledTasks), not this function's.
//
// Pure: card is already-fetched data, no I/O here. Returns null when there
// is nothing to do (fetch failed, or no drift).
function planStatusDrift(task, card) {
  if (!task || !card) return null;
  const mapped = mapStatus(card.status);
  const merged = mergeStatus(task.status, mapped);
  if (merged === task.status) return null;
  return { newStatus: merged, cardStatus: card.status };
}

// Task #1697 (residual from #1691): planStatusDrift only ever unsticks the
// Done case (see its own comment above) — every other Notion status maps to
// 'pending' via mapStatus()'s default case, and mergeStatus() then refuses
// the in_progress->pending downgrade on purpose. That refusal is the correct
// default (protects a genuinely live session from duplicate pickup), but it
// also means a card that drifted to Paused/Not started/Archived/Cancelled
// leaves its mirror stuck at in_progress forever unless something checks
// whether the "live" work is actually still alive. This is that check — same
// guard order scripts/lib/task-reclaim.js's classifyReclaimable() already
// uses for the analogous archive-trapped case (card #1402: live lease, then
// live cmux tab, then the idle-freshness check, then a completed-Outcome
// guard, then never-reopen for a TERMINAL_CARD_STATUSES card) — applied here
// to a LIVE-DIR mirror instead of an archived one.
//
// Pure aside from the injected ctx (mirrors planStatusDrift's shape): no I/O
// here, so it's unit-testable without a real lease dir or cmux process.
// Returns null when this function has nothing to say (task isn't
// in_progress, no card, or the mapped status isn't the refused 'pending'
// case — i.e. Done, which is planStatusDrift's job, or In progress, which
// isn't drift at all). Otherwise always returns a {reason} explaining the
// decision, even when newStatus stays null, so cmdSyncDrift's unchanged[]
// report can show WHY a residual entry is still stuck instead of just its
// raw Notion status.
function planLivenessDowngrade(task, card, ctx = {}) {
  const {
    leaseAliveOf = () => false,
    liveWorkspaceOf = () => null,
    now = Date.now(),
    idleMs = LIVENESS_IDLE_MS,
  } = ctx;
  if (!task || task.status !== 'in_progress' || !card) return null;
  if (mapStatus(card.status) !== 'pending') return null;

  if (leaseAliveOf(task.id)) {
    return { newStatus: null, cardStatus: card.status, reason: "skip-live: a live claude process still holds this task's lease" };
  }
  const ws = liveWorkspaceOf(task);
  if (ws) {
    return { newStatus: null, cardStatus: card.status, reason: `skip-live: a live cmux workspace (${(ws && (ws.ref || ws.title)) || 'unknown'}) is titled like this task` };
  }

  const idle = card.lastEditedAt ? now - Date.parse(card.lastEditedAt) : NaN;
  if (!Number.isFinite(idle)) {
    return { newStatus: null, cardStatus: card.status, reason: 'skip: card has no usable lastEditedAt — cannot tell whether anyone is on it' };
  }
  if (idle < idleMs) {
    return { newStatus: null, cardStatus: card.status, reason: `skip-fresh: card was edited ${(idle / 3600e3).toFixed(1)}h ago — someone may be on it` };
  }

  // Same #383 class sweepUntrackedInProgress's has-completed-outcome guard
  // exists to stop (bsc-reconcile.js): the card already records FINISHED
  // work, so downgrading to pending would make it re-dispatchable and redo
  // it. That sweep only ever covers ledger-UNtracked tasks — this is the
  // only guard standing between a ledger-TRACKED mirror and the same bug.
  if (String(card.outcome || '').trim()) {
    return { newStatus: null, cardStatus: card.status, reason: 'skip-outcome: card already records a completed Outcome — needs a human yes/no, not an automatic downgrade' };
  }

  if (TERMINAL_CARD_STATUSES.has(card.status)) {
    // Archived/Cancelled must never become dispatchable again — mapStatus()'s
    // default case would otherwise map them straight to 'pending' just like
    // Paused/Not started. Close the local mirror to 'completed' instead, the
    // same terminal treatment task-reclaim.js's parkedTaskShape gives this
    // exact case. (cmdPush must not read this as "newly completed LOCAL
    // work" and overwrite the card's Archived/Cancelled status with Done —
    // see cmdPush's own syncedStatus guard, not a stamp on this entry, so a
    // later human reopen of the card is never permanently locked out.)
    return { newStatus: 'completed', cardStatus: card.status, reason: `liveness-checked: no live lease/tab, no Outcome, card idle and Notion says "${card.status}" — closing (terminal status, never re-dispatchable)` };
  }

  return { newStatus: 'pending', cardStatus: card.status, reason: `liveness-checked: no live lease/tab, no Outcome, card idle and Notion says "${card.status}"` };
}

// Decide what a pull should do given the eligible cards and the existing map.
// Returns { toCreate:[{card}], toUpdate:[{card, taskId}], unchanged:[pageId] }.
// Pure: no filesystem or network access, so it is unit-testable.
function planPull(cards, existingMap) {
  const plan = { toCreate: [], toUpdate: [], unchanged: [] };
  for (const card of cards) {
    const entry = existingMap[card.id];
    if (!entry) { plan.toCreate.push({ card }); continue; }
    // fmt 2 = description carries the category segment; older mirrors get
    // rewritten once so bsc-next's category filter sees every task.
    // fmt 3 (task #1154) = description re-attaches a "VERIFY: owner-judgment"
    // line that the 400-char truncation dropped. Bumping the number is what
    // makes the fix reach cards that are ALREADY mirrored: without it this
    // branch only re-runs mapCardToTask when a card's Notion status changes,
    // so every existing long-notes owner-judgment card would have stayed
    // wrongly dispatchable indefinitely (ship-check catch).
    if (entry.syncedStatus !== card.status || entry.fmt !== MIRROR_FMT) {
      plan.toUpdate.push({ card, taskId: entry.taskId });
    } else {
      plan.unchanged.push(card.id);
    }
  }
  return plan;
}

// Card #1410: "BSC Daily:"-titled cards are the morning digest's own alert
// family. As of the BRO-286 Phase 2 migration (2026-08-12) both producers
// (owner-alert-router.js's dispatchCard, digest-autofix.js's fileCard) file
// these to Linear, not Notion — no code path creates a NEW Notion card with
// this title prefix anymore. Excluding them from the pull entirely (rather
// than mirroring-then-archiving) is what actually stops planSelfHeal from
// re-minting a fresh id every time an archived one's live file goes away:
// a card that never enters `cards`/`cardsById` never reaches toCreate,
// toUpdate, or the self-heal loop, independent of whatever the archiver does
// to already-mirrored live files.
//
// KNOWN LIMITATION (ship-check adversarial review, card #1410): this is a
// title match, not a provenance marker — a human who happened to name a real
// card "BSC Daily: ..." via notion-brain.js would silently never get it
// mirrored/dispatched. Accepted: this exact title prefix has only ever been
// used by the digest's own auto-filed alert family (never a human-authored
// title), and the archiver's BSC_DAILY_TITLE_RE population (card #1351) already
// made the same title-based bet for aging these cards out. A provenance-based
// exclusion (e.g. a marker embedded by the filer) would be more robust but is
// a larger change than this fix warrants; revisit if a real false-positive
// title collision is ever observed.
// Task #1691: a card created with `notion-brain.js create --dispatch
// --no-spawn "<reason>"` carries a NO-DISPATCH marker in its Notes (written
// by notion-brain.js, read here via the shared leaf
// scripts/lib/no-dispatch-marker.js — see that module's header for why the
// exclusion happens here rather than by forcing the card's Notion Status).
// Such a card is EXCLUDED from the mirror entirely, the same way a BSC Daily
// card is above: it can never occupy a claimed (`in_progress`) slot in the
// shared task list, regardless of what Status the card shows on the Notion
// board. This is the actual fix for the "DISPATCHED without spawning"
// incident — a card that never enters `cards`/`cardsById` has no claimed
// state to leak.
function isMirrorableCard(card) {
  const name = (card && card.name) || '';
  if (hasNoDispatchMarker(card && card.notes)) return false;
  return !BSC_DAILY_TITLE_RE.test(name) && !FIX_BSC_DAILY_TITLE_RE.test(name);
}

// Card #1351: decide which "unchanged" cards (status/fmt already match — see
// planPull above) still need recreating because their live mirror file
// vanished independently of any Notion change — task-store-archive.js's new
// pending population can now archive an untouched pending task even while
// its Notion card sits unchanged at "Not started". Before that population
// existed, "unchanged" truly meant "nothing to do": only completed/dead-
// in_progress tasks could be archived, and neither needs a live mirror to
// stay actionable (see readTask's docstring). Ship-check adversarial catch,
// 2026-08-12.
//
// Pure aside from the injected `ownershipCheck(taskId, pageId, liveOnly)` —
// same shape as calling taskBelongsTo(dir, taskId, pageId, {liveOnly}) — so
// the decision is unit-testable without a real directory. Returns
// { toRecreate:[{card, hasPriorOwnership}], stillUnchanged:[pageId] };
// hasPriorOwnership tells the caller whether it's safe to carry the old
// task's blocks/blockedBy forward (the liveOnly miss alone doesn't
// distinguish "archived" from "id reused by an unrelated task" — copying a
// stranger's blocks/blockedBy would be wrong).
function planSelfHeal(unchangedPageIds, map, cardsById, ownershipCheck) {
  const toRecreate = [];
  const stillUnchanged = [];
  for (const pageId of unchangedPageIds) {
    const entry = map[pageId];
    const card = cardsById.get(pageId);
    if (entry && card && !ownershipCheck(entry.taskId, pageId, true)) {
      toRecreate.push({ card, taskId: entry.taskId, hasPriorOwnership: ownershipCheck(entry.taskId, pageId, false) });
    } else {
      stillUnchanged.push(pageId);
    }
  }
  return { toRecreate, stillUnchanged };
}

// ── filesystem helpers ─────────────────────────────────────────────────────
function tasksRoot(args) {
  return args['tasks-dir'] || path.join(os.homedir(), '.claude', 'tasks');
}
function listId(args) {
  return args['list-id'] || process.env.CLAUDE_CODE_TASK_LIST_ID || 'broadwayscore';
}
function listDir(args) {
  return path.join(tasksRoot(args), listId(args));
}
function mapPath(dir) { return path.join(dir, '.notion-map.json'); }
function hwmPath(dir) { return path.join(dir, '.highwatermark'); }

function readMap(dir) {
  try { return JSON.parse(fs.readFileSync(mapPath(dir), 'utf8')); }
  catch { return {}; }
}
function writeMap(dir, map) {
  const tmp = mapPath(dir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, mapPath(dir)); // atomic
}

// Highest <id>.json found directly under `d` (non-recursive) — shared by
// nextId's maxFile scan and allocateFreeId's collision check, both of which
// must agree on live+archive to stay consistent with each other.
function maxIdInDir(d) {
  let max = 0;
  try {
    for (const f of fs.readdirSync(d)) {
      const m = /^(\d+)\.json$/.exec(f);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch {}
  return max;
}

// Next id to assign. Prefer the highwatermark; fall back to (max existing id
// across live AND archive/)+1 so we never collide with tasks created by a
// live session OR shadow an already-archived task's id. Card #1410: the
// archive/-blind version of this scan was always a latent gap (a lost
// .highwatermark falls back to this scan per the catch{} below), and grows
// materially more exposed now that DEFAULT_KEEP_TOP_N=1 moves far more tasks
// into archive/ than before.
function nextId(dir) {
  let hwm = 0;
  try { hwm = parseInt(fs.readFileSync(hwmPath(dir), 'utf8'), 10) || 0; } catch {}
  const maxFile = Math.max(maxIdInDir(dir), maxIdInDir(path.join(dir, 'archive')));
  return Math.max(hwm, maxFile + 1);
}
function writeTask(dir, task) {
  const tmp = path.join(dir, `${task.id}.json.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
  fs.renameSync(tmp, path.join(dir, `${task.id}.json`));
}
function readHwm(dir) {
  try { return parseInt(fs.readFileSync(hwmPath(dir), 'utf8'), 10) || 0; } catch { return 0; }
}
// Never regress the highwatermark below a value a concurrent session bumped it to.
function writeHwm(dir, n) { fs.writeFileSync(hwmPath(dir), String(Math.max(readHwm(dir), n))); }

// Card #854: completed tasks >48h old move to a sibling archive/ dir
// (scripts/archive-completed-tasks.js) to shrink the harness's injected
// task-list reminder. readLiveTask() is the pre-#854 behavior (live dir
// only); readTask() additionally falls back to archive/ so cmdPush/
// cmdStatus keep resolving an archived-but-not-yet-pushed card instead of
// treating it as vanished. nextId()'s maxFile scan deliberately stays
// live-dir-only — see scripts/lib/task-store-archive.js's docstring for why
// archived ids must never re-enter that computation.
//
// cmdPull's toUpdate path (ownership check + `existing` read) MUST use
// readLiveTask, not readTask: a card reopened in Notion after its mirrored
// task was archived would otherwise read the archive copy's stale
// status:'completed', mergeStatus's sticky-completed rule would carry that
// into the freshly-written LIVE file, and the reopened card would be
// permanently invisible to actionable() — resurrected-stuck-completed
// instead of the pre-#854 "id reused, mint a fresh task" fallback via
// doCreate. Ship-check adversarial review caught this 2026-08-02.
function readLiveTask(dir, taskId) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, `${taskId}.json`), 'utf8')); }
  catch { return null; }
}
function readTask(dir, taskId) {
  const live = readLiveTask(dir, taskId);
  if (live) return live;
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'archive', `${taskId}.json`), 'utf8')); }
  catch { return null; }
}

// Marker embedded in every task we create, so we can prove a task file still
// belongs to a given Notion card before rewriting or closing it. The integer
// id namespace is shared with live sessions; the page id is our real key.
function notionMarker(pageId) { return `[notion:${pageId}]`; }
// liveOnly: true restricts the lookup to the live dir (cmdPull's ownership
// check — see readTask's docstring above for why). Default (cmdPush) also
// checks archive/, so a card can still be closed once its mirrored task has
// aged out of the live dir.
function taskBelongsTo(dir, taskId, pageId, { liveOnly = false } = {}) {
  const t = liveOnly ? readLiveTask(dir, taskId) : readTask(dir, taskId);
  return !!(t && typeof t.description === 'string' && t.description.includes(notionMarker(pageId)));
}
// Lowest id >= startId whose file does not already exist in the live dir OR
// archive/, so we never clobber a task a live session created in the shared
// list, and never mint an id that shadows an already-archived task (card
// #1410 — a collision there would silently orphan the archived record:
// mergeWithArchive's live-wins-on-collision rule means the archive copy
// becomes unreachable by id forever once a different live task takes it).
function allocateFreeId(dir, startId) {
  let id = startId;
  while (fs.existsSync(path.join(dir, `${id}.json`)) || fs.existsSync(path.join(dir, 'archive', `${id}.json`))) id++;
  return id;
}

// Task #1701: ground truth for "does a live mirror already represent this
// Notion card?", independent of the (possibly stale/incomplete) sidecar map
// — cmdPull's map is only persisted once, at the very end of the whole run
// (writeMap below), so a crash/thrown error after some doCreate() calls have
// already written task files but before that final write leaves the map
// ignorant of a mirror that genuinely exists. The next pull then sees no map
// entry, routes the card back through doCreate(), and mints a SECOND file
// carrying the identical [notion:<id>] marker (the #1698/#1699 incident).
//
// Reuses task-reclaim.js's indexLiveTasks/notionMarkerOf rather than a fresh
// regex: that module already fixed the line-1-anchored version of this same
// scan once — a task carrying a prepended zombie-sweep note pushes
// `[notion:...]` off line 1, and a line-anchored match under-counted the
// live-twin population 3 vs the real 14 (see task-reclaim.js's header).
//
// Live task files are read in ascending id order before indexing, so
// indexLiveTasks's first-match-wins semantics resolve to "lowest id wins"
// whenever two live files already carry the same marker (today's own
// #1698/#1699 shape) — a deterministic tiebreak instead of depending on
// readdirSync's unspecified order.
function buildLiveMarkerIndex(dir) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return indexLiveTasks([]); }
  const ids = files
    .map((f) => /^(\d+)\.json$/.exec(f))
    .filter(Boolean)
    .map((m) => m[1])
    .sort((a, b) => Number(a) - Number(b));
  const tasks = ids.map((id) => readLiveTask(dir, id)).filter(Boolean);
  return indexLiveTasks(tasks);
}

// Pure: decide whether a card headed for doCreate() is actually already
// represented by a live mirror the sidecar map lost track of (repair that
// file in place) or genuinely needs a fresh id (create). `liveByMarker` is
// buildLiveMarkerIndex(dir).byMarker.
function resolveCreateTarget(card, liveByMarker) {
  const marker = String((card && card.id) || '').toLowerCase();
  const orphanTaskId = liveByMarker.get(marker);
  return orphanTaskId ? { kind: 'repair', taskId: orphanTaskId } : { kind: 'create' };
}

// Best-effort cross-process lock so N Cmux panes pulling at once don't race.
// Stale locks (>2 min) are stolen. Returns a release() fn or null if held.
// Age is judged off the lock file's own embedded `acquiredAt`, not fs mtime
// — mtime is trivially reset by any unrelated process that touches/stats
// the file (the #476 bug class; see monitor-lock-staleness.js). mtime is
// kept only as a fallback for an old-format (bare-PID) or corrupt lock file.
function acquireLock(dir) {
  const lock = path.join(dir, '.sync-lock');
  try {
    const fd = fs.openSync(lock, 'wx'); // O_EXCL: fails if it already exists
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    fs.closeSync(fd);
    return () => { try { fs.unlinkSync(lock); } catch {} };
  } catch {
    try {
      let acquiredAt = NaN;
      try {
        const content = JSON.parse(fs.readFileSync(lock, 'utf8'));
        acquiredAt = Date.parse(content.acquiredAt);
        if (!Number.isFinite(acquiredAt) && content.acquiredAt !== undefined) {
          console.warn(`notion-tasks-sync: ${lock} has an unparseable acquiredAt (${JSON.stringify(content.acquiredAt)}) — falling back to mtime staleness`);
        }
      } catch {
        acquiredAt = NaN;
      }
      const age = Number.isFinite(acquiredAt)
        ? Date.now() - acquiredAt
        : Date.now() - fs.statSync(lock).mtimeMs; // old-format (bare pid) or corrupt — mtime fallback
      if (age > 120000) { fs.unlinkSync(lock); return acquireLock(dir); }
    } catch {}
    return null;
  }
}

// ── Notion I/O via notion-brain.js ─────────────────────────────────────────
function repoRoot() {
  // scripts/ lives at <repo>/scripts; from a worktree this resolves correctly.
  return path.resolve(__dirname, '..');
}
function notionBrain(subArgs) {
  const out = execFileSync('node', [path.join(repoRoot(), 'scripts', 'notion-brain.js'), ...subArgs],
    { cwd: repoRoot(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024 });
  return out;
}
function fetchCards(statuses, priorities, limit) {
  // notion-brain search returns full card objects incl id,url,name,status,
  // priority,notes. We query by status, then filter to the wanted priorities
  // client-side (search takes a single status filter path reliably).
  const seen = new Map();
  for (const status of statuses) {
    const raw = notionBrain(['search', '--status', status, '--limit', String(limit)]);
    let cards;
    try { cards = JSON.parse(raw); } catch { cards = []; }
    for (const c of cards) {
      if (priorities.length && !priorities.includes(c.priority)) continue;
      if (!seen.has(c.id)) seen.set(c.id, c);
    }
  }
  return [...seen.values()];
}
function markCardDone(pageId) {
  const today = new Date().toISOString().slice(0, 10);
  // --outcome leaves an audit line (the --force reason string is discarded by
  // updateCard, so it would otherwise be a silent bot mutation).
  try {
    notionBrain(['update', pageId, '--status', 'Done', '--completed-date', today,
      '--outcome', `Auto-closed ${today} by notion-tasks-sync: its mirrored task was marked completed in the shared task list.`]);
    return true;
  } catch (err) {
    // The close-time acceptance verify (task #1003) refused this ONE card
    // because its own acceptance command fails on origin/main. That must not
    // abort the whole sweep — every other completed task still deserves its
    // card closed (ship-check finding). Any other failure still propagates.
    const { CLOSE_REFUSED_EXIT_CODE } = require('./lib/close-time-verify.js');
    if (err && err.status === CLOSE_REFUSED_EXIT_CODE) {
      console.error(`[sync] card ${pageId} left open: close-time verify refused it (its own acceptance command fails on origin/main)`);
      return false;
    }
    throw err;
  }
}

// ── commands ───────────────────────────────────────────────────────────────
function cmdPull(args) {
  const dir = listDir(args);
  const dry = !!args['dry-run'];
  if (!dry) fs.mkdirSync(dir, { recursive: true });
  const statuses = (args.statuses || 'In progress,Not started').split(',').map(s => s.trim()).filter(Boolean);
  const priorities = (args.priorities || 'P0 Now,P1 Next').split(',').map(s => s.trim()).filter(Boolean);
  // Default raised 25 -> 300 (2026-07-24): notion-brain search sorts P0/P1
  // Priority-ascending, not by recency, so a newly created card has no
  // guarantee of landing in the first 25 results once a priority tier's
  // backlog exceeds the page limit — it's silently dropped from the mirror
  // until someone happens to pass a bigger --limit. 300 comfortably covers
  // the current combined P0/P1 Not-started+In-progress backlog (~110) with
  // headroom for growth; fetchCards already paginates via next_cursor to
  // satisfy whatever limit is requested, so this only costs a few extra
  // Notion API calls, not a correctness tradeoff.
  const limit = parseInt(args.limit, 10) || 300;

  const release = dry ? (() => {}) : acquireLock(dir);
  if (!release) { console.error('[sync] another pull holds the lock; skipping'); return { skipped: true }; }
  let summary;
  try {
    // isMirrorableCard filters BEFORE cardsById is built (card #1410) — a
    // "BSC Daily:" card must never enter toCreate/toUpdate/self-heal, not
    // just get skipped later, or planSelfHeal would still re-mint it. It also
    // filters BEFORE slice(0, limit) (ship-check adversarial finding): the
    // reverse order would let a page of legacy BSC-Daily results consume the
    // batch's limit budget and starve real cards below the cutoff.
    const cards = fetchCards(statuses, priorities, limit).filter(isMirrorableCard).slice(0, limit);
    const cardsById = new Map(cards.map((c) => [c.id, c]));
    const map = readMap(dir);
    const plan = planPull(cards, map);
    let id = nextId(dir);
    const created = [], updated = [];
    // Lazy + memoized: only scan the live directory if doCreate() is
    // actually invoked at least once this run (the common case — an empty
    // toCreate and a clean self-heal pass — pays nothing extra).
    let liveMarkerIndex = null;
    const liveByMarker = () => {
      if (!liveMarkerIndex) liveMarkerIndex = buildLiveMarkerIndex(dir);
      return liveMarkerIndex.byMarker;
    };
    // A card whose mapped file was clobbered/reused by a live session is
    // re-created under a fresh free id, so we never rewrite a stranger's task.
    // priorTask (optional): a task whose blocks/blockedBy should carry
    // forward into the fresh id instead of doCreate's blank defaults — used
    // by the self-heal loop below when the prior copy is confirmed to
    // belong to this same card (see its own comment for why that check
    // matters).
    //
    // doCreate() is the single choke point for every path that can mint a
    // task for a card with no *trusted* map entry (fresh toCreate, the
    // toUpdate id-reuse fallback, and the self-heal toRecreate loop below) —
    // so the resolveCreateTarget() ground-truth check lives here once,
    // rather than being duplicated (and inevitably drifting) across each
    // call site (task #1701).
    const doCreate = (card, priorTask) => {
      const target = resolveCreateTarget(card, liveByMarker());
      if (target.kind === 'repair') {
        const existing = readLiveTask(dir, target.taskId) || {};
        const mapped = mapCardToTask(card, target.taskId);
        mapped.status = mergeStatus(existing.status, mapped.status);
        const blocks = (priorTask && priorTask.blocks) || existing.blocks || [];
        const blockedBy = (priorTask && priorTask.blockedBy) || existing.blockedBy || [];
        if (!dry) writeTask(dir, { ...mapped, blocks, blockedBy });
        map[card.id] = { taskId: target.taskId, name: card.name, syncedStatus: card.status, url: card.url, pushed: false, fmt: MIRROR_FMT };
        // Persist the map/hwm right after this write, not just once at the
        // end of the whole run (adversarial review finding on task #1701):
        // the ORIGINAL bug was exactly a task file landing on disk while the
        // sidecar map never learned about it because a crash/error hit
        // between this write and the end-of-run writeMap. The ground-truth
        // scan above repairs drift that already happened; this closes the
        // window that creates it in the first place, for every doCreate()
        // call, not just the ones a future crash happens to interrupt.
        if (!dry) { writeMap(dir, map); writeHwm(dir, id); }
        updated.push({ taskId: target.taskId, name: card.name });
        return;
      }
      id = dry ? id : allocateFreeId(dir, id);
      const task = mapCardToTask(card, id);
      if (priorTask) { task.blocks = priorTask.blocks || []; task.blockedBy = priorTask.blockedBy || []; }
      if (!dry) writeTask(dir, task);
      map[card.id] = { taskId: task.id, name: card.name, syncedStatus: card.status, url: card.url, pushed: false, fmt: MIRROR_FMT };
      created.push({ taskId: task.id, name: card.name });
      id++;
      if (!dry) { writeMap(dir, map); writeHwm(dir, id); }
    };

    for (const { card } of plan.toCreate) doCreate(card);
    for (const { card, taskId } of plan.toUpdate) {
      if (!dry && !taskBelongsTo(dir, taskId, card.id, { liveOnly: true })) { doCreate(card); continue; }
      const existing = readLiveTask(dir, taskId) || {};
      const mapped = mapCardToTask(card, taskId);
      mapped.status = mergeStatus(existing.status, mapped.status);
      const task = { ...mapped, blocks: existing.blocks || [], blockedBy: existing.blockedBy || [] };
      if (!dry) writeTask(dir, task);
      map[card.id].syncedStatus = card.status;
      map[card.id].name = card.name;
      map[card.id].fmt = MIRROR_FMT;
      updated.push({ taskId, name: card.name });
    }

    // Card #1351: self-heal "unchanged" cards whose live mirror vanished
    // independently (see planSelfHeal's docstring above planPull). The
    // ownership check runs even in --dry-run (unlike the toUpdate-miss
    // check above) so a preview run actually reports the recreation that's
    // about to happen — --dry-run is how an operator would confirm this
    // exact bug is fixed, and hiding it behind `!dry` would defeat that.
    // Only the resulting doCreate's writes stay dry-gated internally.
    const { toRecreate, stillUnchanged } = planSelfHeal(
      plan.unchanged, map, cardsById,
      (taskId, pageId, liveOnly) => taskBelongsTo(dir, taskId, pageId, { liveOnly }),
    );
    for (const { card, taskId, hasPriorOwnership } of toRecreate) {
      const priorTask = hasPriorOwnership ? readTask(dir, taskId) : null;
      doCreate(card, priorTask);
    }

    if (!dry) { writeMap(dir, map); writeHwm(dir, id); }

    summary = { listId: listId(args), dir, created, updated, unchanged: stillUnchanged.length, dry };
    console.error(`[sync] pull: ${created.length} created, ${updated.length} updated, ${stillUnchanged.length} unchanged (list=${listId(args)}${dry ? ', DRY RUN' : ''})`);
    for (const c of created) console.error(`  + #${c.taskId} ${c.name}`);
    for (const u of updated) console.error(`  ~ #${u.taskId} ${u.name}`);
  } finally { release(); }
  // Task #1778: reconcile stale in_progress/pending mirrors right after
  // pull's own bulk-search pass, using pull's OWN lock cycle (already
  // released above — reconcileStaleMirrors acquires its own per-write locks,
  // never nested inside pull's). This is deliberately a SEPARATE pass with
  // its own per-card-GET mechanism, not a wider pull `statuses` fetch — pull
  // structurally can't see Done/Paused cards via search (see
  // reconcileStaleMirrors's own severity comment for why folding this in
  // here, not just leaving it in `sync-drift`, is what makes the fix take
  // effect on `pull`'s actual invocation cadence instead of waiting on
  // task #1700's still-open scheduling). Opt out with --no-reconcile for a
  // caller that only wants pull's original fast bulk-search behavior.
  //
  // Default limit is intentionally MUCH smaller than sync-drift's own
  // (DEFAULT_PULL_RECONCILE_LIMIT vs DEFAULT_DRIFT_LIMIT): three real
  // callers invoke `pull` synchronously via execFileSync with a 120s
  // timeout — notion-brain.js's dispatchCreatedCard (the P0/P1
  // dispatch-at-creation path, CLAUDE.md's own "dispatch at creation" rule),
  // digest-autofix.js's syncTasks, and generate-remediation-plan.js's
  // escalatePlanRefusal. Each per-card GET is its own `notion-brain.js get`
  // subprocess; a few hundred of them sequentially would blow that budget
  // and turn "pull" into a dispatch-blocking failure — worse than the
  // staleness this task fixes. A small bounded slice still converges the
  // stale population over repeated pull calls (which happen often, per
  // CLAUDE.md's own dispatch pattern), without risking a caller timeout.
  const DEFAULT_PULL_RECONCILE_LIMIT = 25;
  let driftReconciled = null;
  if (!args['no-reconcile']) {
    driftReconciled = reconcileStaleMirrors(dir, { limit: parseInt(args['reconcile-limit'], 10) || DEFAULT_PULL_RECONCILE_LIMIT, dry });
  }
  return { ...summary, driftReconciled };
}

// cmdPush's own push-eligibility check (card #1779 test-extraction): pulled
// out of the loop below so it can be require()'d directly in tests instead
// of reimplementing "if (entry.pushed) continue; ...task.status..." as
// parallel test logic (CLAUDE.md rule 15). Behavior-preserving — both
// original inline checks were bare `continue` with no differing side effect.
function isPushEligible(entry, task) {
  return !!entry && !entry.pushed && !!task && task.status === 'completed';
}

function cmdPush(args) {
  const dir = listDir(args);
  const dry = !!args['dry-run'];
  // Share the pull lock: push mutates the same map, and both do read→modify→
  // write. Without this, a concurrent pull can clobber a just-set pushed flag
  // (→ double-close) or lose a new mapping (→ duplicate task).
  const release = dry ? (() => {}) : acquireLock(dir);
  if (!release) { console.error('[sync] a sync holds the lock; skipping push'); return { skipped: true }; }
  try {
    const map = readMap(dir);
    const done = [], skipped = [], refused = [], parkedTerminal = [];
    for (const [pageId, entry] of Object.entries(map)) {
      const task = readTask(dir, entry.taskId);
      if (!isPushEligible(entry, task)) continue;
      // The integer id may have been reused by a live session for unrelated
      // work. Only close the card if this file still carries our marker.
      if (!taskBelongsTo(dir, entry.taskId, pageId)) { skipped.push({ taskId: entry.taskId, name: entry.name }); continue; }
      // Task #1697: sync-drift's liveness-checked terminal closure writes a
      // local 'completed' status for a card whose Notion status is ALREADY
      // Archived/Cancelled (planLivenessDowngrade) — that reflects Notion's
      // existing terminal state, not newly-finished local work, so it must
      // never be read as "ready to markCardDone" and overwrite a deliberate
      // Archived/Cancelled with Done. Checked off the entry's last-synced
      // Notion status (not a permanent stamp) so a card a human later
      // reopens naturally drops out of this guard on its next pull/sync-drift.
      if (NEVER_OVERWRITE_WITH_DONE.has(entry.syncedStatus)) {
        parkedTerminal.push({ taskId: entry.taskId, name: entry.name, syncedStatus: entry.syncedStatus });
        continue;
      }
      // pushed only when the card ACTUALLY closed — a trunk-gate refusal
      // must stay retryable, never be recorded as a completed close
      // (ship-check finding: the sweep would report "marked Done" for a card
      // that is still open, and never try again).
      if (!dry) {
        entry.pushed = markCardDone(pageId);
        // A refused close is NOT a close: it must not be counted, printed as
        // "✓ marked Done", or returned in `done` — the operator would read a
        // still-open card as closed and never look again (second review pass:
        // the earlier fix set entry.pushed correctly but left this push
        // unconditional).
        if (!entry.pushed) { refused.push({ taskId: entry.taskId, name: entry.name, pageId }); continue; }
        // Persist right after each real Notion close, not just once at the
        // end of the whole loop (task #1701 cousin — /what-else pattern-
        // recognition pass): markCardDone() is a real, external write. If
        // the loop dies partway through a multi-card batch (Notion API
        // hiccup, process kill), every card ALREADY closed on Notion before
        // that point would otherwise lose its `pushed:true` flag along with
        // every other entry not yet reached, and the next push run would
        // call markCardDone() again for cards that are already Done —
        // harmless to Notion's Status field but appends a duplicate
        // "Auto-closed" Outcome line every time until the map catches up.
        writeMap(dir, map);
      }
      done.push({ taskId: entry.taskId, name: entry.name, pageId });
    }
    console.error(`[sync] push: ${done.length} card(s) marked Done${skipped.length ? `, ${skipped.length} skipped (id reused)` : ''}${refused.length ? `, ${refused.length} refused by close-time verify — their own acceptance command fails on origin/main (still open, will retry)` : ''}${parkedTerminal.length ? `, ${parkedTerminal.length} skipped (Notion status is Archived/Cancelled — never overwrite with Done)` : ''}${dry ? ' (DRY RUN)' : ''}`);
    for (const d of done) console.error(`  ✓ ${d.name}`);
    for (const s of skipped) console.error(`  ⚠ skipped #${s.taskId} (task id no longer maps to this card): ${s.name}`);
    for (const r of refused) console.error(`  ⛔ still open (own file failing on main): ${r.name}`);
    for (const p of parkedTerminal) console.error(`  · skipped #${p.taskId} (Notion says ${p.syncedStatus} — never overwrite with Done): ${p.name}`);
    return { listId: listId(args), done, skipped, refused, parkedTerminal, dry };
  } finally { release(); }
}

// Task #1778: planStatusDrift already unsticks a PENDING mirror when Notion
// says Done — mapStatus('done')->'completed' beats mergeStatus's fallthrough
// even from 'pending' (see planStatusDrift's own comment above). It
// structurally can't see Paused though: mapStatus()'s default case collapses
// Paused into the same 'pending' bucket as Not started, so
// mergeStatus('pending','pending') never reports drift — a pending mirror
// whose card moved to Paused stays 'pending' (and bsc-next-dispatchable)
// forever. This is the narrow fix for exactly that gap: the one case
// planStatusDrift can't already handle for a pending mirror.
//
// KNOWN LIMITATION (self-reviewed per CLAUDE.md rule 18, task #1778): writing
// 'completed' here trades one stale-forever direction for another. The
// native task schema has no fourth "on hold" state, so 'completed' is the
// only way to pull this out of actionable()'s pending|in_progress filter
// (scripts/bsc-next.js) — but mergeStatus's sticky-completed rule (line
// ~141) means a card the owner later UN-pauses will never re-enter the
// mirror: pull's toUpdate always calls mergeStatus(existing='completed',
// mapped), which short-circuits back to 'completed' regardless of the
// card's new status. This is the SAME tradeoff planLivenessDowngrade already
// accepts for Archived/Cancelled (never re-dispatchable by design there);
// Paused is not in TERMINAL_CARD_STATUSES because it genuinely is meant to
// be resumed, so this is a real, accepted gap, not a false equivalence.
// Accepted anyway because the alternative — a closed/finished card mirrored
// as 'pending' forever — is the exact dispatch-storm incident this task
// exists to fix, and stuck-not-dispatchable is a strictly safer failure mode
// than stuck-dispatchable. Revisit with a real repair path (e.g. a marker
// that lets pull's toUpdate bypass mergeStatus's stickiness for a
// reconciliation-closed entry specifically) if resumed-Paused invisibility
// is ever reported as a live problem — out of scope for this P1.
function planPendingClosure(task, card) {
  if (!task || task.status !== 'pending' || !card) return null;
  if (card.status !== 'Paused') return null; // Done is planStatusDrift's job
  return { newStatus: 'completed', cardStatus: 'Paused' };
}

// Task #1691: fix the DOMINANT contributor to "in_progress with no live
// session" — a card whose Notion Status moved past In progress/Not started
// (Done, most often) never gets re-fetched by `pull`, so the local mirror
// never learns. Scoped to `in_progress` local tasks only, one direct GET per
// mapped card (not a search), capped per run so a large backlog doesn't
// burn the Notion API quota in one call — same "capped, reportable, dry-run
// by default" shape sweepUntrackedInProgress uses (bsc-reconcile.js).
// Task #1778 broadened the scope to ALSO cover 'pending' mirrors (see
// planPendingClosure above) — the sibling gap in the same bug class: a
// pending mirror's card can move to Done/Paused and never get re-fetched by
// `pull` either, for the same "pull's own fetch filter only asks for In
// progress/Not started" reason.
//
// SEVERITY NOTE (task #1778, live incident 2026-08-18): a stale in_progress
// mirror isn't just a wasted dispatch RANKING (pending's failure mode) — it
// is an active RE-DISPATCH candidate. scripts/bsc-reconcile.js's stall sweep
// (reconcileStalledTasks) selects `tasks.filter(t => t.status ===
// 'in_progress')` straight off the LOCAL mirror and never consults Notion at
// all in that path, on a 5-minute launchd cron (com.broadwayscore.
// bsc-reconcile.plist). A verified-Done card (#1773, closed ~14:10Z) was
// stall-redispatched by that sweep 24 minutes later because its mirror
// still read in_progress. This function is exported as reconcileStaleMirrors
// and called from BOTH cmdSyncDrift (this command) AND cmdPull (below) —
// `pull` is what CLAUDE.md's own P0/P1 dispatch pattern actually invokes
// before every ranking round, and nothing currently schedules `sync-drift`
// on its own (task #1700), so folding this into `pull` is what makes the
// fix take effect on a realistic cadence instead of waiting on that
// still-open scheduling task. The residual 5-minute window between a
// card closing and the next `pull`/`sync-drift` invocation is real but not
// closed here — closing it fully means either #1700 landing or
// bsc-reconcile.js's own stall sweep consulting Notion directly, and both
// are a different file/task's scope than this one.
const DEFAULT_DRIFT_LIMIT = 250;

// Task #1790: reconcileStaleMirrors used to take a stable `.slice(0, limit)`
// off Object.entries(map) — no offset, no rotation. With a candidate pool
// bigger than `limit`, entries past index `limit` were never reconciled, not
// "reconciled less often" (measured live: 196/221 candidates permanently
// outside the sweep). Fix is identity-keyed, not index-keyed: each map entry
// carries its own `lastReconciledAt` (stamped below whenever this function
// actually re-checks it, whether or not drift was found), and every call
// takes the `limit` entries least recently checked (never-checked = 0, so a
// brand-new candidate is always picked before one already swept this
// round). This self-corrects across repeated calls regardless of how the
// pool's membership or order changes between them — an index/cursor
// approach doesn't, because Object.entries(map).filter(...) is recomputed
// fresh every call and shrinks every time an entry near the cursor gets
// fixed and drops out, desyncing a persisted offset from what it was meant
// to point at (caught in this task's own plan review). It's also race-free
// across concurrent callers: two sessions stamping the same entries with
// `lastReconciledAt = now` converge on the same ordering, unlike a shared
// cursor file, which has no natural merge and would need its own lock.
function selectLeastRecentlyReconciled(candidates, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  // Array#sort is a stable sort in Node/V8 (ES2019+), so candidates that tie
  // on lastReconciledAt (most commonly: all-zero, i.e. never checked) keep
  // their original map order rather than shuffling on every call.
  return [...candidates]
    .sort(([, a], [, b]) => (a.lastReconciledAt || 0) - (b.lastReconciledAt || 0))
    .slice(0, limit);
}

function reconcileStaleMirrors(dir, { limit = DEFAULT_DRIFT_LIMIT, dry = false } = {}) {
  const map = readMap(dir);
  const allCandidates = Object.entries(map).filter(([, e]) => {
    const t = readLiveTask(dir, e.taskId);
    return t && (t.status === 'in_progress' || t.status === 'pending');
  });
  const entries = selectLeastRecentlyReconciled(allCandidates, limit);

  // Task #1697: liveness primitives for planLivenessDowngrade, fetched once
  // up front (cmux listing is a subprocess call — same "fetch once, reuse
  // across the loop" shape bsc-reconcile.js's sweepUntrackedInProgress uses
  // for its own workspace snapshot). Degrades to "no live workspace found"
  // if cmux is down, matching that sweep's own try/catch.
  let workspaces = [];
  try { workspaces = cmuxws.listWorkspaces() || []; } catch { /* cmux down — liveness guard degrades to skip-none */ }
  const leaseAliveOf = (taskId) => {
    const lease = readLease(taskId);
    return !!(lease && pidLooksLikeClaude(lease.pid));
  };
  const liveWorkspaceOf = (t, wsList) => findLiveWorkspaceForTask(t, wsList, cmuxws.isDoneTitle);

  // Task #1790: stamp lastReconciledAt for a candidate that was genuinely
  // EXAMINED this round — on a successful GET, a failed one, AND the stale-
  // ownership skip below — so it rotates to the back of
  // selectLeastRecentlyReconciled's queue regardless of outcome. Ship-check
  // adversarial review (2026-08-18) caught the original version of this
  // function only stamping on success: if >= `limit` candidates fail their
  // Notion GET simultaneously (permission revoked, pages deleted, an
  // outage), the unstamped failures would keep winning "least recently
  // reconciled" forever and starve every other candidate — reproducing this
  // exact task's bug through a different gate (>= limit persistently-broken
  // pages instead of >= limit array index). Stamping failures too trades a
  // slower retry for a genuinely transient blip (next full sweep instead of
  // next call) for a hard bound on total starvation — worth it given `pull`
  // runs often (CLAUDE.md's own dispatch cadence) and sync-drift covers up
  // to 250 candidates at once. A lock loss (another sync mid-write) is a
  // no-op: the entry simply stays eligible next run, coverage is never lost.
  function stampReconciled(pageId) {
    if (dry) return;
    const stampRelease = acquireLock(dir);
    if (!stampRelease) return;
    try {
      const freshMapForStamp = readMap(dir);
      if (freshMapForStamp[pageId]) {
        freshMapForStamp[pageId].lastReconciledAt = Date.now();
        writeMap(dir, freshMapForStamp);
      }
    } finally { stampRelease(); }
  }

  const fixed = [];
  const unchanged = [];
  const fetchFailed = [];
  for (const [pageId, entry] of entries) {
    const task = readLiveTask(dir, entry.taskId);
    if (!task) { stampReconciled(pageId); continue; } // vanished between the filter above and here — stamped too (final ship-check pass, task #1790): a genuine deletion self-limits (drops out of the outer filter next call anyway), but a null readLiveTask racing a concurrent local writer on the SAME entry, run after run, would otherwise sit at lastReconciledAt=0 and starve the rest of the pool through a third gate alongside GET-failure and array-index
    // Same ownership guard cmdPull's toUpdate branch uses (task #1410): if
    // this task id was reused by an unrelated live task since the map was
    // last synced, this entry's mapping is stale — never overwrite a
    // stranger's task. Unlike cmdPull, sync-drift isn't in the business of
    // minting a replacement id (it only fixes an EXISTING claimed slot), so
    // the safe action here is just to skip, not doCreate. Checked in BOTH
    // dry-run and real runs (ship-check catch) — a dry-run that skips this
    // check reports "would fix" for an entry a real run would actually
    // refuse, which makes the dry-run report useless as an approval signal.
    if (!taskBelongsTo(dir, entry.taskId, pageId, { liveOnly: true })) {
      unchanged.push({ taskId: entry.taskId, name: entry.name, cardStatus: 'SKIPPED (stale map entry — task id reused)' });
      stampReconciled(pageId);
      continue;
    }
    let card;
    try {
      card = JSON.parse(notionBrain(['get', pageId]));
    } catch (e) {
      fetchFailed.push({ taskId: entry.taskId, name: entry.name, pageId, error: e.message });
      stampReconciled(pageId);
      continue;
    }
    stampReconciled(pageId);
    let drift = planStatusDrift(task, card);
    // Task #1697: planStatusDrift only unsticks the Done case (mergeStatus
    // never refuses ...->completed). Every other non-"In progress" Notion
    // status (Paused/Not started/Archived/Cancelled) is the refused
    // in_progress->pending downgrade — safe only once a liveness check
    // clears it. viaLiveness tags the fixed[] entry so the in-lock
    // re-verification below knows to re-run the SAME check, not just
    // re-check task.status (a lease/tab can be claimed WHILE this run's
    // slow per-card Notion GETs were in flight). Liveness only ever applies
    // to a task.status === 'in_progress' entry (planLivenessDowngrade's own
    // guard) — for a 'pending' entry this call is a harmless no-op, so it's
    // gated on task.status here purely for clarity, not correctness.
    let viaLiveness = false;
    if (!drift && task.status === 'in_progress') {
      const liveness = planLivenessDowngrade(task, card, { leaseAliveOf, liveWorkspaceOf: (t) => liveWorkspaceOf(t, workspaces) });
      if (liveness && liveness.newStatus) {
        drift = { newStatus: liveness.newStatus, cardStatus: liveness.cardStatus, reason: liveness.reason };
        viaLiveness = true;
      } else if (liveness) {
        unchanged.push({ taskId: entry.taskId, name: entry.name, cardStatus: `${card.status} (${liveness.reason})` });
        continue;
      }
    }
    // Task #1778: the pending-mirror cousin of the liveness check above —
    // unlike in_progress, a pending task was never claimed, so there's no
    // lease/workspace/idle/Outcome liveness to protect; planPendingClosure
    // only needs the card's raw status (it can't go through
    // mapStatus/mergeStatus at all — see its own comment above).
    let viaPausedClosure = false;
    if (!drift && task.status === 'pending') {
      drift = planPendingClosure(task, card);
      if (drift) viaPausedClosure = true;
    }
    if (!drift) { unchanged.push({ taskId: entry.taskId, name: entry.name, cardStatus: card.status }); continue; }
    fixed.push({ taskId: entry.taskId, name: entry.name, from: task.status, to: drift.newStatus, cardStatus: drift.cardStatus, reason: drift.reason });
    if (dry) continue;
    // Ship-check P0 catch (3 independent reviewers): cmdPull/cmdPush hold
    // acquireLock() across their WHOLE read-modify-write cycle because that
    // cycle is fast (one bulk search). sync-drift's cycle is NOT fast — up
    // to `limit` sequential Notion GETs, minutes in practice — so holding
    // the lock for the whole loop would starve every concurrent pull/push
    // for that whole time (worse than no lock: acquireLock() auto-steals
    // locks older than 120s, so a long hold gets silently stolen anyway).
    // Instead: lock only the actual write (fast, milliseconds), and re-read
    // BOTH the task and the on-disk map fresh inside the lock — same
    // check-then-act shape bsc-reconcile.js's sweepUntrackedInProgress
    // flipFn already uses ("a session can claim or complete this task
    // between the sweep's snapshot and this write — the re-read is the
    // last word, never the stale snapshot"). Re-reading the map (not
    // reusing the `map` object captured at function start) is what stops a
    // concurrent pull/push's unrelated entries from being silently
    // reverted by this function's own eventual writeMap.
    const release = acquireLock(dir);
    if (!release) {
      fetchFailed.push({ taskId: entry.taskId, name: entry.name, pageId, error: 'another sync (pull/push/sync-drift) holds the lock — retry next run' });
      fixed.pop();
      continue;
    }
    try {
      const freshTask = readLiveTask(dir, entry.taskId);
      // Task #1778: compare against THIS entry's own snapshot status
      // (task.status — 'in_progress' or 'pending'), not a hardcoded
      // 'in_progress' literal. A hardcoded check here would make every
      // pending-mirror closure fail this guard unconditionally (freshTask
      // .status is 'pending', never 'in_progress') and get silently popped
      // from fixed[] as a false "status changed" — the entire pending path
      // would no-op every single run.
      if (!freshTask || freshTask.status !== task.status) {
        fixed.pop();
        unchanged.push({ taskId: entry.taskId, name: entry.name, cardStatus: 'SKIPPED (status changed since this run started)' });
        continue;
      }
      // Task #1697 correctness fix: a liveness-based downgrade (unlike the
      // Done case) can be invalidated by a dispatch that claims the lease or
      // opens a workspace WHILE this run's slow per-card Notion GETs were in
      // flight. Re-run the SAME liveness check against freshly read
      // lease/workspace state, inside the lock, right before writing — never
      // trust the pre-lock snapshot for this path.
      if (viaLiveness) {
        let freshWorkspaces = workspaces;
        try { freshWorkspaces = cmuxws.listWorkspaces() || []; } catch { /* degrade to the pre-lock snapshot */ }
        const recheck = planLivenessDowngrade(freshTask, card, { leaseAliveOf, liveWorkspaceOf: (t) => liveWorkspaceOf(t, freshWorkspaces) });
        if (!recheck || !recheck.newStatus) {
          fixed.pop();
          unchanged.push({ taskId: entry.taskId, name: entry.name, cardStatus: `SKIPPED (became live during this run: ${recheck ? recheck.reason : 'status changed'})` });
          continue;
        }
      }
      // Same shape as cmdPull's toUpdate branch: rebuild the mirrored task
      // from the fresh card, carry blocks/blockedBy forward, apply
      // mergeStatus (via planStatusDrift, already computed above).
      const mapped = mapCardToTask(card, entry.taskId);
      mapped.status = drift.newStatus;
      const updated = { ...mapped, blocks: freshTask.blocks || [], blockedBy: freshTask.blockedBy || [] };
      writeTask(dir, updated);
      const freshMap = readMap(dir);
      if (freshMap[pageId]) {
        // Deliberately NOT stamping pushed:true here for the Archived/
        // Cancelled terminal closure — that would be a permanent, never-
        // reset mark (ship-check catch: nothing anywhere clears `pushed`),
        // so a card a human later reopens would stay silently un-syncable
        // to Notion forever. cmdPush's own syncedStatus check below (right
        // below this comment's write of syncedStatus) re-evaluates fresh
        // every run instead — a reopened card's next pull/sync-drift updates
        // syncedStatus off Archived/Cancelled and the guard stops firing.
        freshMap[pageId].syncedStatus = card.status;
        freshMap[pageId].name = card.name;
        freshMap[pageId].fmt = MIRROR_FMT;
        // Task #1778: unlike the Archived/Cancelled case just above,
        // planPendingClosure's Paused branch DOES stamp pushed:true here —
        // deliberately scoped to only the entries THIS reconciliation just
        // closed (not a global rule like NEVER_OVERWRITE_WITH_DONE, which an
        // adversarial ship-check review — gpt-5.4-mini — flagged as unsafe:
        // an UNRELATED entry can carry syncedStatus:'Paused' from
        // planLivenessDowngrade's own non-terminal downgrade, and blocking
        // Notion pushes for every such entry would also block a later
        // GENUINE completion of that unrelated task). It's safe specifically
        // here because mergeStatus's sticky-completed rule already means
        // THIS entry's local status can never usefully change again
        // regardless of `pushed` (see planPendingClosure's own KNOWN
        // LIMITATION comment) — there is no future "reopened, resumed,
        // legitimately completed, needs pushing" story this could block,
        // only a wrongful auto-push of the card we just verified is Paused.
        if (viaPausedClosure) freshMap[pageId].pushed = true;
        writeMap(dir, freshMap);
      }
    } finally { release(); }
  }
  console.error(`[sync] reconcile: checked ${entries.length} stale-candidate task(s) (in_progress+pending) — ${fixed.length} drifted (mirror corrected)${fetchFailed.length ? `, ${fetchFailed.length} fetch failed` : ''}${dry ? ' (DRY RUN)' : ''}`);
  for (const f of fixed) console.error(`  ${dry ? '(would fix) ' : '✓ '}#${f.taskId} [${f.from} -> ${f.to}, Notion says "${f.cardStatus}"]${f.reason ? ` ${f.reason}` : ''} ${f.name}`);
  for (const e of fetchFailed) console.error(`  ⚠ fetch failed for #${e.taskId}: ${e.error.split('\n')[0]}`);
  return { fixed, unchanged: unchanged.length, unchangedDetail: unchanged, fetchFailed, dry };
}

// Thin CLI wrapper: `sync-drift` is the standalone, explicitly-invoked form
// of reconcileStaleMirrors (task #1700 will eventually schedule this). See
// that function's own comment for why cmdPull ALSO calls it directly rather
// than waiting for a session to run `sync-drift` separately.
function cmdSyncDrift(args) {
  const dir = listDir(args);
  const dry = !!args['dry-run'];
  const limit = parseInt(args.limit, 10) || DEFAULT_DRIFT_LIMIT;
  return { listId: listId(args), ...reconcileStaleMirrors(dir, { limit, dry }) };
}

function cmdStatus(args) {
  const dir = listDir(args);
  const map = readMap(dir);
  const rows = Object.entries(map).map(([pageId, e]) => {
    const task = readTask(dir, e.taskId);
    return { taskId: e.taskId, taskStatus: task ? task.status : 'MISSING', notionStatus: e.syncedStatus, pushed: !!e.pushed, name: e.name };
  });
  console.error(`[sync] list=${listId(args)} dir=${dir} — ${rows.length} mapped card(s)`);
  for (const r of rows) console.error(`  #${r.taskId} [${r.taskStatus}/${r.notionStatus}${r.pushed ? ',pushed' : ''}] ${r.name}`);
  return { listId: listId(args), rows };
}

// ── main ───────────────────────────────────────────────────────────────────
function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  let result;
  switch (cmd) {
    case 'pull': result = cmdPull(args); break;
    case 'push': result = cmdPush(args); break;
    case 'sync-drift': result = cmdSyncDrift(args); break;
    case 'status': result = cmdStatus(args); break;
    default:
      console.error('usage: notion-tasks-sync.js <pull|push|sync-drift|status> [--list-id ID] [--dry-run] [--json]');
      console.error('  [--statuses "In progress,Not started"] [--priorities "P0 Now,P1 Next"] [--limit 25]');
      console.error('  sync-drift: fix in_progress tasks whose Notion card already moved on (task #1691)');
      process.exit(2);
  }
  if (args.json) console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main();

module.exports = { MIRROR_FMT, parseArgs, mapStatus, mergeStatus, mapCardToTask, isMirrorableCard, planPull, planSelfHeal, planStatusDrift, planLivenessDowngrade, planPendingClosure, reconcileStaleMirrors, selectLeastRecentlyReconciled, NEVER_OVERWRITE_WITH_DONE, nextId, allocateFreeId, taskBelongsTo, notionMarker, writeTask, readTask, readLiveTask, readHwm, writeHwm, acquireLock, readMap, writeMap, mapPath, buildLiveMarkerIndex, resolveCreateTarget, isPushEligible };
