// BRO-7370: the documented cloud setup script must never fail a session's start.
// The runner executes it under errexit; a trial session on a branch that had moved
// apart from main died at `merge --ff-only` (exit 128) before Claude started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function documentedSetupScript(md) {
  const m = /## Owner one-time setup[^\n]*\n[\s\S]*?```\n([\s\S]*?)```/.exec(md);
  if (!m) throw new Error('no setup script block under "## Owner one-time setup" in .claude/CLOUD.md');
  return m[1];
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// home/Broadwayscore is a clone whose checked-out branch is `behind` or `diverged` from origin/main;
// home/app has an install-home-claude-config.js that fails.
function fixture(kind) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-setup-'));
  const home = path.join(tmp, 'home');
  const bare = path.join(tmp, 'origin.git');
  fs.mkdirSync(home);
  git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = path.join(tmp, 'seed');
  git(tmp, 'clone', '-q', bare, seed);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't']]) git(seed, 'config', k, v);
  fs.writeFileSync(path.join(seed, 'a'), '1\n'); git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'one'); git(seed, 'push', '-q', 'origin', 'main');
  const repo = path.join(home, 'Broadwayscore');
  git(tmp, 'clone', '-q', bare, repo);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't']]) git(repo, 'config', k, v);
  fs.writeFileSync(path.join(seed, 'a'), '2\n'); git(seed, 'commit', '-qam', 'main moves'); git(seed, 'push', '-q', 'origin', 'main');
  if (kind === 'diverged') { fs.writeFileSync(path.join(repo, 'b'), 'x\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'trial branch work'); }
  fs.mkdirSync(path.join(home, 'app', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(home, 'app', 'scripts', 'install-home-claude-config.js'), `require('fs').writeFileSync(${JSON.stringify(path.join(tmp, 'installer-ran'))}, '1'); process.exit(1);\n`);
  return { tmp, home, repo };
}

function run(script, home) {
  const s = script.replaceAll('/home/user/', `${home}/`);
  return spawnSync('bash', ['-e', '-c', s], { encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: home } });
}

test('documented setup script survives a branch that diverged from main and a failing installer', () => {
  const script = documentedSetupScript(fs.readFileSync(path.join(ROOT, '.claude', 'CLOUD.md'), 'utf8'));
  for (const kind of ['diverged', 'behind']) {
    const f = fixture(kind);
    try {
      const before = git(f.repo, 'rev-parse', 'HEAD');
      const r = run(script, f.home);
      assert.equal(r.status, 0, `${kind}: setup exited ${r.status}\n${r.stderr}`);
      assert.ok(fs.existsSync(path.join(f.tmp, 'installer-ran')), 'the installer loop still runs');
      const after = git(f.repo, 'rev-parse', 'HEAD');
      if (kind === 'behind') assert.equal(after, git(f.repo, 'rev-parse', 'origin/main'), 'a branch that is only behind still fast-forwards');
      else assert.equal(after, before, 'a diverged branch is left as it is');
    } finally { fs.rmSync(f.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  }
});
