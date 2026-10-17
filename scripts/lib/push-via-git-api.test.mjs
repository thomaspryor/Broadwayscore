// BRO-2389: resilience of the push-via-git-api.sh fallback to "non-race"
// failures when the disqualifier verdict is already correct (an eligible,
// non-managed path). Drives the REAL script against a bare-origin fixture,
// injecting failures through a PATH shim named `timeout` (same shape as GNU
// `timeout -k 10 <secs> <cmd...>`, which is what _git_net resolves).
// Deeper per-branch coverage lives in tests/unit/push-via-git-api.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./push-via-git-api.sh', import.meta.url));
const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t',
};

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } }).toString();
}

// Origin + a runner clone holding one local commit on an ELIGIBLE path
// (not shows.json/reviews.json/data/audit, so the disqualifier lets it through).
function fixture(shimBody) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2389-'));
  const origin = path.join(tmp, 'origin.git');
  const seed = path.join(tmp, 'seed');
  const runner = path.join(tmp, 'runner');
  sh(`git init -q --bare "${origin}"`, tmp);
  sh(`git init -q "${seed}"`, tmp);
  fs.mkdirSync(path.join(seed, 'data'));
  fs.writeFileSync(path.join(seed, 'data', 'base.json'), '{"a":1}\n');
  sh('git add -A && git commit -q -m base && git branch -M main', seed);
  sh(`git push -q "${origin}" main`, seed);
  sh(`git clone -q --branch main "${origin}" "${runner}"`, tmp);
  const base = sh('git rev-parse HEAD', runner).trim();
  fs.writeFileSync(path.join(runner, 'data', 'ours.json'), '{"c":3}\n');
  sh('git add -A && git commit -q -m "our change"', runner);
  const binDir = path.join(tmp, 'shimbin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'timeout'), shimBody(tmp));
  fs.chmodSync(path.join(binDir, 'timeout'), 0o755);
  return { tmp, origin, runner, base, binDir };
}

function run(f, retries) {
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT, 'main', f.base, String(retries)], {
      cwd: f.runner,
      env: {
        ...process.env, ...GIT_ENV,
        PATH: `${f.binDir}:${process.env.PATH}`,
        PUSH_API_TIMEOUT_BACKOFF_BASE_SEC: '0',
        PUSH_API_TIMEOUT_BACKOFF_MAX_SEC: '0',
      },
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

const cleanup = (f) => fs.rmSync(f.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

test('BRO-2389: an eligible change survives a timeout then a lost race and lands, never reporting a non-race failure', async () => {
  const f = fixture((tmp) => `#!/bin/bash
shift 3
for a in "$@"; do
  if [ "$a" = "push" ]; then
    n=$(cat "${tmp}/n" 2>/dev/null || echo 0); echo $((n+1)) > "${tmp}/n"
    if [ "$n" = 0 ]; then exit 124; fi
    if [ "$n" = 1 ]; then echo "! [rejected] main -> main (fetch first)" >&2; exit 1; fi
  fi
done
exec "$@"
`);
  try {
    const res = await run(f, 5);
    assert.equal(res.code, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /non-race reason/);
    // Prove the shim really injected both failures (else this passes vacuously).
    assert.equal(fs.readFileSync(path.join(f.tmp, 'n'), 'utf8').trim(), '3');
    assert.match(res.stderr, /TIMED OUT/);
    assert.match(res.stderr, /ref moved during attempt/);
    assert.match(sh('git log --oneline main', f.origin), /our change/);
    assert.equal(sh('git show main:data/ours.json', f.origin).trim(), '{"c":3}');
  } finally { cleanup(f); }
});

test('BRO-2389: a genuine non-race failure is fatal and surfaces git\'s own reason, not a blank one', async () => {
  const f = fixture(() => `#!/bin/bash
shift 3
for a in "$@"; do
  if [ "$a" = "push" ]; then echo "remote: Permission denied (token lacks contents:write)" >&2; exit 128; fi
done
exec "$@"
`);
  try {
    const res = await run(f, 3);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /push failed for a non-race reason \(attempt 1, rc=128\):/);
    assert.match(res.stderr, /Permission denied/);
    assert.doesNotMatch(res.stderr, /exhausted/, 'a fatal error must not burn the remaining budget');
  } finally { cleanup(f); }
});
