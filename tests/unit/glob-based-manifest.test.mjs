// BRO-2483: the plain-node unit batch is COLLECTED from the tree
// (scripts/lib/unit-test-collection.js) instead of read from the hand-edited,
// sorted tests/unit-test-manifest.txt, which is now a tombstone. Drives the
// real module (CLAUDE.md §15) against fixture trees and the real repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../../scripts/lib/unit-test-collection.js');
const { readManifest, validateManifest, sortManifestFile } = require('../../scripts/lib/test-manifest.js');
const { UNREGISTERED_TEST_QUARANTINE } = require('../../scripts/lib/test-yml-manifest-paths.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'scripts', 'lib', 'unit-test-collection.js');
const OPT_IN_SAMPLE = [...C.OPT_IN][0];
const EXCLUDED_SAMPLE = 'tests/unit/dmarc-deliverability.test.mjs';

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-manifest-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

function fixture(extra = {}) {
  return tree({
    'tests/unit/existing.test.mjs': '',
    'tests/unit/brand-new.test.mjs': '', // added with NO registration anywhere
    'tests/unit/legacy.test.js': '',
    'tests/unit/helper.mjs': '', // not a test
    'tests/unit/sub/nested.test.mjs': '', // non-recursive scan
    'tests/unit/types.test.ts': '', // .ts runs under tsx, never the node batch
    'tests/unit/tsx-only.test.mjs': '',
    'tests/unit/e2e-only.test.mjs': '',
    [EXCLUDED_SAMPLE]: '',
    'tests/smoke/smoky.test.mjs': '',
    'scripts/foo.test.mjs': '',
    'scripts/verify-x.test.mjs': '', // live acceptance probe: default-excluded
    'scripts/_skip-y.test.mjs': '',
    [OPT_IN_SAMPLE]: '',
    'scripts/tests/t.test.cjs': '',
    'scripts/newsletter/n.test.mjs': '',
    'scripts/llm-scoring/l.test.mjs': '',
    'scripts/lib/colocated.test.mjs': '', // the scripts/lib/*.test.mjs step runs these
    'scripts/lib/title.test.js': '', // ...but not .js, so the batch takes it
    'scripts/other/o.test.mjs': '', // not a collected dir
    'tests/unit-test-manifest-tsx.txt': 'tests/unit/tsx-only.test.mjs\n',
    'tests/e2e-unit-test-manifest.txt': '# e2e\ntests/unit/e2e-only.test.mjs\n',
    'tests/unit-test-manifest.txt': '# RETIRED\ntests/unit/ghost.test.mjs\nscripts/other/o.test.mjs\n',
    ...extra,
  });
}

test('a fixture tree: new tests are collected with no registration; probes, tsx/e2e and exclusions are not', () => {
  const root = fixture();
  assert.deepEqual(C.collectNodeUnitTests(root), [
    OPT_IN_SAMPLE,
    'scripts/foo.test.mjs',
    'scripts/lib/title.test.js',
    'scripts/llm-scoring/l.test.mjs',
    'scripts/newsletter/n.test.mjs',
    'scripts/tests/t.test.cjs',
    'tests/smoke/smoky.test.mjs',
    'tests/unit/brand-new.test.mjs',
    'tests/unit/existing.test.mjs',
    'tests/unit/legacy.test.js',
  ].sort());
});

test('the reason for each left-out candidate names its rule', () => {
  const others = new Set(C.readOtherRunnerEntries(fixture()));
  assert.match(C.exclusionReason('scripts/verify-x.test.mjs', { otherRunnerEntries: others }), /verify-\* or _skip-\*/);
  assert.match(C.exclusionReason('tests/unit/tsx-only.test.mjs', { otherRunnerEntries: others }), /tsx or e2e manifest/);
  assert.match(C.exclusionReason('tests/unit/e2e-only.test.mjs', { otherRunnerEntries: others }), /tsx or e2e manifest/);
  assert.equal(C.exclusionReason(EXCLUDED_SAMPLE), C.EXCLUDED.get(EXCLUDED_SAMPLE));
  assert.equal(C.exclusionReason(OPT_IN_SAMPLE), null);
  assert.equal(C.exclusionReason('tests/unit/brand-new.test.mjs'), null);
});

test('the tombstone is never read: its lines neither add nor remove tests', () => {
  const root = fixture();
  const withTombstone = C.collectNodeUnitTests(root);
  fs.rmSync(path.join(root, 'tests/unit-test-manifest.txt'));
  assert.deepEqual(C.collectNodeUnitTests(root), withTombstone);
  assert.ok(!withTombstone.includes('tests/unit/ghost.test.mjs'));
  assert.ok(!withTombstone.includes('scripts/other/o.test.mjs'));
});

test('readManifest/validateManifest resolve the node path to the collection in a collector tree', () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
  fs.copyFileSync(CLI, path.join(root, 'scripts/lib/unit-test-collection.js'));
  const node = path.join(root, 'tests/unit-test-manifest.txt');
  const expected = C.collectNodeUnitTests(root);
  assert.deepEqual(readManifest(node), expected, 'list lines in the tombstone never reach the batch');
  fs.writeFileSync(node, '# RETIRED (BRO-2483)\n');
  assert.deepEqual(readManifest(node), expected);
  assert.deepEqual(readManifest(node, root), expected);
  const v = validateManifest(node, root);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.entries, expected);
  // The tombstone is never rewritten by the auto-sort (it would gain the whole list).
  const before = fs.readFileSync(node, 'utf8');
  assert.equal(sortManifestFile(node), false);
  assert.equal(fs.readFileSync(node, 'utf8'), before);
  // The tombstone keeps the frozen old list (plus whatever in-flight branches
  // union-merge in): unsorted, duplicated or dangling list lines in it are
  // never parsed or judged (BRO-2483 tombstone design).
  fs.writeFileSync(node, `${C.RETIRED_HEADER.join('\n')}\nz.test.mjs\na.test.mjs\nz.test.mjs\ntests/unit/ghost.test.mjs\n`);
  assert.deepEqual(validateManifest(node, root).errors, []);
  assert.deepEqual(readManifest(node), expected);
});

test('the real tombstone opens with RETIRED_HEADER; hasRetiredHeader rejects anything else', () => {
  const text = fs.readFileSync(path.join(ROOT, 'tests/unit-test-manifest.txt'), 'utf8');
  assert.ok(C.hasRetiredHeader(text), 'tests/unit-test-manifest.txt must start with RETIRED_HEADER (unit-test-collection.js)');
  assert.ok(!C.hasRetiredHeader('tests/unit/a.test.mjs\n'));
  assert.ok(!C.hasRetiredHeader(`tests/unit/a.test.mjs\n${C.RETIRED_HEADER.join('\n')}\n`), 'the header must be ON TOP');
});

// Why the list stays: a branch cut BEFORE BRO-2483 appends one line to the old
// manifest; main has the header prepended to that list. With merge=union the
// land rebase is conflict-free, the header stays on top, and the node batch
// is unchanged (nothing reads the file).
test('union merge of an in-flight branch\'s added manifest line: no conflict, header stays on top, collector output unchanged', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-manifest-union-'));
  try {
    const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    const must = (...args) => { const r = git(...args); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r; };
    must('init', '-q', '-b', 'main');
    must('config', 'user.email', 't@t.t');
    must('config', 'user.name', 't');
    const oldList = Array.from({ length: 40 }, (_, i) => `tests/unit/t${String(i).padStart(2, '0')}.test.mjs`);
    fs.mkdirSync(path.join(repo, 'tests/unit'), { recursive: true });
    for (const rel of oldList) fs.writeFileSync(path.join(repo, rel), '');
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'tests/unit-test-manifest.txt merge=union\n');
    fs.writeFileSync(path.join(repo, 'tests/unit-test-manifest.txt'), oldList.join('\n') + '\n');
    must('add', '-A'); must('commit', '-qm', 'old manifest');
    must('checkout', '-qb', 'old-branch');
    fs.writeFileSync(path.join(repo, 'tests/unit/t19b-new.test.mjs'), '');
    const withNew = [...oldList.slice(0, 20), 'tests/unit/t19b-new.test.mjs', ...oldList.slice(20)];
    fs.writeFileSync(path.join(repo, 'tests/unit-test-manifest.txt'), withNew.join('\n') + '\n');
    must('add', '-A'); must('commit', '-qm', 'register a test the old way');
    must('checkout', '-q', 'main');
    // main also keeps appending in the old way for a while (other in-flight branches)...
    fs.writeFileSync(path.join(repo, 'tests/unit-test-manifest.txt'), `${C.RETIRED_HEADER.join('\n')}\n${[...oldList, 'tests/unit/t99-main.test.mjs'].join('\n')}\n`);
    fs.writeFileSync(path.join(repo, 'tests/unit/t99-main.test.mjs'), '');
    must('add', '-A'); must('commit', '-qm', 'BRO-2483: header prepended, list frozen');
    const before = C.collectNodeUnitTests(repo);
    must('checkout', '-q', 'old-branch');
    const rb = git('rebase', '-q', 'main');
    assert.equal(rb.status, 0, `the rebase must be conflict-free: ${rb.stderr}`);
    const merged = fs.readFileSync(path.join(repo, 'tests/unit-test-manifest.txt'), 'utf8');
    assert.ok(C.hasRetiredHeader(merged), 'header still on top after the union merge');
    assert.ok(merged.includes('tests/unit/t19b-new.test.mjs'), 'the in-flight line merged in (and is ignored)');
    // The batch is the collection of the tree: the merged-in line changes nothing;
    // the branch's new test file is collected because it exists, not because it is listed.
    const after = C.collectNodeUnitTests(repo);
    assert.deepEqual(after, [...before, 'tests/unit/t19b-new.test.mjs'].sort());
    fs.writeFileSync(path.join(repo, 'tests/unit-test-manifest.txt'), `${C.RETIRED_HEADER.join('\n')}\n`);
    assert.deepEqual(C.collectNodeUnitTests(repo), after, 'file content never affects the batch');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('a tree WITHOUT the collector (a pre-BRO-2483 base) still reads the manifest file', () => {
  const root = tree({
    'tests/unit/a.test.mjs': '',
    'tests/unit/b.test.mjs': '',
    'tests/unit-test-manifest.txt': 'tests/unit/a.test.mjs\n',
  });
  assert.deepEqual(C.nodeUnitTestsForTree(root), ['tests/unit/a.test.mjs']);
  assert.equal(C.treeUsesCollector(root), false);
  assert.deepEqual(readManifest(path.join(root, 'tests/unit-test-manifest.txt')), ['tests/unit/a.test.mjs']);
  fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
  fs.copyFileSync(CLI, path.join(root, 'scripts/lib/unit-test-collection.js'));
  assert.equal(C.treeUsesCollector(root), true);
  assert.deepEqual(C.nodeUnitTestsForTree(root), ['tests/unit/a.test.mjs', 'tests/unit/b.test.mjs']);
});

test('CLI: one path per line on the real repo; exit 1 on an empty tree', () => {
  const ok = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const lines = ok.stdout.trim().split('\n');
  assert.deepEqual(lines, C.collectNodeUnitTests(ROOT));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-manifest-empty-'));
  const bad = spawnSync(process.execPath, [CLI, '--root', empty], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /collected 0/);
  // --min: the floor test.yml and land-gauntlet.sh use. A small (fixture) tree
  // passes without it and fails with it, printing nothing for mapfile.
  const small = fixture();
  const plain = spawnSync(process.execPath, [CLI, '--root', small], { encoding: 'utf8' });
  assert.equal(plain.status, 0, plain.stderr);
  const floored = spawnSync(process.execPath, [CLI, '--root', small, '--min'], { encoding: 'utf8' });
  assert.equal(floored.status, 1);
  assert.equal(floored.stdout, '');
  assert.match(floored.stderr, new RegExp(`MIN_NODE_BATCH ${C.MIN_NODE_BATCH}`));
  const real = spawnSync(process.execPath, [CLI, '--min'], { encoding: 'utf8' });
  assert.equal(real.status, 0, real.stderr);
  // test.yml and land-gauntlet.sh call the CLI with --min instead of hand-coding the number.
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
  const gauntlet = fs.readFileSync(path.join(ROOT, 'scripts/lib/land-gauntlet.sh'), 'utf8');
  assert.match(yml, /node scripts\/lib\/unit-test-collection\.js --min/);
  assert.match(gauntlet, /node scripts\/lib\/unit-test-collection\.js --min/);
  assert.doesNotMatch(yml + gauntlet, /-lt 1000/);
});

test('the real repo: the node batch has >= MIN_NODE_BATCH files, all existing, none in the tsx/e2e manifests', () => {
  const list = C.collectNodeUnitTests(ROOT);
  assert.ok(list.length >= C.MIN_NODE_BATCH, `collected only ${list.length} (test.yml and land-gauntlet.sh floor at MIN_NODE_BATCH ${C.MIN_NODE_BATCH})`);
  for (const rel of list) assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
  const others = new Set(C.readOtherRunnerEntries(ROOT));
  assert.deepEqual(list.filter((rel) => others.has(rel)), []);
  assert.deepEqual(list.filter((rel) => /^scripts\/lib\/[^/]+\.test\.mjs$/.test(rel)), [], 'scripts/lib/*.test.mjs runs in its own step');
  assert.deepEqual([...list].sort(), list, 'sorted');
  assert.equal(new Set(list).size, list.length, 'no duplicates');
});

test('the real repo: every OPT_IN entry exists and matches the default-exclude pattern', () => {
  for (const rel of C.OPT_IN) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `stale OPT_IN entry: ${rel}`);
    assert.match(rel, C.DEFAULT_EXCLUDE_RE, `OPT_IN entry is not default-excluded, so listing it does nothing: ${rel}`);
    assert.ok(C.collectNodeUnitTests(ROOT).includes(rel), rel);
  }
});

test('the real repo: every EXCLUDED entry exists and has a non-empty reason', () => {
  for (const [rel, reason] of C.EXCLUDED) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `stale EXCLUDED entry: ${rel}`);
    assert.equal(typeof reason, 'string', rel);
    assert.ok(reason.trim().length > 0, `EXCLUDED entry has no reason: ${rel}`);
  }
  assert.deepEqual(C.staleListEntries({ files: C.listCandidateFiles(ROOT) }), []);
});

test('stale OPT_IN / EXCLUDED entries are reported', () => {
  const problems = C.staleListEntries({
    files: ['scripts/verify-real.test.mjs', 'tests/unit/kept.test.mjs', 'tests/unit/plain.test.mjs'],
    optIn: new Set(['scripts/verify-real.test.mjs', 'scripts/verify-gone.test.mjs', 'tests/unit/plain.test.mjs']),
    excluded: new Map([['tests/unit/kept.test.mjs', 'reason'], ['tests/unit/gone.test.mjs', 'reason'], ['tests/unit/plain.test.mjs', '  ']]),
  });
  assert.deepEqual(problems.sort(), [
    'EXCLUDED entry does not exist: tests/unit/gone.test.mjs',
    'EXCLUDED entry has no reason: tests/unit/plain.test.mjs',
    'OPT_IN entry does not exist: scripts/verify-gone.test.mjs',
    'OPT_IN entry is not default-excluded, so listing it does nothing: tests/unit/plain.test.mjs',
  ].sort());
});

test('the tests/unit quarantine is the same map test-yml-manifest-paths.js re-exports', () => {
  assert.equal(UNREGISTERED_TEST_QUARANTINE, C.TESTS_UNIT_QUARANTINE);
  for (const [rel, reason] of C.TESTS_UNIT_QUARANTINE) assert.equal(C.EXCLUDED.get(rel), reason);
});
