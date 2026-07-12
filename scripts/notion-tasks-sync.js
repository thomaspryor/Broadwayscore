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
  const shortNotes = (card.notes || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const descLines = [
    `[notion:${card.id}] ${card.priority || 'no-priority'} · ${card.status || 'no-status'}`,
    card.url || '',
    shortNotes,
  ].filter(Boolean);
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

// Decide what a pull should do given the eligible cards and the existing map.
// Returns { toCreate:[{card}], toUpdate:[{card, taskId}], unchanged:[pageId] }.
// Pure: no filesystem or network access, so it is unit-testable.
function planPull(cards, existingMap) {
  const plan = { toCreate: [], toUpdate: [], unchanged: [] };
  for (const card of cards) {
    const entry = existingMap[card.id];
    if (!entry) { plan.toCreate.push({ card }); continue; }
    if (entry.syncedStatus !== card.status) {
      plan.toUpdate.push({ card, taskId: entry.taskId });
    } else {
      plan.unchanged.push(card.id);
    }
  }
  return plan;
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

// Next id to assign. Prefer the highwatermark; fall back to (max existing id)+1
// so we never collide with tasks created by a live session.
function nextId(dir) {
  let hwm = 0;
  try { hwm = parseInt(fs.readFileSync(hwmPath(dir), 'utf8'), 10) || 0; } catch {}
  let maxFile = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = /^(\d+)\.json$/.exec(f);
      if (m) maxFile = Math.max(maxFile, parseInt(m[1], 10));
    }
  } catch {}
  return Math.max(hwm, maxFile + 1);
}
function writeTask(dir, task) {
  const tmp = path.join(dir, `${task.id}.json.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
  fs.renameSync(tmp, path.join(dir, `${task.id}.json`));
}
function writeHwm(dir, n) { fs.writeFileSync(hwmPath(dir), String(n)); }

function readTask(dir, taskId) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, `${taskId}.json`), 'utf8')); }
  catch { return null; }
}

// Best-effort cross-process lock so N Cmux panes pulling at once don't race.
// Stale locks (>2 min) are stolen. Returns a release() fn or null if held.
function acquireLock(dir) {
  const lock = path.join(dir, '.sync-lock');
  try {
    const fd = fs.openSync(lock, 'wx'); // O_EXCL: fails if it already exists
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return () => { try { fs.unlinkSync(lock); } catch {} };
  } catch {
    try {
      const age = Date.now() - fs.statSync(lock).mtimeMs;
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
  notionBrain(['update', pageId, '--status', 'Done', '--completed-date', today,
    '--force', 'auto-closed by notion-tasks-sync push (task completed)']);
}

// ── commands ───────────────────────────────────────────────────────────────
function cmdPull(args) {
  const dir = listDir(args);
  const dry = !!args['dry-run'];
  if (!dry) fs.mkdirSync(dir, { recursive: true });
  const statuses = (args.statuses || 'In progress,Not started').split(',').map(s => s.trim()).filter(Boolean);
  const priorities = (args.priorities || 'P0 Now,P1 Next').split(',').map(s => s.trim()).filter(Boolean);
  const limit = parseInt(args.limit, 10) || 25;

  const release = dry ? (() => {}) : acquireLock(dir);
  if (!release) { console.error('[sync] another pull holds the lock; skipping'); return { skipped: true }; }
  try {
    const cards = fetchCards(statuses, priorities, limit).slice(0, limit);
    const map = readMap(dir);
    const plan = planPull(cards, map);
    let id = nextId(dir);
    const created = [], updated = [];

    for (const { card } of plan.toCreate) {
      const task = mapCardToTask(card, id);
      if (!dry) writeTask(dir, task);
      map[card.id] = { taskId: task.id, name: card.name, syncedStatus: card.status, url: card.url, pushed: false };
      created.push({ taskId: task.id, name: card.name });
      id++;
    }
    for (const { card, taskId } of plan.toUpdate) {
      const existing = readTask(dir, taskId) || {};
      const task = { ...mapCardToTask(card, taskId), blocks: existing.blocks || [], blockedBy: existing.blockedBy || [] };
      if (!dry) writeTask(dir, task);
      map[card.id].syncedStatus = card.status;
      map[card.id].name = card.name;
      updated.push({ taskId, name: card.name });
    }
    if (!dry) { writeMap(dir, map); writeHwm(dir, id); }

    const summary = { listId: listId(args), dir, created, updated, unchanged: plan.unchanged.length, dry };
    console.error(`[sync] pull: ${created.length} created, ${updated.length} updated, ${plan.unchanged.length} unchanged (list=${listId(args)}${dry ? ', DRY RUN' : ''})`);
    for (const c of created) console.error(`  + #${c.taskId} ${c.name}`);
    for (const u of updated) console.error(`  ~ #${u.taskId} ${u.name}`);
    return summary;
  } finally { release(); }
}

function cmdPush(args) {
  const dir = listDir(args);
  const dry = !!args['dry-run'];
  const map = readMap(dir);
  const done = [];
  for (const [pageId, entry] of Object.entries(map)) {
    if (entry.pushed) continue;
    const task = readTask(dir, entry.taskId);
    if (task && task.status === 'completed') {
      if (!dry) { markCardDone(pageId); entry.pushed = true; }
      done.push({ taskId: entry.taskId, name: entry.name, pageId });
    }
  }
  if (!dry && done.length) writeMap(dir, map);
  console.error(`[sync] push: ${done.length} card(s) marked Done${dry ? ' (DRY RUN)' : ''}`);
  for (const d of done) console.error(`  ✓ ${d.name}`);
  return { listId: listId(args), done, dry };
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

module.exports = { parseArgs, mapStatus, mapCardToTask, planPull, nextId };
