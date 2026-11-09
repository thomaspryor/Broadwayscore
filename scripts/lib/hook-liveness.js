#!/usr/bin/env node
// BRO-7180: regression alarm for "repo hooks silently stop firing in cloud sessions" (BRO-7177).
// Feeds .claude/hooks/lib/home-hook-runner.sh a synthetic PreToolUse event (cwd = a worktree of
// this repo, CLAUDE_PROJECT_DIR = the real session dir) and checks it reaches its final exec
// (the runner answers the sentinel command with PROBE_MARKER instead of running the hook).
// Not ground truth: a skip is accepted when the session's project settings wire the hook, the
// same rule the runner applies, so this catches runner drift and early exits, not a wrong rule.
// Usage: node hook-liveness.js --runner <path>. Always exits 0 (fail open); warning on stdout.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROBE_COMMAND = '__hook_runner_probe__';
const PROBE_MARKER = 'HOOK-RUNNER-PROBE-EXEC';
const PROBE_HOOK = 'pre-push-land-preflight.sh'; // a REPO_SCOPED Bash PreToolUse hook: the shape BRO-7177 broke

const git = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).stdout?.trim() || '';

function probe({ runner, repo: repoArg, projectDir = process.env.CLAUDE_PROJECT_DIR || '', timeoutMs = 20000 }) {
  const repo = repoArg || path.resolve(path.dirname(runner), '..', '..', '..');
  const main = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!main) return { alive: true, via: 'unresolvable repo (fail open)' };
  const wts = git(repo, ['worktree', 'list', '--porcelain']).split('\n')
    .filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
  const cwd = wts.find((w) => w !== path.dirname(main) && fs.existsSync(w)) || repo;
  const r = spawnSync('bash', [runner, PROBE_HOOK], {
    cwd, encoding: 'utf8', timeout: timeoutMs,
    input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command: PROBE_COMMAND } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, HOOK_RUNNER_PROBE: '1' },
  });
  if ((r.stdout || '').includes(PROBE_MARKER)) return { alive: true };
  const sessionDir = projectDir || cwd; // the runner's rule: P=${CLAUDE_PROJECT_DIR:-$cwd}
  const top = git(sessionDir, ['rev-parse', '--show-toplevel']);
  const sameRepo = top && git(sessionDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']) === main;
  let wired = false;
  if (sameRepo) {
    try { wired = fs.readFileSync(path.join(top, '.claude', 'settings.json'), 'utf8').includes(`.claude/hooks/${PROBE_HOOK}`); } catch { /* unreadable: not wired */ }
  }
  if (wired) return { alive: true, via: 'project settings' };
  return { alive: false, cwd, projectDir, status: r.status, signal: r.signal };
}

function main() {
  const i = process.argv.indexOf('--runner');
  if (i < 0 || !process.argv[i + 1]) return;
  const ri = process.argv.indexOf('--repo');
  const repoArg = ri > 0 ? path.resolve(process.argv[ri + 1]) : undefined;
  let res;
  try { res = probe({ runner: path.resolve(process.argv[i + 1]), repo: repoArg }); } catch (e) { return; }
  if (res.alive) return;
  console.log(`⚠️ BRO-7180: repo hooks are NOT firing in this session. A synthetic PreToolUse event (cwd ${res.cwd}, CLAUDE_PROJECT_DIR ${res.projectDir || 'unset'}) never reached the hook runner's exec, so the land preflight, worktree and push gates may be silently off. Check .claude/hooks/lib/home-hook-runner.sh and ${'/home/user/.claude/settings.json'} (node scripts/install-home-claude-config.js --check).`);
  try {
    const repo = repoArg || path.resolve(path.dirname(process.argv[i + 1]), '..', '..', '..');
    fs.appendFileSync(path.join(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).replace(/\/\.git$/, ''), '.claude', 'hook-liveness.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...res }) + '\n');
  } catch { /* ledger is best effort */ }
}

if (require.main === module) main();
module.exports = { probe, PROBE_COMMAND, PROBE_MARKER, PROBE_HOOK };
