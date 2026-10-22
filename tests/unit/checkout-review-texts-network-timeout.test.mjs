// BRO-5338: checkout-review-texts and checkout-aggregator-archive ran a bare
// `git clone`, so a transport hang blocked until the job timeout (BRO-3074 only
// fixed checkout-core-data). Both now run through git_net. These tests run the
// REAL clone steps under GitHub's bash flags against a fake `git` and a `sleep`
// shim, and pin that no bare clone is left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACTIONS = path.join(ROOT, '.github', 'actions');

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

const CASES = [
  {
    label: 'review-texts',
    file: 'checkout-review-texts',
    step: 'Clone review-texts repo',
    tokenEnv: 'REVIEW_TEXTS_TOKEN',
    timeoutEnv: 'CHECKOUT_REVIEW_TEXTS_NET_TIMEOUT_SEC',
    hungMsg: /review-texts clone hung, killed after 1s \(attempt 1\/3/,
    hungAll: /hung on all 3 attempts/,
    okMsg: /review-texts cloned in/,
    // The step's tail (sha record, validation baseline) needs a real repo; the
    // clone loop and the sparse-checkout call end before this marker.
    cut: '# Stale-checkout race guard',
    // The fake clone has to create data/review-texts/.git for the post-loop check.
    mkdir: (dir) => path.join(dir, 'cwd', 'data', 'review-texts', '.git'),
    cwd: (dir) => path.join(dir, 'cwd'),
    rewrite: (s) => s,
  },
  {
    label: 'aggregator-archive',
    file: 'checkout-aggregator-archive',
    step: 'Clone aggregator-archive repo',
    tokenEnv: 'REPO_TOKEN',
    timeoutEnv: 'CHECKOUT_AGGREGATOR_ARCHIVE_NET_TIMEOUT_SEC',
    hungMsg: /Aggregator archive clone hung, killed after 1s \(attempt 1\/3/,
    hungAll: /hung on all 3 attempts/,
    okMsg: /Aggregator archive cloned fresh/,
    cut: null,
    mkdir: (dir) => path.join(dir, 'checkout'),
    cwd: () => ROOT,
    rewrite: (s, dir) => s.split('/tmp/aggregator-archive-checkout').join(path.join(dir, 'checkout')),
  },
];

for (const c of CASES) {
  const yml = fs.readFileSync(path.join(ACTIONS, c.file, 'action.yml'), 'utf8');
  const stepName = (() => {
    // Tolerate a renamed step: pick the step whose run block holds the clone.
    const names = [...yml.matchAll(/^\s+- name: (.+)$/gm)].map((m) => m[1].trim());
    return names.find((n) => { try { return /git clone|clone /.test(stepScript(yml, n)); } catch { return false; } });
  })();

  function runStep(fakeGit, timeoutSec = '1', env = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rt-'));
    try {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      fs.mkdirSync(path.join(dir, 'cwd'));
      fs.writeFileSync(path.join(bin, 'git'), `#!/bin/bash\nn=$(cat "${dir}/count" 2>/dev/null || echo 0); case " $* " in *" clone "*) IS_CLONE=1; n=$((n+1)); echo $n > "${dir}/count";; esac\nMK="${c.mkdir(dir)}"\n${fakeGit}\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
      let script = c.rewrite(stepScript(yml, stepName), dir);
      if (c.cut) script = script.slice(0, script.indexOf(c.cut));
      const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
        cwd: c.cwd(dir),
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_WORKSPACE: ROOT, [c.tokenEnv]: 'x', [c.timeoutEnv]: timeoutSec, FETCH_DEPTH: '1', SPARSE_PATHS: '', ...env },
        encoding: 'utf8',
        timeout: 60000,
      });
      const attempts = Number(fs.existsSync(path.join(dir, 'count')) ? fs.readFileSync(path.join(dir, 'count'), 'utf8') : 0);
      return { ...r, attempts };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  test(`${c.label}: clone step sources the helper and has no bare git clone`, () => {
    assert.ok(stepName, 'clone step not found');
    const script = stepScript(yml, stepName);
    assert.match(script, /\. "\$\{GITHUB_WORKSPACE\}\/scripts\/lib\/git-net-timeout\.sh"/);
    assert.match(script, /git_net "\$NET_SEC" clone /);
    const bare = script.split('\n').filter((l) => /(^|[\s;&|(])git (-C \S+ )?(clone|sparse-checkout)\b/.test(l) && !l.trim().startsWith('#'));
    assert.deepEqual(bare, []);
  });

  test(`${c.label}: a hung clone is killed and retried 3 times, then the step fails`, { skip: !hasTimeout && 'no timeout binary' }, () => {
    const r = runStep('exec /bin/sleep 30');
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.attempts, 3);
    assert.match(r.stdout, c.hungMsg);
    assert.match(r.stdout, c.hungAll);
  });

  test(`${c.label}: hang on attempt 1 then success on attempt 2 passes`, { skip: !hasTimeout && 'no timeout binary' }, () => {
    const r = runStep('if [ -n "$IS_CLONE" ] && [ "$n" -eq 1 ]; then exec /bin/sleep 30; fi; mkdir -p "$MK"; exit 0');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.attempts, 2);
    assert.match(r.stdout, c.okMsg);
  });

  test(`${c.label}: a clone that ignores SIGTERM is SIGKILLed (rc 137) and retried like a hang`, { skip: !hasTimeout && 'no timeout binary' }, () => {
    const r = runStep('if [ -n "$IS_CLONE" ] && [ "$n" -eq 1 ]; then trap "" TERM; exec /bin/sleep 30; fi; mkdir -p "$MK"; exit 0');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.attempts, 2);
    assert.match(r.stdout, /killed after 1s \(attempt 1\/3, rc=137\)/);
  });

  test(`${c.label}: a plain clone failure still takes the generic retry path`, { skip: !hasTimeout && 'no timeout binary' }, () => {
    const r = runStep('echo "fatal: repository not found" >&2; exit 128');
    assert.equal(r.status, 1);
    assert.equal(r.attempts, 3);
    assert.doesNotMatch(r.stdout, /hung/);
  });
}

test('review-texts: a hung sparse-checkout is bounded too', { skip: !hasTimeout && 'no timeout binary' }, () => {
  const c = CASES[0];
  const yml = fs.readFileSync(path.join(ACTIONS, c.file, 'action.yml'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rt-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(dir, 'cwd'));
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/bash\ncase " $* " in *" clone "*) mkdir -p "${dir}/cwd/data/review-texts/.git"; exit 0;; esac\nexec /bin/sleep 30\n`, { mode: 0o755 });
    let script = stepScript(yml, 'Clone review-texts repo');
    script = script.slice(0, script.indexOf(c.cut));
    const t0 = Date.now();
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      cwd: path.join(dir, 'cwd'),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_WORKSPACE: ROOT, REVIEW_TEXTS_TOKEN: 'x', CHECKOUT_REVIEW_TEXTS_NET_TIMEOUT_SEC: '1', FETCH_DEPTH: '1', SPARSE_PATHS: 'hamilton' },
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.notEqual(r.status, 0);
    assert.ok(Date.now() - t0 < 30000, 'sparse-checkout hang was not cut off');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
