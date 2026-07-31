// End-to-end fixture for task #707: scripts/lib/push-via-git-api.sh, the
// generalized Git Data API push fallback for push-with-retry.sh (task #698's
// live fix). Mirrors reconcile-bww-roundup-ledger.test.mjs's bare-origin +
// two-clones-racing pattern, but exercises the fallback's own algorithm
// (build a commit on top of whatever the remote tip currently is, then a
// compare-and-swap ref update) rather than push-with-retry.sh's local
// rebase path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'lib', 'push-via-git-api.sh');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t',
};

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } }).toString();
}

function runScript(args, cwd) {
  return execFileSync('bash', [SCRIPT, ...args], {
    cwd, env: { ...process.env, ...GIT_ENV }, stdio: 'pipe',
  }).toString().trim();
}

function spawnScript(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT, ...args], {
      cwd, env: { ...process.env, ...GIT_ENV },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr }));
  });
}

function setupOriginWithSeed(tmp, seedFiles) {
  const originDir = path.join(tmp, 'origin.git');
  const seedDir = path.join(tmp, 'seed');
  sh(`git init -q --bare "${originDir}"`, tmp);
  sh(`git init -q "${seedDir}"`, tmp);
  sh('git config user.email t@t.t', seedDir);
  sh('git config user.name t', seedDir);
  for (const [rel, content] of Object.entries(seedFiles)) {
    const full = path.join(seedDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  sh('git add -A', seedDir);
  sh('git commit -q -m base', seedDir);
  sh('git branch -M main', seedDir);
  sh(`git push -q "${originDir}" main`, seedDir);
  return originDir;
}

function cloneRepo(originDir, dest) {
  sh(`git clone -q --branch main "${originDir}" "${dest}"`, path.dirname(dest));
  sh('git config user.email t@t.t', dest);
  sh('git config user.name t', dest);
}

test('push-via-git-api.sh replays our own diff onto a tip that moved after our base, without a local rebase', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-'));
  try {
    const originDir = setupOriginWithSeed(tmp, { 'data/base.json': '{"a":1}\n' });

    const runnerDir = path.join(tmp, 'runner');
    cloneRepo(originDir, runnerDir);
    const baseSha = sh('git rev-parse HEAD', runnerDir).trim();

    // A concurrent writer lands FIRST — this is what makes push-with-retry.sh's
    // local flow lose the non-fast-forward race in the real incident (task #698).
    const concurrentDir = path.join(tmp, 'concurrent');
    cloneRepo(originDir, concurrentDir);
    fs.writeFileSync(path.join(concurrentDir, 'data', 'concurrent.json'), '{"b":2}\n');
    sh('git add -A', concurrentDir);
    sh('git commit -q -m "concurrent change"', concurrentDir);
    sh('git push -q origin main', concurrentDir);

    // Our own change, built on the now-stale base — never pushed via plain
    // `git push` (that would just fail non-fast-forward, the exact condition
    // this script exists to route around).
    fs.writeFileSync(path.join(runnerDir, 'data', 'ours.json'), '{"c":3}\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "our change"', runnerDir);
    const headSha = sh('git rev-parse HEAD', runnerDir).trim();

    const newSha = runScript(['main', baseSha, '5'], runnerDir);
    assert.match(newSha, /^[0-9a-f]{40}$/, 'stdout must be exactly the new commit sha, no log noise mixed in');
    assert.notEqual(newSha, headSha, 'the API-built commit has a different parent lineage than local HEAD');

    const verifyDir = path.join(tmp, 'verify');
    cloneRepo(originDir, verifyDir);
    assert.equal(sh('git rev-parse HEAD', verifyDir).trim(), newSha);
    assert.deepEqual(
      fs.readdirSync(path.join(verifyDir, 'data')).sort(),
      ['base.json', 'concurrent.json', 'ours.json'],
      'both the concurrent writer\'s file and our own file must survive — neither local rebase nor any working-tree checkout ran',
    );
    assert.equal(fs.readFileSync(path.join(verifyDir, 'data', 'concurrent.json'), 'utf8'), '{"b":2}\n');
    assert.equal(fs.readFileSync(path.join(verifyDir, 'data', 'ours.json'), 'utf8'), '{"c":3}\n');

    // The new commit's parent must be the tip that was actually on origin at
    // push time (the concurrent writer's commit), not our stale local base —
    // proves this is a real replay-onto-current-tip, not a lucky no-op.
    const parentSha = sh(`git log -1 --format=%P HEAD`, verifyDir).trim();
    const concurrentTip = sh('git rev-parse HEAD', concurrentDir).trim();
    assert.equal(parentSha, concurrentTip);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('push-via-git-api.sh handles delete + rename correctly (no orphaned old path, no lost renamed content)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-'));
  try {
    const originDir = setupOriginWithSeed(tmp, {
      'data/base.json': '{"a":1}\n',
      'data/to-delete.json': '{"old":1}\n',
    });

    const runnerDir = path.join(tmp, 'runner');
    cloneRepo(originDir, runnerDir);
    const baseSha = sh('git rev-parse HEAD', runnerDir).trim();

    fs.rmSync(path.join(runnerDir, 'data', 'to-delete.json'));
    fs.renameSync(path.join(runnerDir, 'data', 'base.json'), path.join(runnerDir, 'data', 'renamed.json'));
    sh('git add -A', runnerDir);
    sh('git commit -q -m "delete + rename"', runnerDir);

    runScript(['main', baseSha, '5'], runnerDir);

    const verifyDir = path.join(tmp, 'verify');
    cloneRepo(originDir, verifyDir);
    assert.deepEqual(fs.readdirSync(path.join(verifyDir, 'data')).sort(), ['renamed.json']);
    assert.equal(fs.readFileSync(path.join(verifyDir, 'data', 'renamed.json'), 'utf8'), '{"a":1}\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('two concurrent push-via-git-api.sh invocations racing the SAME origin: one wins immediately, the other loses the CAS and retries to success', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-race-'));
  try {
    const originDir = setupOriginWithSeed(tmp, { 'data/base.json': '{"a":1}\n' });

    const runnerADir = path.join(tmp, 'runnerA');
    const runnerBDir = path.join(tmp, 'runnerB');
    cloneRepo(originDir, runnerADir);
    cloneRepo(originDir, runnerBDir);

    const baseA = sh('git rev-parse HEAD', runnerADir).trim();
    fs.writeFileSync(path.join(runnerADir, 'data', 'a.json'), '{"x":"A"}\n');
    sh('git add -A', runnerADir);
    sh('git commit -q -m "runner A change"', runnerADir);

    const baseB = sh('git rev-parse HEAD', runnerBDir).trim();
    fs.writeFileSync(path.join(runnerBDir, 'data', 'b.json'), '{"x":"B"}\n');
    sh('git add -A', runnerBDir);
    sh('git commit -q -m "runner B change"', runnerBDir);

    const [resultA, resultB] = await Promise.all([
      spawnScript(['main', baseA, '8'], runnerADir),
      spawnScript(['main', baseB, '8'], runnerBDir),
    ]);

    assert.equal(resultA.code, 0, `runner A must succeed (stderr: ${resultA.stderr})`);
    assert.equal(resultB.code, 0, `runner B must succeed (stderr: ${resultB.stderr})`);
    // At least one side must have observed and recovered from a lost
    // compare-and-swap — otherwise this test isn't actually exercising the
    // race/retry path it exists to cover.
    assert.ok(
      /ref moved during attempt/.test(resultA.stderr) || /ref moved during attempt/.test(resultB.stderr),
      'expected at least one runner to hit and retry past a lost compare-and-swap',
    );

    const verifyDir = path.join(tmp, 'verify');
    cloneRepo(originDir, verifyDir);
    assert.deepEqual(
      fs.readdirSync(path.join(verifyDir, 'data')).sort(),
      ['a.json', 'b.json', 'base.json'],
      'both runners\' files must survive the race',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('push-via-git-api.sh fails loudly (exit 1) with no push attempted when base_sha is invalid', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-'));
  try {
    const originDir = setupOriginWithSeed(tmp, { 'data/base.json': '{"a":1}\n' });
    const runnerDir = path.join(tmp, 'runner');
    cloneRepo(originDir, runnerDir);
    fs.writeFileSync(path.join(runnerDir, 'data', 'ours.json'), '{"c":3}\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "our change"', runnerDir);

    assert.throws(() => runScript(['main', 'not-a-real-sha', '3'], runnerDir));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
