import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkLanded, isShallowRepo, isAncestor } = require('./landing-verify.js');

function makeThreeCommitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'landing-verify-'));
  const origin = path.join(root, 'origin.git');
  const workdir = path.join(root, 'workdir');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', workdir]);
  const git = (...a) => execFileSync('git', a, { cwd: workdir, encoding: 'utf8' });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('remote', 'add', 'origin', origin);

  const shas = [];
  for (const name of ['a', 'b', 'c']) {
    fs.writeFileSync(path.join(workdir, `${name}.txt`), `${name}\n`);
    git('add', '-A');
    git('commit', '-qm', name);
    shas.push(git('rev-parse', 'HEAD').trim());
  }
  git('push', '-q', 'origin', 'main');
  return { root, origin, workdir, shas }; // shas = [c1, c2, c3] oldest -> newest
}

// Reproduces the exact 2026-08-14 incident mechanism: a --depth=1 fetch on a
// client that ALREADY has an older commit as a loose object (from its own
// prior local commits, here) still writes a shallow boundary at the fetched
// tip. `merge-base --is-ancestor` then walks from the boundary commit,
// which git treats as parentless regardless of what objects exist on disk,
// so it can never reach the older commit — even though `git cat-file -e`
// on that older commit succeeds. This is what silently reported genuinely
// landed commits as "not landed" in the incident.
function shallowGraftAtTip(workdir) {
  execFileSync('git', ['fetch', '--depth=1', 'origin', '+refs/heads/main:refs/remotes/origin/main'], {
    cwd: workdir,
  });
}

test('control: git cat-file -e succeeds on the older commit but merge-base --is-ancestor is fooled by the shallow graft', () => {
  const { root, origin, workdir, shas } = makeThreeCommitRepo();
  try {
    const [c1] = shas;
    shallowGraftAtTip(workdir);
    assert.equal(isShallowRepo(workdir), true, 'fixture precondition: the graft must make the repo shallow');
    assert.doesNotThrow(
      () => execFileSync('git', ['cat-file', '-e', c1], { cwd: workdir }),
      'fixture precondition: the older commit object must still be present on disk'
    );
    assert.equal(
      isAncestor(c1, 'origin/main', workdir),
      false,
      'fixture precondition: this is the exact false negative the incident hit'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// These tests run IN GitHub Actions, where GITHUB_ACTIONS is always set — and
// ensureFullHistory now skips the unshallow whenever it is (BRO-3320). A test
// that read the ambient environment would therefore exercise the SKIP path in
// CI while appearing to cover the fetch path, and pass for the wrong reason.
// So every test below states which branch it wants, rather than inheriting one.
// Registered as `t.after` as well as `finally` so a thrown assertion cannot
// leak the mutation into the next test (node:test runs top-level tests within
// a file sequentially, so restoring is sufficient — but only if it happens).
function forceUnshallowEnv(t, { skip }) {
  const saved = {
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    PUSH_SKIP_UNSHALLOW: process.env.PUSH_SKIP_UNSHALLOW,
  };
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  t.after(restore);
  delete process.env.GITHUB_ACTIONS;
  delete process.env.PUSH_SKIP_UNSHALLOW;
  if (skip === 'ci') process.env.GITHUB_ACTIONS = 'true';
  else if (skip === 'env') process.env.PUSH_SKIP_UNSHALLOW = '1';
  return restore;
}

test('checkLanded never reports NOT_LANDED for a shallow-truncated commit that is genuinely on main', (t) => {
  forceUnshallowEnv(t, { skip: false });
  const { root, origin, workdir, shas } = makeThreeCommitRepo();
  try {
    const [c1] = shas;
    shallowGraftAtTip(workdir);
    assert.equal(isShallowRepo(workdir), true, 'fixture precondition');

    const warnings = [];
    const result = checkLanded({ sha: c1, branch: 'main', remote: 'origin', cwd: workdir, log: (m) => warnings.push(m) });

    assert.notEqual(result.verdict, 'NOT_LANDED', `must never silently answer NOT_LANDED; got ${JSON.stringify(result)}`);
    assert.notEqual(result.landed, false, `landed must never be false for a commit genuinely on main; got ${JSON.stringify(result)}`);
    assert.ok(warnings.length > 0, 'a shallow repo must produce at least one loud warning, not a silent check');

    // origin is a normal local repo (not itself shallow), so the unshallow
    // attempt should succeed and the verdict should resolve to LANDED.
    assert.equal(result.verdict, 'LANDED');
    assert.equal(result.landed, true);
    assert.equal(isShallowRepo(workdir), false, 'checkLanded should have restored full history as a side effect');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkLanded reports UNKNOWN, not NOT_LANDED, when unshallow is impossible', (t) => {
  forceUnshallowEnv(t, { skip: false });
  const { root, workdir, shas } = makeThreeCommitRepo();
  try {
    const [c1] = shas;
    // Point origin at a nonexistent path so the fixture's shallow graft AND
    // any unshallow attempt both fail closed instead of reaching a real remote.
    const deadOrigin = path.join(root, 'does-not-exist.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', deadOrigin]);
    execFileSync('git', ['remote', 'set-url', 'origin', deadOrigin], { cwd: workdir });
    // Can't shallow-fetch from a remote with no matching history, so build the
    // shallow state by pointing at a throwaway origin that DOES have the
    // commits, then remove it before checkLanded runs.
    const tempOrigin = path.join(root, 'temp-origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', tempOrigin]);
    execFileSync('git', ['remote', 'set-url', 'origin', tempOrigin], { cwd: workdir });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: workdir });
    shallowGraftAtTip(workdir);
    assert.equal(isShallowRepo(workdir), true, 'fixture precondition');
    // Now break the remote so checkLanded's unshallow attempt cannot succeed.
    execFileSync('git', ['remote', 'set-url', 'origin', deadOrigin], { cwd: workdir });

    const warnings = [];
    const result = checkLanded({ sha: c1, branch: 'main', remote: 'origin', cwd: workdir, log: (m) => warnings.push(m) });

    assert.equal(result.verdict, 'UNKNOWN');
    assert.equal(result.landed, null);
    assert.equal(result.shallow, true);
    assert.ok(
      warnings.some((w) => /STILL shallow/i.test(w)),
      'must log a distinct loud warning when unshallow fails, not fail silently'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// BRO-3320. The unshallow used to run unconditionally, including from the
// pre-push hook — which executes INSIDE `timeout $GIT_NET_TIMEOUT_SEC git push`.
// On this repo it has ~1.8 GB to move and never finishes, so it burned the
// whole push budget and the push died before its own transport ever started.
// These two tests pin the skip by OBSERVABLE EFFECT rather than by mocking:
// origin is pointed at a path that does not exist, so a fetch could only fail
// slowly and loudly. Returning a clean verdict fast is proof none was made.
for (const [label, skip] of [['GITHUB_ACTIONS is set (CI)', 'ci'], ['PUSH_SKIP_UNSHALLOW=1', 'env']]) {
  test(`checkLanded skips the unshallow entirely and reports UNKNOWN immediately when ${label}`, (t) => {
    forceUnshallowEnv(t, { skip });
    const { root, workdir, shas } = makeThreeCommitRepo();
    try {
      const [c1] = shas;
      shallowGraftAtTip(workdir);
      assert.equal(isShallowRepo(workdir), true, 'fixture precondition: must be shallow');
      // Unreachable remote: any attempted fetch would have to fail, not succeed.
      execFileSync('git', ['remote', 'set-url', 'origin', path.join(root, 'does-not-exist.git')], { cwd: workdir });

      const warnings = [];
      const started = Date.now();
      const result = checkLanded({ sha: c1, branch: 'main', remote: 'origin', cwd: workdir, log: (m) => warnings.push(m) });
      const elapsedMs = Date.now() - started;

      assert.equal(result.verdict, 'UNKNOWN');
      assert.equal(result.landed, null, 'must never answer NOT_LANDED — the whole point of the module');
      assert.equal(result.shallow, true);
      assert.equal(
        result.reason,
        'unshallow-skipped-ci',
        'a deliberate skip must be distinguishable from a fetch that was tried and failed'
      );
      assert.ok(
        warnings.some((w) => /SKIPPED/.test(w)),
        `the skip must be loud and greppable, not silent; got ${JSON.stringify(warnings)}`
      );
      assert.equal(
        isShallowRepo(workdir), true,
        'the repo must still be shallow — proof no unshallow was performed'
      );
      // A real attempt against a nonexistent remote cannot return this fast.
      assert.ok(elapsedMs < 1000, `must return without a network attempt; took ${elapsedMs}ms`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('the skip does NOT fire on a repo that is not shallow — a full checkout still gets a real verdict in CI', (t) => {
  forceUnshallowEnv(t, { skip: 'ci' });
  const { root, workdir, shas } = makeThreeCommitRepo();
  try {
    const [c1] = shas;
    assert.equal(isShallowRepo(workdir), false, 'fixture precondition: NOT shallow');
    const result = checkLanded({ sha: c1, branch: 'main', remote: 'origin', cwd: workdir, log: () => {} });
    // The early `if (!isShallowRepo(cwd))` return runs before the skip, so the
    // guard keeps all of its teeth wherever history is actually present —
    // which is every local session, and the 26 fetch-depth:0 workflows.
    assert.equal(result.verdict, 'LANDED');
    assert.equal(result.landed, true);
    assert.equal(result.reason, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an ancestor-check ERROR (invalid sha) reports UNKNOWN, not NOT_LANDED — not every non-shallow failure is a real "not landed" verdict', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'landing-verify-error-'));
  try {
    const origin = path.join(root, 'origin.git');
    const workdir = path.join(root, 'workdir');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', workdir]);
    const git = (...a) => execFileSync('git', a, { cwd: workdir, encoding: 'utf8' });
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('remote', 'add', 'origin', origin);
    fs.writeFileSync(path.join(workdir, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-qm', 'first');
    git('push', '-q', 'origin', 'main');

    assert.equal(isShallowRepo(workdir), false, 'fixture precondition: full clone, not shallow');
    // A well-formed but nonexistent SHA: `merge-base --is-ancestor` exits 128
    // ("Not a valid commit name"), not 1 ("not an ancestor") — ship-check
    // finding, task #1489: the old code collapsed every nonzero exit into
    // NOT_LANDED, which would misreport a transient/plumbing error as
    // definitive proof the commit never landed.
    const bogusSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const warnings = [];
    const result = checkLanded({ sha: bogusSha, branch: 'main', remote: 'origin', cwd: workdir, log: (m) => warnings.push(m) });
    assert.equal(result.verdict, 'UNKNOWN');
    assert.equal(result.landed, null);
    assert.equal(result.reason, 'ancestor-check-error');
    assert.ok(warnings.length > 0, 'an ancestor-check error must be logged loudly, not swallowed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('control: non-shallow repo + commit truly not on branch reports NOT_LANDED', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'landing-verify-control-'));
  try {
    const origin = path.join(root, 'origin.git');
    const workdir = path.join(root, 'workdir');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', workdir]);
    const git = (...a) => execFileSync('git', a, { cwd: workdir, encoding: 'utf8' });
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('remote', 'add', 'origin', origin);
    fs.writeFileSync(path.join(workdir, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-qm', 'first');
    git('push', '-q', 'origin', 'main');

    // A commit never pushed anywhere — genuinely not on origin/main.
    git('checkout', '-qb', 'side');
    fs.writeFileSync(path.join(workdir, 'b.txt'), 'b\n');
    git('add', '-A');
    git('commit', '-qm', 'unlanded');
    const unlandedSha = git('rev-parse', 'HEAD').trim();
    git('checkout', '-q', 'main');

    assert.equal(isShallowRepo(workdir), false, 'fixture precondition: full clone, not shallow');
    const result = checkLanded({ sha: unlandedSha, branch: 'main', remote: 'origin', cwd: workdir });
    assert.equal(result.verdict, 'NOT_LANDED');
    assert.equal(result.landed, false);
    assert.equal(result.shallow, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
