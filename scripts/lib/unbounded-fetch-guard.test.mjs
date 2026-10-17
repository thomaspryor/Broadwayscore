// Unit tests for the unbounded-fetch lint guard (task #420).
//
// Every case below is a real shape this guard had to get right. The ones marked
// REGRESSION were caught by running the guard against the live repo, not by
// imagining inputs — the first cut of the detector got each of them wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  analyzeWorkflowCheckout,
  auditUnboundedFetches,
  findUnboundedFetches,
  isFetchBounded,
  isWaived,
  isolateCommand,
  localDependencies,
  normalizePath,
  reachableFrom,
  referencedScripts,
  spawnedScripts,
  stripBlockComments,
} = require('./unbounded-fetch-guard.js');

// ── isFetchBounded ──────────────────────────────────────────────────────────

test('isFetchBounded accepts every depth-bounding flag form', () => {
  for (const cmd of [
    ' origin main --depth=1',
    ' origin main --depth 50',
    ' --deepen=200 origin main',
    ' --shallow-since=@1750000000 origin main',
    ' --shallow-exclude=v1.0 origin',
    ' --unshallow',
  ]) {
    assert.equal(isFetchBounded(cmd), true, cmd);
  }
});

test('isFetchBounded rejects unbounded and near-miss flags', () => {
  assert.equal(isFetchBounded(' origin main'), false);
  assert.equal(isFetchBounded(' origin main --quiet'), false);
  assert.equal(isFetchBounded(' origin +refs/heads/main:refs/remotes/origin/main'), false);
  // A flag that merely CONTAINS a bound name is not a bound.
  assert.equal(isFetchBounded(' origin main --depthless'), false);
  assert.equal(isFetchBounded(' origin main --no-deepening'), false);
});

// ── isolateCommand ──────────────────────────────────────────────────────────

test('isolateCommand stops at the closing quote in JS', () => {
  // Without this, a --depth on a LATER command in the same line would be read
  // as this fetch's bound.
  const rest = isolateCommand(" origin main', { stdio: 'pipe' }); other('--depth=1')", 'js');
  assert.equal(isFetchBounded(rest), false);
});

test('isolateCommand stops at a shell separator', () => {
  const rest = isolateCommand(' origin main && git rebase --depth=1 origin/main', 'js');
  assert.equal(isFetchBounded(rest), false);
});

test('isolateCommand keeps flags that belong to this fetch', () => {
  assert.equal(isFetchBounded(isolateCommand(' origin main --depth=1', 'js')), true);
  assert.equal(isFetchBounded(isolateCommand(' --deepen=200 origin main', 'sh')), true);
});

// ── findUnboundedFetches: JS ────────────────────────────────────────────────

test('flags the exact shape task #420 was filed for', () => {
  const src = `function push() {\n  execSync('git fetch origin main', { stdio: 'pipe' });\n}`;
  const hits = findUnboundedFetches(src, 'scripts/collect-review-texts.js');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].subcommand, 'fetch');
});

test('flags git pull, which is a fetch with the same exposure', () => {
  const src = `execSync('git pull --rebase -X theirs origin main', { cwd: rtDir });`;
  const hits = findUnboundedFetches(src, 'scripts/x.js');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].subcommand, 'pull');
});

test('flags each fetch in a chained command separately', () => {
  const src = `execSync('git fetch origin main && git rebase origin/main');\nexecSync('git fetch origin main && git merge origin/main -X ours');`;
  assert.equal(findUnboundedFetches(src, 'scripts/llm-scoring/index.ts').length, 2);
});

test('does not flag a bounded fetch', () => {
  const src = `execSync('git fetch origin main --depth 1');`;
  assert.equal(findUnboundedFetches(src, 'scripts/x.js').length, 0);
});

test('REGRESSION: a log string mentioning a fetch is not a call site', () => {
  // scripts/lib/overnight-digest.js line 131 — the first cut flagged this
  // *string*, and in doing so completely missed the real argv-form fetch on
  // the same line. Two bugs, one line.
  const src = `try { doThing(); } catch { digest.errors.push('git fetch failed — commit summary may be stale'); }`;
  assert.equal(findUnboundedFetches(src, 'scripts/lib/overnight-digest.js').length, 0);
});

test('REGRESSION: argv form is detected (execFileSync with a separate args array)', () => {
  const src = `run('git', ['fetch', 'origin', 'main', '--quiet']);`;
  const hits = findUnboundedFetches(src, 'scripts/lib/overnight-digest.js');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].subcommand, 'fetch');
});

test('argv form with a bound is clean', () => {
  const src = `execFileSync('git', ['-C', dir, 'fetch', '--depth=1', '--quiet']);`;
  assert.equal(findUnboundedFetches(src, 'scripts/x.mjs').length, 0);
});

test('comments and block comments never count as call sites', () => {
  const src = [
    '// Historically we ran git fetch origin main here.',
    '/*',
    ' * execSync("git fetch origin main") — the old unbounded form.',
    ' */',
    'const ok = true;',
  ].join('\n');
  assert.equal(findUnboundedFetches(src, 'scripts/x.js').length, 0);
});

test('stripBlockComments preserves line numbering', () => {
  const src = 'a\n/* x\n y */\nb';
  assert.equal(stripBlockComments(src).split('\n').length, src.split('\n').length);
});

// ── findUnboundedFetches: shell ─────────────────────────────────────────────

test('flags an unbounded shell fetch and ignores an echo about one', () => {
  const src = [
    'git fetch origin main',
    'echo "  Fix: git fetch origin && git merge origin/main"',
    '# git fetch origin main (documented, not run)',
  ].join('\n');
  const hits = findUnboundedFetches(src, 'scripts/x.sh');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 1);
});

test('a git -c config prefix does not hide the subcommand', () => {
  const src = 'git -c "http.lowSpeedLimit=1000" -c "http.lowSpeedTime=45" fetch "$@"';
  assert.equal(findUnboundedFetches(src, 'scripts/lib/push-with-retry.sh').length, 1);
});

// ── waivers ─────────────────────────────────────────────────────────────────

test('waiver on the same line suppresses the finding', () => {
  const src = `execSync('git fetch origin main'); // unbounded-fetch-ok: fixture`;
  assert.equal(findUnboundedFetches(src, 'scripts/x.js').length, 0);
});

test('waiver anywhere in the comment block above suppresses the finding', () => {
  const src = [
    '// A long explanation that needs',
    '// several lines, and somewhere in it:',
    '// unbounded-fetch-ok: the bound arrives via "$@"',
    '// followed by even more prose.',
    "execSync('git fetch origin main');",
  ].join('\n');
  assert.equal(findUnboundedFetches(src, 'scripts/x.js').length, 0);
});

test('REGRESSION: waiver reaches across a shell line continuation', () => {
  // push-with-retry.sh's git_fetch wrapper: the comment block sits above
  // `_timeout ... \`, and the git line is the continuation. A naive one-line
  // (or comment-only) lookback stops at the `_timeout` line and the waiver
  // never applies.
  const src = [
    'git_fetch() {',
    '  # unbounded-fetch-ok: wrapper — the bound arrives in "$@"',
    '  _timeout "$GIT_NET_TIMEOUT_SEC" \\',
    '    git -c "http.lowSpeedLimit=1000" fetch "$@"',
    '}',
  ].join('\n');
  assert.equal(findUnboundedFetches(src, 'scripts/lib/push-with-retry.sh').length, 0);
});

test('a blank line breaks the waiver block so it cannot leak downward', () => {
  const src = [
    '// unbounded-fetch-ok: applies to something else',
    '',
    "execSync('git fetch origin main');",
  ].join('\n');
  assert.equal(findUnboundedFetches(src, 'scripts/x.js').length, 1);
});

test('isWaived is false when nothing above it waives', () => {
  assert.equal(isWaived(['const a = 1;', "execSync('git fetch origin main');"], 1, 'js'), false);
});

// ── workflow checkout depth ─────────────────────────────────────────────────

const WF = (body) => `name: X\non:\n  push:\njobs:\n  a:\n    steps:\n${body}`;

test('a checkout with no fetch-depth is SHALLOW (actions/checkout defaults to 1)', () => {
  const r = analyzeWorkflowCheckout(WF('      - uses: actions/checkout@v5\n'));
  assert.deepEqual(r, { hasCheckout: true, shallow: true });
});

test('fetch-depth: 0 is a complete clone', () => {
  const r = analyzeWorkflowCheckout(WF('      - uses: actions/checkout@v5\n        with:\n          fetch-depth: 0\n'));
  assert.deepEqual(r, { hasCheckout: true, shallow: false });
});

test('fetch-depth: 1 stated explicitly is still shallow', () => {
  const r = analyzeWorkflowCheckout(WF('      - uses: actions/checkout@v5\n        with:\n          fetch-depth: 1\n'));
  assert.equal(r.shallow, true);
});

test('a workflow is exposed if ANY of its checkouts is shallow', () => {
  // bulk-collect-review-texts.yml is exactly this: three checkouts, only the
  // middle one sets fetch-depth: 0. The shallow jobs are still exposed.
  const src = WF(
    '      - uses: actions/checkout@v5\n' +
    '      - uses: actions/checkout@v5\n        with:\n          fetch-depth: 0\n'
  );
  assert.equal(analyzeWorkflowCheckout(src).shallow, true);
});

test('a workflow with no checkout is not an exposure path', () => {
  const r = analyzeWorkflowCheckout(WF('      - run: echo hi\n'));
  assert.deepEqual(r, { hasCheckout: false, shallow: false });
});

// ── referenced scripts ──────────────────────────────────────────────────────

test('referencedScripts picks up run-step invocations', () => {
  const src = 'jobs:\n  a:\n    steps:\n      - run: node scripts/collect-review-texts.js --limit=5\n';
  assert.deepEqual(referencedScripts(src), ['scripts/collect-review-texts.js']);
});

test('REGRESSION: a push paths: filter is not an invocation', () => {
  // test.yml path-lists ~40 scripts. Counting those as "reachable" made almost
  // every script in the repo look exposed — including launchd-only tooling
  // like autonomous-nightly.sh, which never runs in CI at all.
  const src = [
    'on:',
    '  push:',
    '    paths:',
    "      - 'scripts/validate-data.js'",
    "      - 'scripts/lib/finance-stats.js'",
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: node scripts/really-runs.js',
  ].join('\n');
  assert.deepEqual(referencedScripts(src), ['scripts/really-runs.js']);
});

test('paths-ignore is excluded too', () => {
  const src = "on:\n  push:\n    paths-ignore:\n      - 'scripts/docs-only.js'\n";
  assert.deepEqual(referencedScripts(src), []);
});

test('REGRESSION: a step comment naming a script as a cross-reference is not an invocation (BRO-1794)', () => {
  // A step comment describing what a NEW step's "different risk class"
  // cousins are (documentation, not a call) made referencedScripts() report
  // scripts/sync-review-texts.sh as reachable purely because its path
  // appeared in prose next to a run: block — same false-positive shape as
  // the paths: filter case above, just via a whole-line `#` comment instead.
  const src = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - name: some step',
    '        # see also scripts/sync-review-texts.sh, tracked separately',
    '        run: node scripts/really-runs.js',
  ].join('\n');
  assert.deepEqual(referencedScripts(src), ['scripts/really-runs.js']);
});

test('a trailing comment after real content does not hide a real invocation', () => {
  const src = "jobs:\n  a:\n    steps:\n      - run: node scripts/really-runs.js  # fast path\n";
  assert.deepEqual(referencedScripts(src), ['scripts/really-runs.js']);
});

// ── dependency graph + reachability ─────────────────────────────────────────

test('normalizePath resolves .. without touching disk', () => {
  assert.equal(normalizePath('scripts/lib/../foo/./bar.js'), 'scripts/foo/bar.js');
});

test('localDependencies resolves relative requires, skips packages', () => {
  const files = new Set(['scripts/lib/helper.js', 'scripts/lib/other.js']);
  const resolve = (p) => (files.has(p) ? p : null);
  const src = "const a = require('./helper');\nconst b = require('../lib/other.js');\nconst c = require('lodash');";
  assert.deepEqual(localDependencies(src, 'scripts/lib/main.js', resolve).sort(), ['scripts/lib/helper.js', 'scripts/lib/other.js']);
});

test('reachableFrom walks the graph transitively', () => {
  const graph = new Map([['a', ['b']], ['b', ['c']], ['c', []], ['d', []]]);
  assert.deepEqual([...reachableFrom(['a'], graph)].sort(), ['a', 'b', 'c']);
});

test('reachableFrom terminates on a require cycle', () => {
  const graph = new Map([['a', ['b']], ['b', ['a']]]);
  assert.deepEqual([...reachableFrom(['a'], graph)].sort(), ['a', 'b']);
});

// ── end-to-end audit decision ───────────────────────────────────────────────

test('audit reports a violation only when a SHALLOW workflow can reach it', () => {
  const scripts = new Map([
    ['scripts/exposed.js', "execSync('git fetch origin main');"],
    ['scripts/deep-only.js', "execSync('git fetch origin main');"],
    ['scripts/never-run.js', "execSync('git fetch origin main');"],
  ]);
  const workflows = new Map([
    ['.github/workflows/shallow.yml', WF('      - uses: actions/checkout@v5\n      - run: node scripts/exposed.js\n')],
    ['.github/workflows/deep.yml', WF('      - uses: actions/checkout@v5\n        with:\n          fetch-depth: 0\n      - run: node scripts/deep-only.js\n')],
  ]);
  const { violations } = auditUnboundedFetches({ scripts, workflows });
  assert.deepEqual(violations.map((v) => v.file), ['scripts/exposed.js']);
  assert.deepEqual(violations[0].workflows, ['.github/workflows/shallow.yml']);
});

test('audit follows require() so a shared lib inherits its callers exposure', () => {
  // scripts/lib/overnight-digest.js is only reachable this way — no workflow
  // names it directly.
  const scripts = new Map([
    ['scripts/entry.js', "const d = require('./lib/dep.js');"],
    ['scripts/lib/dep.js', "execSync('git fetch origin main');"],
  ]);
  const workflows = new Map([
    ['.github/workflows/w.yml', WF('      - uses: actions/checkout@v5\n      - run: node scripts/entry.js\n')],
  ]);
  const { violations } = auditUnboundedFetches({ scripts, workflows });
  assert.deepEqual(violations.map((v) => v.file), ['scripts/lib/dep.js']);
});

test('audit is clean when every reachable fetch is bounded or waived', () => {
  const scripts = new Map([
    ['scripts/a.js', "execSync('git fetch origin main --depth=1');"],
    ['scripts/b.js', "// unbounded-fetch-ok: fixture\nexecSync('git fetch origin main');"],
  ]);
  const workflows = new Map([
    ['.github/workflows/w.yml', WF('      - uses: actions/checkout@v5\n      - run: node scripts/a.js\n      - run: node scripts/b.js\n')],
  ]);
  assert.deepEqual(auditUnboundedFetches({ scripts, workflows }).violations, []);
});

// ── spawn edges (Codex ship-check: false negatives are the dangerous direction) ──

test('spawnedScripts finds shell-out invocations', () => {
  const files = new Set(['scripts/worker.js', 'scripts/helper.sh']);
  const resolve = (p) => (files.has(p) ? p : null);
  const src = [
    "execSync('node scripts/worker.js --limit=5');",
    "spawnSync('bash', ['scripts/helper.sh']);",
    "console.log('scripts/not-a-real-file.js');",
  ].join('\n');
  assert.deepEqual(spawnedScripts(src, resolve).sort(), ['scripts/helper.sh', 'scripts/worker.js']);
});

test('REGRESSION: audit reaches a worker that is only SPAWNED, never required', () => {
  // The narrow require()-only model reported this repo clean; adding spawn
  // edges immediately surfaced a real unbounded fetch in
  // scripts/autonomous-acceptance-recheck.js, reachable from 122 shallow
  // workflows. A missed edge here is a silent multi-GB CI stall.
  const scripts = new Map([
    ['scripts/dispatcher.js', "execSync('node scripts/worker.js');"],
    ['scripts/worker.js', "execSync('git fetch origin main');"],
  ]);
  const workflows = new Map([
    ['.github/workflows/w.yml', WF('      - uses: actions/checkout@v5\n      - run: node scripts/dispatcher.js\n')],
  ]);
  const { violations } = auditUnboundedFetches({ scripts, workflows });
  assert.deepEqual(violations.map((v) => v.file), ['scripts/worker.js']);
});

test('composite action yml is analysed like a workflow (its checkout defaults to depth 1)', () => {
  // .github/actions/checkout-review-texts/action.yml sets fetch-depth: 1 by
  // default; treating only .github/workflows/ as entry points hid every script
  // a composite action invokes.
  const action = [
    'name: Checkout review-texts',
    'runs:',
    '  using: composite',
    '  steps:',
    '    - uses: actions/checkout@v5',
    '      with:',
    '        fetch-depth: 1',
    '    - run: node scripts/inside-action.js',
  ].join('\n');
  assert.equal(analyzeWorkflowCheckout(action).shallow, true);
  assert.deepEqual(referencedScripts(action), ['scripts/inside-action.js']);
});
