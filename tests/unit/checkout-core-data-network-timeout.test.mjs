// BRO-3074: checkout-core-data's clone ran a bare `git clone`, so a transport
// hang blocked until the job timeout. It now runs through git_net. These tests
// run the REAL "Clone core data repo" step under GitHub's bash flags against a
// fake `git` and a `sleep` shim, and pin that no bare clone is left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACTION = path.join(ROOT, '.github', 'actions', 'checkout-core-data', 'action.yml');

const hasTimeout = (() => {
  try { execSync('command -v timeout || command -v gtimeout', { stdio: 'ignore', shell: '/bin/bash' }); return true; } catch { return false; }
})();

function stepScript(yml, stepName) {
  const lines = yml.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.ok(at >= 0, `step "${stepName}" not found`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
  const body = [];
  let indent = null;
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    const ind = l.match(/^ */)[0].length;
    if (indent === null) indent = ind;
    if (ind < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

const yml = fs.readFileSync(ACTION, 'utf8');

test('clone step sources the helper and has no bare git clone', () => {
  const script = stepScript(yml, 'Clone core data repo');
  assert.match(script, /\. "\$\{GITHUB_WORKSPACE\}\/scripts\/lib\/git-net-timeout\.sh"/);
  assert.match(script, /git_net "\$NET_SEC" clone /);
  const bare = script.split('\n').filter((l) => /(^|[\s;&|(])git clone\b/.test(l) && !l.trim().startsWith('#'));
  assert.deepEqual(bare, []);
});

// fakeGit: body of the fake `git` (attempt counter in $COUNT_FILE).
function runStep(fakeGit, timeoutSec = '1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-clone-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/bash\nn=$(cat "${dir}/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/count"\n${fakeGit}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    const checkout = path.join(dir, 'checkout');
    const script = stepScript(yml, 'Clone core data repo').split('/tmp/core-data-checkout').join(checkout);
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      cwd: ROOT,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_WORKSPACE: ROOT, CORE_DATA_TOKEN: 'x', CHECKOUT_CORE_DATA_NET_TIMEOUT_SEC: timeoutSec },
      encoding: 'utf8',
      timeout: 60000,
    });
    const attempts = Number(fs.existsSync(path.join(dir, 'count')) ? fs.readFileSync(path.join(dir, 'count'), 'utf8') : 0);
    return { ...r, attempts };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

test('a hung clone is killed and retried 3 times, then the step fails', { skip: !hasTimeout && 'no timeout binary' }, () => {
  const r = runStep('exec /bin/sleep 30');
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.attempts, 3);
  assert.match(r.stdout, /Core data clone hung, killed after 1s \(attempt 1\/3/);
  assert.match(r.stdout, /hung on all 3 attempts/);
});

test('hang on attempt 1 then success on attempt 2 passes', { skip: !hasTimeout && 'no timeout binary' }, () => {
  const r = runStep('if [ "$n" -eq 1 ]; then exec /bin/sleep 30; fi; mkdir -p "${@: -1}"; exit 0');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.attempts, 2);
  assert.match(r.stdout, /Core data cloned fresh/);
});

test('a clone that ignores SIGTERM is SIGKILLed (rc 137) and retried like a hang', { skip: !hasTimeout && 'no timeout binary' }, () => {
  // Ignored signals survive exec, so the sleep ignores timeout's TERM and
  // only the -k 10 KILL ends it (~11s).
  const r = runStep('if [ "$n" -eq 1 ]; then trap "" TERM; exec /bin/sleep 30; fi; mkdir -p "${@: -1}"; exit 0');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.attempts, 2);
  assert.match(r.stdout, /killed after 1s \(attempt 1\/3, rc=137\)/);
});
