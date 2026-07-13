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
const cmuxws = require('./lib/cmux-workspaces.js');
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

function pickTask(tasks, opts) {
  if (opts.id) return tasks.find(t => String(t.id) === String(opts.id)) || null;
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
  const launchTitle = task.subject.slice(0, 50);
  return workspaces.find(w => {
    if (isDone(w.title)) return false;      // finished — sweep will close it
    const t = String(w.title).replace(/^[^\p{L}\p{N}[]+/u, '');
    const n = Math.min(t.length, launchTitle.length);
    return n >= 20 && t.slice(0, n) === launchTitle.slice(0, n);
  }) || null;
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
    // Standing anti-stale-seed instruction (chain break #1, 2026-07-12): a
    // launched session's seed is a snapshot — directives added to the card
    // after launch (e.g. "dispatch the next sprint yourself") are invisible
    // unless the session re-reads the card before wrapping up.
    `Before wrap-up, RE-READ this card via notion-brain get — directives may have been added since launch. If the card instructs chaining, dispatch the next workspace yourself; never end by telling the user to paste a prompt.`,
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

function sleepSec(s) { spawnSync('sleep', [String(s)]); }

// Poll fn() every second until it returns truthy or timeoutSec elapses.
function pollUntil(fn, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    sleepSec(1);
  }
}

function launchCmux(task, seed, commandOverride) {
  const seedFile = path.join(os.tmpdir(), `bsc-seed-${task.id}.txt`);
  fs.writeFileSync(seedFile, seed);
  const title = task.subject.slice(0, 50);
  // The wrapper script expands $(cat …) so the multi-line prompt survives
  // without brittle inline quoting. `claude "<prompt>"` opens interactive on it.
  // --dangerously-skip-permissions: launched sessions must never permission-ping
  // (user rule 2026-07-12); explicit permissions.deny rules still outrank bypass.
  // commandOverride is a test seam (kill test, scope add 3) — never set in real use.
  const command = commandOverride || `claude --dangerously-skip-permissions "$(cat ${seedFile})"`;
  // Shell-init race (real failure 2026-07-12): new-workspace TYPES the command
  // into the pane while zsh/direnv may still be initializing, so leading
  // keystrokes get swallowed ('nclaude' → command not found) and the session
  // never starts. Shrink the typed surface to a short constant string by
  // putting the real command in a script file.
  const cmdFile = path.join(os.tmpdir(), `bsc-cmd-${task.id}.sh`);
  fs.writeFileSync(cmdFile, `#!/bin/bash\n${command}\n`);
  const typed = ` bash ${cmdFile}`; // leading space additionally survives a swallowed first key
  if (!fs.existsSync(CMUX)) return { ok: false, reason: 'cmux CLI not found', seedFile, command };

  let lastWs = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = new Set(cmuxws.listWorkspaces().map(w => w.ref));
    const r = spawnSync(CMUX, ['new-workspace', '--name', title, '--cwd', REPO, '--command', typed, '--focus', 'true'],
      { encoding: 'utf8' });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.status !== 0) {
      if (r.stderr) process.stderr.write(r.stderr);
      if (attempt === 1) { sleepSec(2); continue; }
      return { ok: false, reason: `cmux exited ${r.status}`, seedFile, command };
    }
    // Resolve the created workspace: new-workspace prints "OK workspace:N"
    // (cmux 0.64.6); fall back to a before/after list diff if that changes.
    const m = /workspace:\d+/.exec(String(r.stdout || ''));
    const ws = m ? { ref: m[0] } : pollUntil(
      () => cmuxws.listWorkspaces().find(w => !before.has(w.ref)), 5);
    lastWs = ws || lastWs;
    // VERIFY the launch (scope add 3): a workspace whose command was mangled
    // never starts claude and never self-marks ✅, so nothing would notice.
    // Poll for a running claude_code process. 30s window: shell init (direnv)
    // + claude cold start can exceed 15s post-reboot, and a false timeout
    // kills a healthy launch (ship-check reviewer finding, 2026-07-12).
    if (ws && pollUntil(() => cmuxws.claudeRunningIn(ws.ref), 30)) {
      return { ok: true, ref: ws.ref, seedFile, command };
    }
    if (attempt === 1) {
      // Verify-before-close: one last check after a beat, so a claude that
      // registered at the buzzer isn't killed as a corpse.
      sleepSec(2);
      if (ws && cmuxws.claudeRunningIn(ws.ref)) {
        return { ok: true, ref: ws.ref, seedFile, command };
      }
      if (ws) { try { cmuxws.closeWorkspace(ws.ref); } catch { /* already gone */ } }
      sleepSec(2);
    }
  }
  return {
    ok: false,
    reason: `no running claude in ${lastWs ? lastWs.ref : 'the new workspace'} after 2 attempts`,
    workspaceRef: lastWs ? lastWs.ref : null,
    seedFile, command,
  };
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
    console.log(`Top workable tasks in '${LIST_ID}' (launch with --pick N):`);
    list.slice(0, 10).forEach((t, i) => console.log(`  ${i + 1}. #${t.id} [${t.status}] ${t.subject}`));
    const excluded = actionable(tasks, true).filter(isExcludedCategory);
    if (excluded.length) {
      console.log(`\nHuman-territory (${excluded.length} marketing/partnerships — never auto-picked; use --id N deliberately):`);
      excluded.slice(0, 6).forEach(t => console.log(`     #${t.id} [${categoryOf(t)}] ${t.subject}`));
    }
    return;
  }

  const task = pickTask(tasks, args);
  if (!task) { console.error('[bsc-next] no matching actionable task.'); process.exit(1); }
  const guardErr = completedLaunchGuard(task, args);
  if (guardErr) { console.error(`[bsc-next] ${guardErr}`); process.exit(1); }

  const pid = notionIdOf(task);
  const card = pid ? fetchCard(pid) : null;
  const seed = buildSeed(task, card);

  if (args['dry-run'] || args['print-prompt']) {
    console.log(`# would launch on: #${task.id} [${task.status}] ${task.subject}\n`);
    console.log(seed);
    return;
  }

  if (args.exec) {
    // Run an interactive claude on the seed in this terminal (no Cmux).
    const r = spawnSync('claude', ['--dangerously-skip-permissions', seed], { stdio: 'inherit', cwd: REPO });
    if (r.error) { console.error(`[bsc-next] failed to launch claude: ${r.error.message}`); process.exit(1); }
    process.exit(r.status == null ? 1 : r.status); // null = killed by signal → non-zero
  }

  // Backstop auto-prune (scope add 2, task #48): sessions that die before
  // self-closing leave ✅-marked workspaces behind — sweep them at every
  // dispatch so the workspace list stays honest even without manual bsc-prune.
  if (cmuxws.cmuxAvailable()) {
    try {
      const { closed, skipped } = cmuxws.pruneDone();
      if (closed.length) {
        console.log(`[bsc-next] pruned ${closed.length} finished ✅ workspace(s): ${closed.map(w => w.ref).join(', ')}`);
      }
      if (skipped.length) {
        console.log(`[bsc-next] left ${skipped.length} ✅ workspace(s) with claude still running: ${skipped.map(w => w.ref).join(', ')}`);
      }
    } catch (e) { console.error(`[bsc-next] prune sweep failed (continuing): ${e.message}`); }

    // Duplicate-dispatch guard (post-sweep so a just-pruned ✅ twin can't block).
    if (!args.force) {
      try {
        const dup = findLiveWorkspaceForTask(task, cmuxws.listWorkspaces(), cmuxws.isDoneTitle);
        if (dup) {
          console.error(`[bsc-next] a live workspace already matches task #${task.id}: ${dup.ref}  "${dup.title}".`);
          console.error(`  Another session may be on this task. Check it (cmux read-screen --workspace ${dup.ref}),`);
          console.error(`  or re-run with --force to launch a second workspace anyway.`);
          process.exit(1);
        }
      } catch (e) { console.error(`[bsc-next] duplicate check failed (continuing): ${e.message}`); }
    }
  }

  const res = launchCmux(task, seed);
  if (res.ok) {
    console.log(`[bsc-next] opened Cmux workspace ${res.ref} on #${task.id}: ${task.subject} (claude verified running)`);
  } else {
    console.error(`[bsc-next] LAUNCH NOT VERIFIED (${res.reason}).`);
    if (res.workspaceRef) console.error(`  dead workspace: ${res.workspaceRef} (left open for inspection)`);
    console.error(`  command that should have run:`);
    console.error(`  ${res.command}`);
    console.error(`  Run it yourself in a workspace, or retry: claude "$(cat ${res.seedFile})"`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parseArgs, loadTasks, actionable, pickTask, completedLaunchGuard, findLiveWorkspaceForTask, notionIdOf, buildSeed, launchCmux, categoryOf, isExcludedCategory, EXCLUDED_CATEGORIES };
