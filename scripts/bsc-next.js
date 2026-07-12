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
const CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux';
const LIST_ID = process.env.CLAUDE_CODE_TASK_LIST_ID || 'broadwayscore';
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', LIST_ID);

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
// ("[notion:<id>] P0 Now · In progress"). Rank it so "top" means highest
// priority, not just lowest task id. Unknown/absent → lowest.
function priorityRank(task) {
  const m = /\]\s*(P\d)\b/.exec(task.description || '');
  return m ? parseInt(m[1].slice(1), 10) : 9;
}

// Actionable list, best-first: by Notion priority, then pending before
// in_progress (fresh work first), then task id. Completed dropped.
function actionable(tasks) {
  return tasks
    .filter(t => t.status === 'pending' || t.status === 'in_progress')
    .map((t, i) => ({ t, i }))
    .sort((a, b) =>
      priorityRank(a.t) - priorityRank(b.t) ||
      (a.t.status === 'pending' ? 0 : 1) - (b.t.status === 'pending' ? 0 : 1) ||
      parseInt(a.t.id, 10) - parseInt(b.t.id, 10))
    .map(x => x.t);
}

function pickTask(tasks, opts) {
  if (opts.id) return tasks.find(t => String(t.id) === String(opts.id)) || null;
  const list = actionable(tasks);
  const idx = opts.pick ? parseInt(opts.pick, 10) - 1 : 0;
  return list[idx] || null;
}

function notionIdOf(task) {
  const m = /\[notion:([a-f0-9-]+)\]/i.exec(task.description || '');
  return m ? m[1] : null;
}

function buildSeed(task, card) {
  const url = (card && card.url) || ((task.description || '').match(/https?:\/\/\S+/) || [''])[0];
  const notes = (card && card.notes) || task.description || '(no description)';
  const meta = [
    card && card.priority ? `Priority: ${card.priority}` : null,
    card && card.keyFiles ? `Key files: ${card.keyFiles}` : null,
  ].filter(Boolean).join(' · ');
  return [
    `Work on this card as this session's focus. First claim its task in the shared task list (mark task #${task.id} in_progress via TaskUpdate), then implement it per CLAUDE.md rules — worktree before any code edit, /ship-check before you claim it's done.`,
    ``,
    `CARD: ${task.subject}`,
    url ? `Notion: ${url}` : null,
    meta || null,
    ``,
    notes,
    ``,
    `Start by confirming your understanding and a short plan, then proceed.`,
  ].filter(v => v !== null).join('\n');
}

// ── side-effecting helpers ─────────────────────────────────────────────────
function fetchCard(pageId) {
  try {
    const raw = execFileSync('node', [path.join(REPO, 'scripts', 'notion-brain.js'), 'get', pageId],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(raw);
  } catch { return null; }
}

function launchCmux(task, seed) {
  const seedFile = path.join(os.tmpdir(), `bsc-seed-${task.id}.txt`);
  fs.writeFileSync(seedFile, seed);
  const title = task.subject.slice(0, 50);
  // The workspace shell expands $(cat …) so the multi-line prompt survives
  // without brittle inline quoting. `claude "<prompt>"` opens interactive on it.
  const command = `claude "$(cat ${seedFile})"`;
  if (!fs.existsSync(CMUX)) return { ok: false, reason: 'cmux CLI not found', seedFile, command };
  const r = spawnSync(CMUX, ['new-workspace', '--name', title, '--cwd', REPO, '--command', command, '--focus', 'true'],
    { stdio: 'inherit' });
  return { ok: r.status === 0, reason: r.status === 0 ? null : `cmux exited ${r.status}`, seedFile, command };
}

// ── main ───────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));
  const tasks = loadTasks(TASKS_DIR);
  if (!tasks.length) {
    console.error(`[bsc-next] shared task list '${LIST_ID}' is empty (${TASKS_DIR}).`);
    console.error(`Run 'node scripts/notion-tasks-sync.js pull' to mirror your Notion backlog first.`);
    process.exit(1);
  }

  if (args.list) {
    const list = actionable(tasks);
    console.log(`Top actionable tasks in '${LIST_ID}' (launch with --pick N):`);
    list.slice(0, 10).forEach((t, i) => console.log(`  ${i + 1}. #${t.id} [${t.status}] ${t.subject}`));
    return;
  }

  const task = pickTask(tasks, args);
  if (!task) { console.error('[bsc-next] no matching actionable task.'); process.exit(1); }

  const pid = notionIdOf(task);
  const card = pid ? fetchCard(pid) : null;
  const seed = buildSeed(task, card);

  if (args['dry-run'] || args['print-prompt']) {
    console.log(`# would launch on: #${task.id} [${task.status}] ${task.subject}\n`);
    console.log(seed);
    return;
  }

  if (args.exec) {
    // Replace this process with an interactive claude on the seed (no Cmux).
    const { spawnSync: sp } = require('child_process');
    const r = sp('claude', [seed], { stdio: 'inherit', cwd: REPO });
    process.exit(r.status || 0);
  }

  const res = launchCmux(task, seed);
  if (res.ok) {
    console.log(`[bsc-next] opened Cmux workspace on #${task.id}: ${task.subject}`);
  } else {
    console.error(`[bsc-next] could not open Cmux workspace (${res.reason}). Run this yourself:`);
    console.error(`  claude "$(cat ${res.seedFile})"`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parseArgs, loadTasks, actionable, pickTask, notionIdOf, buildSeed };
