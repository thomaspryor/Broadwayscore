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
const { BSC_DAILY_TITLE_RE } = require('./lib/task-store-archive.js');

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
function isMirrorableCard(card) {
  return !BSC_DAILY_TITLE_RE.test((card && card.name) || '');
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
    // A card whose mapped file was clobbered/reused by a live session is
    // re-created under a fresh free id, so we never rewrite a stranger's task.
    // priorTask (optional): a task whose blocks/blockedBy should carry
    // forward into the fresh id instead of doCreate's blank defaults — used
    // by the self-heal loop below when the prior copy is confirmed to
    // belong to this same card (see its own comment for why that check
    // matters).
    const doCreate = (card, priorTask) => {
      id = dry ? id : allocateFreeId(dir, id);
      const task = mapCardToTask(card, id);
      if (priorTask) { task.blocks = priorTask.blocks || []; task.blockedBy = priorTask.blockedBy || []; }
      if (!dry) writeTask(dir, task);
      map[card.id] = { taskId: task.id, name: card.name, syncedStatus: card.status, url: card.url, pushed: false, fmt: MIRROR_FMT };
      created.push({ taskId: task.id, name: card.name });
      id++;
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

    const summary = { listId: listId(args), dir, created, updated, unchanged: stillUnchanged.length, dry };
    console.error(`[sync] pull: ${created.length} created, ${updated.length} updated, ${stillUnchanged.length} unchanged (list=${listId(args)}${dry ? ', DRY RUN' : ''})`);
    for (const c of created) console.error(`  + #${c.taskId} ${c.name}`);
    for (const u of updated) console.error(`  ~ #${u.taskId} ${u.name}`);
    return summary;
  } finally { release(); }
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
    const done = [], skipped = [], refused = [];
    for (const [pageId, entry] of Object.entries(map)) {
      if (entry.pushed) continue;
      const task = readTask(dir, entry.taskId);
      if (!task || task.status !== 'completed') continue;
      // The integer id may have been reused by a live session for unrelated
      // work. Only close the card if this file still carries our marker.
      if (!taskBelongsTo(dir, entry.taskId, pageId)) { skipped.push({ taskId: entry.taskId, name: entry.name }); continue; }
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
      }
      done.push({ taskId: entry.taskId, name: entry.name, pageId });
    }
    if (!dry && done.length) writeMap(dir, map);
    console.error(`[sync] push: ${done.length} card(s) marked Done${skipped.length ? `, ${skipped.length} skipped (id reused)` : ''}${refused.length ? `, ${refused.length} refused by close-time verify — their own acceptance command fails on origin/main (still open, will retry)` : ''}${dry ? ' (DRY RUN)' : ''}`);
    for (const d of done) console.error(`  ✓ ${d.name}`);
    for (const s of skipped) console.error(`  ⚠ skipped #${s.taskId} (task id no longer maps to this card): ${s.name}`);
    for (const r of refused) console.error(`  ⛔ still open (own file failing on main): ${r.name}`);
    return { listId: listId(args), done, skipped, refused, dry };
  } finally { release(); }
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
    case 'status': result = cmdStatus(args); break;
    default:
      console.error('usage: notion-tasks-sync.js <pull|push|status> [--list-id ID] [--dry-run] [--json]');
      console.error('  [--statuses "In progress,Not started"] [--priorities "P0 Now,P1 Next"] [--limit 25]');
      process.exit(2);
  }
  if (args.json) console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main();

module.exports = { MIRROR_FMT, parseArgs, mapStatus, mergeStatus, mapCardToTask, isMirrorableCard, planPull, planSelfHeal, nextId, allocateFreeId, taskBelongsTo, notionMarker, writeTask, readTask, readLiveTask, readHwm, writeHwm, acquireLock, readMap, mapPath };
