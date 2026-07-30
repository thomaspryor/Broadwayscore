import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyFileSurvival, classifyAll, anyReverted } = require('./push-content-survival.js');
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'push-content-survival.js');

// ── Pure classifier ──────────────────────────────────────────────────────
test('classifyFileSurvival: final matches local -> survived', () => {
  assert.equal(classifyFileSurvival({ baseBlob: 'A', localBlob: 'B', finalBlob: 'B' }), 'survived');
});

test('classifyFileSurvival: final matches base (not local) -> reverted (task #619 signature)', () => {
  assert.equal(classifyFileSurvival({ baseBlob: 'A', localBlob: 'B', finalBlob: 'A' }), 'reverted');
});

test('classifyFileSurvival: local === base -> unchanged (nothing was really at risk)', () => {
  assert.equal(classifyFileSurvival({ baseBlob: 'A', localBlob: 'A', finalBlob: 'A' }), 'unchanged');
});

test('classifyFileSurvival: local === base even if final differs -> still unchanged, not reverted', () => {
  assert.equal(classifyFileSurvival({ baseBlob: 'A', localBlob: 'A', finalBlob: 'C' }), 'unchanged');
});

test('classifyFileSurvival: final differs from both base and local -> ambiguous (legitimate concurrent merge)', () => {
  assert.equal(classifyFileSurvival({ baseBlob: 'A', localBlob: 'B', finalBlob: 'C' }), 'ambiguous');
});

test('classifyAll + anyReverted: flags a run with at least one reverted file', () => {
  const classified = classifyAll([
    { file: 'ok.txt', baseBlob: 'A', localBlob: 'B', finalBlob: 'B' },
    { file: 'CLAUDE.md', baseBlob: 'A', localBlob: 'B', finalBlob: 'A' },
  ]);
  assert.equal(anyReverted(classified), true);
});

test('classifyAll + anyReverted: clean run with no reversions', () => {
  const classified = classifyAll([
    { file: 'ok.txt', baseBlob: 'A', localBlob: 'B', finalBlob: 'B' },
    { file: 'merged.txt', baseBlob: 'A', localBlob: 'B', finalBlob: 'D' },
  ]);
  assert.equal(anyReverted(classified), false);
});

// ── CLI + a real repo reproducing the incident's own end-state ──────────
// This does not attempt to reproduce the exact internal git-conflict-resolution
// trigger (unconfirmed under real concurrent-CI load) — it reproduces the
// documented END-STATE from the task #619 evidence: a push landed, and the
// file's content on the ref we just "succeeded" against is byte-identical to
// its PRE-EDIT content, with our commit's actual edit nowhere on that ref.
function gitc(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

function buildIncidentRepro() {
  const dir = mkdtempSync(join(tmpdir(), 'push-content-survival-'));
  gitc(dir, 'init', '-q');
  gitc(dir, 'config', 'user.email', 't@t');
  gitc(dir, 'config', 'user.name', 't');

  // base: pre-edit content (what the byte-cap fix was trying to shrink)
  execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, 'CLAUDE.md'))}, 'a'.repeat(200) + '\\n')`]);
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'base');
  // `git init`'s default initial branch name is NOT guaranteed across
  // environments (init.defaultBranch varies; the CI runner's git produced a
  // different name than this machine's, breaking the later `checkout main`
  // with "pathspec 'main' did not match any file(s) known to git"). Force it
  // explicitly rather than assuming.
  gitc(dir, 'branch', '-M', 'main');
  const baseSha = gitc(dir, 'rev-parse', 'HEAD').trim();

  // our run's commit: the actual fix (shrinks the file)
  execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, 'CLAUDE.md'))}, 'a'.repeat(50) + '\\n')`]);
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'fix: trim CLAUDE.md byte cap');
  const beforeSha = gitc(dir, 'rev-parse', 'HEAD').trim();

  // "origin" after the buggy resolution: a NEW commit landed (real ref-update,
  // matching the reported symptom) but this file's content is back to base.
  gitc(dir, 'branch', 'origin-tip', baseSha);
  gitc(dir, 'checkout', '-q', 'origin-tip');
  execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, 'unrelated.txt'))}, 'other run landed fine\\n')`]);
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'unrelated: some other concurrent commit');
  const originTip = gitc(dir, 'rev-parse', 'HEAD').trim();
  gitc(dir, 'checkout', '-q', 'main');

  return { dir, baseSha, beforeSha, originTip };
}

function runCli(dir, args) {
  try {
    const out = execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf8' });
    return { out: out.trim(), code: 0 };
  } catch (e) {
    return { out: String(e.stdout || '').trim() + String(e.stderr || ''), code: e.status };
  }
}

test('CLI: catches the task #619 incident end-state (reverted-to-base content) that the old guards miss', () => {
  const { dir, baseSha, beforeSha, originTip } = buildIncidentRepro();
  const { out, code } = runCli(dir, [
    `--before-sha=${beforeSha}`,
    `--base-sha=${baseSha}`,
    `--check-ref=${originTip}`,
  ]);
  assert.equal(code, 1);
  assert.match(out, /REVERTED/);
  assert.match(out, /CLAUDE\.md/);
});

test('CLI: a clean run where the file legitimately survives exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-content-survival-clean-'));
  gitc(dir, 'init', '-q');
  gitc(dir, 'config', 'user.email', 't@t');
  gitc(dir, 'config', 'user.name', 't');
  execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, 'CLAUDE.md'))}, 'base\\n')`]);
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'base');
  const baseSha = gitc(dir, 'rev-parse', 'HEAD').trim();
  execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, 'CLAUDE.md'))}, 'fixed\\n')`]);
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'fix');
  const beforeSha = gitc(dir, 'rev-parse', 'HEAD').trim();

  const { out, code } = runCli(dir, [
    `--before-sha=${beforeSha}`,
    `--base-sha=${baseSha}`,
    `--check-ref=${beforeSha}`,
  ]);
  assert.equal(code, 0);
  assert.match(out, /OK/);
});

test('CLI: missing args fail OPEN (skip, exit 0) rather than blocking an otherwise-good push', () => {
  const { code, out } = runCli(process.cwd(), []);
  assert.equal(code, 0);
  assert.match(out, /SKIP/);
});
