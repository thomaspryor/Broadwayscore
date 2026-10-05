import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  filterToplevelTestEntries, siblingSourcePath, findGaps,
  filterTestsDirEntries, toplevelScriptDeps,
  jobRunsOnPush, parseJobs, findWorkflowRunGaps, scriptsExecutedBy, joinContinuations,
} = require('./audit-toplevel-script-test-yml-coverage.js');
const { relativeSpecifiers, stripComments } = require('./audit-test-yml-lib-deps.js');

test('filterToplevelTestEntries: keeps only top-level scripts/*.test.(mjs|ts)', () => {
  const lines = [
    'scripts/fix-platform-ticket-links.test.mjs',
    'scripts/lib/some-helper.test.mjs',
    'scripts/tests/tm-gap-links.test.mjs',
    'tests/unit/some-test.test.mjs',
    'scripts/some-typed-thing.test.ts',
    '',
    '# a comment',
  ];
  assert.deepEqual(filterToplevelTestEntries(lines), [
    'scripts/fix-platform-ticket-links.test.mjs',
    'scripts/some-typed-thing.test.ts',
  ]);
});

test('siblingSourcePath: resolves a real .test.mjs to its real .js sibling', () => {
  assert.equal(
    siblingSourcePath('scripts/fix-platform-ticket-links.test.mjs'),
    'scripts/fix-platform-ticket-links.js'
  );
});

test('siblingSourcePath: returns null when the sibling source does not exist on disk', () => {
  assert.equal(siblingSourcePath('scripts/definitely-not-a-real-script-9999.test.mjs'), null);
});

test('siblingSourcePath: returns null for a non-matching path shape', () => {
  assert.equal(siblingSourcePath('scripts/lib/some-helper.test.mjs'), null);
});

// --- BRO-3202: the second gap shape — a manifest-registered test under tests/
// whose required top-level scripts/ SOURCE has no push-path entry. The test
// file is always covered by the 'tests/**' glob, so only the source can be
// missing, and the source is the half that changes behaviour.

const UNIT_DIR = new URL('../tests/unit/', import.meta.url).pathname;

test('filterTestsDirEntries: keeps only tests/**/*.test.(mjs|ts)', () => {
  const lines = [
    'tests/unit/audit-dependencies.test.mjs',
    'tests/unit/nested/deep.test.ts',
    'scripts/fix-platform-ticket-links.test.mjs',
    'scripts/lib/some-helper.test.mjs',
    'tests/unit/not-a-test.mjs',
    '',
    '# a comment',
  ];
  assert.deepEqual(filterTestsDirEntries(lines), [
    'tests/unit/audit-dependencies.test.mjs',
    'tests/unit/nested/deep.test.ts',
  ]);
});

test('toplevelScriptDeps: finds a top-level scripts/ require, ignores scripts/lib and packages', () => {
  const src = [
    "import { test } from 'node:test';",
    "const a = require('../../scripts/audit-dependencies.js');",
    "const b = require('../../scripts/lib/test-yml-push-paths.js');",
    "const c = require('node:fs');",
  ].join('\n');
  assert.deepEqual(
    toplevelScriptDeps(src, UNIT_DIR),
    ['scripts/audit-dependencies.js'],
    'scripts/lib/** is already globbed; bare package specifiers are not files'
  );
});

test('toplevelScriptDeps: resolves a specifier written without its extension', () => {
  const src = "const x = require('../../scripts/audit-dependencies');";
  assert.deepEqual(toplevelScriptDeps(src, UNIT_DIR), ['scripts/audit-dependencies.js']);
});

// The shared regex used to be /require\(['"]\.…/ — no whitespace allowed after
// `require(` — so the multi-line shape a long destructure gets formatted into
// silently dropped the dependency from BOTH audits.
// tests/unit/assert-broadcast-step-order.test.mjs:25 is written exactly that
// way and was invisible to this audit until the regex was made
// whitespace-tolerant.
test('relativeSpecifiers: catches a require() split across lines', () => {
  const src = [
    'const { findNodeInstallLine, findChecklistGateLine } = require(',
    "  '../../scripts/assert-broadcast-step-order.js',",
    ');',
  ].join('\n');
  assert.deepEqual([...relativeSpecifiers(src)], ['../../scripts/assert-broadcast-step-order.js']);
});

test('relativeSpecifiers: is not left stateful by a previous call (/g lastIndex)', () => {
  const src = "const a = require('./one.js');\nimport b from './two.js';";
  const first = [...relativeSpecifiers(src)];
  const second = [...relativeSpecifiers(src)];
  assert.deepEqual(second, first, 'a second call must see the same specifiers');
  assert.deepEqual(first, ['./one.js', './two.js']);
});

test('findGaps: the real repo reports all three shapes and currently has none of any', () => {
  const gaps = findGaps();
  assert.deepEqual(gaps, [], `push-path entries missing for: ${gaps.map((g) => g.source).join(', ')}`);
});

// --- BRO-3202 ship-check: making REQUIRE_RE whitespace-tolerant widened what
// PROSE can match. This repo's tests routinely name requires in comments (e.g.
// tests/unit/linear-next.test.mjs describes `require('./bsc-next.js')`), and
// today those resolve to nothing only by luck. A doc comment citing a path that
// does exist would mint a phantom gap and fail the floor test below.
test('relativeSpecifiers ignores a require() written inside a line comment', () => {
  const src = [
    "// The old code called require('../../scripts/audit-dependencies.js') here.",
    "const real = require('../../scripts/audit-test-yml-lib-deps.js');",
  ].join('\n');
  assert.deepEqual([...relativeSpecifiers(src)], ['../../scripts/audit-test-yml-lib-deps.js']);
});

test('relativeSpecifiers ignores a require() inside a block comment', () => {
  const src = [
    '/**',
    " * Pattern: require('../../scripts/audit-dependencies.js') — do not copy logic.",
    ' */',
    "const real = require('./one.js');",
  ].join('\n');
  assert.deepEqual([...relativeSpecifiers(src)], ['./one.js']);
});

test('stripComments preserves line count so nothing else shifts', () => {
  const src = "a\n// comment\n/* block\n   block */\nb";
  assert.equal(stripComments(src).split('\n').length, src.split('\n').length);
});

test('stripComments does not eat the // in a URL', () => {
  const src = "const u = 'https://example.com/x';\nconst a = require('./one.js');";
  assert.deepEqual([...relativeSpecifiers(src)], ['./one.js']);
});

test('toplevelScriptDeps resolves an extensionless TypeScript import', () => {
  // Without .ts in RESOLVE_CANDIDATES this returned [], which is how
  // scripts/llm-scoring/input-builder.ts stayed invisible to both audits.
  const src = "import { buildInput } from '../../scripts/llm-scoring/input-builder';";
  assert.deepEqual(toplevelScriptDeps(src, UNIT_DIR), ['scripts/llm-scoring/input-builder.ts']);
});

test('toplevelScriptDeps still ignores scripts/lib (already globbed)', () => {
  const src = "const x = require('../../scripts/lib/test-yml-push-paths.js');";
  assert.deepEqual(toplevelScriptDeps(src, UNIT_DIR), []);
});

// --- BRO-3207: the third shape — scripts test.yml itself executes from a
// push-running job. Fixtures are inline YAML; `exists` is stubbed so no disk.

const { readPushPaths } = require('./audit-test-yml-lib-deps.js');
const fixture = (jobs, paths = ["'tests/**'"]) => [
  'on:', '  push:', '    paths:', ...paths.map((p) => `      - ${p}`),
  '  schedule:', "    - cron: '0 0 * * *'", 'jobs:', jobs,
].join('\n');
const gapsFor = (yml) => findWorkflowRunGaps(yml, readPushPaths(yml), () => true);

test('jobRunsOnPush: no if, actor-only if, and un-parseable ifs all assume push', () => {
  assert.equal(jobRunsOnPush(''), true);
  assert.equal(jobRunsOnPush("github.actor != 'dependabot[bot]'"), true);
  assert.equal(jobRunsOnPush('always()'), true);
  assert.equal(jobRunsOnPush("!(github.event_name == 'schedule')"), true);
  assert.equal(jobRunsOnPush("(github.event_name == 'schedule' || github.event_name == 'push') && x"), true);
  assert.equal(jobRunsOnPush("github.event_name != 'schedule'"), true);
});

test('jobRunsOnPush: schedule/dispatch-only ifs do not run on push', () => {
  assert.equal(jobRunsOnPush("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'"), false);
  assert.equal(jobRunsOnPush("github.event_name == 'schedule'"), false);
  assert.equal(jobRunsOnPush("github.event_name != 'push'"), false);
  assert.equal(jobRunsOnPush(
    "github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && github.event.inputs.t != 'x')"
  ), false);
  assert.equal(jobRunsOnPush("github.event_name == 'push' || github.event_name == 'schedule'"), true);
});

test('findWorkflowRunGaps: a push-running job executing an unlisted script is a workflow-run gap', () => {
  const gaps = gapsFor(fixture([
    '  unit:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: node scripts/some-gate.js --flag',
    '      - run: |',
    '          set -e',
    '          npx tsx scripts/typed-gate.ts',
  ].join('\n')));
  assert.deepEqual(gaps.map((g) => [g.source, g.via, g.test]), [
    ['scripts/some-gate.js', 'workflow-run', 'test.yml:unit'],
    ['scripts/typed-gate.ts', 'workflow-run', 'test.yml:unit'],
  ]);
});

test('findWorkflowRunGaps: a schedule-only job does NOT generate a false positive', () => {
  const gaps = gapsFor(fixture([
    '  nightly:',
    "    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
    '    steps:',
    '      - run: node scripts/nightly-only.js',
    '  folded:',
    '    if: >',
    "      github.event_name == 'schedule' ||",
    "      (github.event_name == 'workflow_dispatch' &&",
    "       github.event.inputs.test_type != 'x')",
    '    steps:',
    '      - run: node scripts/folded-nightly.js',
  ].join('\n')));
  assert.deepEqual(gaps, []);
});

test('findWorkflowRunGaps: listed scripts, comments, echo hints, name: text and missing files are ignored', () => {
  const yml = fixture([
    '  unit:',
    '    steps:',
    '      - name: node scripts/in-a-name.js',
    '      # node scripts/in-a-comment.js',
    '      - run: node scripts/listed.js',
    '      - run: |',
    '          # node scripts/shell-comment.js',
    '          echo "Run locally: npx tsx scripts/echo-hint.ts"',
    '          node scripts/not-on-disk.js',
  ].join('\n'), ["'tests/**'", "'scripts/listed.js'"]);
  const gaps = findWorkflowRunGaps(yml, readPushPaths(yml), (rel) => rel !== 'scripts/not-on-disk.js');
  assert.deepEqual(gaps, []);
});

test('findWorkflowRunGaps: scripts/lib is covered by its glob and a script is reported once', () => {
  const yml = fixture([
    '  a:', '    steps:', '      - run: node scripts/lib/x.js', '      - run: node scripts/dup.js',
    '  b:', '    steps:', '      - run: node scripts/dup.js',
  ].join('\n'), ["'tests/**'", "'scripts/lib/**'"]);
  assert.deepEqual(gapsFor(yml).map((g) => g.source), ['scripts/dup.js']);
});

test('parseJobs: job if: and run bodies attach to the right job', () => {
  const jobs = parseJobs(fixture([
    '  a:', "    if: github.actor != 'bot'", '    steps:', '      - run: node scripts/a.js',
    '  b:', '    steps:', '      - run: |', '          node scripts/b.js',
  ].join('\n')));
  assert.deepEqual(jobs.map((j) => [j.name, j.ifExpr, j.runLines]), [
    ['a', "github.actor != 'bot'", ['node scripts/a.js']],
    ['b', '', ['node scripts/b.js']],
  ]);
});

// Acceptance: removing ANY of the 14 BRO-3202 entries must fail the floor.
const BRO_3202_ENTRIES = [
  'audit-nft-excluded-runtime-reads', 'audit-playwright-evaluate-click', 'audit-tests-vs-derived-data',
  'audit-text-quality', 'audit-verifier-wiring', 'auto-close-expired-shows', 'build-actor-slugs-manifest',
  'build-cast-manifest', 'check-brand-tokens-sync', 'check-image-aspect', 'lint-design-tokens',
  'test-email-broadcast', 'test-temporal-override-regression', 'validate-archive-productions',
];
test('findWorkflowRunGaps: dropping any BRO-3202 push-path entry on the real test.yml is detected', async () => {
  const { readFileSync } = await import('node:fs');
  const yml = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  const entries = readPushPaths(yml);
  for (const name of BRO_3202_ENTRIES) {
    const rel = entries.find((e) => new RegExp(`^scripts/${name}\\.(js|mjs|cjs)$`).test(e));
    assert.ok(rel, `${name} should be hand-listed in test.yml`);
    const gaps = findWorkflowRunGaps(yml, entries.filter((e) => e !== rel));
    assert.ok(gaps.some((g) => g.source === rel && g.via === 'workflow-run'), `removing ${rel} must produce a gap`);
  }
});

test('scriptsExecutedBy: flag values, multiple files, ./ prefix, bash .sh, continuations', () => {
  assert.deepEqual(scriptsExecutedBy('node --test --test-timeout 60000 scripts/A.test.mjs'), ['scripts/A.test.mjs']);
  assert.deepEqual(scriptsExecutedBy('node -r dotenv/config scripts/F.js'), ['scripts/F.js']);
  assert.deepEqual(scriptsExecutedBy('node --test scripts/B.test.mjs scripts/C.test.mjs'), ['scripts/B.test.mjs', 'scripts/C.test.mjs']);
  assert.deepEqual(scriptsExecutedBy('node ./scripts/D.js'), ['scripts/D.js']);
  assert.deepEqual(scriptsExecutedBy('cd x && npx tsx scripts/T.ts | tee out'), ['scripts/T.ts']);
  assert.deepEqual(scriptsExecutedBy('bash scripts/run.test.sh'), ['scripts/run.test.sh']);
  assert.deepEqual(scriptsExecutedBy('node scripts/x.sh'), [], 'node does not run .sh');
  assert.deepEqual(scriptsExecutedBy('echo "Run: node scripts/x.js"'), []);
  assert.deepEqual(scriptsExecutedBy('FOO=1 node scripts/E.js'), ['scripts/E.js']);
  assert.deepEqual(joinContinuations(['node \\', 'scripts/E.js', 'echo hi']), ['node scripts/E.js', 'echo hi']);
});
