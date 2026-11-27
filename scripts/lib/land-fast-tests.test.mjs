// land-fast-tests.js (BRO-7150): which tests run first, and in which land gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const F = require('./land-fast-tests.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const universe = {
  nodeSet: new Set(['tests/unit/a.test.mjs', 'tests/unit/b.test.mjs', 'tests/unit/c.test.mjs', 'tests/unit/slow.test.mjs', 'tests/unit/inv.test.mjs']),
  tsxSet: new Set(['tests/unit/t.test.ts']),
  libFiles: ['scripts/lib/x.test.mjs'],
};
const texts = {
  'tests/unit/a.test.mjs': "import '../../scripts/lib/widget-maker.js'",
  'tests/unit/b.test.mjs': "readFileSync('.github/workflows/' + f)",
  'tests/unit/c.test.mjs': 'nothing relevant',
  'tests/unit/slow.test.mjs': 'scripts/lib/widget-maker.js',
  'tests/unit/inv.test.mjs': 'repo-wide',
  'tests/unit/t.test.ts': 'widget-maker',
  'scripts/lib/x.test.mjs': "require('./widget-maker.js')",
};
const sel = (changed, extra = {}) => F.selectFastTests({ changed, universe, readText: (f) => texts[f], invariants: ['tests/unit/inv.test.mjs'], slow: new Set(['tests/unit/slow.test.mjs']), ...extra });

test('gateFor maps files to their land gate', () => {
  assert.equal(F.gateFor('scripts/lib/x.test.mjs', universe), 'scripts-lib-tests');
  assert.equal(F.gateFor('tests/unit/a.test.mjs', universe), 'unit-tests-node');
  assert.equal(F.gateFor('tests/unit/t.test.ts', universe), 'unit-tests-tsx');
  assert.equal(F.gateFor('tests/e2e/z.spec.ts', universe), null);
});

test('invariants always run; tests naming a changed file are picked; slow ones are left out', () => {
  const r = sel(['scripts/lib/widget-maker.js']);
  const files = r.files.map((f) => f.file);
  assert.ok(files.includes('tests/unit/inv.test.mjs'), 'invariant');
  assert.ok(files.includes('tests/unit/a.test.mjs'), 'names the path');
  assert.ok(files.includes('scripts/lib/x.test.mjs'), 'names the basename');
  assert.ok(files.includes('tests/unit/t.test.ts'), 'names the stem');
  assert.ok(!files.includes('tests/unit/c.test.mjs'));
  assert.ok(!files.includes('tests/unit/slow.test.mjs'));
  assert.equal(r.skipped.slow, 1);
});

test('a changed test runs even when slow; a dir literal pulls in tests that scan it', () => {
  const files = sel(['tests/unit/slow.test.mjs', '.github/workflows/land.yml']).files.map((f) => f.file);
  assert.ok(files.includes('tests/unit/slow.test.mjs'));
  assert.ok(files.includes('tests/unit/b.test.mjs'));
});

test('broad dirs and the cap keep the set small, strongest matches first', () => {
  assert.equal(F.matchTier('scripts/lib/zz.js', 'q', "'scripts/lib'"), null);
  // BRO-7729: a skill or command edit must pull in the parity test that compares the committed mirror.
  assert.equal(F.matchTier('.claude/commands/wrap-up.md', 'tests/unit/codex-parity.test.mjs', "join(ROOT, '.claude', 'settings.json')")?.tier, 1);
  assert.equal(F.matchTier('.claude/skills/x/SKILL.md', 'tests/unit/codex-parity.test.mjs', '')?.tier, 1);
  assert.equal(F.matchTier('.claude/hooks/a.sh', 'tests/unit/codex-parity.test.mjs', ''), null);
  for (const [, testFile] of F.MIRRORED_SOURCES) assert.ok(fs.existsSync(testFile), `${testFile} exists`);
  const r = sel(['scripts/lib/widget-maker.js'], { maxTargeted: 1 });
  // a names the full path (tier 1, never capped); the cap of 1 keeps one weaker match (x, basename) and drops t (stem).
  assert.deepEqual(r.files.map((f) => f.file), ['tests/unit/inv.test.mjs', 'tests/unit/a.test.mjs', 'scripts/lib/x.test.mjs']);
  assert.ok(r.skipped.overCap >= 1);
});

test('a test that names a changed file by full path is never cut by the cap (BRO-7628 land refusal)', () => {
  // 60 alphabetically-early tests that only name the basename, plus one late test that reads the file by path.
  const nodeSet = new Set(['tests/unit/zz-reads-by-path.test.mjs']);
  const t = { 'tests/unit/zz-reads-by-path.test.mjs': "read('src/app/my-shows/MyShowsClient.tsx')" };
  for (let i = 0; i < 60; i++) { const f = `tests/unit/a${String(i).padStart(2, '0')}.test.mjs`; nodeSet.add(f); t[f] = 'MyShowsClient.tsx'; }
  const r = F.selectFastTests({ changed: ['src/app/my-shows/MyShowsClient.tsx'], universe: { nodeSet, tsxSet: new Set(), libFiles: [] }, readText: (f) => t[f], invariants: [] });
  const files = r.files.map((f) => f.file);
  assert.ok(files.includes('tests/unit/zz-reads-by-path.test.mjs'), 'strong match kept');
  assert.equal(files.length, 1 + F.MAX_TARGETED, 'weak matches still capped');
});

test('writeScopeDir writes one <gate>.files per gate used', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'lft-'));
  try {
    const gates = F.writeScopeDir(dir, sel(['scripts/lib/widget-maker.js']).files);
    assert.deepEqual(gates.sort(), ['scripts-lib-tests', 'unit-tests-node', 'unit-tests-tsx']);
    assert.match(fs.readFileSync(path.join(dir, 'unit-tests-node.files'), 'utf8'), /inv\.test\.mjs/);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('every listed invariant and slow test exists in a fast gate of this tree', () => {
  const u = F.universeFor(ROOT);
  for (const f of F.INVARIANT_TESTS) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
    assert.ok(F.gateFor(f, u), `${f} runs in a fast gate`);
  }
  assert.deepEqual([...F.INVARIANT_TESTS].sort(), F.INVARIANT_TESTS, 'INVARIANT_TESTS stays sorted');
  for (const f of F.SLOW_TESTS) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
});

test('parseArgs requires a command and --base', () => {
  assert.ok(F.parseArgs(['select']).error);
  assert.ok(F.parseArgs(['nope', '--base', 'x']).error);
  assert.equal(F.parseArgs(['run', '--base', 'abc', '--tip', 'def']).tip, 'def');
});

test('a skipped invariant stays out when only named, and runs when the test itself changed', () => {
  const skip = new Set(['tests/unit/inv.test.mjs']);
  const named = sel(['scripts/lib/widget-maker.js'], { skip, invariants: ['tests/unit/inv.test.mjs'] }).files.map((f) => f.file);
  assert.ok(!named.includes('tests/unit/inv.test.mjs'));
  texts['tests/unit/inv.test.mjs'] = 'scripts/lib/widget-maker.js';
  try {
    const again = sel(['scripts/lib/widget-maker.js'], { skip }).files.map((f) => f.file);
    assert.ok(!again.includes('tests/unit/inv.test.mjs'), 'naming the changed file does not pull a skipped test back in');
  } finally { texts['tests/unit/inv.test.mjs'] = 'repo-wide'; }
  const changed = sel(['tests/unit/inv.test.mjs'], { skip }).files.map((f) => f.file);
  assert.ok(changed.includes('tests/unit/inv.test.mjs'));
});

test('mirrorLandRegeneration regenerates a stale doc only when base land-rebase.sh does', async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'lft-mirror-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  try {
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    fs.mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts/generate-workflow-dependencies.js'),
      "const fs=require('fs');if(process.argv.includes('--check'))process.exit(fs.readFileSync('doc','utf8')==='new\\n'?0:1);fs.writeFileSync('doc','new\\n');\n");
    fs.writeFileSync(path.join(dir, 'doc'), 'old\n');
    fs.writeFileSync(path.join(dir, 'scripts/lib/land-rebase.sh'), '# no refresh here\n');
    g('add', '-A'); g('commit', '-qm', 'old base');
    assert.equal(F.mirrorLandRegeneration(dir, 'HEAD'), false, 'base cannot regenerate: leave the doc stale, as land.yml would');
    assert.equal(fs.readFileSync(path.join(dir, 'doc'), 'utf8'), 'old\n');
    fs.writeFileSync(path.join(dir, 'scripts/lib/land-rebase.sh'), 'refresh_generated_docs() { :; }\n');
    g('commit', '-qam', 'new base');
    assert.equal(F.mirrorLandRegeneration(dir, 'HEAD'), true);
    assert.equal(fs.readFileSync(path.join(dir, 'doc'), 'utf8'), 'new\n');
    assert.equal(F.mirrorLandRegeneration(dir, 'HEAD'), false, 'already fresh');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('a very wide diff skips name matching: invariants plus the changed tests only', () => {
  const r = sel(['scripts/lib/widget-maker.js', 'tests/unit/c.test.mjs'], { maxChanged: 1 });
  assert.deepEqual(r.files.map((f) => f.file).sort(), ['tests/unit/c.test.mjs', 'tests/unit/inv.test.mjs']);
  assert.equal(r.skipped.wideDiff, 2);
  assert.equal(sel(['scripts/lib/widget-maker.js']).skipped.wideDiff, 0);
});

// BRO-7637: land run 39741371743 (land/bro-5887-probe) was refused by land.js colocated-tests on
// scripts/verify-reddit-review-check.test.mjs, a changed test no CI gate collects, so name matching
// never picked it. colocatedTests() is decideChecks' own list; selectFastTests runs those regardless.
test('colocated tests outside every CI gate still run (land.js colocated-tests parity)', () => {
  const colocated = [{ file: 'scripts/verify-probe.test.mjs', tsx: false }, { file: 'scripts/lib/q.test.ts', tsx: true }, { file: 'tests/unit/a.test.mjs', tsx: false }];
  const r = sel(['scripts/verify-probe.test.mjs', 'scripts/lib/q.ts', 'scripts/lib/widget-maker.js'], { colocated });
  const by = Object.fromEntries(r.files.map((f) => [f.file, f]));
  assert.equal(by['scripts/verify-probe.test.mjs'].gate, 'unit-tests-node');
  assert.equal(by['scripts/lib/q.test.ts'].gate, 'unit-tests-tsx');
  assert.equal(by['tests/unit/a.test.mjs'].gate, 'unit-tests-node', 'a collected one keeps its own gate');
  assert.ok(!sel(['scripts/lib/q.ts']).files.some((f) => f.file === 'scripts/lib/q.test.ts'), 'without the list it is missed');
  const slow = sel(['scripts/lib/widget-maker.js'], { colocated: [{ file: 'tests/unit/slow.test.mjs', tsx: false }] });
  assert.ok(!slow.files.some((f) => f.file === 'tests/unit/slow.test.mjs'), 'a slow colocated test of an unchanged test file stays with the full gauntlet');
});

test('colocatedTests reads the tree with autonomous-checks decideChecks', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'lft-colo-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'scripts/lib/autonomous-checks.js'), path.join(dir, 'scripts/lib/autonomous-checks.js'));
    for (const f of ['scripts/lib/w.js', 'scripts/lib/w.test.mjs', 'scripts/verify-x.test.mjs']) fs.writeFileSync(path.join(dir, f), '');
    const got = F.colocatedTests(dir, ['scripts/lib/w.js', 'scripts/verify-x.test.mjs', 'scripts/gone.test.mjs']).map((c) => c.file).sort();
    assert.deepEqual(got, ['scripts/lib/w.test.mjs', 'scripts/verify-x.test.mjs']);
    assert.deepEqual(F.colocatedTests(path.join(dir, 'nope'), ['scripts/lib/w.js']), [], 'an older tree without the module selects nothing extra');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

// BRO-7637 ship-check: a tsx-run colocated test must run under tsx even when its path also matches the
// scripts/lib node gate; and colocatedTests must read the manifests land.js reads (readTsxRunTests).
test('a tsx colocated test under scripts/lib runs in the tsx gate', () => {
  const r = sel(['scripts/lib/q.ts'], { colocated: [{ file: 'scripts/lib/q.test.mjs', tsx: true }] });
  assert.equal(r.files.find((f) => f.file === 'scripts/lib/q.test.mjs')?.gate, 'unit-tests-tsx');
});
test('colocatedTests uses the same tsx manifests as land.js', () => {
  const src = fs.readFileSync(new URL('./land-fast-tests.js', import.meta.url), 'utf8');
  assert.match(src, /readTsxRunTests\(root\)/);
  assert.doesNotMatch(src, /readTsxManifest\(root\)/);
});

test('a change to scripts/lib/land-*.js or .github/ selects undriven-rebase-lint (BRO-7814)', () => {
  const lintTest = 'scripts/lib/undriven-rebase-lint.test.mjs';
  const u = { ...universe, libFiles: [...universe.libFiles, lintTest] };
  const pick = (changed) => F.selectFastTests({ changed, universe: u, readText: () => 'unrelated', invariants: [], slow: new Set() }).files.map((f) => f.file);
  assert.ok(pick(['scripts/lib/land-local-check.js']).includes(lintTest), 'land-local-check.js');
  assert.ok(pick(['scripts/lib/land-rebase.sh']).includes(lintTest), 'land-rebase.sh');
  assert.ok(pick(['.github/workflows/land.yml']).includes(lintTest), 'land.yml');
  assert.ok(!pick(['scripts/lib/widget-maker.js']).includes(lintTest), 'unrelated file');
});

test('a .github change selects tests that scan .github through fs without naming the file (BRO-7814 cousins)', () => {
  const u = { nodeSet: new Set(['tests/unit/scan.test.mjs', 'tests/unit/other.test.mjs']), tsxSet: new Set(), libFiles: [] };
  const t = { 'tests/unit/scan.test.mjs': "const DIR = path.join(root, '.github', 'workflows');\nconst files = fs.readdirSync(DIR);", 'tests/unit/other.test.mjs': "const w = path.join(root, '.github', 'workflows'); // a path, never listed" };
  const pick = (changed) => F.selectFastTests({ changed, universe: u, readText: (f) => t[f], invariants: [], slow: new Set() }).files.map((f) => f.file);
  assert.deepEqual(pick(['.github/workflows/land.yml']), ['tests/unit/scan.test.mjs']);
  assert.deepEqual(pick(['scripts/lib/widget-maker.js']), [], 'a non-.github change does not pull it in');
});

test('BRO-7150: depsChangedFiles names a package.json/lock change on base...tip (the CLI then skips)', () => {
  let seen;
  const stub = (out, code = 0) => (cwd, args) => { seen = args; return { code, stdout: out, stderr: '' }; };
  assert.deepEqual(F.depsChangedFiles('/r', 'B', 'T', stub('package-lock.json\npackage.json')), ['package-lock.json', 'package.json']);
  assert.deepEqual(seen, ['diff', '--name-only', 'B...T', '--', 'package.json', 'package-lock.json']);
  assert.deepEqual(F.depsChangedFiles('/r', 'B', 'T', stub('')), []);
  assert.deepEqual(F.depsChangedFiles('/r', 'B', 'T', stub('package.json', 128)), [], 'git failure: judge as usual');
});
