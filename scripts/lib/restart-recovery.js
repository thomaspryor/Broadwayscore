'use strict';

/**
 * restart-recovery.js (BRO-7631): get a worker back on track after a container restart.
 *
 * A restart kills every background task (a land wait, a replay, a child-idle-watch) and the session goes
 * idle with no REPORT-BACK; nobody notices unless a parent happens to be watching (BRO-6717, BRO-6518,
 * two more on 2026-11-17). Two halves:
 *
 *   record(cmd, cwd) / clear(id)   long waits write themselves into a per-session pending-waits file that
 *                                  survives the restart (wait-for-land.js does, on start and on exit)
 *   resumeNotice(root)             .claude/hooks/session-start.sh prints this on a `resume` event: the
 *                                  waits that never finished (re-run them), worktrees with uncommitted or
 *                                  unpushed work, and the instruction to continue the brief to REPORT-BACK.
 *
 * CLI: node restart-recovery.js record --cmd "<cmd>" [--cwd dir]   -> prints the wait id
 *      node restart-recovery.js clear <id>
 *      node restart-recovery.js resume [repoRoot]                  -> prints the notice (nothing if none)
 * Kill switch: RESTART_RECOVERY_DISABLED=true. Never throws; recording failures are silent.
 */

const fs = require('fs');
const gitGuard = require('./git-proc-guard.js'); // BRO-7458: network git timeouts kill orphaned helpers
const os = require('os');
const path = require('path');

const sessionId = (env = process.env) => String(env.CLAUDE_CODE_SESSION_ID || 'nosession').replace(/[^\w-]/g, '');
const waitsFile = (env = process.env) => path.join(env.RESTART_RECOVERY_DIR || os.tmpdir(), `bsc-pending-waits-${sessionId(env)}.jsonl`);
const disabled = (env = process.env) => env.RESTART_RECOVERY_DISABLED === 'true';

function readWaits(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { return []; }
}

/** @returns {string|null} the wait id */
function record(cmd, cwd = process.cwd(), env = process.env) {
  if (disabled(env)) return null;
  try {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    fs.appendFileSync(waitsFile(env), `${JSON.stringify({ id, cmd, cwd, at: new Date().toISOString() })}\n`);
    return id;
  } catch { return null; }
}

function clear(id, env = process.env) {
  if (disabled(env) || !id) return;
  try {
    const f = waitsFile(env);
    const keep = readWaits(f).filter((w) => w.id !== id);
    fs.writeFileSync(f, keep.map((w) => JSON.stringify(w)).join('\n') + (keep.length ? '\n' : ''));
  } catch { /* best effort */ }
}

/** Pure: build the notice text from waits and worktree states. Empty string when there is nothing to say. */
function buildNotice({ waits = [], worktrees = [] }) {
  const lines = [
    'CONTAINER RESTART RECOVERY (BRO-7631): this session resumed after a restart. Every background task you had running died with it, and nobody is told when a worker goes idle.',
    '1. Check `git status` in your worktree(s) and commit and push anything uncommitted (list below).',
  ];
  if (waits.length) {
    lines.push('2. These waits never finished; re-run each one (in the background) before you go idle:');
    for (const w of waits) lines.push(`   - (cwd ${w.cwd}) ${w.cmd}   [started ${w.at}]`);
  } else lines.push('2. No recorded waits were pending. Re-arm any background watch or land wait you had started.');
  if (worktrees.length) {
    lines.push('   Worktrees with unfinished work:');
    for (const w of worktrees) lines.push(`   - ${w.path}: ${w.dirty} uncommitted file(s), ${w.ahead} unpushed commit(s)`);
  }
  lines.push('3. Re-read your original brief and continue it to the end: land, verify, then send the REPORT-BACK to your parent. Do not end your turn idle without it.');
  return lines.join('\n');
}

function worktreeStates(root) {
  const base = path.join(root, '.claude', 'worktrees');
  let names = [];
  try { names = fs.readdirSync(base); } catch { return []; }
  const out = [];
  for (const n of names) {
    const p = path.join(base, n);
    try {
      const run = (a) => gitGuard.runGitOrThrow(a, { cwd: p, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
      const dirty = run(['status', '--porcelain']).split('\n').filter(Boolean).length;
      let ahead = 0;
      try { ahead = Number(run(['rev-list', '--count', '@{upstream}..HEAD'])) || 0; } catch { ahead = Number(run(['rev-list', '--count', 'origin/main..HEAD'])) || 0; }
      if (dirty || ahead) out.push({ path: p, dirty, ahead });
    } catch { /* not a worktree */ }
  }
  return out;
}

function resumeNotice(root, env = process.env) {
  if (disabled(env)) return '';
  // A hook may run without CLAUDE_CODE_SESSION_ID while the wait was recorded with it (or the reverse): read the
  // session's own file plus the id-less one, so a mismatch still surfaces the waits.
  const files = new Set([waitsFile(env), waitsFile({ ...env, CLAUDE_CODE_SESSION_ID: '' })]);
  const waits = [...files].flatMap((f) => readWaits(f));
  return buildNotice({ waits, worktrees: worktreeStates(root) });
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'record') {
    const get = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
    const id = record(get('--cmd') || '', get('--cwd') || process.cwd());
    if (id) process.stdout.write(id);
  } else if (cmd === 'clear') clear(rest[0]);
  else if (cmd === 'resume') { const t = resumeNotice(rest[0] || process.cwd()); if (t) process.stdout.write(`${t}\n`); }
}

module.exports = { record, clear, buildNotice, resumeNotice, readWaits, waitsFile, worktreeStates };
