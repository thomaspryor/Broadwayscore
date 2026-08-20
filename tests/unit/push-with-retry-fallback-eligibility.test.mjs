// Regression coverage for task #1847: the Git Data API fallback
// (scripts/lib/push-via-git-api.sh) flipped from opt-in (PUSH_VIA_API_FALLBACK=1
// required) to opt-out (eligible by default unless PUSH_API_FALLBACK_DISABLE=1).
// These tests exercise the ELIGIBILITY decision itself — not the fallback's
// own push mechanics (see push-via-git-api.test.mjs) or the HEAD_TRUSTED_CLEAN
// interaction (see push-with-retry-abort-preserves-head.test.mjs's task #1793
// case) — by forcing every push to fail (no real remote contention needed) and
// reading push-with-retry.sh's own log lines to see whether it attempted the
// fallback or explicitly skipped it, and why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(fileURLToPath(new URL('../../scripts/lib/push-with-retry.sh', import.meta.url)));

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t',
  GITHUB_ACTIONS: '',
};

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } }).toString();
}

// A `git` wrapper that fails every `push` call outright (no real transport
// attempted) and otherwise proxies to real git. No injected concurrent
// commit — these tests only care about whether the fallback is ATTEMPTED,
// not the HEAD_TRUSTED_CLEAN interaction (covered elsewhere).
function makeAlwaysFailPushGitDir(tmp) {
  const dir = path.join(tmp, 'fake-git-alwaysfail-bin');
  fs.mkdirSync(dir);
  const realGit = execSync('command -v git').toString().trim();
  fs.writeFileSync(path.join(dir, 'git'), `#!/usr/bin/env bash
sub=""
args=("$@")
i=0
while [ $i -lt \${#args[@]} ]; do
  a="\${args[$i]}"
  case "$a" in
    -c|-C) i=$((i+2)); continue;;
    -*) i=$((i+1)); continue;;
    *) sub="$a"; break;;
  esac
done
[ "$sub" = "push" ] && exit 1
exec "${realGit}" "$@"
`);
  fs.chmodSync(path.join(dir, 'git'), 0o755);
  return dir;
}

function setupRunner(tmp, seedFile) {
  const originDir = path.join(tmp, 'origin.git');
  const seedDir = path.join(tmp, 'seed');
  const runnerDir = path.join(tmp, 'runner');
  sh(`git init -q --bare "${originDir}"`, tmp);
  sh(`git init -q "${seedDir}"`, tmp);
  sh('git config user.email t@t.t', seedDir);
  sh('git config user.name t', seedDir);
  if (seedFile) {
    const [rel, content] = seedFile;
    const full = path.join(seedDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    sh('git add -A', seedDir);
  }
  sh('git commit -q --allow-empty -m base', seedDir);
  sh('git branch -M main', seedDir);
  sh(`git push -q "${originDir}" main`, seedDir);

  fs.mkdirSync(runnerDir);
  sh('git init -q', runnerDir);
  sh('git config user.email t@t.t', runnerDir);
  sh('git config user.name t', runnerDir);
  sh(`git remote add origin "${originDir}"`, runnerDir);
  sh('git fetch -q origin main', runnerDir);
  sh('git checkout -q -B main origin/main', runnerDir);
  return { originDir, runnerDir };
}

function runFixture(runnerDir, fakeGitDir, extraEnv, tmp) {
  let stdout = '';
  let code = 0;
  try {
    stdout = execSync(`bash "${SCRIPT}" 1 main`, {
      cwd: runnerDir,
      stdio: 'pipe',
      env: {
        ...process.env, ...GIT_ENV,
        PATH: `${fakeGitDir}:${process.env.PATH}`,
        PUSH_FAILURE_LOG: path.join(tmp, 'failures.jsonl'),
        ...extraEnv,
      },
    }).toString();
  } catch (err) {
    code = err.status ?? 1;
    stdout = `${err.stdout || ''}${err.stderr || ''}`;
  }
  return { code, stdout };
}

test('task #1847: fallback is attempted by default with no PUSH_VIA_API_FALLBACK/PUSH_API_FALLBACK_DISABLE env vars set', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-retry-elig-default-'));
  try {
    const { runnerDir } = setupRunner(tmp);
    fs.writeFileSync(path.join(runnerDir, 'plain.js'), 'const x = 1;\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "plain commit"', runnerDir);

    const fakeGitDir = makeAlwaysFailPushGitDir(tmp);
    const { stdout } = runFixture(runnerDir, fakeGitDir, {}, tmp);

    assert.match(stdout, /trying the Git Data API fallback/,
      `expected the fallback to be attempted by default (no opt-in env var set). Output:\n${stdout}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('task #1847: PUSH_API_FALLBACK_DISABLE=1 still disables the fallback under the new default', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-retry-elig-disable-'));
  try {
    const { runnerDir } = setupRunner(tmp);
    fs.writeFileSync(path.join(runnerDir, 'plain.js'), 'const x = 1;\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "plain commit"', runnerDir);

    const fakeGitDir = makeAlwaysFailPushGitDir(tmp);
    const { stdout } = runFixture(runnerDir, fakeGitDir, { PUSH_API_FALLBACK_DISABLE: '1' }, tmp);

    assert.doesNotMatch(stdout, /trying the Git Data API fallback/,
      `expected PUSH_API_FALLBACK_DISABLE=1 to suppress the fallback. Output:\n${stdout}`);
    assert.match(stdout, /the Git Data API fallback \(default-on\) did NOT run this attempt/,
      `expected the discoverability pointer to explain why. Output:\n${stdout}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('task #1847: a MANAGED-file diff (e.g. data/commercial.json) still disqualifies the fallback under the new default', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-retry-elig-managed-'));
  try {
    const { runnerDir } = setupRunner(tmp, ['data/commercial.json', '{}\n']);
    fs.writeFileSync(path.join(runnerDir, 'data', 'commercial.json'), '{"a":1}\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "commercial update"', runnerDir);

    const fakeGitDir = makeAlwaysFailPushGitDir(tmp);
    const { stdout } = runFixture(runnerDir, fakeGitDir, {}, tmp);

    assert.match(stdout, /skipping Git Data API fallback — our outgoing diff touches a union-merge-MANAGED file/,
      `expected the MANAGED-file disqualifier to still fire. Output:\n${stdout}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('task #1847: missing reconcile-merged-json.js FAILS CLOSED (disqualifies) instead of silently allowing the fallback', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-retry-elig-failclosed-'));
  const fixtureLibDir = path.join(tmp, 'fixture-scripts', 'lib');
  try {
    const { runnerDir } = setupRunner(tmp);
    fs.writeFileSync(path.join(runnerDir, 'plain.js'), 'const x = 1;\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "plain commit"', runnerDir);

    // Isolated copy of push-with-retry.sh + deps, WITHOUT reconcile-merged-json.js
    // — simulates the prerequisite-missing case the fail-open bug (Codex
    // plan-review finding) used to silently proceed on.
    fs.mkdirSync(fixtureLibDir, { recursive: true });
    const realLibDir = path.dirname(SCRIPT);
    for (const f of fs.readdirSync(realLibDir)) {
      if ((f.endsWith('.js') || f.endsWith('.sh')) && f !== 'reconcile-merged-json.js') {
        fs.copyFileSync(path.join(realLibDir, f), path.join(fixtureLibDir, f));
      }
    }
    const fixtureScript = path.join(fixtureLibDir, 'push-with-retry.sh');
    assert.equal(fs.existsSync(path.join(fixtureLibDir, 'reconcile-merged-json.js')), false,
      'fixture setup error: reconcile-merged-json.js should be absent');

    const fakeGitDir = makeAlwaysFailPushGitDir(tmp);
    let stdout = '';
    let code = 0;
    try {
      stdout = execSync(`bash "${fixtureScript}" 1 main`, {
        cwd: runnerDir,
        stdio: 'pipe',
        env: {
          ...process.env, ...GIT_ENV,
          PATH: `${fakeGitDir}:${process.env.PATH}`,
          PUSH_FAILURE_LOG: path.join(tmp, 'failures.jsonl'),
        },
      }).toString();
    } catch (err) {
      code = err.status ?? 1;
      stdout = `${err.stdout || ''}${err.stderr || ''}`;
    }

    assert.match(stdout, /skipping Git Data API fallback — cannot run the MANAGED\/audit\/shows\.json\/reviews\.json disqualifier check/,
      `expected a missing disqualifier-check prerequisite to fail CLOSED (disqualify), not silently proceed. Output:\n${stdout}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
