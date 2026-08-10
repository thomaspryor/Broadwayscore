import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyFileSurvival,
  classifyFileSurvivalDeep,
  extractAddedLines,
  addedLinesSurvived,
  classifyAll,
  anyReverted,
} = require('./push-content-survival.js');
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

// ── Deep (line-level) check for the 'ambiguous' bucket (task #833) ──────────
// A file-level blob comparison can't tell "a legitimate 3-way merge combined
// our edit with an unrelated concurrent one" from "our edit was clobbered by
// a concurrent write that also touched this file" — both produce final !=
// base AND final != local. This extracts the lines OUR commit added and
// checks whether they're still present verbatim in the final content, which
// answers "is MY change there" directly instead of inferring it from
// whole-file identity.
test('extractAddedLines: pulls + lines from a unified diff, skips the +++ header and blanks', () => {
  const patch = [
    '--- a/test.yml', '+++ b/test.yml', '@@ -1,3 +1,5 @@',
    ' line1', '+MAPFILE-LINE-1', '+MAPFILE-LINE-2', '+', ' line2', ' line3',
  ].join('\n');
  assert.deepEqual(extractAddedLines(patch), ['MAPFILE-LINE-1', 'MAPFILE-LINE-2']);
});

test('extractAddedLines: empty/null patch -> no added lines', () => {
  assert.deepEqual(extractAddedLines(''), []);
  assert.deepEqual(extractAddedLines(null), []);
});

test('addedLinesSurvived: true when every added line is present in final content', () => {
  assert.equal(
    addedLinesSurvived(['MAPFILE-LINE-1', 'MAPFILE-LINE-2'], 'line1\nline2\nline3\n', 'line1\nMAPFILE-LINE-1\nMAPFILE-LINE-2\nline2\n'),
    true
  );
});

test('addedLinesSurvived: false when an added line is missing (task #833 signature)', () => {
  assert.equal(
    addedLinesSurvived(['MAPFILE-LINE-1', 'MAPFILE-LINE-2'], 'line1\nline2\n', 'line1\nMAPFILE-LINE-1\nline2\n'),
    false
  );
});

test('addedLinesSurvived: fails OPEN with no added lines (pure deletion) or missing final content', () => {
  assert.equal(addedLinesSurvived([], 'base', 'anything'), true);
  assert.equal(addedLinesSurvived(['x'], 'base', null), true);
});

// Adversarial review finding (task #833 follow-up): a naive set-membership
// check would report "survived" whenever the added line's text ALSO occurs
// somewhere else in the file — even when the actual occurrence our commit
// introduced was clobbered. Occurrence-COUNT comparison against base catches
// this: the line already existed once at base, so surviving at count 1 in
// final (not 2) proves our added occurrence specifically is gone.
test('addedLinesSurvived: false when the added line text pre-existed elsewhere and our occurrence was clobbered (duplicate-line false-negative fix)', () => {
  const addedLines = ['- run: npm test'];
  const baseContent = 'jobs:\n  a:\n    steps:\n      - run: npm test\n'; // one pre-existing occurrence
  // final still has exactly ONE occurrence (the pre-existing one) — our
  // ADDED occurrence in a second job never made it in.
  const finalContent = 'jobs:\n  a:\n    steps:\n      - run: npm test\n  b:\n    steps:\n      - run: something-else\n';
  assert.equal(addedLinesSurvived(addedLines, baseContent, finalContent), false);
});

test('addedLinesSurvived: true when the added line text pre-existed elsewhere AND our new occurrence also survived', () => {
  const addedLines = ['- run: npm test'];
  const baseContent = 'jobs:\n  a:\n    steps:\n      - run: npm test\n'; // one pre-existing occurrence
  // final has TWO occurrences: the pre-existing one plus ours.
  const finalContent = 'jobs:\n  a:\n    steps:\n      - run: npm test\n  b:\n    steps:\n      - run: npm test\n';
  assert.equal(addedLinesSurvived(addedLines, baseContent, finalContent), true);
});

// Adversarial review finding: a byte-exact comparison would false-positive
// 'reverted' on a legitimate 3-way merge where a concurrent formatter only
// changed INTERNAL whitespace (indentation, double-spacing) on our own added
// line. Internal-whitespace normalization tolerates pure reformatting while
// still catching real content differences.
test('addedLinesSurvived: tolerates internal-whitespace-only reformatting of our own added line', () => {
  const addedLines = ['  key:   value'];
  const finalContent = 'key: value\n'; // formatter collapsed the double-space and indentation
  assert.equal(addedLinesSurvived(addedLines, '', finalContent), true);
});

test('classifyFileSurvivalDeep: non-ambiguous statuses pass through unchanged (no extra work needed)', () => {
  assert.equal(classifyFileSurvivalDeep({ baseBlob: 'A', localBlob: 'B', finalBlob: 'B' }), 'survived');
  assert.equal(classifyFileSurvivalDeep({ baseBlob: 'A', localBlob: 'B', finalBlob: 'A' }), 'reverted');
  assert.equal(classifyFileSurvivalDeep({ baseBlob: 'A', localBlob: 'A', finalBlob: 'A' }), 'unchanged');
});

test('classifyFileSurvivalDeep: ambiguous + added lines present -> stays ambiguous (legitimate concurrent merge)', () => {
  const status = classifyFileSurvivalDeep({
    baseBlob: 'A', localBlob: 'B', finalBlob: 'C',
    addedLines: ['MAPFILE-LINE-1', 'MAPFILE-LINE-2'],
    baseContent: 'line1\nline2\nline3\n',
    finalContent: 'line1\nMAPFILE-LINE-1\nMAPFILE-LINE-2\nunrelated-concurrent-edit\n',
  });
  assert.equal(status, 'ambiguous');
});

test('classifyFileSurvivalDeep: ambiguous + added lines MISSING -> downgraded to reverted (task #833 signature)', () => {
  const status = classifyFileSurvivalDeep({
    baseBlob: 'A', localBlob: 'B', finalBlob: 'C',
    addedLines: ['MAPFILE-LINE-1', 'MAPFILE-LINE-2'],
    baseContent: 'line1\nline2\n',
    finalContent: 'line1\nsome-other-concurrent-edit\n',
  });
  assert.equal(status, 'reverted');
});

// ── CLI: full end-state repro of the task #833 signature ────────────────────
// Builds the documented end-state directly (same convention as the task #619
// repro below): our commit adds 2 lines to a file; the ref we "pushed" to has
// a THIRD version — neither pre-edit base nor our intended content — that is
// missing our 2 added lines. The pre-fix classifier would call this
// 'ambiguous' and exit 0; the deep check must catch it.
test('CLI: catches the task #833 signature (ambiguous merge that silently clobbered our added lines)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-content-survival-833-'));
  gitc(dir, 'init', '-q');
  gitc(dir, 'config', 'user.email', 't@t');
  gitc(dir, 'config', 'user.name', 't');

  execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, 'test.yml'))}, 'line1\\nline2\\nline3\\n')`]);
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'base');
  gitc(dir, 'branch', '-M', 'main');
  const baseSha = gitc(dir, 'rev-parse', 'HEAD').trim();

  // our run's commit: adds 2 "mapfile" lines (the task #833 incident's own shape)
  execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, 'test.yml'))}, 'line1\\nMAPFILE-LINE-1\\nMAPFILE-LINE-2\\nline2\\nline3\\n')`]);
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'fix: restore mapfile lines');
  const beforeSha = gitc(dir, 'rev-parse', 'HEAD').trim();

  // "origin" after the buggy resolution: a genuine ref-update landed (real new
  // commit, matching the reported "Push succeeded" symptom), but this file's
  // final content is a THIRD version — a concurrent edit that touched the same
  // file elsewhere and, in doing so, clobbered our 2-line insertion. This is
  // neither pure base nor pure local, so the old blob-only check calls it
  // 'ambiguous' and lets it through.
  gitc(dir, 'branch', 'origin-tip', baseSha);
  gitc(dir, 'checkout', '-q', 'origin-tip');
  execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, 'test.yml'))}, 'line1\\nCONCURRENT-EDIT\\nline2\\nline3\\n')`]);
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'concurrent: unrelated edit that clobbered our insertion');
  const originTip = gitc(dir, 'rev-parse', 'HEAD').trim();
  gitc(dir, 'checkout', '-q', 'main');

  const { out, code } = runCli(dir, [
    `--before-sha=${beforeSha}`,
    `--base-sha=${baseSha}`,
    `--check-ref=${originTip}`,
  ]);
  assert.equal(code, 1, `expected the deep check to catch the missing added lines and exit 1. Output:\n${out}`);
  assert.match(out, /REVERTED/);
  assert.match(out, /test\.yml/);
  assert.match(out, /task #833 signature/);
});

test('CLI: a genuine 3-way merge (our lines AND a concurrent edit both survive) stays ambiguous, exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-content-survival-833-ok-'));
  gitc(dir, 'init', '-q');
  gitc(dir, 'config', 'user.email', 't@t');
  gitc(dir, 'config', 'user.name', 't');

  execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, 'test.yml'))}, 'line1\\nline2\\nline3\\n')`]);
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'base');
  gitc(dir, 'branch', '-M', 'main');
  const baseSha = gitc(dir, 'rev-parse', 'HEAD').trim();

  execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, 'test.yml'))}, 'line1\\nMAPFILE-LINE-1\\nMAPFILE-LINE-2\\nline2\\nline3\\n')`]);
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'fix: restore mapfile lines');
  const beforeSha = gitc(dir, 'rev-parse', 'HEAD').trim();

  // Final content legitimately combines OUR added lines with an unrelated
  // concurrent edit elsewhere in the file — nothing was lost.
  gitc(dir, 'branch', 'origin-tip', baseSha);
  gitc(dir, 'checkout', '-q', 'origin-tip');
  execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, 'test.yml'))}, 'line1\\nMAPFILE-LINE-1\\nMAPFILE-LINE-2\\nline2\\nline3\\nCONCURRENT-APPEND\\n')`]);
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'concurrent: unrelated append, our lines untouched');
  const originTip = gitc(dir, 'rev-parse', 'HEAD').trim();
  gitc(dir, 'checkout', '-q', 'main');

  const { out, code } = runCli(dir, [
    `--before-sha=${beforeSha}`,
    `--base-sha=${baseSha}`,
    `--check-ref=${originTip}`,
  ]);
  assert.equal(code, 0, `expected a clean exit — our lines survived alongside the concurrent edit. Output:\n${out}`);
  assert.match(out, /AMBIGUOUS/);
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

// ── 'superseded' (Opening Night Poller incident, Aug 7-9 2026) ──────────────

test('classifyFileSurvivalDeep: ambiguous + added lines missing + pushedBlob === finalBlob -> superseded (own resolution integrated a sibling version)', () => {
  const status = classifyFileSurvivalDeep({
    baseBlob: 'A', localBlob: 'B', finalBlob: 'C', pushedBlob: 'C',
    addedLines: ['OUR-LINE'],
    baseContent: 'line1\n',
    finalContent: 'line1\nSIBLING-VERSION\n',
  });
  assert.equal(status, 'superseded');
});

test('classifyFileSurvivalDeep: no pushedBlob -> unchanged pre-existing behavior (reverted)', () => {
  const status = classifyFileSurvivalDeep({
    baseBlob: 'A', localBlob: 'B', finalBlob: 'C',
    addedLines: ['OUR-LINE'],
    baseContent: 'line1\n',
    finalContent: 'line1\nSIBLING-VERSION\n',
  });
  assert.equal(status, 'reverted');
});

test('classifyFileSurvivalDeep: null pushedBlob and null finalBlob must NOT satisfy the superseded comparison (deleted-file guard)', () => {
  // finalContent is non-null here (unlike a real deleted file) purely to force
  // the missing-added-lines path — addedLinesSurvived fails open on null.
  const status = classifyFileSurvivalDeep({
    baseBlob: 'A', localBlob: 'B', finalBlob: null, pushedBlob: null,
    addedLines: ['OUR-LINE'],
    baseContent: 'line1\n',
    finalContent: 'line1\n',
  });
  assert.equal(status, 'reverted');
});

test('classifyFileSurvivalDeep: pushedBlob differs from finalBlob (post-push clobber) still fails -> reverted (task #833 detection preserved)', () => {
  const status = classifyFileSurvivalDeep({
    baseBlob: 'A', localBlob: 'B', finalBlob: 'D', pushedBlob: 'B',
    addedLines: ['OUR-LINE'],
    baseContent: 'line1\n',
    finalContent: 'line1\nCLOBBERED\n',
  });
  assert.equal(status, 'reverted');
});

// CLI end-state repro of the poller incident: our rebase integrated the
// sibling pipeline's already-pushed version of the same review file, so the
// commit we pushed (which IS the check-ref tip) lacks our exact added lines.
// With --pushed-sha this must pass with a SUPERSEDED warning; without it, the
// pre-fix behavior (exit 1) is preserved.
function buildSupersedeRepro() {
  const dir = mkdtempSync(join(tmpdir(), 'push-content-survival-supersede-'));
  gitc(dir, 'init', '-q');
  gitc(dir, 'config', 'user.email', 't@t');
  gitc(dir, 'config', 'user.name', 't');

  execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, 'review.json'))}, '{"outlet":"thr"}\\n')`]);
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'base');
  gitc(dir, 'branch', '-M', 'main');
  const baseSha = gitc(dir, 'rev-parse', 'HEAD').trim();

  // our run's commit: the poller's version of the review
  execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, 'review.json'))}, '{"outlet":"thr","fullText":"POLLER-COLLECTED-TEXT"}\\n')`]);
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'poller: collected review');
  const beforeSha = gitc(dir, 'rev-parse', 'HEAD').trim();

  // what our rebase actually produced and pushed: the sibling pipeline's
  // version of the same review won during integration — our exact line is gone
  gitc(dir, 'branch', 'pushed-tip', baseSha);
  gitc(dir, 'checkout', '-q', 'pushed-tip');
  execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, 'review.json'))}, '{"outlet":"thr","fullText":"SIBLING-COLLECTED-TEXT","scored":true}\\n')`]);
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'rebased: sibling version integrated');
  const pushedTip = gitc(dir, 'rev-parse', 'HEAD').trim();
  gitc(dir, 'checkout', '-q', 'main');

  return { dir, baseSha, beforeSha, pushedTip };
}

test('CLI: poller incident shape WITH --pushed-sha -> SUPERSEDED warning, exit 0', () => {
  const { dir, baseSha, beforeSha, pushedTip } = buildSupersedeRepro();
  const { out, code } = runCli(dir, [
    `--before-sha=${beforeSha}`,
    `--base-sha=${baseSha}`,
    `--check-ref=${pushedTip}`,
    `--pushed-sha=${pushedTip}`,
  ]);
  assert.equal(code, 0, `expected superseded to pass. Output:\n${out}`);
  assert.match(out, /SUPERSEDED/);
  assert.match(out, /review\.json/);
});

test('CLI: poller incident shape WITHOUT --pushed-sha -> pre-existing behavior preserved (exit 1)', () => {
  const { dir, baseSha, beforeSha, pushedTip } = buildSupersedeRepro();
  const { out, code } = runCli(dir, [
    `--before-sha=${beforeSha}`,
    `--base-sha=${baseSha}`,
    `--check-ref=${pushedTip}`,
  ]);
  assert.equal(code, 1, `expected old behavior without the flag. Output:\n${out}`);
  assert.match(out, /REVERTED/);
});

test('CLI: post-push clobber (check-ref moved past what we pushed, our lines gone) still fails WITH --pushed-sha', () => {
  const { dir, baseSha, beforeSha } = buildSupersedeRepro();
  // pushed commit carries OUR content (a healthy resolution)...
  gitc(dir, 'branch', 'healthy-pushed', baseSha);
  gitc(dir, 'checkout', '-q', 'healthy-pushed');
  execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, 'review.json'))}, '{"outlet":"thr","fullText":"POLLER-COLLECTED-TEXT"}\\n')`]);
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'pushed: our content intact');
  const healthyPushed = gitc(dir, 'rev-parse', 'HEAD').trim();
  // ...but the ref tip afterwards holds a clobbered third version
  execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, 'review.json'))}, '{"outlet":"thr","fullText":"STALE-CLOBBER"}\\n')`]);
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'concurrent: stale write clobbered us post-push');
  const clobberTip = gitc(dir, 'rev-parse', 'HEAD').trim();
  gitc(dir, 'checkout', '-q', 'main');

  const { out, code } = runCli(dir, [
    `--before-sha=${beforeSha}`,
    `--base-sha=${baseSha}`,
    `--check-ref=${clobberTip}`,
    `--pushed-sha=${healthyPushed}`,
  ]);
  assert.equal(code, 1, `expected post-push clobber to still fail. Output:\n${out}`);
  assert.match(out, /REVERTED/);
});
