/**
 * invisible-verification-scan.test.mjs — task #1075.
 *
 * Locks the scanner behind audit-invisible-verification.js: a literal
 * `git show <ref>:<gitignored-path>` read is a check that can never see its
 * subject, so it must be flagged; everything else must not be.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { findGitRefReads, findInvisibleVerifications } = require(
  path.join(REPO, 'scripts/lib/invisible-verification-scan.js')
);

const IGNORED = new Set(['data/shows.json', 'data/reviews.json']);
const isIgnored = (p) => IGNORED.has(p);

test('finds literal git show / cat-file reads with ref and path', () => {
  const reads = findGitRefReads([
    "const s = execSync('git show origin/main:data/shows.json');",
    'if git cat-file -e HEAD:CLAUDE.md 2>/dev/null; then',
  ].join('\n'));
  assert.equal(reads.length, 2);
  assert.deepEqual(
    reads.map((r) => [r.ref, r.filePath]),
    [['origin/main', 'data/shows.json'], ['HEAD', 'CLAUDE.md']]
  );
});

test('skips fully-interpolated paths — no literal prefix to judge', () => {
  const reads = findGitRefReads([
    'git show "$ref:$file"',
    'execSync(`git show ${BASE_REF}:${relPath}`)',
    'git show HEAD:${f}',
  ].join('\n'));
  assert.deepEqual(reads, []);
});

// Adversarial-review findings, 2026-08-06: the first cut of the regex only
// matched `git show|cat-file -e` directly after `git`, and only fully-literal
// paths — so these five real shapes walked straight through the gate.
test('catches git -C, cat-file -p and cat-file blob forms', () => {
  const reads = findGitRefReads([
    'execSync("git -C /repo show origin/main:data/shows.json")',
    'git cat-file -p HEAD:data/reviews.json',
    'git cat-file blob origin/main:data/shows.json',
  ].join('\n'));
  assert.equal(reads.length, 3);
  assert.deepEqual(reads.map((r) => r.filePath), [
    'data/shows.json', 'data/reviews.json', 'data/shows.json',
  ]);
});

test('an interpolated FILENAME under a gitignored directory is still flagged', () => {
  const ignoredDir = (p) => p === 'data/review-texts/';
  const files = [{
    path: 'scripts/watch-corpus.js',
    source: 'execSync(`git show origin/main:data/review-texts/${showId}/nytimes.json`)',
  }];
  const { violations } = findInvisibleVerifications({ files, isIgnored: ignoredDir });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].probePath, 'data/review-texts/');
  assert.equal(violations[0].literal, false);
});

test('an interpolated path under a TRACKED directory is not flagged', () => {
  const files = [{
    path: 'scripts/ok.js',
    source: 'execSync(`git show origin/main:src/config/${name}.ts`)',
  }];
  assert.deepEqual(findInvisibleVerifications({ files, isIgnored }).violations, []);
});

test('an interpolated REF with a literal path is still scanned', () => {
  // scripts/scoring-delta.js's real shape — the ref varies, the path does not,
  // and the path is what determines observability.
  const reads = findGitRefReads('execSync(`git show ${BASE_REF}:data/critic-registry.json`)');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].filePath, 'data/critic-registry.json');
});

test('flags exactly the gitignored targets — the reads that can only fail', () => {
  const files = [
    { path: 'scripts/watch-thing.js', source: "execSync('git show origin/main:data/shows.json')" },
    { path: 'scripts/ok.js', source: "execSync('git show origin/main:CLAUDE.md')" },
  ];
  const { violations, readsFound, scanned } = findInvisibleVerifications({ files, isIgnored });
  assert.equal(scanned, 2);
  assert.equal(readsFound, 2);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, 'scripts/watch-thing.js');
  assert.equal(violations[0].filePath, 'data/shows.json');
  assert.equal(violations[0].line, 1);
});

test('an explicit observability-ok marker on the line exempts it', () => {
  const files = [{
    path: 'scripts/deliberate.js',
    source: "execSync('git show origin/main:data/shows.json') // observability-ok: absence handled as CANNOT_OBSERVE",
  }];
  assert.deepEqual(findInvisibleVerifications({ files, isIgnored }).violations, []);
});

test('the marker also exempts the line directly below it', () => {
  const files = [{
    path: 'scripts/deliberate.js',
    source: [
      '// observability-ok: null hash forces a replay, never a "same" verdict',
      "execSync('git show origin/main:data/shows.json')",
    ].join('\n'),
  }];
  assert.deepEqual(findInvisibleVerifications({ files, isIgnored }).violations, []);
});

test('a comment describing the pattern is not itself a read', () => {
  const source = [
    ' * a watcher grepped `git show origin/main:data/shows.json` in THIS repo',
    '# git show origin/main:data/reviews.json',
    "// execSync('git show origin/main:data/shows.json')",
  ].join('\n');
  assert.deepEqual(findGitRefReads(source), []);
});

test('a trailing comment after real code does NOT exempt the code', () => {
  const files = [{
    path: 'scripts/sneaky.js',
    source: "execSync('git show origin/main:data/shows.json') // TODO handle failure",
  }];
  assert.equal(findInvisibleVerifications({ files, isIgnored }).violations.length, 1);
});

test('requires an isIgnored predicate rather than silently passing', () => {
  assert.throws(() => findInvisibleVerifications({ files: [] }), TypeError);
});
