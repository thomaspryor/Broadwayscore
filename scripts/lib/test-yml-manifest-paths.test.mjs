// Colocated test for the manifest-vs-push-paths gate.
//
// CLAUDE.md §15: this require()s the real decision function and drives the real
// binary. It never restates the rule — a test carrying its own copy of the rule
// is how a "fix" ships as a CI no-op (the stale-announced incident, BRO-343 v23).
//
// Two things must hold, and the second is the one that matters:
//   1. The live repo has zero gaps (the invariant this gate protects).
//   2. The gate actually FIRES on a tree that has one. A green gate that cannot
//      go red is not a gate, and #1 alone can never tell the two apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findManifestPathGaps, readManifestEntries, MANIFEST_FILES } = require('./test-yml-manifest-paths.js');
const { readPushPaths, isCovered } = require('./test-yml-push-paths.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO, 'scripts', 'audit-test-yml-manifest-paths.js');

/** A minimal repo tree: a test.yml push-paths block plus both manifests. */
function fixture({ pushPaths, manifestEntries, tsxEntries = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-paths-'));
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.github/workflows/test.yml'),
    ['name: Test Suite', 'on:', '  push:', '    branches: [main]', '    paths:',
      ...pushPaths.map((p) => `      - '${p}'`),
      '  schedule:', "    - cron: '0 6 * * *'", 'jobs: {}', ''].join('\n')
  );
  // Derived from MANIFEST_FILES, never a hardcoded pair: when the gate learned
  // about a third manifest, a hardcoded fixture broke every test with
  // "manifest not found" instead of exercising the rule.
  const contents = {
    'tests/unit-test-manifest.txt': manifestEntries,
    'tests/unit-test-manifest-tsx.txt': tsxEntries,
  };
  for (const m of MANIFEST_FILES) {
    fs.mkdirSync(path.dirname(path.join(dir, m)), { recursive: true });
    fs.writeFileSync(path.join(dir, m), (contents[m] ?? []).join('\n') + '\n');
  }
  return dir;
}

test('the live repo has zero gaps — every manifest-registered test is push-path reachable', () => {
  const gaps = findManifestPathGaps(REPO);
  assert.deepEqual(
    gaps.map((g) => g.test),
    [],
    'A manifest-registered test that no push path reaches RUNS in CI but a push touching only ' +
      "it triggers zero CI. Add each to on.push.paths in .github/workflows/test.yml."
  );
});

test('the gate is not vacuous: an uncovered manifest entry IS reported', () => {
  const dir = fixture({
    pushPaths: ['src/**', 'tests/**', 'scripts/lib/**'],
    manifestEntries: [
      'tests/unit/covered-by-tests-glob.test.mjs',
      'scripts/lib/covered-by-lib-glob.test.mjs',
      'scripts/orphan-no-path-entry.test.mjs', // the gap
    ],
  });
  try {
    const gaps = findManifestPathGaps(dir);
    assert.deepEqual(gaps.map((g) => g.test), ['scripts/orphan-no-path-entry.test.mjs']);
    assert.equal(gaps[0].manifest, 'tests/unit-test-manifest.txt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicit path entry closes the gap — the fix the error message tells you to make actually works', () => {
  const dir = fixture({
    pushPaths: ['src/**', 'tests/**', 'scripts/orphan-no-path-entry.test.mjs'],
    manifestEntries: ['scripts/orphan-no-path-entry.test.mjs'],
  });
  try {
    assert.deepEqual(findManifestPathGaps(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the tsx manifest is scanned too, and gaps name the manifest they came from', () => {
  const dir = fixture({
    pushPaths: ['tests/**'],
    manifestEntries: [],
    tsxEntries: ['scripts/tests/only-in-tsx-manifest.test.mjs'],
  });
  try {
    const gaps = findManifestPathGaps(dir);
    assert.deepEqual(gaps, [
      { test: 'scripts/tests/only-in-tsx-manifest.test.mjs', manifest: 'tests/unit-test-manifest-tsx.txt' },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('comments and blank lines in a manifest are not treated as test paths', () => {
  const dir = fixture({ pushPaths: ['tests/**'], manifestEntries: ['# a comment', '', '  ', 'tests/unit/x.test.mjs'] });
  try {
    assert.deepEqual(findManifestPathGaps(dir), []);
    assert.deepEqual(
      readManifestEntries(path.join(dir, 'tests/unit-test-manifest.txt')),
      ['tests/unit/x.test.mjs']
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('it fails CLOSED when the push-paths block cannot be parsed, rather than declaring everything fine', () => {
  const dir = fixture({ pushPaths: [], manifestEntries: ['scripts/whatever.test.mjs'] });
  try {
    assert.throws(() => findManifestPathGaps(dir), /parsed 0 push paths/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real binary exits 1 on a gap and 0 without one', () => {
  // Drives the CLI itself, so the exit-code wiring CI depends on is executed,
  // not merely read. The step is blocking: a wrong exit code here is a gate
  // that reports success while main can go dark.
  const gapDir = fixture({
    pushPaths: ['tests/**'],
    manifestEntries: ['scripts/orphan-no-path-entry.test.mjs'],
  });
  const cleanDir = fixture({
    pushPaths: ['tests/**', 'scripts/orphan-no-path-entry.test.mjs'],
    manifestEntries: ['scripts/orphan-no-path-entry.test.mjs'],
  });
  try {
    const bad = spawnSync(process.execPath, [CLI, `--root=${gapDir}`], { encoding: 'utf8' });
    assert.equal(bad.status, 1, `expected exit 1 on a gap, got ${bad.status}`);
    assert.match(`${bad.stdout}${bad.stderr}`, /orphan-no-path-entry\.test\.mjs/);

    const good = spawnSync(process.execPath, [CLI, `--root=${cleanDir}`], { encoding: 'utf8' });
    assert.equal(good.status, 0, `expected exit 0 with no gap, got ${good.status}: ${good.stderr}`);
    assert.match(good.stdout, /no gaps/);

    const json = spawnSync(process.execPath, [CLI, `--root=${gapDir}`, '--json'], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(json.stdout).gaps.map((g) => g.test), ['scripts/orphan-no-path-entry.test.mjs']);
  } finally {
    fs.rmSync(gapDir, { recursive: true, force: true });
    fs.rmSync(cleanDir, { recursive: true, force: true });
  }
});

test('push-path globs keep GitHub Actions semantics: ** crosses segments, bare * does not', () => {
  // Guards the shared parser both audits now depend on. `next.config.*` and
  // `tsconfig.*` in the real allow-list rely on the single-segment `*`.
  const entries = readPushPaths(
    ['on:', '  push:', '    paths:', "      - 'scripts/lib/**'", "      - 'next.config.*'", 'jobs: {}'].join('\n')
  );
  assert.deepEqual(entries, ['scripts/lib/**', 'next.config.*']);
  assert.ok(isCovered('scripts/lib/deep/nested/a.test.mjs', entries), '** must cross segments');
  assert.ok(isCovered('next.config.js', entries));
  assert.ok(!isCovered('next.config.d/inner.js', entries), 'bare * must not cross a segment boundary');
  assert.ok(!isCovered('scripts/top-level.js', entries));
});

test('MANIFEST_FILES covers EVERY manifest test.yml actually consumes — not just the ones we remembered', () => {
  // The first version of this gate scanned two manifests and its assertion said
  // "both", while test.yml reads three. That is the shape of blind spot that lets
  // this bug class return: a gate that is green because it never looked. So do not
  // assert against a hardcoded list — derive the truth from test.yml itself.
  const yml = fs.readFileSync(path.join(REPO, '.github/workflows/test.yml'), 'utf8');
  const consumed = [...yml.matchAll(/tests\/[a-z0-9-]*manifest[a-z0-9-]*\.txt/g)].map((m) => m[0]);
  const missing = [...new Set(consumed)].filter((m) => !MANIFEST_FILES.includes(m));
  assert.deepEqual(
    missing,
    [],
    `test.yml consumes manifest(s) the gate never scans: ${missing.join(', ')}. ` +
      'A test registered there but placed outside every push-path glob would trigger zero CI ' +
      'with this gate reporting green. Add them to MANIFEST_FILES.'
  );
  for (const m of MANIFEST_FILES) {
    assert.ok(fs.existsSync(path.join(REPO, m)), `${m} is named by the gate but missing from the repo`);
  }
  assert.ok(MANIFEST_FILES.length >= 3, `expected at least the 3 known manifests, got ${MANIFEST_FILES.length}`);
});

test('glob translation handles the forms a blocking gate must not get wrong', () => {
  // All three were latent (no current entry hits them) and all three were found in
  // pre-merge review. On a BLOCKING gate a crash or a false green is a CI outage.
  const q = readPushPaths(["on:", "  push:", "    paths:", "      - 'foo?.js'", 'jobs: {}'].join('\n'));
  assert.ok(isCovered('foo?.js', q), "'?' must be a literal, not a regex quantifier");
  assert.ok(!isCovered('fo.js', q), "unescaped '?' would have matched 'fo.js'");

  const spaced = ["dir with space/**"];
  assert.ok(isCovered('dir with space/a.test.mjs', spaced), 'a real space must stay literal');
  assert.ok(!isCovered('dirXwithXspace/a.test.mjs', spaced), 'the space placeholder must not leak into .*');

  // GitHub applies paths in order, last match wins, so an exclusion takes coverage back.
  const negated = ['scripts/lib/**', '!scripts/lib/generated/**'];
  assert.ok(isCovered('scripts/lib/real.test.mjs', negated));
  assert.ok(!isCovered('scripts/lib/generated/x.test.mjs', negated), 'a ! entry must REMOVE coverage, not add it');
  assert.ok(isCovered('scripts/lib/generated/x.test.mjs', ['scripts/lib/**']), 'control: positive-only still covers');
});
