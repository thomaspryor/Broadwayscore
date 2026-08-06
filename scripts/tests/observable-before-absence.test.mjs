/**
 * observable-before-absence.test.mjs — task #1075.
 *
 * The bug being locked out (caught by luck 2026-08-05): a monitor written to
 * prove a customer-facing bug was fixed grepped `git show origin/main:data/shows.json`
 * from THIS repo. shows.json is gitignored here (core data lives in a private
 * repo, CLAUDE.md §11), so the git read always threw, the grep always found
 * nothing, and the check reported "wrong ticket link GONE" — permanently,
 * whether or not it was ever fixed.
 *
 * The integration cases below build a real throwaway git repo with a real
 * .gitignore and run the real probes against it, so they reproduce that exact
 * situation rather than a mock of it. The unit cases drive the pure
 * classifiers, per CLAUDE.md §15 (require() the real functions, restate no logic).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
  OBSERVABILITY,
  PRESENCE,
  CannotObserveError,
  classifyGitObservability,
  classifyFsObservability,
  classifyPresence,
  absenceIsEvidence,
  assertObservable,
  probeGitPath,
  probeFsPath,
  observePresence,
} = require(path.join(REPO, 'scripts/lib/observable-before-absence.js'));

// ── (c) the predicate is a pure function, require()d from scripts/lib/ ──────

test('classifyPresence is pure: same facts in, same verdict out, no IO', () => {
  const observable = { status: OBSERVABILITY.OBSERVABLE, reason: 'readable', detail: '' };
  const a = classifyPresence({ observability: observable, found: false });
  const b = classifyPresence({ observability: observable, found: false });
  assert.deepEqual(a, b);
  assert.equal(a.presence, PRESENCE.ABSENT);
  assert.equal(classifyPresence({ observability: observable, found: true }).presence, PRESENCE.PRESENT);
});

test('absence never reads as evidence when the target was unobservable', () => {
  for (const facts of [
    { refResolved: false, blobExists: false },              // gc'd branch (the jobBranchLanded variant)
    { refResolved: true, blobExists: false, gitIgnored: true }, // gitignored/private path
    { error: 'not a git repository' },                       // probe itself failed
  ]) {
    const observability = classifyGitObservability(facts);
    assert.equal(observability.status, OBSERVABILITY.CANNOT_OBSERVE);
    assert.equal(absenceIsEvidence(observability), false);
    // found:false must NOT collapse into ABSENT
    assert.equal(classifyPresence({ observability, found: false }).presence, PRESENCE.CANNOT_OBSERVE);
  }
});

test('a gc\'d ref and a missing-in-ref path give distinguishable reasons', () => {
  assert.equal(classifyGitObservability({ refResolved: false }).reason, 'ref-missing');
  assert.equal(
    classifyGitObservability({ refResolved: true, blobExists: false, gitIgnored: true }).reason,
    'path-gitignored-here'
  );
  assert.equal(
    classifyGitObservability({ refResolved: true, blobExists: false, gitIgnored: false }).reason,
    'path-not-in-ref'
  );
});

test('classifyFsObservability separates missing-because-private from plain missing', () => {
  assert.equal(classifyFsObservability({ fileExists: true }).status, OBSERVABILITY.OBSERVABLE);
  assert.equal(classifyFsObservability({ fileExists: false }).reason, 'file-missing');
  assert.equal(
    classifyFsObservability({ fileExists: false, gitIgnored: true }).reason,
    'file-missing-gitignored'
  );
});

test('assertObservable throws CannotObserveError instead of returning a clean result', () => {
  const blind = classifyFsObservability({ fileExists: false, gitIgnored: true });
  assert.throws(() => assertObservable(blind, 'data/shows.json'), CannotObserveError);
  assert.throws(() => assertObservable(blind, 'data/shows.json'), /cannot observe data\/shows\.json/);
  const seeing = classifyFsObservability({ fileExists: true });
  assert.equal(assertObservable(seeing, 'x').status, OBSERVABILITY.OBSERVABLE);
});

// ── Integration: a real repo with a real .gitignore ─────────────────────────

function makeRepo() {
  // realpath: macOS /tmp is a symlink and git resolves it, which would make
  // cwd-relative comparisons inside the probes inconsistent.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'obs-abs-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  // Mirrors this repo: core data is gitignored because it lives in a private repo.
  fs.writeFileSync(path.join(dir, '.gitignore'), 'data/shows.json\n');
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'shows.json'), '{"ticketUrl":"WRONG-LINK-STILL-LIVE"}\n');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'nothing to see here\n');
  git('add', '.gitignore', 'tracked.txt');
  git('commit', '-qm', 'init');
  return { dir, git };
}

test('(a) gitignored target read via a git ref → CANNOT_OBSERVE, not a pass', () => {
  const { dir } = makeRepo();
  // The exact 2026-08-05 shape: the bug string IS still live in the working
  // tree, but `git show HEAD:data/shows.json` can never see it.
  const r = observePresence({
    ref: 'HEAD',
    filePath: 'data/shows.json',
    contains: 'WRONG-LINK-STILL-LIVE',
    cwd: dir,
  });
  assert.equal(r.presence, PRESENCE.CANNOT_OBSERVE);
  assert.equal(r.reason, 'path-gitignored-here');
  assert.notEqual(r.presence, PRESENCE.ABSENT, 'a blind check must never report the bug gone');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('(a2) a deleted/gc\'d ref → CANNOT_OBSERVE, not a real negative', () => {
  const { dir } = makeRepo();
  const observability = probeGitPath({ ref: 'origin/gone-branch', filePath: 'tracked.txt', cwd: dir });
  assert.equal(observability.status, OBSERVABILITY.CANNOT_OBSERVE);
  assert.equal(observability.reason, 'ref-missing');
  const r = observePresence({ ref: 'origin/gone-branch', filePath: 'tracked.txt', contains: 'anything', cwd: dir });
  assert.equal(r.presence, PRESENCE.CANNOT_OBSERVE);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('(a3) a gitignored target missing from the working tree → CANNOT_OBSERVE', () => {
  const { dir } = makeRepo();
  // Simulates CI / a fresh worktree without the private core-data clone.
  fs.rmSync(path.join(dir, 'data', 'shows.json'));
  const observability = probeFsPath({ filePath: 'data/shows.json', cwd: dir });
  assert.equal(observability.status, OBSERVABILITY.CANNOT_OBSERVE);
  assert.equal(observability.reason, 'file-missing-gitignored');
  const r = observePresence({ filePath: 'data/shows.json', contains: 'WRONG-LINK-STILL-LIVE', cwd: dir });
  assert.equal(r.presence, PRESENCE.CANNOT_OBSERVE);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('(b) a genuinely-absent-but-observable target → a real negative (ABSENT)', () => {
  const { dir } = makeRepo();
  const viaRef = observePresence({ ref: 'HEAD', filePath: 'tracked.txt', contains: 'WRONG-LINK-STILL-LIVE', cwd: dir });
  assert.equal(viaRef.presence, PRESENCE.ABSENT);
  assert.equal(viaRef.observability.status, OBSERVABILITY.OBSERVABLE);

  const viaFs = observePresence({ filePath: 'tracked.txt', contains: 'WRONG-LINK-STILL-LIVE', cwd: dir });
  assert.equal(viaFs.presence, PRESENCE.ABSENT);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('(b2) a present string is still reported PRESENT through both readers', () => {
  const { dir } = makeRepo();
  assert.equal(
    observePresence({ ref: 'HEAD', filePath: 'tracked.txt', contains: 'nothing to see', cwd: dir }).presence,
    PRESENCE.PRESENT
  );
  assert.equal(
    observePresence({ filePath: 'data/shows.json', contains: /WRONG-LINK/, cwd: dir }).presence,
    PRESENCE.PRESENT
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a tracked path IS observable at a ref that has it (no over-blocking)', () => {
  const { dir } = makeRepo();
  const observability = probeGitPath({ ref: 'HEAD', filePath: 'tracked.txt', cwd: dir });
  assert.equal(observability.status, OBSERVABILITY.OBSERVABLE);
  assert.equal(absenceIsEvidence(observability), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('contains accepts a predicate function as well as string/RegExp', () => {
  const { dir } = makeRepo();
  const r = observePresence({
    filePath: 'tracked.txt',
    contains: (text) => text.trim().split(/\s+/).length === 4,
    cwd: dir,
  });
  assert.equal(r.presence, PRESENCE.PRESENT);
  fs.rmSync(dir, { recursive: true, force: true });
});
