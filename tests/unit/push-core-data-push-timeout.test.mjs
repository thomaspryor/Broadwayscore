// BRO-4966: push-core-data's 5-attempt loop ran a bare `git push origin main`
// (and a bare fetch + `git pull --rebase`), so a transport hang blocked until
// the job timeout instead of counting as a failed attempt. The step now
// sources scripts/lib/git-net-timeout.sh and wraps every network op in
// git_net. These tests run the real helper against a fake `git`, and pin that
// no unbounded network op is left inside the loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HELPER = path.join(ROOT, 'scripts', 'lib', 'git-net-timeout.sh');
const ACTION = path.join(ROOT, '.github', 'actions', 'push-core-data', 'action.yml');

const hasTimeout = (() => {
  try { execSync('command -v timeout || command -v gtimeout', { stdio: 'ignore', shell: '/bin/bash' }); return true; } catch { return false; }
})();

function withFakeGit(body, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-net-timeout-'));
  try {
    fs.writeFileSync(path.join(dir, 'git'), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

function runHelper(fakeGitDir, script) {
  return spawnSync('bash', ['-c', `. "${HELPER}"; ${script}`], {
    env: { ...process.env, PATH: `${fakeGitDir}:${process.env.PATH}` },
    encoding: 'utf8',
    timeout: 30000,
  });
}

test('git_net kills a hung git op and returns 124 well before the hang ends', { skip: !hasTimeout && 'no timeout binary' }, () => {
  withFakeGit('exec sleep 30', (dir) => {
    const t0 = Date.now();
    const r = runHelper(dir, 'git_net 1 push origin main; echo "rc=$?"');
    assert.match(r.stdout, /rc=124/);
    assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0}ms`);
  });
});

test('git_net passes args, lowSpeed flags and the exit code through', () => {
  withFakeGit('echo "args:$*"; exit 3', (dir) => {
    const r = runHelper(dir, 'git_net 5 push origin main; echo "rc=$?"');
    assert.match(r.stdout, /args:-c http\.lowSpeedLimit=1000 -c http\.lowSpeedTime=45 push origin main/);
    assert.match(r.stdout, /rc=3/);
  });
});

test('push-core-data sources the helper and bounds every network op in the retry loop', () => {
  const yml = fs.readFileSync(ACTION, 'utf8');
  assert.match(yml, /\. "\$\{GITHUB_WORKSPACE\}\/scripts\/lib\/git-net-timeout\.sh"/);
  const start = yml.indexOf('for i in 1 2 3 4 5; do');
  assert.ok(start > 0, 'retry loop marker not found');
  const end = yml.indexOf('\n        done\n', start);
  assert.ok(end > start, 'retry loop end not found');
  const code = yml.slice(start, end).split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /\bgit\s+(push|fetch|pull|clone|ls-remote)\b/, 'unbounded git network op left in the loop');
  assert.match(code, /git_net "\$NET_SEC" push origin main/);
  assert.match(code, /git_net "\$NET_SEC" fetch origin main/);
  assert.match(code, /git rebase -X ours FETCH_HEAD/);
});
