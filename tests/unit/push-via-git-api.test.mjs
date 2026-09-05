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
    // This test asserts the SAFETY property of a real race (both writers'
    // content survives), NOT that a compare-and-swap was actually lost.
    //
    // It used to assert /ref moved during attempt/ on one of the two stderrs.
    // That is timing-dependent and it flaked main red: the script re-reads the
    // remote tip fresh at the top of every attempt, so the losing window is
    // only between that read and the ref update. When the runner serializes
    // the two invocations — B starts after A has fully landed — B reads the
    // ALREADY-advanced tip, its CAS succeeds first try, and no "ref moved"
    // line is ever emitted even though nothing is broken. Observed on
    // Broadwayscore test.yml run 33960170292, where the assertion failed on
    // both the initial attempt and the automatic retry.
    //
    // The retry path still gets a hard assertion — see the deterministic
    // pre-receive test below, which forces the lost CAS instead of hoping for
    // it. Do not reinstate a timing-dependent assertion here.

    const verifyDir = path.join(tmp, 'verify');
    cloneRepo(originDir, verifyDir);
    assert.deepEqual(
      fs.readdirSync(path.join(verifyDir, 'data')).sort(),
      ['a.json', 'b.json', 'base.json'],
      'both runners\' files must survive the race',
    );
    // Holds whether the two invocations interleaved or serialized, so it is
    // safe to assert here: two writers must land exactly two commits. A retry
    // that minted a duplicate, or a clobber that dropped one, both show up.
    assert.equal(
      Number(sh('git rev-list --count main', verifyDir).trim()),
      3,
      'origin must hold exactly the seed plus one commit per runner',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('push-via-git-api.sh does not shallow-graft the caller\'s local repo when the remote tip is already known locally (task #1847)', () => {
  // Bug found while widening push-with-retry.sh's fallback eligibility to
  // default-on (task #1847): `git fetch --depth=1 <remote> <sha>` shallow-
  // grafts the LOCAL repository as a side effect even when <sha> and its
  // full ancestry are ALREADY present locally — flipping
  // `is-shallow-repository` to true and truncating `git log`/`git rev-list`/
  // `merge-base --is-ancestor` traversal at that commit for the rest of the
  // checkout's lifetime. Confirmed via a minimal repro outside this
  // fixture. This script's own header promises it "never touches the
  // caller's working tree, index, or local branch ref" — an undocumented
  // shallow-graft of the object database breaks that promise and corrupts
  // every ancestry-dependent guard in push-with-retry.sh (BRO-259 checks,
  // orphan-commit checks) for as long as the checkout persists, which
  // matters most for the persistent shared local checkout (unlike CI's
  // disposable one). The fix skips the fetch when the object is already
  // present, and depth-bounds a genuinely-needed fetch only when the repo
  // was ALREADY shallow.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-shallow-'));
  try {
    const originDir = setupOriginWithSeed(tmp, { 'data/base.json': '{"a":1}\n' });

    const runnerDir = path.join(tmp, 'runner');
    cloneRepo(originDir, runnerDir);

    // Build a multi-commit chain and push it normally so origin's tip is
    // exactly our own local HEAD — already fully known locally, with real
    // ancestry depth (base -> commit1 -> commit2), matching the production
    // shape: push-with-retry.sh's local flow already pushed this run's
    // commits before the API fallback is ever invoked.
    fs.writeFileSync(path.join(runnerDir, 'data', 'c1.json'), '{"c1":1}\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "commit1"', runnerDir);
    fs.writeFileSync(path.join(runnerDir, 'data', 'c2.json'), '{"c2":1}\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "commit2"', runnerDir);
    sh('git push -q origin main', runnerDir);

    assert.equal(sh('git rev-parse --is-shallow-repository', runnerDir).trim(), 'false');
    const preRunLog = sh('git log --oneline', runnerDir).trim();
    assert.equal(preRunLog.split('\n').length, 3, `expected a 3-commit chain before the run. Log:\n${preRunLog}`);

    // Diff a small amount of new content on top of the already-pushed tip —
    // any non-empty base_sha..HEAD works; base_sha is the ORIGINAL clone
    // point, well behind the current (already-known) tip.
    const originalBaseSha = sh('git rev-parse HEAD~2', runnerDir).trim();
    fs.writeFileSync(path.join(runnerDir, 'data', 'c3.json'), '{"c3":1}\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "commit3"', runnerDir);

    runScript(['main', originalBaseSha, '5'], runnerDir);

    assert.equal(sh('git rev-parse --is-shallow-repository', runnerDir).trim(), 'false',
      'push-via-git-api.sh must not shallow-graft a checkout that was full before it ran');
    const postRunLog = sh('git log --oneline HEAD', runnerDir).trim();
    assert.ok(postRunLog.split('\n').length >= 4,
      `expected the original 3-commit ancestry to remain traversable. Log:\n${postRunLog}`);
    assert.match(postRunLog, /commit1/, `commit1 no longer traversable — ancestry truncated. Log:\n${postRunLog}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BRO-2413: apiFallbackMerge reconciles a genuinely multi-writer file (data/audit/alert-router-attempts.jsonl) instead of one writer clobbering the other', () => {
  // This is the acceptance test for BRO-2413: alert-router-attempts.jsonl
  // has 3 real independent writers and used to unconditionally disqualify
  // this whole script (push-with-retry.sh's NEVER_FALLBACK-adjacent
  // data/audit/ check) because plain "ours wins outright" would silently
  // drop whichever writer's push lost the race. It's now registered
  // apiFallbackMerge (core-data-merge-registry.js) with a real merge
  // function (scripts/lib/merge-alert-router-attempts.js) that
  // push-via-git-api.sh runs against the live remote tip on every retry —
  // this proves BOTH concurrent writers' lines survive, not just one.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-apifallbackmerge-'));
  try {
    const originDir = setupOriginWithSeed(tmp, {
      'data/audit/alert-router-attempts.jsonl':
        '{"ts":"2026-09-01T00:00:00.000Z","conditionKey":"base","title":"base","ok":true,"error":null}\n',
    });

    const runnerDir = path.join(tmp, 'runner');
    cloneRepo(originDir, runnerDir);
    const baseSha = sh('git rev-parse HEAD', runnerDir).trim();

    // A concurrent writer lands FIRST, appending its OWN line — this is the
    // scenario the old whole-file overlay would have silently discarded.
    const concurrentDir = path.join(tmp, 'concurrent');
    cloneRepo(originDir, concurrentDir);
    fs.appendFileSync(
      path.join(concurrentDir, 'data', 'audit', 'alert-router-attempts.jsonl'),
      '{"ts":"2026-09-01T00:00:01.000Z","conditionKey":"concurrent-writer","title":"concurrent","ok":true,"error":null}\n',
    );
    sh('git add -A', concurrentDir);
    sh('git commit -q -m "concurrent alert"', concurrentDir);
    sh('git push -q origin main', concurrentDir);

    // Our own append, built on the now-stale base.
    fs.appendFileSync(
      path.join(runnerDir, 'data', 'audit', 'alert-router-attempts.jsonl'),
      '{"ts":"2026-09-01T00:00:02.000Z","conditionKey":"our-writer","title":"ours","ok":true,"error":null}\n',
    );
    sh('git add -A', runnerDir);
    sh('git commit -q -m "our alert"', runnerDir);

    const newSha = runScript(['main', baseSha, '5'], runnerDir);
    assert.match(newSha, /^[0-9a-f]{40}$/);

    const verifyDir = path.join(tmp, 'verify');
    cloneRepo(originDir, verifyDir);
    const finalLines = fs.readFileSync(path.join(verifyDir, 'data', 'audit', 'alert-router-attempts.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const keys = finalLines.map((l) => l.conditionKey).sort();
    assert.deepEqual(
      keys,
      ['base', 'concurrent-writer', 'our-writer'],
      'both writers\' lines AND the base line must survive — a plain "ours wins" overlay would have dropped concurrent-writer\'s line entirely',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BRO-2413 round-2 (Codex adversarial ship-check P0): a deliberate local delete of an apiFallbackMerge entry is NOT resurrected by a stale remote copy', () => {
  // clearDigestQueue()-style scenario: base and the concurrent writer both
  // have an entry; OUR commit deliberately removes it (already delivered).
  // A naive 2-way union would restore it from the concurrent writer's stale
  // pre-delete copy — this is exactly what the 3-way base-aware merge
  // (push-via-git-api.sh now fetches BASE_SHA's copy of the path too) exists
  // to prevent.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-delete-'));
  try {
    const originDir = setupOriginWithSeed(tmp, {
      'data/audit/alert-digest-queue.json':
        '[{"conditionKey":"stale-alert","title":"t","description":"d","severity":"warning","url":null,"decision":false,"decisionPrompt":null,"model":null,"fields":[],"queuedAt":"2026-09-01T00:00:00.000Z"}]\n',
    });

    const runnerDir = path.join(tmp, 'runner');
    cloneRepo(originDir, runnerDir);
    const baseSha = sh('git rev-parse HEAD', runnerDir).trim();

    // A concurrent writer touches an UNRELATED file, never sees our delete —
    // its copy of alert-digest-queue.json (via git show at push time) is
    // still the base's, still containing "stale-alert".
    const concurrentDir = path.join(tmp, 'concurrent');
    cloneRepo(originDir, concurrentDir);
    fs.writeFileSync(path.join(concurrentDir, 'data', 'unrelated.json'), '{"b":2}\n');
    sh('git add -A', concurrentDir);
    sh('git commit -q -m "unrelated concurrent change"', concurrentDir);
    sh('git push -q origin main', concurrentDir);

    // Our own commit: the queue is now EMPTY — we drained it (delivered).
    fs.writeFileSync(path.join(runnerDir, 'data', 'audit', 'alert-digest-queue.json'), '[]\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "drain digest queue"', runnerDir);

    const newSha = runScript(['main', baseSha, '5'], runnerDir);
    assert.match(newSha, /^[0-9a-f]{40}$/);

    const verifyDir = path.join(tmp, 'verify');
    cloneRepo(originDir, verifyDir);
    const finalQueue = JSON.parse(fs.readFileSync(path.join(verifyDir, 'data', 'audit', 'alert-digest-queue.json'), 'utf8'));
    assert.deepEqual(finalQueue, [], 'the drained (delivered) alert must stay drained, not get resurrected by the concurrent writer\'s stale pre-delete copy');
    // The unrelated file must still have survived the merge (proves this
    // wasn't a whole-file "ours wins" that happened to also drop the queue).
    assert.equal(fs.readFileSync(path.join(verifyDir, 'data', 'unrelated.json'), 'utf8'), '{"b":2}\n');
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

// BRO-2823: a push SIGTERMed by the `timeout -k 10` wrapper (rc=124) is not a
// fatal error, but it used to be treated as one. git dies without writing to
// stderr, so PUSH_ERR is empty, the race-text grep cannot match, and control
// fell through to the "non-race reason" branch which exits 1 — abandoning
// every remaining budgeted attempt. Measured in two workflows, both printing
// an empty reason: data-health-check run 33922438634 (90.66s) and
// commercial-rss-poll run 33929580504 (90.1s).
//
// Both tests drive the real script through a PATH shim named `timeout`, which
// is what `command -v timeout` at push-via-git-api.sh:93 resolves. The shim
// takes `-k 10 <secs> <cmd...>`, the same shape as GNU timeout.

function installTimeoutShim(tmp, body) {
  const binDir = path.join(tmp, 'shimbin');
  fs.mkdirSync(binDir, { recursive: true });
  const shim = path.join(binDir, 'timeout');
  fs.writeFileSync(shim, body);
  fs.chmodSync(shim, 0o755);
  return binDir;
}

function spawnScriptWithEnv(args, cwd, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT, ...args], {
      cwd, env: { ...process.env, ...GIT_ENV, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr }));
  });
}

test('BRO-2823: a push killed by the timeout wrapper (rc=124, empty stderr) is RETRIED, not treated as a fatal non-race error', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-'));
  try {
    const originDir = setupOriginWithSeed(tmp, { 'data/base.json': '{"a":1}\n' });
    const runnerDir = path.join(tmp, 'runner');
    cloneRepo(originDir, runnerDir);
    const baseSha = sh('git rev-parse HEAD', runnerDir).trim();
    fs.writeFileSync(path.join(runnerDir, 'data', 'ours.json'), '{"c":3}\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "our change"', runnerDir);

    // First push: pretend the network op burned the whole cap. Do NOT run it,
    // so the remote never moves — the retry must be what lands the commit.
    // Every other op (ls-remote, fetch) delegates normally.
    const marker = path.join(tmp, 'push-timed-out-once');
    const binDir = installTimeoutShim(tmp, `#!/bin/bash
shift 2            # drop -k 10
shift              # drop the seconds arg
for a in "$@"; do
  if [ "$a" = "push" ] && [ ! -f "${marker}" ]; then
    touch "${marker}"
    exit 124       # SIGTERMed by timeout: no stdout, no stderr
  fi
done
exec "$@"
`);

    const res = await spawnScriptWithEnv(['main', baseSha, '5'], runnerDir, {
      PATH: `${binDir}:${process.env.PATH}`,
    });

    assert.equal(res.code, 0, `expected success after retrying the timeout, got ${res.code}\n${res.stderr}`);
    assert.ok(fs.existsSync(marker), 'the shim never intercepted a push — test did not exercise the timeout path');
    assert.match(res.stderr, /push TIMED OUT after \d+s \(rc=124/, 'timeout was not logged as a timeout');
    assert.doesNotMatch(res.stderr, /non-race reason/, 'a timeout was still misclassified as a fatal non-race error');

    // The commit actually landed on the origin, and our content is there.
    const originLog = sh('git log --oneline main', originDir);
    assert.match(originLog, /our change/);
    const landed = sh('git show main:data/ours.json', originDir);
    assert.equal(landed.trim(), '{"c":3}');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BRO-2823: a push that LANDS server-side but is then killed (rc=124) does not mint an empty no-op commit on the retry', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-'));
  try {
    const originDir = setupOriginWithSeed(tmp, { 'data/base.json': '{"a":1}\n' });
    const runnerDir = path.join(tmp, 'runner');
    cloneRepo(originDir, runnerDir);
    const baseSha = sh('git rev-parse HEAD', runnerDir).trim();
    fs.writeFileSync(path.join(runnerDir, 'data', 'ours.json'), '{"c":3}\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "our change"', runnerDir);

    const before = sh('git rev-list --count main', originDir).trim();

    // The nasty case: the push SUCCEEDS on the remote, then the client is
    // killed before it can read the response. The retry re-reads CURRENT_TIP as
    // our OWN landed commit and replays the same overlay onto it, so the tree
    // is unchanged and commit-tree would otherwise mint an empty commit.
    const marker = path.join(tmp, 'push-landed-then-killed');
    const binDir = installTimeoutShim(tmp, `#!/bin/bash
shift 2
shift
for a in "$@"; do
  if [ "$a" = "push" ] && [ ! -f "${marker}" ]; then
    touch "${marker}"
    "$@" >/dev/null 2>&1   # it really lands
    exit 124               # ...and we are killed before reading the response
  fi
done
exec "$@"
`);

    const res = await spawnScriptWithEnv(['main', baseSha, '5'], runnerDir, {
      PATH: `${binDir}:${process.env.PATH}`,
    });

    assert.equal(res.code, 0, `expected success, got ${res.code}\n${res.stderr}`);
    assert.ok(fs.existsSync(marker), 'the shim never intercepted a push');

    const after = sh('git rev-list --count main', originDir).trim();
    assert.equal(
      Number(after), Number(before) + 1,
      `expected exactly ONE new commit on origin, got ${Number(after) - Number(before)} — the retry minted a no-op commit`,
    );
    assert.match(res.stderr, /ALREADY on main/, 'the already-landed case was not detected');

    // And the reported sha is the one that actually landed.
    const originTip = sh('git rev-parse main', originDir).trim();
    assert.equal(res.stdout, originTip, 'script reported a sha that is not the origin tip');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Installs a pre-receive hook on the bare origin that, on the FIRST push only,
// advances refs/heads/main by one unrelated commit. Every later push is a
// no-op hook. This makes the retry path deterministic instead of
// timing-dependent: the pusher is guaranteed to lose the tip exactly once,
// then must re-read the moved tip and replay onto it.
//
// `decline` selects WHICH of the script's two race signatures the fixture
// produces, and they are genuinely different remote conditions:
//   decline: false -> the hook accepts, so git's OWN ref update runs against
//     an old-value that no longer matches and fails with
//     "cannot lock ref 'refs/heads/main': is at X but expected Y" —
//     a real, lost compare-and-swap.
//   decline: true  -> the hook rejects, so git reports
//     "! [remote rejected] main -> main (pre-receive hook declined)" —
//     NOT a lost CAS, a different alternative in the same grep at
//     push-via-git-api.sh:455.
// Both must be classified as "retry", which is why both are exercised.
function installTipAdvancingHook(originDir, { decline = false } = {}) {
  const hookPath = path.join(originDir, 'hooks', 'pre-receive');
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  // This is the only fixture here that DEPENDS on a hook firing, so it must
  // not inherit a core.hooksPath from the developer's global git config (husky
  // and friends set one). A stray hooksPath silently points pre-receive
  // somewhere else and every assertion below would fail for the wrong reason.
  sh('git config --local core.hooksPath hooks', originDir);
  fs.writeFileSync(hookPath, [
    '#!/bin/sh',
    'set -e',
    'GD=$(git rev-parse --absolute-git-dir)',
    'MARK="$GD/tip-already-advanced"',
    'if [ -f "$MARK" ]; then exit 0; fi',
    ': > "$MARK"',
    // git >= 2.11 runs pre-receive with the pushed objects in a QUARANTINE
    // directory (GIT_QUARANTINE_PATH / GIT_OBJECT_DIRECTORY), which is
    // discarded wholesale when the hook rejects. Objects this hook writes
    // land there too, so without unsetting these the interloper commit is
    // garbage-collected the instant we exit 1 and refs/heads/main silently
    // stays put — the fixture then looks like the script clobbered the moved
    // tip when in fact the tip never moved. Measured both ways before this
    // line was added: quarantined => tipMoved=false, unset => tipMoved=true.
    'unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_AUTHOR_NAME=t; GIT_AUTHOR_EMAIL=t@t.t',
    'GIT_COMMITTER_NAME=t; GIT_COMMITTER_EMAIL=t@t.t',
    'export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL',
    'CUR=$(git rev-parse refs/heads/main)',
    'BLOB=$(printf %s interloper | git hash-object -w --stdin)',
    'GIT_INDEX_FILE="$GD/tmp-interloper-index"; export GIT_INDEX_FILE',
    'rm -f "$GIT_INDEX_FILE"',
    'git read-tree "$CUR"',
    'git update-index --add --cacheinfo 100644,"$BLOB",data/interloper.json',
    'TREE=$(git write-tree)',
    'NEW=$(git commit-tree "$TREE" -p "$CUR" -m "interloper advances the tip")',
    'git update-ref refs/heads/main "$NEW" "$CUR"',
    'rm -f "$GIT_INDEX_FILE"',
    decline ? 'echo "pre-receive: declining after advancing the tip" >&2' : '# accepting: git\'s own ref update will now lose its compare-and-swap',
    decline ? 'exit 1' : 'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(hookPath, 0o755);
}

// Reads the origin's branch state so a test can prove the fixture actually
// did something, rather than passing because nothing happened.
function originState(originDir) {
  return {
    tip: sh('git rev-parse refs/heads/main', originDir).trim(),
    dataFiles: sh('git ls-tree --name-only refs/heads/main:data', originDir)
      .trim().split('\n').filter(Boolean).sort(),
  };
}

// Pins the contract between this fixture and the race grep at
// push-via-git-api.sh:455. If a future git reworded its ref-lock failure, the
// script would silently reclassify a lost compare-and-swap as a fatal
// non-race error and abandon its remaining retries — and every behavioural
// test below would still pass, because the script would simply exit 1 for a
// different reason. This test is what fails loudly in that case.
test('the accepting fixture produces the compare-and-swap text the script\'s race grep depends on', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-castext-'));
  try {
    const originDir = setupOriginWithSeed(tmp, { 'data/base.json': '{"a":1}\n' });
    installTipAdvancingHook(originDir, { decline: false });

    const clientDir = path.join(tmp, 'client');
    cloneRepo(originDir, clientDir);
    fs.writeFileSync(path.join(clientDir, 'data', 'mine.json'), '{"x":"mine"}\n');
    sh('git add -A', clientDir);
    sh('git commit -q -m "client change"', clientDir);

    let stderr = '';
    assert.throws(() => sh('git push origin main', clientDir), (err) => {
      stderr = String(err.stderr || '');
      return true;
    }, 'a plain push against an already-advanced tip must be rejected');

    assert.match(stderr, /cannot lock ref/, 'fixture no longer produces a compare-and-swap failure');
    assert.match(stderr, /is at [0-9a-f]{40} but expected [0-9a-f]{40}/, 'the old-value mismatch is what makes this a lost CAS');
    assert.doesNotMatch(
      stderr,
      /pre-receive hook declined/,
      'this fixture must fail on the ref lock, NOT on a hook decline — otherwise it is testing the wrong branch',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('push-via-git-api.sh recovers from a genuinely lost compare-and-swap: replays onto the moved tip and lands', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-cas-'));
  try {
    const originDir = setupOriginWithSeed(tmp, { 'data/base.json': '{"a":1}\n' });
    installTipAdvancingHook(originDir, { decline: false });

    const runnerDir = path.join(tmp, 'runner');
    cloneRepo(originDir, runnerDir);
    const baseSha = sh('git rev-parse HEAD', runnerDir).trim();
    fs.writeFileSync(path.join(runnerDir, 'data', 'mine.json'), '{"x":"mine"}\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "runner change"', runnerDir);

    const result = await spawnScript(['main', baseSha, '4'], runnerDir);

    assert.equal(result.code, 0, `push must survive one lost CAS (stderr: ${result.stderr})`);
    assert.match(
      result.stderr,
      /ref moved during attempt 1\/4/,
      'the first attempt must be classified as a lost race, not a fatal non-race error',
    );

    // The interloper commit the hook injected must still be present, and our
    // own file must sit on top of it. If the script clobbered the moved tip
    // instead of replaying onto it, interloper.json would be gone.
    const after = originState(originDir);
    assert.deepEqual(
      after.dataFiles,
      ['base.json', 'interloper.json', 'mine.json'],
      'our content must be replayed ON TOP of the tip that moved, not over it',
    );
    // readdir alone would also pass on an unrelated or octopus shape, so pin
    // the ancestry: the landed commit's first parent is the interloper commit.
    const parentSubject = sh('git log -1 --format=%s refs/heads/main^', originDir).trim();
    assert.equal(
      parentSubject,
      'interloper advances the tip',
      'the landed commit must sit directly on the interloper commit, not beside it',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a pre-receive DECLINE that also moved the tip is retried as a race, not treated as a fatal error', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-decline-'));
  try {
    const originDir = setupOriginWithSeed(tmp, { 'data/base.json': '{"a":1}\n' });
    installTipAdvancingHook(originDir, { decline: true });

    const runnerDir = path.join(tmp, 'runner');
    cloneRepo(originDir, runnerDir);
    const baseSha = sh('git rev-parse HEAD', runnerDir).trim();
    fs.writeFileSync(path.join(runnerDir, 'data', 'mine.json'), '{"x":"mine"}\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "runner change"', runnerDir);

    const result = await spawnScript(['main', baseSha, '4'], runnerDir);

    assert.equal(result.code, 0, `a declined-then-accepted push must recover (stderr: ${result.stderr})`);
    assert.match(result.stderr, /ref moved during attempt 1\/4/, 'a remote rejection must route to the retry path');
    assert.deepEqual(
      originState(originDir).dataFiles,
      ['base.json', 'interloper.json', 'mine.json'],
      'the declined attempt must not have cost us the interloper commit or our own file',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('NEGATIVE CONTROL: with a retry budget of 1 the same lost CAS is fatal, and the fixture provably moved the tip', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-cas-neg-'));
  try {
    const originDir = setupOriginWithSeed(tmp, { 'data/base.json': '{"a":1}\n' });
    installTipAdvancingHook(originDir, { decline: false });
    const before = originState(originDir);

    const runnerDir = path.join(tmp, 'runner');
    cloneRepo(originDir, runnerDir);
    const baseSha = sh('git rev-parse HEAD', runnerDir).trim();
    fs.writeFileSync(path.join(runnerDir, 'data', 'mine.json'), '{"x":"mine"}\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "runner change"', runnerDir);

    // MAX_RETRIES=1 gives the script exactly one attempt, which loses the
    // compare-and-swap. Without a retry the push MUST fail.
    const result = await spawnScript(['main', baseSha, '1'], runnerDir);

    assert.notEqual(result.code, 0, 'one attempt against a guaranteed lost CAS must not succeed');
    assert.match(result.stderr, /exhausted 1 attempts/, 'must exhaust its budget rather than fail for a non-race reason');

    // The half a bare "it failed" assertion cannot see: this test passes
    // IDENTICALLY if the hook's update-ref silently did nothing and the push
    // failed for some unrelated reason — which is exactly the push-quarantine
    // regression the `unset` in the hook exists to prevent. Prove the fixture
    // still does its job, or the positive tests above are vacuous and nothing
    // would say so.
    const after = originState(originDir);
    assert.notEqual(after.tip, before.tip, 'the hook must actually have advanced the origin tip');
    assert.ok(
      after.dataFiles.includes('interloper.json'),
      'the interloper commit must be on the origin branch — if it is not, push quarantine ate it and every CAS test here is testing nothing',
    );
    assert.ok(
      !after.dataFiles.includes('mine.json'),
      'our own content must NOT be on origin: the single attempt was supposed to fail',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
